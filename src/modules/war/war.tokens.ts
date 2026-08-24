import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const EXPIRY_EVENTS_QUEUE = 'expiry_events';

/** Time-driven engine jobs (auto-war at opens_at; future lock sweeps). */
export function createExpiryQueue(redisUrl: string): Queue {
  return new Queue(EXPIRY_EVENTS_QUEUE, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  });
}
