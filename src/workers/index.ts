import { Worker, Job } from 'bullmq';
import { bullConnection } from '../redis/connection';
import { QUEUE, RATE_LIMITS, QueueName } from '../queues/queues';
import { env } from '../config/env';
import { audit, query } from '../db/pool';
import * as saga from '../saga/orchestrator';
import { ReplitGenerationAdapter, GenerationError } from '../adapters/ReplitGenerationAdapter';
import { WordPressAdapter } from '../adapters/WordPressAdapter';
import { MetaAdsAdapter } from '../adapters/MetaAdsAdapter';
import { ActiveCampaignAdapter } from '../adapters/ActiveCampaignAdapter';
import { LinkedInPublisher, FacebookPublisher, InstagramPublisher } from '../adapters/SocialAdapters';
import { postCompletionNote, postFailureNote } from '../services/karbonClient';
import { appendUtm, campaignSlug } from '../utils/utm';

// Worker processes. Blocking steps (generation / wordpress / meta / email)
// THROW on failure so BullMQ retries with exponential backoff; when attempts
// are exhausted the 'failed' handler flips the saga to its terminal state.
// The social worker never throws — platform failures are independent and
// non-blocking by design.

const generation = new ReplitGenerationAdapter();
const wordpress = new WordPressAdapter();
const metaAds = new MetaAdsAdapter();
const activeCampaign = new ActiveCampaignAdapter();
const socialPublishers = [new LinkedInPublisher(), new FacebookPublisher(), new InstagramPublisher()];

const CONCURRENCY = 5; // concurrent workflows per queue — safe with the pool sizes above

function mkWorker(
  name: QueueName,
  processor: (job: Job) => Promise<unknown>,
  opts: { blocking: boolean }
): Worker {
  const worker = new Worker(name, processor, {
    connection: bullConnection,
    concurrency: CONCURRENCY,
    limiter: RATE_LIMITS[name] // 5 req/s AC · 10 req/10s Meta (rule 3)
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const attemptsAllowed = (job.opts.attempts ?? env.workflow.maxJobAttempts) as number;
    const exhausted = job.attemptsMade >= attemptsAllowed;
    const runId = (job.data as { runId?: string }).runId;

    if (runId) {
      await audit(runId, 'api', 'job.failed', {
        queue: name,
        jobId: job.id,
        attempt: job.attemptsMade,
        of: attemptsAllowed,
        error: err.message.slice(0, 600),
        willRetry: !exhausted
      }).catch(() => undefined);
    }

    if (exhausted && opts.blocking && runId) {
      const ge = err as GenerationError;
      await saga
        .markTerminalFailure(runId, name, {
          message: err.message.slice(0, 600),
          httpStatus: ge.httpStatus,
          responseBody: ge.responseBody,
          attempts: job.attemptsMade
        })
        .catch((e) => console.error('[saga] failed to mark terminal failure', e));
    }
  });

  worker.on('error', (err) => console.error(`[worker:${name}]`, err.message));
  return worker;
}

export function startWorkers(): Worker[] {
  const workers: Worker[] = [];

  // ---- replit-generation ----
  workers.push(
    mkWorker(
      QUEUE.generation,
      async (job) => {
        const { runId, revisionNote } = job.data as { runId: string; revisionNote?: string };
        const run = await saga.runRow(runId);
        const brandVoice = await settingString('brand_voice');
        await audit(runId, 'api', 'generation.dispatched', {
          endpoint: env.replit.url,
          auth: 'bearer',
          timeoutMs: env.replit.timeoutMs,
          brandVoiceChars: brandVoice.length,
          revision: Boolean(revisionNote)
        });
        const result = await generation.generate({
          topic: run.topic,
          keywords: run.keywords,
          tone: run.tone,
          brandVoice,
          revisionNote
        });
        await saga.onGenerationComplete(runId, result);
      },
      { blocking: true }
    )
  );

  // ---- wordpress-publisher ----
  workers.push(
    mkWorker(
      QUEUE.wordpress,
      async (job) => {
        const { runId } = job.data as { runId: string };
        const d = await saga.draft(runId);
        const res = await wordpress.publishPost({
          title: d.blog_title,
          markdown: d.blog_text,
          metaDescription: d.blog_meta_description,
          leadMagnetUrl: d.lead_magnet_url ?? ''
        });
        await saga.onDeployComplete(runId, res.liveUrl, res.cmsPostId);
      },
      { blocking: true }
    )
  );

  // ---- meta-ads (limiter: 10 req / 10 s) ----
  workers.push(
    mkWorker(
      QUEUE.metaAds,
      async (job) => {
        const { runId, slug } = job.data as { runId: string; slug: string };
        const d = await saga.draft(runId);
        const p = d.meta_ads_payload ?? {};
        const res = await metaAds.createLeadGenCampaign({
          headline: p.headline ?? '',
          primaryText: p.primaryText ?? '',
          destinationUrl: p.link || env.activeCampaign.signupFormUrl,
          campaignSlug: slug
        });
        await saga.onChannelComplete(runId, 'meta_ads', { ...res });
      },
      { blocking: true }
    )
  );

  // ---- activecampaign (limiter: 5 req / s) ----
  workers.push(
    mkWorker(
      QUEUE.activeCampaign,
      async (job) => {
        const { runId, slug } = job.data as { runId: string; slug: string };
        const d = await saga.draft(runId);
        const p = d.ac_email_payload ?? {};
        const res = await activeCampaign.createAndSendCampaign({
          subject: p.subject ?? '',
          body: p.body ?? '',
          campaignSlug: slug
        });
        await saga.onChannelComplete(runId, 'activecampaign', { ...res });
      },
      { blocking: true }
    )
  );

  // ---- social-publish (NON-BLOCKING failures; never throws) ----
  workers.push(
    mkWorker(
      QUEUE.social,
      async (job) => {
        const { runId, slug } = job.data as { runId: string; slug: string };
        const d = await saga.draft(runId);
        const p = d.social_payload ?? {};
        const captions: Record<string, string> = {
          linkedin: p.linkedin ?? '',
          facebook: p.facebook ?? '',
          instagram: p.instagram ?? ''
        };
        const results = await Promise.all(
          socialPublishers.map((pub) =>
            pub.publish({
              caption: captions[pub.platform],
              linkUrl: pub.platform === 'instagram' ? null : d.live_url, // IG: no links, "link in bio"
              campaignSlug: slug
            })
          )
        );
        await saga.onSocialPartial(runId, results);
      },
      { blocking: false }
    )
  );

  // ---- karbon-callback (Timeline API only — rule 2) ----
  workers.push(
    mkWorker(
      QUEUE.karbonCallback,
      async (job) => {
        const { runId, kind, step } = job.data as { runId: string; kind: 'success' | 'failure'; step?: string };
        const run = await saga.runRow(runId);

        if (kind === 'success') {
          const d = await saga.draft(runId);
          const slug = campaignSlug(run.topic);
          const artifacts = await lastArtifacts(runId);
          await postCompletionNote(run.karbon_work_id, run.topic, {
            liveUrl: d.live_url,
            leadMagnetUrl: d.lead_magnet_url ? appendUtm(d.lead_magnet_url, 'activecampaign', slug) : null,
            adCampaignId: artifacts.adCampaignId,
            emailCampaignId: artifacts.emailCampaignId,
            social: artifacts.social
          }, artifacts.partialNotes);
        } else {
          const failure = (await saga.runRow(runId)) as unknown as { error?: { message?: string; httpStatus?: number; responseBody?: string; attempts?: number } };
          await postFailureNote(run.karbon_work_id, run.topic, {
            step: step ?? 'unknown',
            message: failure.error?.message ?? 'Retries exhausted',
            httpStatus: failure.error?.httpStatus,
            responseBody: failure.error?.responseBody,
            attempts: failure.error?.attempts ?? env.workflow.maxJobAttempts
          });
        }
        await saga.onCallbackComplete(runId, kind);
      },
      { blocking: false } // never terminal-fail a run because the notification failed
    )
  );

  console.info(`[workers] ${workers.length} workers online (concurrency ${CONCURRENCY})`);
  return workers;
}

async function settingString(key: string): Promise<string> {
  const { rows } = await query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows.length ? String(rows[0].value) : '';
}

/** Pull channel artifacts + social partial-failure notes from the audit trail. */
async function lastArtifacts(runId: string): Promise<{
  adCampaignId: string | null;
  emailCampaignId: string | null;
  social: { linkedin?: string; facebook?: string; instagram?: string };
  partialNotes: string[];
}> {
  const { rows } = await query<{ action: string; payload: Record<string, unknown> }>(
    `SELECT action, payload FROM audit_trails
      WHERE workflow_run_id = $1 AND action LIKE 'publish.%.completed'
      ORDER BY created_at DESC`,
    [runId]
  );
  const out = {
    adCampaignId: null as string | null,
    emailCampaignId: null as string | null,
    social: {} as { linkedin?: string; facebook?: string; instagram?: string },
    partialNotes: [] as string[]
  };
  for (const r of rows) {
    if (r.action === 'publish.meta_ads.completed') out.adCampaignId = String(r.payload.campaignId ?? '');
    if (r.action === 'publish.activecampaign.completed') out.emailCampaignId = String(r.payload.campaignId ?? '');
    if (r.action === 'publish.social.completed') {
      const results = (r.payload.results ?? []) as Array<{ platform: string; ok: boolean; postId?: string; error?: string }>;
      for (const s of results) {
        if (s.ok) out.social[s.platform as 'linkedin' | 'facebook' | 'instagram'] = s.postId ?? 'posted';
        else out.partialNotes.push(`${s.platform} failed (non-blocking): ${s.error ?? 'unknown error'}`);
      }
    }
  }
  return out;
}
