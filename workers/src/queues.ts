import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const QUEUE_NAMES = ['email', 'embedding', 'export', 'expiry_events'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** BullMQ connections must allow blocking commands. */
export function createQueueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createQueues(redisUrl: string): Record<QueueName, Queue> {
  const make = (name: QueueName): Queue => new Queue(name, { connection: createQueueConnection(redisUrl) });
  return {
    email: make('email'),
    embedding: make('embedding'),
    export: make('export'),
    expiry_events: make('expiry_events'),
  };
}
