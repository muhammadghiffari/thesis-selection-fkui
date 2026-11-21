import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_LOGIN_FAILURES } from '../../src/modules/identity/login-rate-limiter.js';
import {
  seedStaff,
  seedStudent,
  signStudentAccessToken,
  startTestApp,
  type TestApp,
} from '../helpers/start-test-app.js';

/**
 * F2 acceptance flows over real HTTP against Testcontainers pg/redis:
 * public register unavailable (closure), seeded student password login
 * unavailable (401), wrong password → 401, 429 rate limit,
 * refresh rotation invalidation, logout revocation, requireRole enforcement.
 */

let app: TestApp;
const ADMIN = { email: 'admin-f2@fkui.or.id', password: 'admin-pass-123' };
const STUDENT = { email: 'f2-student@ui.ac.id', password: 'student-pass-1' };

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  // Public register is closed — students are provisioned directly. The users
  // table trigger (`trg_check_student_email_domain`) still enforces @ui.ac.id
  // on this row, same as every other student insert path.
  await seedStudent(app.db, STUDENT.email, STUDENT.password);
}, 300_000);

afterAll(async () => {
  await app?.close();
});

async function call(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
  accessToken?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('POST /api/auth/register', () => {
  it('is unavailable — public student self-registration stays closed', async () => {
    const res = await call('POST', '/auth/register', {
      email: `f2-${crypto.randomUUID()}@ui.ac.id`,
      password: 'secret-pass-1',
    });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/auth/login', () => {
  it('seeded student password login is unavailable → 401', async () => {
    const res = await call('POST', '/auth/login', { email: STUDENT.email, password: STUDENT.password });
    expect(res.status).toBe(401);
  });

  it('wrong password → 401', async () => {
    const wrongPass = await call('POST', '/auth/login', { email: ADMIN.email, password: 'wrong-pass-99' });
    expect(wrongPass.status).toBe(401);

    // password login for the seeded student stays unavailable by design:
    // findStaffForLogin restricts credential lookup to admin/lecturer.
    const studentAttempt = await call('POST', '/auth/login', {
      email: STUDENT.email,
      password: STUDENT.password,
    });
    expect(studentAttempt.status).toBe(401);
  });

  it('blocks after MAX_LOGIN_FAILURES failures per email+IP with 429', async () => {
    const victim = `rl-${crypto.randomUUID()}@any.example`;
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      const attempt = await call('POST', '/auth/login', { email: victim, password: 'whatever-123' });
      expect(attempt.status).toBe(401);
    }
    const blocked = await call('POST', '/auth/login', { email: victim, password: 'whatever-123' });
    expect(blocked.status).toBe(429);
  });
});

describe('refresh rotation & logout', () => {
  it('rotating invalidates the old refresh token', async () => {
    const login = await call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(201);
    const oldRefresh = login.json.refreshToken as string;

    const rotated = await call('POST', '/auth/refresh', { refreshToken: oldRefresh });
    expect(rotated.status).toBe(201);
    expect(rotated.json.refreshToken).toBeTruthy();
    expect(rotated.json.refreshToken).not.toBe(oldRefresh);

    // replay of the consumed token must fail
    const replay = await call('POST', '/auth/refresh', { refreshToken: oldRefresh });
    expect(replay.status).toBe(401);

    // the successor still works
    const me = await call('GET', '/auth/me', undefined, rotated.json.accessToken as string);
    expect(me.status).toBe(200);
    expect(me.json.role).toBe('admin');
  });

  it('logout revokes the refresh token', async () => {
    const login = await call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password });
    const refreshToken = login.json.refreshToken as string;

    const out = await call('POST', '/auth/logout', { refreshToken });
    expect(out.status).toBe(201);

    const after = await call('POST', '/auth/refresh', { refreshToken });
    expect(after.status).toBe(401);
  });
});

describe('role guards', () => {
  it('requireRole blocks students from staff provisioning (403) and anonymous (401)', async () => {
    const studentToken = await signStudentAccessToken(app.db, STUDENT.email);

    const me = await call('GET', '/auth/me', undefined, studentToken);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: STUDENT.email, role: 'student' });

    const forbidden = await call('POST', '/auth/staff', {
      email: `lec-${crypto.randomUUID()}@example.com`,
      password: 'lecturer-pass-1',
      role: 'lecturer',
    }, studentToken);
    expect(forbidden.status).toBe(403);

    const anonymous = await call('POST', '/auth/staff', {
      email: `lec-${crypto.randomUUID()}@example.com`,
      password: 'lecturer-pass-1',
      role: 'lecturer',
    });
    expect(anonymous.status).toBe(401);
  });

  it('admin provisions a lecturer who can then log in', async () => {
    const login = await call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password });
    const created = await call('POST', '/auth/staff', {
      email: `lec-${crypto.randomUUID()}@example.com`,
      password: 'lecturer-pass-1',
      role: 'lecturer',
    }, login.json.accessToken as string);
    expect(created.status).toBe(201);

    const lecLogin = await call('POST', '/auth/login', {
      email: created.json.email as string,
      password: 'lecturer-pass-1',
    });
    expect(lecLogin.status).toBe(201);
    expect((await call('GET', '/auth/me', undefined, lecLogin.json.accessToken as string)).json.role).toBe('lecturer');
  });
});
