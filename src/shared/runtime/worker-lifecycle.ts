import type { Processor, Worker } from 'bullmq';
import { bootWorkers, type Processors } from '../../../workers/src/index.js';
import type { QueueName } from '../../../workers/src/queues.js';

/** Processor + optional cleanup (DB pool, ioredis connection) for one worker. */
export interface WorkerRuntime {
  readonly processor: Processor;
  /** Closes worker-owned resources; runs at shutdown. */
  readonly shutdown?: () => Promise<void>;
}

export interface WorkerFactory extends WorkerRuntime {
  /** Queue the workers process jobs on. */
  readonly name: QueueName;
}

export type SiblingExitCallback = (info: { worker: Worker; code: number | null }) => void;

export interface SupervisedRuntime {
  readonly workers: Worker[];
  /**
   * Non-zero exit code of a sibling worker ('exit' event). The parent process
   * exits with this code when it shuts down — non-zero wins over 0.
   */
  readonly siblingExitCode: number | null;
  /** Registers a callback notified when a sibling worker exits. */
  readonly onSiblingExit: (cb: SiblingExitCallback) => void;
  /** Closes workers + runs factory cleanups. Idempotent. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Boots BullMQ workers in the API process ("shared mode": one service runs the
 * API and the workers). A non-zero sibling exit closes the other workers and
 * is visible via `siblingExitCode` so the parent can exit with that code.
 */
export async function bootWorkersInProcess(
  redisUrl: string,
  factories: WorkerFactory[],
): Promise<SupervisedRuntime> {
  const processors: Processors = {};
  for (const factory of factories) processors[factory.name] = factory.processor;

  const callbacks = new Set<SiblingExitCallback>();
  const running = await bootWorkers(redisUrl, processors, {
    // ponytail: BullMQ Workers are processes — their typed event map has no
    // 'exit' today (5.81.3), so sibling-death detection rides on this hook
    // and is exercised via the mocked Worker in unit tests; shutdown stays
    // the production-safe path for now.
    onWorkerExit: (worker, code) => {
      for (const w of running.workers) {
        if (w !== worker) void w.close().catch(() => undefined);
      }
      for (const cb of callbacks) cb({ worker, code });
    },
  });

  let closed = false;
  return {
    workers: running.workers,
    get siblingExitCode() {
      return running.siblingExitCode;
    },
    onSiblingExit: (cb) => {
      callbacks.add(cb);
    },
    shutdown: async () => {
      if (closed) return;
      closed = true;
      callbacks.clear();
      await running.shutdown();
      await Promise.allSettled(factories.map((f) => f.shutdown?.()));
    },
  };
}
