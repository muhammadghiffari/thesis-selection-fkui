import { Worker, type Processor } from 'bullmq';
import { createQueueConnection, type QueueName } from './queues.js';

export type Processors = Partial<Record<QueueName, Processor>>;

export interface RunningWorkers {
  workers: Worker[];
  shutdown: () => Promise<void>;
}

/**
 * Boots one BullMQ worker per registered processor. F1 ships the harness
 * only; processors register in later phases (email F3, embedding F2,
 * export F9, expiry-events F5).
 */
export async function bootWorkers(redisUrl: string, processors: Processors): Promise<RunningWorkers> {
  const connection = createQueueConnection(redisUrl);
  const workers = Object.entries(processors).map(
    ([name, processor]) =>
      new Worker(name, processor as Processor, {
        connection,
        concurrency: 5,
      }),
  );

  return {
    workers,
    shutdown: async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
