import { query, withTx, audit } from '../db/pool';
import { redis } from '../redis/connection';
import { QUEUE, enqueue } from '../queues/queues';
import { scoreSeo } from '../services/seoScorer';
import { generateDistributionPayloads, DistributionPayloads } from '../services/distributionCopy';
import { GenerationResult, KarbonTrigger, SocialPostResult } from '../adapters/types';
import { campaignSlug } from '../utils/utm';
import { env } from '../config/env';

// ─────────────────────────────────────────────────────────────────────────────
// Durable saga orchestrator. State lives in Postgres (workflow_runs.status +
// content_drafts); BullMQ moves work between steps; every transition writes an
// audit row. Concurrency-safe: every transition is a guarded UPDATE … WHERE
// status = <expected> — a stale actor (double click, second reviewer, replayed
// job) gets 0 rows back and surfaces a conflict instead of overwriting.
//
//   triggered → generating → seo_review ⇄ revision
//     seo_review → deploying → dist_generating → dist_review
//     dist_review → publishing → completing → complete
//   any step ↘ failed (terminal: retries exhausted → Karbon timeline note)
// ─────────────────────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { rows } = await query<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows.length ? (rows[0].value as T) : fallback;
}

/** Guarded status transition. Returns false when the run was not in `from`. */
async function transition(
  runId: string,
  from: string | string[],
  to: string,
  step: string,
  extra: { sql?: string; params?: unknown[] } = {}
): Promise<boolean> {
  const fromList = Array.isArray(from) ? from : [from];
  const { rowCount } = await query(
    `UPDATE workflow_runs
        SET status = $1::run_status, current_step = $2, updated_at = now() ${extra.sql ?? ''}
      WHERE id = $3 AND status = ANY($4::run_status[])`,
    [to, step, runId, fromList, ...(extra.params ?? [])].slice(0, 4 + (extra.params?.length ?? 0))
  );
  return (rowCount ?? 0) > 0;
}

// ---------- 1. Trigger (Karbon webhook, already HMAC + idempotency checked) ----------
export async function createRunFromTrigger(t: KarbonTrigger): Promise<{ runId: string }> {
  const run = await withTx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO workflow_runs (karbon_work_id, karbon_stage_id, client_name, topic, keywords, tone, status, current_step)
       VALUES ($1, $2, $3, $4, $5, $6, 'triggered', 'trigger')
       ON CONFLICT ON CONSTRAINT uq_karbon_trigger DO NOTHING
       RETURNING id`,
      [t.workItemId, t.stageId, t.clientName, t.topic, t.keywords, t.tone]
    );
    return rows[0] as { id: string } | undefined;
  });

  if (!run) throw new ConflictError('Run already exists for this work item + stage (idempotency backstop)');

  await audit(run.id, 'api', 'run.triggered', {
    karbonWorkId: t.workItemId,
    karbonStageId: t.stageId,
    hmac: 'verified',
    idempotency: 'acquired'
  });

  await transition(run.id, 'triggered', 'generating', 'generation');
  await enqueue(QUEUE.generation, 'generate', { runId: run.id });
  return { runId: run.id };
}

// ---------- 2. Generation complete → SEO score → gate 1 ----------
export async function onGenerationComplete(runId: string, gen: GenerationResult): Promise<void> {
  const seo = scoreSeo({
    blogText: gen.blogMarkdown,
    title: gen.blogTitle,
    metaDescription: gen.metaDescription,
    keywords: await runKeywords(runId)
  });

  await withTx(async (c) => {
    await c.query(
      `INSERT INTO content_drafts (workflow_run_id, blog_title, blog_meta_description, blog_text, lead_magnet_url, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')`,
      [runId, gen.blogTitle, gen.metaDescription, gen.blogMarkdown, gen.leadMagnetUrl]
    );
    await c.query(
      `UPDATE workflow_runs SET seo_score = $1, seo_report = $2, updated_at = now() WHERE id = $3`,
      [seo.total, JSON.stringify(seo), runId]
    );
  });

  await transition(runId, 'generating', 'seo_review', 'review');
  await audit(runId, 'api', 'draft.persisted', {
    words: gen.wordCount,
    latencyMs: gen.generatorLatencyMs,
    seoScore: seo.total,
    suggestions: seo.suggestions.length
  });

  // Optional auto-approve (gate 1 ONLY — the distribution gate always needs a human).
  const threshold = await getSetting<number>('seo_auto_approve_threshold', env.workflow.seoAutoApproveThreshold);
  const autoOn = await getSetting<boolean>('auto_approve_enabled', env.workflow.autoApproveEnabled);
  if (autoOn && seo.total >= threshold) {
    await audit(runId, 'system', 'draft.auto_approved', { seoScore: seo.total, threshold });
    await approveDraft(runId, null, 'auto');
  }
}

// ---------- 3. Gate 1: approve / revise (human or auto) ----------
export async function approveDraft(runId: string, userId: string | null, actor: string): Promise<void> {
  const ok = await transition(runId, 'seo_review', 'deploying', 'deploy', {
    sql: ', approved_by = $5',
    params: [userId]
  });
  if (!ok) {
    const cur = await runStatus(runId);
    throw new ConflictError(`Draft is no longer awaiting review (status: ${cur}) — already handled by another user?`);
  }
  await audit(runId, actor, 'draft.approved', {}, userId);
  await enqueue(QUEUE.wordpress, 'deploy', { runId, actor });
}

export async function requestRevision(runId: string, note: string, userId: string, actor: string): Promise<void> {
  const ok = await transition(runId, 'seo_review', 'generating', 'generation', {
    sql: ', revision_count = revision_count + 1',
    params: []
  });
  if (!ok) {
    const cur = await runStatus(runId);
    throw new ConflictError(`Draft is no longer awaiting review (status: ${cur})`);
  }
  await audit(runId, actor, 'draft.revision_requested', { note }, userId);
  await enqueue(QUEUE.generation, 'generate', { runId, revisionNote: note });
}

// ---------- 4. Deploy complete → distribution payload generation → gate 2 ----------
export async function onDeployComplete(runId: string, liveUrl: string, cmsPostId: string): Promise<void> {
  await query(
    `UPDATE content_drafts SET live_url = $1, status = 'deployed', updated_at = now()
      WHERE workflow_run_id = $2`,
    [liveUrl, runId]
  );
  await transition(runId, 'deploying', 'dist_generating', 'dist_generation');
  await audit(runId, 'api', 'deploy.completed', { liveUrl, cmsPostId });

  const d = await draft(runId);
  const run = await runRow(runId);
  const brandVoice = await getSetting<string>('brand_voice', '');
  const payloads = await generateDistributionPayloads({
    topic: run.topic,
    blogTitle: d.blog_title,
    metaDescription: d.blog_meta_description,
    liveUrl,
    leadMagnetUrl: d.lead_magnet_url ?? '',
    leadMagnetName: 'Financial Health Checklist (PDF)',
    keywords: run.keywords,
    brandVoice
  });

  await query(
    `UPDATE content_drafts SET meta_ads_payload = $1, ac_email_payload = $2, social_payload = $3, updated_at = now()
      WHERE workflow_run_id = $4`,
    [JSON.stringify(payloads.metaAds), JSON.stringify(payloads.acEmail), JSON.stringify(payloads.social), runId]
  );
  await transition(runId, 'dist_generating', 'dist_review', 'dist_review');
  await audit(runId, 'api', 'distribution.generated', { brandVoiceChars: brandVoice.length });
  // Saga PAUSES here — gate 2. Nothing is enqueued to ads/email/social until
  // a human calls publishAll(). Auto-approve NEVER applies to this gate.
}

// ---------- 5. Gate 2: manual overrides + Approve & Publish All ----------
export async function saveOverrides(
  runId: string,
  channel: 'meta_ads' | 'ac_email' | 'social',
  payload: Record<string, unknown>,
  userId: string,
  actor: string
): Promise<void> {
  const col = { meta_ads: 'meta_ads_payload', ac_email: 'ac_email_payload', social: 'social_payload' }[channel];
  const { rowCount } = await query(
    `UPDATE content_drafts d SET ${col} = $1,
        overrides = d.overrides || $2::jsonb, updated_at = now()
       FROM workflow_runs r
      WHERE d.workflow_run_id = $3 AND r.id = $3 AND r.status = 'dist_review'`,
    [JSON.stringify(payload), JSON.stringify({ [channel]: { by: actor, at: new Date().toISOString() } }), runId]
  );
  if (!rowCount) throw new ConflictError('Run is not at the distribution gate — payloads are frozen');
  await audit(runId, actor, 'distribution.override_saved', { channel }, userId);
}

const pubKey = (runId: string) => `pub:${runId}`;

export async function publishAll(runId: string, userId: string, actor: string): Promise<void> {
  const ok = await transition(runId, 'dist_review', 'publishing', 'publish', {
    sql: ', published_by = $5',
    params: [userId]
  });
  if (!ok) {
    const cur = await runStatus(runId);
    throw new ConflictError(`Distribution already handled (status: ${cur}) — nothing overwritten`);
  }

  const toggles = await getSetting<{ ads: boolean; email: boolean; social: boolean }>('adapters_enabled', {
    ads: true,
    email: true,
    social: true
  });
  const run = await runRow(runId);
  const slug = campaignSlug(run.topic);

  const channels: Array<{ queue: typeof QUEUE[keyof typeof QUEUE]; job: string; enabled: boolean }> = [
    { queue: QUEUE.metaAds, job: 'create-lead-campaign', enabled: toggles.ads },
    { queue: QUEUE.activeCampaign, job: 'send-campaign', enabled: toggles.email },
    { queue: QUEUE.social, job: 'post-all-platforms', enabled: toggles.social }
  ];
  const active = channels.filter((c) => c.enabled);

  await audit(runId, actor, 'distribution.approved', {
    channels: active.map((c) => c.queue),
    skipped: channels.filter((c) => !c.enabled).map((c) => c.queue),
    utm: 'enforced-at-publish'
  }, userId);

  if (active.length === 0) {
    await finishPublishing(runId);
    return;
  }
  // Fan-out counter: when it hits 0 the run moves to the Karbon callback.
  await redis.set(pubKey(runId), String(active.length), 'EX', 24 * 3600);
  for (const c of active) await enqueue(c.queue, c.job, { runId, slug, actor });
}

export async function onChannelComplete(
  runId: string,
  channel: string,
  artifact: Record<string, unknown>
): Promise<void> {
  await audit(runId, 'api', `publish.${channel}.completed`, artifact);
  await decrementFanout(runId);
}

/** Social failures are NON-BLOCKING (spec): record + count down, don't park the run. */
export async function onSocialPartial(runId: string, results: SocialPostResult[]): Promise<void> {
  await audit(runId, 'api', 'publish.social.completed', {
    results: results.map((r) => ({ platform: r.platform, ok: r.ok, error: r.error ?? null }))
  });
  await decrementFanout(runId);
}

async function decrementFanout(runId: string): Promise<void> {
  const left = await redis.decr(pubKey(runId));
  if (left <= 0) {
    await redis.del(pubKey(runId));
    await finishPublishing(runId);
  }
}

async function finishPublishing(runId: string): Promise<void> {
  await transition(runId, 'publishing', 'completing', 'callback');
  await query(`UPDATE content_drafts SET status = 'published', updated_at = now() WHERE workflow_run_id = $1`, [runId]);
  await enqueue(QUEUE.karbonCallback, 'completion-note', { runId, kind: 'success' });
}

// ---------- 6. Terminal failure (retries exhausted on any blocking step) ----------
export async function markTerminalFailure(
  runId: string,
  step: string,
  failure: { message: string; httpStatus?: number; responseBody?: string; attempts: number }
): Promise<void> {
  await query(
    `UPDATE workflow_runs SET status = 'failed', current_step = $1, error = $2, updated_at = now() WHERE id = $3`,
    [step, JSON.stringify(failure), runId]
  );
  await audit(runId, 'system', 'run.terminal_failure', { step, ...failure });
  // "Workflow Failed" note to the Karbon timeline (rule 2) — via the callback
  // queue so the notification itself gets retry semantics.
  await enqueue(QUEUE.karbonCallback, 'failure-note', { runId, kind: 'failure', step });
}

export async function onCallbackComplete(runId: string, kind: 'success' | 'failure'): Promise<void> {
  if (kind === 'success') {
    await transition(runId, 'completing', 'complete', 'done', { sql: ', completed_at = now()', params: [] });
    await audit(runId, 'api', 'karbon.timeline_note_posted', { kind });
  } else {
    await audit(runId, 'api', 'karbon.failure_note_posted', { kind });
  }
}

// ---------- row helpers ----------
export interface RunRow {
  id: string;
  karbon_work_id: string;
  topic: string;
  keywords: string[];
  tone: string;
  status: string;
  revision_count: number;
}
export interface DraftRow {
  blog_title: string;
  blog_meta_description: string;
  blog_text: string;
  lead_magnet_url: string | null;
  live_url: string | null;
  meta_ads_payload: Record<string, string> | null;
  ac_email_payload: Record<string, string> | null;
  social_payload: Record<string, string> | null;
}

export async function runRow(runId: string): Promise<RunRow> {
  const { rows } = await query<RunRow>('SELECT * FROM workflow_runs WHERE id = $1', [runId]);
  if (!rows[0]) throw new Error(`Run not found: ${runId}`);
  return rows[0];
}
export async function draft(runId: string): Promise<DraftRow> {
  const { rows } = await query<DraftRow>(
    'SELECT * FROM content_drafts WHERE workflow_run_id = $1 ORDER BY created_at DESC LIMIT 1',
    [runId]
  );
  if (!rows[0]) throw new Error(`Draft not found for run: ${runId}`);
  return rows[0];
}
async function runStatus(runId: string): Promise<string> {
  return (await runRow(runId)).status;
}
async function runKeywords(runId: string): Promise<string[]> {
  return (await runRow(runId)).keywords;
}
