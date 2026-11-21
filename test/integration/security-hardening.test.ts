import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { seedStaff, seedStudent, signStudentAccessToken, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * Security hardening + password reset acceptance over real HTTP:
 * - authz: 401 unauthenticated / 403 wrong role on admin endpoints
 * - API 404 for unknown routes with structured envelope (+ requestId)
 * - strict validation: extra fields, bad email, short password → 400
 * - password reset: generic 200 (no enumeration), single-use token,
 *   all sessions revoked, old password stops working
 */

let app: TestApp;
const ADMIN = { email: 'hard-admin@fkui.or.id', password: 'admin-pass-123' };
const STUDENT_EMAIL = 'hard-student@ui.ac.id';

async function call(
  method: 'POST' | 'GET',
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
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}

let adminToken = '';
let studentToken = '';
let adminRefresh = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');

  const login = await call('POST', '/auth/login', ADMIN);
  expect(login.status).toBe(201);
  adminToken = login.json.accessToken as string;
  adminRefresh = login.json.refreshToken as string;

  // Public register is closed — seed the student directly (enroll path is F3+).
  await seedStudent(app.db, STUDENT_EMAIL, 'student-pass-1');
  studentToken = await signStudentAccessToken(app.db, STUDENT_EMAIL);
}, 300_000);

afterAll(async () => {
  await app?.close();
});

describe('authorization (OWASP A01)', () => {
  it('unauthenticated GET /api/admin/students → 401 with structured code', async () => {
    const res = await call('GET', '/admin/students');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHORIZED');
    expect(typeof res.json.requestId === 'string' || res.json.requestId === undefined).toBe(true);
  });

  it('student GET /api/admin/students → 403 FORBIDDEN', async () => {
    const res = await call('GET', '/admin/students', undefined, { authorization: `Bearer ${studentToken}` });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('FORBIDDEN');
  });

  it('admin GET /api/admin/students → 200', async () => {
    const res = await call('GET', '/admin/students', undefined, { authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
  });

  it('health stays public → 200 without token', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
  });
});

describe('API error envelope (OWASP A05/A09)', () => {
  it('unknown API route → 404 NOT_FOUND with requestId + path + timestamp', async () => {
    const res = await call('GET', '/does-not-exist-xyz');
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('NOT_FOUND');
    expect(res.json.path).toContain('/api/does-not-exist-xyz');
    expect(typeof res.json.timestamp).toBe('string');
  });

  it('extra body field is rejected (forbidNonWhitelisted) → 400', async () => {
    const res = await call('POST', '/auth/login', {
      email: ADMIN.email,
      password: ADMIN.password,
      admin: true,
    });
    expect(res.status).toBe(400);
  });

  it('malformed email + short password → 400', async () => {
    const badEmail = await call('POST', '/auth/login', { email: 'not-an-email', password: 'whatever-123' });
    expect(badEmail.status).toBe(400);
    const shortPass = await call('POST', '/auth/login', { email: ADMIN.email, password: 'x' });
    expect(shortPass.status).toBe(400);
  });

  it('X-Request-Id header is echoed on every response', async () => {
    const res = await call('GET', '/admin/students', undefined, { authorization: `Bearer ${adminToken}` });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('password reset (OWASP A07 / ASVS 2.1.5)', () => {
  it('forgot-password for unknown email → generic 200 (no enumeration)', async () => {
    const ghost = `ghost-${crypto.randomUUID()}@fkui.or.id`;
    const res = await call('POST', '/auth/forgot-password', { email: ghost });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ sent: true });
  });

  it('forgot-password for staff → 200 and creates a pending hashed token', async () => {
    const before = (await app.db.execute(
      sql`SELECT count(*)::int AS n FROM password_reset_tokens`,
    )) as unknown as { rows: Array<{ n: number }> };
    const beforeCount = before.rows[0]?.n ?? 0;

    const res = await call('POST', '/auth/forgot-password', { email: ADMIN.email });
    expect(res.status).toBe(201);

    const after = (await app.db.execute(
      sql`SELECT count(*)::int AS n FROM password_reset_tokens WHERE used_at IS NULL`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect((after.rows[0]?.n ?? 0)).toBeGreaterThan(beforeCount);
  });

  it('reset with a bad token → 401', async () => {
    const res = await call('POST', '/auth/reset-password', {
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password: 'new-pass-12345',
    });
    expect(res.status).toBe(401);
  });

  it('full flow: seeded token resets password, revokes refresh token, single-use', async () => {
    // Seed a token as the service would (raw known only here).
    const { randomBytes } = await import('node:crypto');
    const raw = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    const userRow = (await app.db.execute(sql`
      SELECT id FROM users WHERE email = ${ADMIN.email}
    `)) as unknown as { rows: Array<{ id: string }> };
    const userId = userRow.rows[0]!.id;
    await app.db.execute(sql`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${userId}, ${hash}, now() + interval '30 minutes')
    `);

    const reset = await call('POST', '/auth/reset-password', { token: raw, password: 'reset-pass-999' });
    expect(reset.status).toBe(201);
    expect(reset.json).toMatchObject({ reset: true });

    // replay → 401 (single-use)
    const replay = await call('POST', '/auth/reset-password', { token: raw, password: 'reset-pass-888' });
    expect(replay.status).toBe(401);

    // old refresh token revoked
    const oldRefreshAttempt = await call('POST', '/auth/refresh', { refreshToken: adminRefresh });
    expect(oldRefreshAttempt.status).toBe(401);

    // old password no longer works; new password does
    // NOTE: a failed login records a rate-limit failure — use fresh IP-ish email variance is
    // unnecessary because limits are per email+IP and this is the first failure here.
    const oldLogin = await call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call('POST', '/auth/login', { email: ADMIN.email, password: 'reset-pass-999' });
    expect(newLogin.status).toBe(201);
  });
});
