import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F4 pre-war lobby: countdown inputs, preference capture, auto-war consent.
 * Reuses the F3 magic-link claim flow to obtain a student session.
 */

let app: TestApp;
const ADMIN = { email: 'f4-admin@fkui.or.id', password: 'admin-pass-123' };
let adminToken = '';
let periodId = '';
let studentAccessToken = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminToken = ((await login.json()) as { accessToken: string }).accessToken;

  // import one student
  const commit = await fetch(`${app.url}/api/admin/students/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      rows: [
        { npm: '550001', fullName: 'Four Lim', email: 'four-f4@ui.ac.id', classType: 'regular', researchTrack: 'clinical' },
      ],
    }),
  });
  expect(commit.status).toBe(201);

  // scheduled period (pre-opens_at) + H-7 blast to create the enrollment
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `F4-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      closesAt: new Date(Date.now() + 96 * 3_600_000).toISOString(),
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

  // craft a magic link for the student and claim it → session
  const userId = (
    (await app.db.execute(sql`
      SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = '550001'
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;
  const jti = crypto.randomUUID();
  const { JwtService } = await import('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
  const linkToken = await jwt.signAsync(
    { sub: userId, role: 'student', periodId, jti },
    { expiresIn: '1h' },
  );
  await app.db.execute(sql`
    UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex')
    FROM students s WHERE s.id = pe.student_id AND pe.period_id = ${periodId}
  `);
  const claim = await fetch(`${app.url}/api/magic/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: linkToken, fingerprint: 'fp-four-0001' }),
  });
  expect(claim.status).toBe(201);
  studentAccessToken = ((await claim.json()) as { accessToken: string }).accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
});

async function studentGet(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    headers: { authorization: `Bearer ${studentAccessToken}` },
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function studentPost(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${studentAccessToken}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('server-authoritative lobby view', () => {
  it('returns countdown inputs from a single server timestamp; no thesis fields', async () => {
    const before = Date.now();
    const res = await studentGet(`/lobby?periodId=${periodId}`);
    const after = Date.now();

    expect(res.status).toBe(200);
    const serverTime = Date.parse(res.json.serverTime as string);
    expect(serverTime).toBeGreaterThanOrEqual(before - 1000);
    expect(serverTime).toBeLessThanOrEqual(after + 1000);

    const period = res.json.period as { opensAt: string; closesAt: string; status: string };
    expect(period.status).toBe('scheduled');
    expect(Date.parse(period.opensAt)).toBeGreaterThan(Date.now());

    const untilOpen = res.json.secondsUntilOpen as number;
    expect(untilOpen).toBeGreaterThan(47 * 3600);
    expect(res.json.autoWar).toEqual({ enabled: false, consentedAt: null });
    expect(JSON.stringify(res.json)).not.toContain('embedding');
  });

  it('401 without session and 404 without enrollment', async () => {
    const anon = await fetch(`${app.url}/api/lobby?periodId=${periodId}`);
    expect(anon.status).toBe(401);

    const other = crypto.randomUUID();
    const res = await studentGet(`/lobby?periodId=${other}`);
    expect(res.status).toBe(404);
  });
});

describe('AI preference capture', () => {
  it('stores free text as embedding (updatable); text retrievable, embedding never exposed', async () => {
    const save = await studentPost('/lobby/preferences', {
      periodId,
      text: 'Interested in community nutrition programs and maternal health interventions',
    });
    expect(save.status).toBe(201);
    expect(save.json.saved).toBe(true);

    // upsert overwrites
    const second = await studentPost('/lobby/preferences', {
      periodId,
      text: 'Actually more drawn to clinical trial biostatistics and epidemiology methods',
    });
    expect(second.status).toBe(201);

    const pref = await studentGet(`/lobby/preferences?periodId=${periodId}`);
    expect(pref.status).toBe(200);
    expect((pref.json.text as string)).toContain('biostatistics');

    const db = (await app.db.execute(sql`
      SELECT vector_dims(embedding)::int AS dims FROM student_preferences sp
      JOIN students s ON s.id = sp.student_id WHERE s.npm = '550001'
    `)) as unknown as { rows: Array<{ dims: number }> };
    expect(db.rows[0]?.dims).toBe(1536);
  });

  it('rejects too-short interest text with 400', async () => {
    const res = await studentPost('/lobby/preferences', { periodId, text: 'too short' });
    expect(res.status).toBe(400);
  });
});

describe('auto-war opt-in', () => {
  it('enabling requires explicit consent; consent persisted server-side; disable works', async () => {
    const noConsent = await studentPost('/lobby/auto-war', { periodId, enabled: true });
    expect(noConsent.status).toBe(400);

    const enable = await studentPost('/lobby/auto-war', { periodId, enabled: true, consent: true });
    expect(enable.status).toBe(201);
    expect(enable.json.enabled).toBe(true);
    expect(typeof enable.json.consentedAt).toBe('string');

    const audit = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action = 'auto_war.opt_in'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(audit.rows[0]?.n).toBe(1);

    const disable = await studentPost('/lobby/auto-war', { periodId, enabled: false });
    expect(disable.status).toBe(201);
    expect(disable.json.enabled).toBe(false);

    const view = await studentGet(`/lobby?periodId=${periodId}`);
    expect((view.json.autoWar as { enabled: boolean }).enabled).toBe(false);
  });
});
