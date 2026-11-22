import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootWorkers } from './index.js';

interface MockWorkerInstance {
  readonly name: string;
  readonly close: ReturnType<typeof vi.fn>;
  readonly emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

const { instances } = vi.hoisted(() => ({ instances: [] as MockWorkerInstance[] }));

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}));

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  class MockWorker extends EventEmitter {
    readonly close = vi.fn().mockResolvedValue(undefined);
    constructor(public readonly name: string) {
      super();
      instances.push(this as unknown as MockWorkerInstance);
    }
  }
  return { Worker: MockWorker, Queue: vi.fn(), QueueEvents: vi.fn() };
});

describe('bootWorkers', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('starts one worker per processor, notifies sibling exits, closes on shutdown', async () => {
    const onWorkerExit = vi.fn();
    const running = await bootWorkers('redis://test', { email: vi.fn(), export: vi.fn() }, { onWorkerExit });
    expect(instances.map((w) => w.name)).toEqual(['email', 'export']);
    instances[0]?.emit('exit', 2);
    expect(onWorkerExit).toHaveBeenCalledWith(instances[0], 2);
    expect(running.siblingExitCode).toBe(2);
    instances[0]?.emit('exit', 3); // later non-zero must not replace the first non-zero
    expect(running.siblingExitCode).toBe(2);
    await running.shutdown();
    expect(instances[0]?.close).toHaveBeenCalled();
    expect(instances[1]?.close).toHaveBeenCalled();
  });
});
