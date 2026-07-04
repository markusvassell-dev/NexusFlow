import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { redis } from '../redis/connection';

// Session/JWT middleware guarding all dashboard API routes (CLAUDE.md rule 10).
// JWT (httpOnly cookie or Bearer header) carries { sub, jti, role, handle }.
// The jti must still exist in Redis (sess:{jti}) — logout/revocation kills it
// there instantly without waiting for token expiry.

export interface AuthedUser {
  id: string;
  role: 'admin' | 'reviewer' | 'editor';
  handle: string; // e.g. 'j.mercer' — stamped onto audit_trails + BullMQ job data
  email: string;
}

export interface JwtClaims {
  sub: string;
  jti: string;
  role: AuthedUser['role'];
  handle: string;
  email: string;
  exp: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
    sessionJti?: string;
  }
}

export const SESSION_COOKIE = 'nf_session';
export const sessionKey = (jti: string) => `sess:${jti}`;

function extractToken(req: Request): string | null {
  const bearer = req.header('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  return cookie ?? null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  let claims: JwtClaims;
  try {
    claims = jwt.verify(token, env.jwtSecret) as JwtClaims;
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  // Revocation check — session must still be live in Redis.
  const live = await redis.exists(sessionKey(claims.jti));
  if (!live) {
    res.status(401).json({ error: 'session_revoked' });
    return;
  }
  req.user = { id: claims.sub, role: claims.role, handle: claims.handle, email: claims.email };
  req.sessionJti = claims.jti;
  next();
}

/** Role gate. Editors can edit payloads but never approve/publish. */
export function requireRole(...roles: Array<AuthedUser['role']>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: 'forbidden',
        message: `Role '${req.user.role}' cannot perform this action — requires: ${roles.join(', ')}`
      });
      return;
    }
    next();
  };
}
