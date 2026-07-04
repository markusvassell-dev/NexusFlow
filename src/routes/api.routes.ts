import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  approveDraft,
  requestRevision,
  saveOverrides,
  publishAll,
  ConflictError,
  draft
} from '../saga/orchestrator';

// Dashboard API. Everything behind requireAuth (rule 10); approve/publish
// additionally behind requireRole('admin','reviewer') — editors can edit
// payloads but never push content live. ConflictError → HTTP 409 so the UI
// shows a "already handled by another user" notice instead of overwriting.

export const apiRouter = Router();
apiRouter.use(requireAuth);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((err) => {
      if (err instanceof ConflictError) {
        res.status(409).json({ error: 'conflict', message: err.message });
        return;
      }
      next(err);
    });

// ---- Runs & monitoring ----
apiRouter.get(
  '/runs',
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT id, karbon_work_id, karbon_stage_id, client_name, topic, status, current_step,
              seo_score, revision_count, error, created_at, updated_at, completed_at
         FROM workflow_runs ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ runs: rows });
  })
);

apiRouter.get(
  '/runs/:id',
  wrap(async (req, res) => {
    const runId = req.params.id;
    const run = await query('SELECT * FROM workflow_runs WHERE id = $1', [runId]);
    if (!run.rows[0]) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const d = await query('SELECT * FROM content_drafts WHERE workflow_run_id = $1 ORDER BY created_at DESC LIMIT 1', [runId]);
    res.json({ run: run.rows[0], draft: d.rows[0] ?? null });
  })
);

// Audit trail (drives the dashboard's BullMQ job-log modal: attempts,
// timestamps, verbatim HTTP error bodies from job.failed events).
apiRouter.get(
  '/runs/:id/audit',
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.actor, a.action, a.payload, a.created_at,
              u.first_name, u.last_name, u.role
         FROM audit_trails a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.workflow_run_id = $1 ORDER BY a.created_at ASC`,
      [req.params.id]
    );
    res.json({ audit: rows });
  })
);

// ---- Review queue ----
apiRouter.get(
  '/review-queue',
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT r.id, r.topic, r.client_name, r.status, r.seo_score, r.seo_report, r.updated_at,
              d.blog_title, d.blog_meta_description, d.blog_text, d.lead_magnet_url, d.live_url,
              d.meta_ads_payload, d.ac_email_payload, d.social_payload, d.overrides
         FROM workflow_runs r
         JOIN content_drafts d ON d.workflow_run_id = r.id
        WHERE r.status IN ('seo_review', 'dist_review')
        ORDER BY r.updated_at ASC`
    );
    res.json({ items: rows });
  })
);

// Gate 1 — content approval (admin/reviewer only).
apiRouter.post(
  '/runs/:id/approve',
  requireRole('admin', 'reviewer'),
  wrap(async (req, res) => {
    await approveDraft(req.params.id, req.user!.id, req.user!.handle);
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/runs/:id/request-revision',
  requireRole('admin', 'reviewer'),
  wrap(async (req, res) => {
    const note = String((req.body as { note?: string })?.note ?? '').slice(0, 2000);
    await requestRevision(req.params.id, note, req.user!.id, req.user!.handle);
    res.json({ ok: true });
  })
);

// Draft edits (any role — attribution logged).
apiRouter.patch(
  '/runs/:id/draft',
  wrap(async (req, res) => {
    const { blogTitle, metaDescription } = req.body as { blogTitle?: string; metaDescription?: string };
    const { rowCount } = await query(
      `UPDATE content_drafts d SET blog_title = COALESCE($1, d.blog_title),
              blog_meta_description = COALESCE($2, d.blog_meta_description), updated_at = now()
         FROM workflow_runs r
        WHERE d.workflow_run_id = $3 AND r.id = $3 AND r.status = 'seo_review'`,
      [blogTitle ?? null, metaDescription ?? null, req.params.id]
    );
    if (!rowCount) {
      res.status(409).json({ error: 'conflict', message: 'Draft is no longer editable — already approved?' });
      return;
    }
    res.json({ ok: true });
  })
);

// Gate 2 — freeze manual overrides, then Approve & Publish All.
apiRouter.patch(
  '/runs/:id/distribution/:channel',
  wrap(async (req, res) => {
    const channel = req.params.channel as 'meta_ads' | 'ac_email' | 'social';
    if (!['meta_ads', 'ac_email', 'social'].includes(channel)) {
      res.status(422).json({ error: 'unknown_channel' });
      return;
    }
    await saveOverrides(req.params.id, channel, req.body as Record<string, unknown>, req.user!.id, req.user!.handle);
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/runs/:id/publish-all',
  requireRole('admin', 'reviewer'),
  wrap(async (req, res) => {
    await publishAll(req.params.id, req.user!.id, req.user!.handle);
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/runs/:id/draft/preview',
  wrap(async (req, res) => {
    const d = await draft(req.params.id);
    res.json({ leadMagnetUrl: d.lead_magnet_url, blogText: d.blog_text });
  })
);

// ---- Settings (admin writes; all roles read) ----
apiRouter.get(
  '/settings',
  wrap(async (req, res) => {
    const { rows } = await query('SELECT key, value, updated_at FROM app_settings');
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  })
);

apiRouter.put(
  '/settings/:key',
  requireRole('admin'),
  wrap(async (req, res) => {
    const allowed = ['seo_auto_approve_threshold', 'auto_approve_enabled', 'adapters_enabled', 'brand_voice'];
    if (!allowed.includes(req.params.key)) {
      res.status(422).json({ error: 'unknown_setting' });
      return;
    }
    await query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.params.key, JSON.stringify((req.body as { value: unknown }).value), req.user!.id]
    );
    res.json({ ok: true });
  })
);
