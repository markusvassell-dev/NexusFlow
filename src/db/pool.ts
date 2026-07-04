import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';

// Single shared pool. Railway Postgres accepts up to ~20 connections on starter
// plans; keep max conservative because the worker process holds its own pool.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  // A broken idle client should not crash the process; pg replaces it lazily.
  console.error('[pg] idle client error', err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Append an audit row. actor is 'system' | 'api' | a user handle; userId optional. */
export async function audit(
  runId: string | null,
  actor: string,
  action: string,
  payload: Record<string, unknown> = {},
  userId: string | null = null
): Promise<void> {
  await query(
    `INSERT INTO audit_trails (workflow_run_id, user_id, actor, action, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, userId, actor, action, JSON.stringify(payload)]
  );
}
