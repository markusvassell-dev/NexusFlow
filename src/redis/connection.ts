import Redis, { RedisOptions } from 'ioredis';
import { env } from '../config/env';

// BullMQ v5 requires maxRetriesPerRequest: null on blocking connections.
// We keep one shared client for app-level commands (idempotency SETNX, session
// lookups, publish counters) and hand BullMQ its own options object so each
// Queue/Worker manages its own blocking connection internally.
const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (times: number) => Math.min(times * 200, 5_000), // backoff cap 5s
  reconnectOnError: (err: Error) => err.message.includes('READONLY') // failover support
};

/** Shared app client (non-blocking commands only — never BLPOP/BRPOP on this). */
export const redis = new Redis(env.redisUrl, baseOptions);

redis.on('error', (err) => console.error('[redis] error', err.message));
redis.on('reconnecting', () => console.warn('[redis] reconnecting…'));

/** Fresh connection factory (BullMQ QueueEvents, subscribers, etc.). */
export function newRedisConnection(): Redis {
  return new Redis(env.redisUrl, baseOptions);
}

/** Options object for BullMQ Queue/Worker constructors. */
export const bullConnection = { url: env.redisUrl, ...baseOptions } as const;

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
