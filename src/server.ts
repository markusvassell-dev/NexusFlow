import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { apiRouter } from './routes/api.routes';
import { webhookRouter } from './routes/webhook.routes';
import { pool } from './db/pool';
import { redis } from './redis/connection';

export function buildServer(): express.Express {
  const app = express();
  app.set('trust proxy', 1); // Railway sits behind a proxy

  // Webhooks FIRST — they need the raw body, so they mount before express.json().
  app.use('/api/webhooks', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Railway health check target. Fails loudly if Postgres/Redis are unreachable.
  app.get('/healthz', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api', apiRouter);

  // Serve the built React dashboard (single-service topology).
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => err && next());
  });

  // Central error handler — never leak stack traces to clients.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http]', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
