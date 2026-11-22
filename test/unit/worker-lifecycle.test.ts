import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootWorkersInProcess, type WorkerFactory } from '../../src/shared/runtime/worker-lifecycle.js';

interface MockWorkerInstance {
  readonly name: string;
  readonly processor: unknown;
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
    constructor(
      public readonly name: string,
      public readonly processor: unknown,
    ) {
      super();
      instances.push(this as unknown as MockWorkerInstance);
    }
  }
  return { Worker: MockWorker, Queue: vi.fn(), QueueEvents: vi.fn() };
});

describe('bootWorkersInProcess', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('starts all registered workers in the shared process', async () => {
    const emailProc = vi.fn();
    const exportProc = vi.fn();
    const runtime = await bootWorkersInProcess('redis://test', [
      { name: 'email', processor: emailProc },
      { name: 'export', processor: exportProc },
    ]);
    expect(runtime.workers).toHaveLength(2);
    expect(instances.map((w) => w.name)).toEqual(['email', 'export']);
    expect(instances[0]?.processor).toBe(emailProc);
    expect(instances[1]?.processor).toBe(exportProc);
    expect(runtime.siblingExitCode).toBeNull();
    await runtime.shutdown();
  });

  it('closes workers and notifies on sibling exit', async () => {
    const runtime = await bootWorkersInProcess('redis://test', [
      { name: 'email', processor: vi.fn() },
      { name: 'export', processor: vi.fn() },
    ]);
    const exitCb = vi.fn();
    runtime.onSiblingExit(exitCb);
    instances[0]?.emit('exit', 1);
    expect(instances[1]?.close).toHaveBeenCalled();
    expect(exitCb).toHaveBeenCalledTimes(1);
    expect(exitCb).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }));
    expect(runtime.siblingExitCode).toBe(1);
    await runtime.shutdown();
  });

  it('first non-zero exit code wins and later codes are ignored', async () => {
    const runtime = await bootWorkersInProcess('redis://test', [
      { name: 'email', processor: vi.fn() },
      { name: 'export', processor: vi.fn() },
    ]);
    expect(runtime.siblingExitCode).toBeNull();
    instances[0]?.emit('exit', 1);
    expect(runtime.siblingExitCode).toBe(1);
    instances[0]?.emit('exit', 0); // zero must not erase the non-zero code
    expect(runtime.siblingExitCode).toBe(1);
    instances[1]?.emit('exit', 2); // later non-zero must not replace the first non-zero
    expect(runtime.siblingExitCode).toBe(1);
    await runtime.shutdown();
  });

  it('continues factory shutdowns when one fails', async () => {
    const firstShutdown = vi.fn(async () => { throw new Error('boom'); });
    const secondShutdown = vi.fn(async () => undefined);
    const runtime = await bootWorkersInProcess('redis://test', [
      { name: 'email', processor: vi.fn(), shutdown: firstShutdown },
      { name: 'export', processor: vi.fn(), shutdown: secondShutdown },
    ] satisfies WorkerFactory[]);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(secondShutdown).toHaveBeenCalledTimes(1);
  });

  it('runs factory shutdowns on shutdown', async () => {
    const shutdownSpy = vi.fn(async () => undefined);
    const runtime = await bootWorkersInProcess('redis://test', [
      { name: 'email', processor: vi.fn(), shutdown: shutdownSpy },
    ] satisfies WorkerFactory[]);
    await runtime.shutdown();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });
});
