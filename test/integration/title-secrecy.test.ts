import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F4 DEDICATED title-secrecy suite.
 *
 * Enumerates EVERY student-accessible endpoint and asserts that, before
 * opens_at, no response leaks any thesis data (title / lecturer /
 * description). Admin endpoints must answer 401/403/404 to the student.
 */

let app: TestApp;
const ADMIN = { email: 'sec-admin@fkui.or.id', password: 'admin-pass-123' };

// distinctive markers seeded into thesis rows — any leak contains these
const TITLE = 'SECRET-TITLE-q7x9-markers-of-disease';
const DESC = 'SECRET-DESC-m4k3-never-visible-to-students';
const LECTURER = 'SECRET-LECTURER-Prof-Zz';

let studentToken = '';
let periodId = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const adminToken = ((await login.json()) as { accessToken: string }).accessToken;

  // student + scheduled (pre-opens_at) period + enrollment
  await fetch(`${app.url}/api/admin/students/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      rows: [
        { npm: '440001', fullName: 'Sec Recruit', email: 'sec-f4@ui.ac.id', classType: 'kki', researchTrack: 'community' },
      ],
    }),
  });

  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Sec-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      closesAt: new Date(Date.now() + 120 * 3_600_000).toISOString(),
    }),
  });
  periodId = ((await period.json()) as Record<string, string>).id!;
  await fetch(`${app.url}/api/admin/periods/${periodId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ to: 'scheduled' }),
  });
  await fetch(`${app.url}/api/admin/periods/${periodId}/run-stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ stage: 'initial_h7' }),
  });

  // SECRET theses in that period
  for (let i = 0; i < 3; i++) {
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, description, track)
      VALUES (${periodId}, ${TITLE + '-' + i}, ${DESC + '-' + i}, 'clinical')
    `);
  }
  await app.db.execute(sql`
    INSERT INTO lecturers (full_name) VALUES (${LECTURER})
  `);
  await app.db.execute(sql`
    UPDATE theses SET lecturer_id = (SELECT id FROM lecturers WHERE full_name = ${LECTURER} LIMIT 1)
    WHERE period_id = ${periodId}
  `);

  // student session via magic claim
  const userId = (
    (await app.db.execute(sql`
      SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = '440001'
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;
  const jti = crypto.randomUUID();
  const { JwtService } = await import('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
  const link = await jwt.signAsync({ sub: userId, role: 'student', periodId, jti }, { expiresIn: '1h' });
  await app.db.execute(sql`
    UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex')
    FROM students s WHERE s.id = pe.student_id AND pe.period_id = ${periodId}
  `);
  const claim = await fetch(`${app.url}/api/magic/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link, fingerprint: 'fp-sec-0001' }),
  });
  expect(claim.status).toBe(201);
  studentToken = ((await claim.json()) as { accessToken: string }).accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
});

/**
 * Every route a student session can possibly reach, pre-opens_at.
 * expect: 'noThesisData' → scan body for markers; numeric → exact status.
 */
const MANIFEST: Array<{
  method: string;
  path: string;
  body?: unknown;
  expect: 'noThesisData' | number;
}> = [
  // lobby & self
  { method: 'GET', path: `/lobby?periodId=${'{p}'}`, expect: 'noThesisData' },
  { method: 'GET', path: `/lobby/preferences?periodId=${'{p}'}`, expect: 'noThesisData' },
  { method: 'GET', path: '/auth/me', expect: 'noThesisData' },
  // public flows
  { method: 'POST', path: '/auth/login', body: { email: 'x@y.com', password: 'wrong-password' }, expect: 401 },
  { method: 'POST', path: '/magic/open', body: { token: 'garbage-token-value-0123456789', fingerprint: 'fp-00000000' }, expect: 401 },
  { method: 'POST', path: '/magic/claim', body: { token: 'garbage-token-value-0123456789', fingerprint: 'fp-00000000' }, expect: 401 },
  // admin surface — must NOT be reachable
  { method: 'GET', path: '/admin/students', expect: 403 },
  { method: 'GET', path: '/admin/students/export.xlsx', expect: 403 },
  { method: 'POST', path: '/admin/students/import/preview', expect: 403 },
  { method: 'POST', path: '/admin/students/import/commit', body: {}, expect: 403 },
  { method: 'POST', path: '/admin/students/bulk', body: {}, expect: 403 },
  { method: 'GET', path: `/admin/theses?periodId=${'{p}'}`, expect: 403 },
  { method: 'GET', path: `/admin/theses/export.xlsx?periodId=${'{p}'}`, expect: 403 },
  { method: 'POST', path: '/admin/theses/import/commit', body: {}, expect: 403 },
  { method: 'GET', path: '/admin/periods', expect: 403 },
  { method: 'GET', path: `/admin/periods/${'{p}'}`, expect: 403 },
  { method: 'POST', path: '/admin/periods', body: {}, expect: 403 },
  { method: 'POST', path: `/admin/periods/${'{p}'}/clone`, expect: 403 },
  { method: 'POST', path: `/admin/periods/${'{p}'}/transition`, body: {}, expect: 403 },
  { method: 'GET', path: `/admin/periods/${'{p}'}/enrollments`, expect: 403 },
  { method: 'POST', path: `/admin/periods/${'{p}'}/run-stage`, body: {}, expect: 403 },
  { method: 'POST', path: '/admin/auth/staff', body: {}, expect: 404 },
  // F5 war surface — must be unreachable pre-opens_at
  { method: 'GET', path: `/war/catalog?periodId=${'{p}'}`, expect: 403 },
  { method: 'POST', path: '/war/claims', body: {}, expect: 400 },
  { method: 'POST', path: `/war/claims/${'{p}'}/confirm`, expect: 404 },
  { method: 'GET', path: `/war/receipt?periodId=${'{p}'}`, expect: 'noThesisData' },
];

describe('TITLE SECRECY — no student endpoint leaks thesis data before opens_at', () => {
  it.each(MANIFEST.map((e) => [`${e.method} ${e.path}`, e] as const))(
    '%s',
    async (_label, entry) => {
      const path = entry.path.replace('{p}', periodId);
      const res = await fetch(`${app.url}/api${path}`, {
        method: entry.method,
        headers: {
          ...(entry.body !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${studentToken}`,
        },
        body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
      });
      const text = await res.text();

      if (entry.expect === 'noThesisData') {
        expect(res.status).toBeLessThan(500);
        expect(text).not.toContain(TITLE);
        expect(text).not.toContain(DESC);
        expect(text).not.toContain(LECTURER);
        // belt & braces: no raw embedding vectors either
        expect(text).not.toContain('"embedding"');
      } else {
        expect([entry.expect]).toContain(res.status);
        expect(text).not.toContain(TITLE);
      }
    },
    15_000,
  );

  it('even after opens... nothing changes for OTHER periods (cross-period isolation)', async () => {
    const otherPeriod = (
      (
        await app.db.execute(sql`
          INSERT INTO selection_periods (name, academic_year, status, opens_at, closes_at)
          VALUES ('Other', '2026/2027', 'open', now() - interval '1 hour', now() + interval '1 hour')
          RETURNING id
        `)
      ) as unknown as { rows: Array<{ id: string }> }
    ).rows[0]!.id;

    // student has NO enrollment in the open period → lobby 404, no data
    const res = await fetch(
      `${app.url}/api/lobby?periodId=${otherPeriod}`,
      { headers: { authorization: `Bearer ${studentToken}` } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(TITLE);

    void periodId;
  });
});
