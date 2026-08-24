import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const EMAIL_QUEUE = 'email';

/** BullMQ-safe connection + stage queue factory (API side; workers have their own). */
export function createEmailQueue(redisUrl: string): Queue {
  return new Queue(EMAIL_QUEUE, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  });
}
