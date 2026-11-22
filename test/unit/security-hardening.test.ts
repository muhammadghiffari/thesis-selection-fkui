import { describe, expect, it, vi } from 'vitest';
import { sanitizeString, sanitizeValue } from '../../src/shared/validation/sanitize.js';
import { botGuard } from '../../src/shared/security/bot-guard.js';
import { ThrottlerGuard } from '../../src/shared/throttle/throttler.guard.js';
import type { ExecutionContext } from '@nestjs/common';

describe('sanitize', () => {
  it('strips HTML tags + control chars and trims', () => {
    expect(sanitizeString('  <script>alert(1)</script>hello\u0000  ')).toBe('alert(1)hello');
    expect(sanitizeString('<b>bold</b>')).toBe('bold');
  });

  it('recurses into objects and arrays', () => {
    const out = sanitizeValue({ a: '<p>x</p>', b: ['<i>y</i>', 1], c: { d: ' ok ' } });
    expect(out).toEqual({ a: 'x', b: ['y', 1], c: { d: 'ok' } });
  });

  it('leaves non-strings untouched (numbers, booleans, null)', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
  });
});

describe('botGuard', () => {
  function run(ua: string | undefined, url: string) {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      status: vi.fn(() => ({ json: () => undefined })),
      json: vi.fn(),
    } as never;
    const req = { url, headers: ua === undefined ? {} : { 'user-agent': ua } } as never;
    const next = vi.fn();
    botGuard(req, res, next);
    return { res, next, headers };
  }

  it('blocks known AI crawler UAs on /api/* with 403', () => {
    const { res, next } = run('GPTBot/1.0', '/api/admin/students');
    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks ClaudeBot, CCBot, and generic search crawlers', () => {
    for (const ua of ['ClaudeBot', 'CCBot', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Bytespider']) {
      const { res, next } = run(ua, '/api/health');
      // health is exempt so LB probes keep working
      expect(next).toHaveBeenCalled();
      expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalledWith(403);
    }
    for (const ua of ['ClaudeBot', 'CCBot']) {
      const { res, next } = run(ua, '/api/auth/login');
      expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('lets browsers through and marks API responses noindex', () => {
    const { res, next, headers } = run('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', '/api/auth/me');
    expect(next).toHaveBeenCalled();
    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalled();
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
  });
});

describe('ThrottlerGuard', () => {
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
      ttl: vi.fn(async () => 42),
      __store: store,
    };
  }

  function ctxFor(_opts: unknown, ip = '1.2.3.4', sub?: string): ExecutionContext {
    const req = { ip, user: sub ? { sub } : undefined };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  it('429s over a per-route limit and exposes retryAfter', async () => {
    const redis = fakeRedis();
    const guard = new ThrottlerGuard({ getAllAndOverride: () => ({ limit: 2, ttlSec: 60, keyBy: 'ip' }) } as never, redis as never);
    const ctx = ctxFor({ limit: 2, ttlSec: 60, keyBy: 'ip' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const err = await guard.canActivate(ctx).catch((e) => e);
    expect(err.getStatus()).toBe(429);
  });

  it('falls back to the generous default when no metadata is present', async () => {
    const redis = fakeRedis();
    const guard = new ThrottlerGuard({ getAllAndOverride: () => undefined } as never, redis as never);
    const ctx = ctxFor(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('keys per-user when keyBy=user (NAT-safe)', async () => {
    const redis = fakeRedis();
    const guard = new ThrottlerGuard({ getAllAndOverride: () => ({ limit: 1, ttlSec: 60, keyBy: 'user' }) } as never, redis as never);
    const ctxA = ctxFor(undefined, 'same-ip', 'user-a');
    const ctxB = ctxFor(undefined, 'same-ip', 'user-b');
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    await expect(guard.canActivate(ctxB)).resolves.toBe(true);
  });
});
