import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import 'dotenv/config';

// Applies db/schema.sql (idempotent DDL). Usage: npm run db:migrate

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.info('[migrate] schema applied');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
