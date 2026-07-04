import { Router, Request, Response, raw } from 'express';
import { verifyKarbonSignature } from '../middleware/karbonHmac';
import { karbonIdempotency, releaseIdempotencyKey, KarbonTriggerPayload } from '../middleware/idempotency';
import { createRunFromTrigger, ConflictError } from '../saga/orchestrator';

export const webhookRouter = Router();

// POST /api/webhooks/karbon
// Order matters: raw body capture → HMAC verify (rule 1) → idempotency SETNX
// (rule 1) → create run + enqueue. Duplicate deliveries exit at the idempotency
// step with 200 so Karbon stops retrying.
webhookRouter.post(
  '/karbon',
  raw({ type: '*/*', limit: '256kb' }), // req.body stays a Buffer for signature verification
  verifyKarbonSignature,
  karbonIdempotency,
  async (req: Request, res: Response) => {
    const payload = (req as Request & { karbonPayload: KarbonTriggerPayload }).karbonPayload;
    const idemKey = (req as Request & { idempotencyKey: string }).idempotencyKey;

    try {
      const { runId } = await createRunFromTrigger({
        workItemId: payload.workItemId,
        stageId: payload.stageId,
        clientName: payload.clientName ?? '',
        topic: payload.topic,
        keywords: payload.keywords ?? [],
        tone: payload.tone ?? 'Authoritative, plainspoken'
      });
      res.status(202).json({ ok: true, runId });
    } catch (err) {
      if (err instanceof ConflictError) {
        // DB unique constraint caught a duplicate the Redis key missed
        // (e.g. Redis flushed) — still a graceful 200.
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      // Run creation failed for a real reason: release the idempotency lock so
      // Karbon's retry can succeed once the underlying issue is fixed.
      await releaseIdempotencyKey(idemKey);
      console.error('[webhook:karbon]', err);
      res.status(500).json({ error: 'trigger_failed' });
    }
  }
);
