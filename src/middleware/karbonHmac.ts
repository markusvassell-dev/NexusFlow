import { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

// Strict HMAC-SHA256 verification of the Karbon webhook payload (CLAUDE.md rule 1).
// This is signature verification on the RAW request body — not a shared-secret
// token compare. Mount the webhook route with express.raw() so req.body is the
// untouched Buffer; any JSON re-serialization would break the signature.
//
// Expected header:  X-Karbon-Signature: sha256=<hex digest>
// Digest:           HMAC_SHA256(KARBON_WEBHOOK_SECRET, rawBody)

export function verifyKarbonSignature(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('x-karbon-signature') ?? '';
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;

  if (!provided) {
    res.status(401).json({ error: 'missing_signature' });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    // Misconfiguration guard: the route MUST use express.raw().
    res.status(500).json({ error: 'raw_body_unavailable' });
    return;
  }

  const expected = createHmac('sha256', env.karbon.webhookSecret)
    .update(req.body)
    .digest('hex');

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');

  // timingSafeEqual throws on length mismatch — treat as invalid, constant-time otherwise.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  try {
    (req as Request & { karbonPayload: unknown }).karbonPayload = JSON.parse(
      req.body.toString('utf8')
    );
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  next();
}
