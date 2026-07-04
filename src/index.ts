import { buildServer } from './server';
import { startWorkers } from './workers';
import { env } from './config/env';
import { pool } from './db/pool';
import { closeRedis } from './redis/connection';
import { closeQueues } from './queues/queues';

// Single-service topology: HTTP API + BullMQ workers in one process. This is
// the simplest Railway deployment; to scale, run `node dist/index.js --worker`
// as a second Railway service and `--web` as the first.

const mode = process.argv.includes('--worker') ? 'worker' : process.argv.includes('--web') ? 'web' : 'all';

async function main(): Promise<void> {
  const workers = mode !== 'web' ? startWorkers() : [];

  if (mode !== 'worker') {
    const app = buildServer();
    // RAILWAY CRITICAL (rule 4): bind 0.0.0.0 and use process.env.PORT.
    // Railway assigns the port dynamically; hardcoding localhost:3000 makes
    // the health check unreachable and the deploy gets killed.
    app.listen(env.port, env.host, () => {
      console.info(`[server] listening on http://${env.host}:${env.port} (${env.nodeEnv})`);
    });
  }

  const shutdown = async (signal: string) => {
    console.info(`[shutdown] ${signal} — draining…`);
    await Promise.allSettled([
      ...workers.map((w) => w.close()),
      closeQueues(),
      closeRedis(),
      pool.end()
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM')); // Railway sends SIGTERM on redeploy
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
