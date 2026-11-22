import { Worker, type Processor } from 'bullmq';
import { EventEmitter } from 'node:events';
import { createQueueConnection, type QueueName } from './queues.js';

export type Processors = Partial<Record<QueueName, Processor>>;

export interface WorkerHooks {
  /** Notified when any worker emits 'exit' (e.g. a crashed sibling). */
  onWorkerExit?: (worker: Worker, code: number | null) => void;
}

export interface RunningWorkers {
  workers: Worker[];
  /** Last non-zero exit code emitted by a worker via 'exit'; null otherwise. */
  siblingExitCode: number | null;
  shutdown: () => Promise<void>;
}

/**
 * Boots one BullMQ worker per registered processor. F1 ships the harness
 * only; processors register in later phases (email F3, embedding F2,
 * export F9, expiry-events F5).
 */
export async function bootWorkers(
  redisUrl: string,
  processors: Processors,
  hooks: WorkerHooks = {},
): Promise<RunningWorkers> {
  const connection = createQueueConnection(redisUrl);
  const workers = Object.entries(processors).map(
    ([name, processor]) =>
      new Worker(name, processor as Processor, {
        connection,
        concurrency: 5,
      }),
  );

  const siblingExitCode: { value: number | null } = { value: null };
  for (const worker of workers) {
    // BullMQ types Worker.on() with its own event map that has no 'exit';
    // this is the sibling-death observation point (mocked in unit tests).
    (worker as unknown as EventEmitter).on('exit', (code: number | null) => {
      if (siblingExitCode.value === null && code !== null && code !== 0) siblingExitCode.value = code;
      hooks.onWorkerExit?.(worker, code);
    });
  }

  return {
    workers,
    get siblingExitCode() {
      return siblingExitCode.value;
    },
    shutdown: async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
