import { NextFunction, Request, Response } from 'express';
import { redis } from '../redis/connection';

// Redis-backed idempotency for the Karbon webhook (CLAUDE.md rule 1).
// Key = work item ID + stage ID. One workflow per stage change: a duplicate
// delivery (Karbon retries, network replays, double-fires) must NOT re-trigger
// generation. SET NX EX is the atomic lock; the unique constraint on
// workflow_runs(karbon_work_id, karbon_stage_id) is the durable backstop.

const TTL_SECONDS = 24 * 60 * 60; // 24h — outlives Karbon's retry window

export interface KarbonTriggerPayload {
  workItemId: string;
  stageId: string;
  clientName?: string;
  topic: string;
  keywords?: string[];
  tone?: string;
}

export async function karbonIdempotency(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const payload = (req as Request & { karbonPayload: KarbonTriggerPayload }).karbonPayload;

  if (!payload?.workItemId || !payload?.stageId) {
    res.status(422).json({ error: 'missing_work_item_or_stage' });
    return;
  }

  const key = `idem:${payload.workItemId}:${payload.stageId}`;
  // Atomic: returns 'OK' only for the first delivery.
  const acquired = await redis.set(key, String(Date.now()), 'EX', TTL_SECONDS, 'NX');

  if (acquired !== 'OK') {
    // Graceful drop: 200 (not 4xx/5xx) so Karbon does not keep retrying.
    res.status(200).json({ ok: true, duplicate: true, idempotencyKey: key });
    return;
  }

  (req as Request & { idempotencyKey: string }).idempotencyKey = key;
  next();
}

/** Release the lock if run creation fails downstream, so a legitimate retry can succeed. */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  await redis.del(key);
}
