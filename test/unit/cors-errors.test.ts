import type { ArgumentsHost } from '@nestjs/common';
import {
  ForbiddenException,
  GoneException,
  HttpException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import cors from 'cors';
import { describe, expect, it, vi } from 'vitest';
import { corsOptions, isOriginAllowed } from '../../src/shared/security/cors.js';
import { AllExceptionsFilter } from '../../src/shared/filters/all-exceptions.filter.js';

/**
 * Task 4: CORS must fail CLOSED and every error must keep the requestId
 * envelope. These are pure/unit tests — they boot no Nest app and need no
 * Docker, so they double as the runnable proof of the bootstrap CORS fix.
 */

const ALLOW = ['https://demo.example.onrender.com', 'http://localhost:5173'];

describe('CORS allowlist — pure decision (OWASP A05)', () => {
  it('allows requests with no Origin (same-origin / server-to-server / curl)', () => {
    expect(isOriginAllowed(undefined, ALLOW)).toBe(true);
  });

  it('allows only exact allowlist matches', () => {
    for (const origin of ALLOW) expect(isOriginAllowed(origin, ALLOW)).toBe(true);
    expect(isOriginAllowed('https://evil.example', ALLOW)).toBe(false);
  });

  it('never falls back to a wildcard, even for near-misses', () => {
    for (const origin of [
      '*',
      'https://demo.example.onrender.com/', // trailing slash
      'http://demo.example.onrender.com', // wrong scheme
      'https://sub.demo.example.onrender.com', // subdomain
      'https://demo.example.onrender.com.evil.test',
      'null',
    ]) {
      expect(isOriginAllowed(origin, ALLOW)).toBe(false);
    }
    expect(ALLOW).not.toContain('*');
  });

  it('fails closed when the allowlist is empty in production', () => {
    expect(isOriginAllowed('https://demo.example.onrender.com', [])).toBe(false);
    // only Origin-less (same-origin) traffic survives an empty allowlist
    expect(isOriginAllowed(undefined, [])).toBe(true);
  });
});

describe('CORS origin callback — no error may escape (no 500)', () => {
  it('resolves allowed origins with true and no error', () => {
    const cb = vi.fn();
    corsOptions(ALLOW).origin?.(ALLOW[0], cb as never);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('resolves rejected origins with false and NO error', () => {
    // This is the regression: the old code called callback(new Error(...)),
    // which reached AllExceptionsFilter as a 500 and leaked the origin.
    const cb = vi.fn();
    corsOptions(ALLOW).origin?.('https://evil.example', cb as never);
    expect(cb).toHaveBeenCalledWith(null, false);
    const firstArg = cb.mock.calls[0]?.[0];
    expect(firstArg).toBeNull();
  });

  it('ships hardened, non-wildcard defaults', () => {
    const opts = corsOptions(ALLOW);
    expect(opts.credentials).toBe(false);
    expect(opts.exposedHeaders).toContain('X-Request-Id');
    expect(opts.exposedHeaders).toContain('Retry-After');
    expect(JSON.stringify(opts)).not.toContain('"*"');
  });
});

describe('CORS middleware — fail-closed over req/res (no Docker)', () => {
  // The cors package calls next(null) when the origin callback resolves false;
  // Express treats null as "no error", so the request continues (browser
  // blocks it via the missing ACAO header) and never becomes a 500.
  function expectContinuedWithoutError(next: ReturnType<typeof vi.fn>): void {
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0]?.[0] ?? null).toBeNull();
  }

  function run(origin: string | undefined, method = 'GET') {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      getHeader: (k: string) => headers[k.toLowerCase()],
      removeHeader: (k: string) => {
        delete headers[k.toLowerCase()];
      },
      end: vi.fn(),
    } as never;
    const req = {
      method,
      headers: origin === undefined ? {} : { origin },
    } as never;
    const next = vi.fn();
    cors(corsOptions(ALLOW))(req, res, next);
    return { headers, next };
  }

  it('reflects an allowed Origin and continues cleanly', () => {
    const { headers, next } = run(ALLOW[0]);
    expect(headers['access-control-allow-origin']).toBe(ALLOW[0]);
    expectContinuedWithoutError(next);
  });

  it('emits NO CORS headers for a rejected Origin and passes NO error to next', () => {
    const { headers, next } = run('https://evil.example');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expectContinuedWithoutError(next);
    expect(JSON.stringify(headers)).not.toContain('evil.example');
  });

  it('also fails closed on a rejected preflight (OPTIONS)', () => {
    const { headers, next } = run('https://evil.example', 'OPTIONS');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expectContinuedWithoutError(next);
  });

  it('does not reflect a wildcard for an Origin-less request', () => {
    const { headers, next } = run(undefined);
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expectContinuedWithoutError(next);
  });
});

describe('Error envelope — codes, requestId, no leaks', () => {
  function fakeHost(url = '/api/x', requestId?: string) {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    const request: Record<string, unknown> = { url, headers: {} };
    if (requestId !== undefined) request.id = requestId;
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader, headersSent: false }),
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;
    return { host, json, status, setHeader };
  }

  const logger = { error: vi.fn(), warn: vi.fn() } as never;
  const filter = new AllExceptionsFilter(logger);

  it('401 and 403 carry the guard code and the requestId', () => {
    for (const [ex, code] of [
      [new UnauthorizedException('Missing bearer token'), 'UNAUTHORIZED'],
      [new ForbiddenException('Requires one of roles: admin'), 'FORBIDDEN'],
    ] as const) {
      const { host, json, status } = fakeHost('/api/admin/students', 'req-abc-123');
      filter.catch(ex, host);
      expect(status).toHaveBeenCalledWith(ex.getStatus());
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ code, requestId: 'req-abc-123', path: '/api/admin/students' }),
      );
    }
  });

  it('maps 409 / 410 / 422 to stable codes', () => {
    for (const [ex, code] of [
      [new HttpException('conflict', 409), 'CONFLICT'],
      [new GoneException('closed'), 'GONE'],
      [new UnprocessableEntityException('bad'), 'VALIDATION_ERROR'],
    ] as const) {
      const { host, json } = fakeHost();
      filter.catch(ex, host);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    }
  });

  it('429 sets Retry-After and keeps the requestId', () => {
    const ex = new HttpException('Too many requests', 429);
    (ex as unknown as { response?: unknown }).response = {
      statusCode: 429,
      message: 'slow down',
      retryAfter: 37,
    };
    const { host, json, setHeader, status } = fakeHost('/api/auth/login', 'req-429');
    filter.catch(ex, host);
    expect(status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '37');
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED', requestId: 'req-429' }),
    );
  });

  it('500 never leaks internals and still carries the requestId', () => {
    const { host, json, status } = fakeHost('/api/x', 'req-500');
    filter.catch(new Error('DATABASE_PASSWORD=hunter2 at /secret/path'), host);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-500' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('/secret/path');
  });

  it('works when no requestId was assigned (no undefined field)', () => {
    const { host, json } = fakeHost('/api/x');
    filter.catch(new HttpException('nope', 404), host);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
    expect(body).not.toHaveProperty('requestId');
  });
});
