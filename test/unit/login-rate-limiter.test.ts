import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { LoginRateLimiter } from '../../src/modules/identity/login-rate-limiter.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    incr: vi.fn(async (k: string) => {
      const next = (Number(store.get(k)) || 0) + 1;
      store.set(k, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    __store: store,
  };
}

describe('LoginRateLimiter', () => {
  it('allows up to MAX_LOGIN_FAILURES failures then blocks with 429', async () => {
    const limiter = new LoginRateLimiter(fakeRedis() as never);

    for (let i = 0; i < 5; i++) {
      await limiter.assertAllowed('a@ui.ac.id', '1.1.1.1');
      await limiter.recordFailure('a@ui.ac.id', '1.1.1.1');
    }
    await expect(limiter.assertAllowed('a@ui.ac.id', '1.1.1.1')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('keys per email+IP — other clients unaffected', async () => {
    const redis = fakeRedis();
    const limiter = new LoginRateLimiter(redis as never);
    for (let i = 0; i < 5; i++) await limiter.recordFailure('a@ui.ac.id', '1.1.1.1');

    await expect(limiter.assertAllowed('b@ui.ac.id', '1.1.1.1')).resolves.toBeUndefined();
    await expect(limiter.assertAllowed('a@ui.ac.id', '2.2.2.2')).resolves.toBeUndefined();
  });

  it('sets a 15-minute window on the first failure and clears on success', async () => {
    const redis = fakeRedis();
    const limiter = new LoginRateLimiter(redis as never);

    await limiter.recordFailure('a@ui.ac.id', '1.1.1.1');
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('rl:login:a@ui.ac.id'), 900);

    await limiter.reset('a@ui.ac.id', '1.1.1.1');
    expect(redis.del).toHaveBeenCalled();
  });

  it('blocked error is HttpException with 429 status', async () => {
    const redis = fakeRedis();
    const limiter = new LoginRateLimiter(redis as never);
    for (let i = 0; i < 5; i++) await limiter.recordFailure('x@ui.ac.id', '::ffff:127.0.0.1');

    const err = await limiter.assertAllowed('x@ui.ac.id', '::ffff:127.0.0.1').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });
});
