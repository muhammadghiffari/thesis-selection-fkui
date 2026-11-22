import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  seedStaff,
  seedStudent,
  signStudentAccessToken,
  startTestApp,
  type TestApp,
} from '../helpers/start-test-app.js';

/**
 * Task 5 (free-Render demo readiness): verify the EXISTING permission and
 * clean-error behavior end to end over real HTTP (pg/redis via Testcontainers).
 *
 * - POST /api/auth/staff is admin-only (anon 401, student 403, admin 201).
 * - Student provisioning stays admin-only (import/commit) + @ui.ac.id enforced;
 *   no public register (404).
 * - Reports download of a queued/processing job → clean 409 CONFLICT (no crash,
 *   no leaked internals); route is admin-only.
 *
 * NOTE: on free Render export files are EPHEMERAL by design (DEPLOY.md). This
 * suite intentionally makes NO assertion about durable artifact persistence.
 */

let app: TestApp;
const ADMIN = { email: 't5-admin@fkui.or.id', password: 'admin-pass-123' };
const STUDENT_EMAIL = 't5-student@ui.ac.id';
let adminToken = '';
let studentToken = '';
let periodId = '';

async function call(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  await seedStudent(app.db, STUDENT_EMAIL, 'student-pass-1');

  const login = await call('POST', '/auth/login', ADMIN);
  expect(login.status).toBe(201);
  adminToken = login.json.accessToken as string;
  studentToken = await signStudentAccessToken(app.db, STUDENT_EMAIL);

  const period = await call(
    'POST',
    '/admin/periods',
    { name: `T5-${crypto.randomUUID()}`, academicYear: '2026/2027' },
    adminToken,
  );
  expect([200, 201]).toContain(period.status);
  periodId = period.json.id as string;
  expect(periodId).toBeTruthy();
}, 300_000);

afterAll(async () => {
  await app?.close();
});

describe('POST /api/auth/staff — staff creation is admin-only', () => {
  const payload = () => ({
    email: `t5-lec-${crypto.randomUUID()}@example.com`,
    password: 'lecturer-pass-1',
    role: 'lecturer',
  });

  it('anonymous → 401 UNAUTHORIZED', async () => {
    const res = await call('POST', '/auth/staff', payload());
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHORIZED');
  });

  it('student token → 403 FORBIDDEN', async () => {
    const res = await call('POST', '/auth/staff', payload(), studentToken);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('FORBIDDEN');
  });

  it('admin token → 201, and the new lecturer can log in', async () => {
    const p = payload();
    const res = await call('POST', '/auth/staff', p, adminToken);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ email: p.email, role: 'lecturer' });

    const login = await call('POST', '/auth/login', { email: p.email, password: p.password });
    expect(login.status).toBe(201);
  });
});

describe('student provisioning is admin-only, @ui.ac.id enforced, no public register', () => {
  const row = (email: string, npm: string) => ({
    npm,
    fullName: 'T5 Student',
    email,
    classType: 'regular',
    researchTrack: 'clinical',
  });

  it('no public register endpoint → 404 NOT_FOUND', async () => {
    const res = await call('POST', '/auth/register', {
      email: `t5-${crypto.randomUUID()}@ui.ac.id`,
      password: 'secret-pass-1',
    });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('NOT_FOUND');
  });

  it('POST /api/admin/students/import/commit: anon → 401, student → 403', async () => {
    const anon = await call('POST', '/admin/students/import/commit', {
      rows: [row(`anon-${crypto.randomUUID()}@ui.ac.id`, '910001')],
    });
    expect(anon.status).toBe(401);
    expect(anon.json.code).toBe('UNAUTHORIZED');

    const forbidden = await call(
      'POST',
      '/admin/students/import/commit',
      { rows: [row(`stu-${crypto.randomUUID()}@ui.ac.id`, '910002')] },
      studentToken,
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.code).toBe('FORBIDDEN');
  });

  it('admin commit enforces @ui.ac.id: valid inserted, wrong-domain row skipped with clean error', async () => {
    const goodEmail = `t5-good-${crypto.randomUUID()}@ui.ac.id`;
    const badEmail = `t5-bad-${crypto.randomUUID()}@gmail.com`;

    const res = await call(
      'POST',
      '/admin/students/import/commit',
      { rows: [row(goodEmail, '910100'), row(badEmail, '910101')] },
      adminToken,
    );
    expect(res.status).toBe(201);
    expect((res.json.inserted as unknown[]).length).toBe(1);

    const skipped = res.json.skipped as Array<{ errors: Record<string, string> }>;
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.errors.email).toMatch(/must end with/);

    // no user row is created for the rejected domain
    const leaked = (await app.db.execute(sql`
      SELECT 1 FROM users WHERE email = ${badEmail}
    `)) as unknown as { rows: unknown[] };
    expect(leaked.rows.length).toBe(0);
  });
});

describe('GET /api/reports/:id/download — clean 409 for non-ready jobs, admin-only', () => {
  let jobId = '';

  beforeAll(async () => {
    // Request a job but never run the worker → it stays in 'queued'.
    const req = await call(
      'POST',
      '/reports',
      { kind: 'final_selections', periodId },
      adminToken,
    );
    expect([200, 201]).toContain(req.status);
    jobId = req.json.jobId as string;
    expect(jobId).toBeTruthy();
  });

  it('anonymous → 401; student → 403', async () => {
    const anon = await call('GET', `/reports/${jobId}/download`);
    expect(anon.status).toBe(401);

    const forbidden = await call('GET', `/reports/${jobId}/download`, undefined, studentToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.code).toBe('FORBIDDEN');
  });

  it('queued job → 409 CONFLICT with a clean message and no leaked internals', async () => {
    const res = await call('GET', `/reports/${jobId}/download`, undefined, adminToken);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('CONFLICT');
    expect(res.json.message).toMatch(/queued/i);
    expect(JSON.stringify(res.json)).not.toMatch(/EXPORT_DIR|node_modules|\bat \w|Error:/);
  });

  it('processing job → 409 CONFLICT with a clean message', async () => {
    await app.db.execute(sql`UPDATE export_jobs SET status = 'processing' WHERE id = ${jobId}`);
    const res = await call('GET', `/reports/${jobId}/download`, undefined, adminToken);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('CONFLICT');
    expect(res.json.message).toMatch(/processing/i);
  });

  it('unknown job → 404 NOT_FOUND', async () => {
    const res = await call(
      'GET',
      `/reports/${crypto.randomUUID()}/download`,
      undefined,
      adminToken,
    );
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('NOT_FOUND');
  });
});
