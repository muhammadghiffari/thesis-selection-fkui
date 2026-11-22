import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedStaff, seedStudent, signStudentAccessToken, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * Task 4 — deploy smoke over real HTTP (needs Testcontainers pg/redis; run in
 * CI with a container runtime). CORS is proven fail-closed by the pure/unit
 * suite (test/unit/cors-errors.test.ts) because enableCors() lives in main.ts
 * bootstrap, not in the Nest module graph that startTestApp() boots.
 *
 * Covers: clean 404s, guard 401/403 (+requestId), requestId echo, strict
 * validation 400, and throttled auth 429 with Retry-After. No 402 page exists
 * (there is no payment flow) and none is expected.
 */

let app: TestApp;
const ADMIN = { email: 'smoke-admin@fkui.or.id', password: 'smoke-pass-123' };
const STUDENT_EMAIL = 'smoke-student@ui.ac.id';

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    headers: res.headers,
  };
}

let adminToken = '';
let studentToken = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');

  const login = await call('POST', '/auth/login', ADMIN);
  expect(login.status).toBe(201);
  adminToken = login.json.accessToken as string;

  // Public register is closed — seed directly; domain trigger still applies.
  await seedStudent(app.db, STUDENT_EMAIL, 'student-pass-1');
  studentToken = await signStudentAccessToken(app.db, STUDENT_EMAIL);
}, 300_000);

afterAll(async () => {
  await app?.close();
});

describe('clean 404s (no API internals leaked)', () => {
  it('unknown API path → 404 NOT_FOUND envelope with path + timestamp', async () => {
    const res = await call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('NOT_FOUND');
    expect(res.json.statusCode).toBe(404);
    expect(String(res.json.path)).toContain('/api/nope');
    expect(typeof res.json.timestamp).toBe('string');
    expect(JSON.stringify(res.json)).not.toMatch(/stack|at \w+ \(|node_modules|salt|password/i);
  });

  it('health is public and carries a request id header', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('guards — 401 / 403 with requestId envelope', () => {
  it('missing token → 401 UNAUTHORIZED with requestId', async () => {
    const res = await call('GET', '/admin/students');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHORIZED');
    expect(res.json.requestId ?? res.headers.get('x-request-id')).toBeTruthy();
  });

  it('wrong role → 403 FORBIDDEN with requestId', async () => {
    const res = await call('GET', '/admin/students', undefined, {
      authorization: `Bearer ${studentToken}`,
    });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('FORBIDDEN');
    expect(res.json.requestId ?? res.headers.get('x-request-id')).toBeTruthy();
  });

  it('correct role → 200', async () => {
    const res = await call('GET', '/admin/students', undefined, {
      authorization: `Bearer ${adminToken}`,
    });
    expect(res.status).toBe(200);
  });

  it('client-supplied safe X-Request-Id is echoed', async () => {
    const res = await call('GET', '/health', undefined, { 'x-request-id': 'smoke-req-42' });
    expect(res.headers.get('x-request-id')).toBe('smoke-req-42');
  });
});

describe('validation + throttling', () => {
  it('extra body field → 400 BAD_REQUEST', async () => {
    const res = await call('POST', '/auth/login', {
      email: ADMIN.email,
      password: ADMIN.password,
      isAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_REQUEST');
  });

  it('throttled auth endpoint → 429 RATE_LIMITED with Retry-After', async () => {
    // forgot-password is throttled at 10/min/IP (@Throttle on the controller).
    // Unknown email keeps this side-effect-free and non-enumerating.
    const ghost = `ghost-${Date.now()}@fkui.or.id`;
    let last: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 11; i++) {
      last = await call('POST', '/auth/forgot-password', { email: ghost });
      if (i < 10) expect(last.status).toBe(201);
    }
    expect(last?.status).toBe(429);
    expect(last?.json.code).toBe('RATE_LIMITED');
    expect(last?.json.requestId).toBeTruthy();
    const retryAfter = last?.headers.get('retry-after');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
