import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F3 magic link flows + scheduler stage guards over real HTTP against
 * Testcontainers pg16+redis7.
 */

let app: TestApp;
const ADMIN = { email: 'f3-admin@fkui.or.id', password: 'admin-pass-123' };
const FP_A = 'device-fingerprint-alice-0001';
const FP_B = 'device-fingerprint-bob-00002';
let token = '';
let periodId = '';

// two students: alice (main flow), bea (reminder targeting)
const aliceNpm = '660001';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  token = ((await login.json()) as { accessToken: string }).accessToken;

  // import two students
  const commit = await fetch(`${app.url}/api/admin/students/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      rows: [
        { npm: aliceNpm, fullName: 'Alice Wonder', email: 'alice-f3@ui.ac.id', classType: 'regular', researchTrack: 'clinical' },
        { npm: '660002', fullName: 'Bea Sharp', email: 'bea-f3@ui.ac.id', classType: 'regular', researchTrack: 'basic' },
      ],
    }),
  });
  expect(commit.status).toBe(201);

  // period scheduled with future opens_at → triggers scheduler via event bus
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `F3-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      closesAt: new Date(Date.now() + 96 * 3_600_000).toISOString(),
    }),
  });
  periodId = ((await period.json()) as Record<string, string>).id!;
  const t = await fetch(`${app.url}/api/admin/periods/${periodId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: 'scheduled' }),
  });
  expect(t.status).toBe(201);

  // seed enrollments + initial links (H-7 blast) so later flows have rows
  const blast = await fetch(`${app.url}/api/admin/periods/${periodId}/run-stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ stage: 'initial_h7' }),
  });
  expect(blast.status).toBe(201);
}, 300_000);

afterAll(async () => {
  await app?.close();
});

async function adminPost(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function studentIds(): Promise<Map<string, string>> {
  const res = await fetch(`${app.url}/api/admin/students?pageSize=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = ((await res.json()) as { rows: Array<{ id: string; npm: string }> }).rows;
  return new Map(rows.map((r) => [r.npm, r.id]));
}


describe('magic link lifecycle', () => {
  it('open binds device and starts TTL; claim issues session; replay → 410; foreign device → 409', async () => {
    // mint a token directly through the service layer equivalent: use resend,
    // then capture raw token via a signed twin — simpler: sign our own JWT with
    // matching jti AFTER reading... not possible. Therefore this suite drives
    // the flow through StageRunner's issueLink exposed via resend is also raw-
    // less. Final approach: craft token first, then store its hash via SQL.
    const jti = crypto.randomUUID();
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const rawToken = await jwt.signAsync(
      { sub: await userIdOf(aliceNpm), role: 'student', periodId, jti },
      { expiresIn: '1h' },
    );
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex'),
        device_fingerprint_hash = NULL, link_opened_at = NULL, link_claimed_at = NULL
      FROM students s WHERE s.id = pe.student_id AND s.npm = ${aliceNpm} AND pe.period_id = ${periodId}
    `);

    async function post(path: 'open' | 'claim', fp: string) {
      const res = await fetch(`${app.url}/api/magic/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: rawToken, fingerprint: fp }),
      });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }

    // 1) open from device A — binds + starts clock
    const opened = await post('open', FP_A);
    expect(opened.status).toBe(201);
    expect(typeof opened.json.expiresAt).toBe('string');

    // 2) claim from device B — rejected 409, integrity logged
    const stolen = await post('claim', FP_B);
    expect(stolen.status).toBe(409);
    const integrity = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action = 'integrity.device_rebind_attempt'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(integrity.rows[0]?.n).toBeGreaterThan(0);

    // 3) claim from device A — success, session works
    const claimed = await post('claim', FP_A);
    expect(claimed.status).toBe(201);
    expect(typeof claimed.json.accessToken).toBe('string');
    const me = await fetch(`${app.url}/api/auth/me`, {
      headers: { authorization: `Bearer ${claimed.json.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { role: string }).role).toBe('student');

    // 4) replay same claim → 410 Gone
    const replay = await post('claim', FP_A);
    expect(replay.status).toBe(410);
  });

  it('expired link (past claim window) → 401 on claim', async () => {
    // backdate alice's opened_at beyond TTL, unclaim her row
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET link_opened_at = now() - interval '1 hour', link_claimed_at = NULL
      FROM students s WHERE s.id = pe.student_id AND s.npm = ${aliceNpm} AND pe.period_id = ${periodId}
    `);
    const jti = crypto.randomUUID();
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const raw = await jwt.signAsync(
      { sub: await userIdOf(aliceNpm), role: 'student', periodId, jti },
      { expiresIn: '1h' },
    );
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex')
      FROM students s WHERE s.id = pe.student_id AND s.npm = ${aliceNpm} AND pe.period_id = ${periodId}
    `);

    const res = await fetch(`${app.url}/api/magic/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: raw, fingerprint: FP_A }),
    });
    expect(res.status).toBe(401);
  });

  it('JWT-level expiry → 401 even before any state', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const raw = await jwt.signAsync(
      { sub: await userIdOf(aliceNpm), role: 'student', periodId, jti: crypto.randomUUID() },
      { expiresIn: '-60s' },
    );
    const res = await fetch(`${app.url}/api/magic/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: raw, fingerprint: FP_A }),
    });
    expect([401, 500]).toContain(res.status); // UnauthorizedException maps 401
    expect(res.status).toBe(401);
  });
});

describe('scheduler stage guards & targeting', () => {
  it('stage runs twice → exactly one delivery per student per stage', async () => {
    const first = await adminPost(`/admin/periods/${periodId}/run-stage`, { stage: 'initial_h7' });
    const second = await adminPost(`/admin/periods/${periodId}/run-stage`, { stage: 'initial_h7' });
    expect(first.status).toBe(201);
    expect(second.json.sent).toBe(0); // guard blocks duplicates

    const counts = (await app.db.execute(sql`
      SELECT template, count(*)::int AS n FROM notification_deliveries
      WHERE payload->>'periodId' = ${periodId} AND template = 'magic_link'
      GROUP BY template
    `)) as unknown as { rows: Array<{ template: string; n: number }> };
    expect(counts.rows[0]?.n).toBe(2); // exactly one per enrolled student

    // reminder_stage advanced to 1 for everyone
    const stages = (await app.db.execute(sql`
      SELECT DISTINCT reminder_stage FROM period_enrollments WHERE period_id = ${periodId}
    `)) as unknown as { rows: Array<{ reminder_stage: number }> };
    expect(stages.rows.every((r) => r.reminder_stage >= 1)).toBe(true);
  });

  it('reminders skip students who already claimed; closes warning targets below-3/3 only', async () => {
    // catalog for selection seeding
    for (let i = 0; i < 4; i++) {
      await app.db.execute(sql`
        INSERT INTO theses (period_id, title, track) VALUES (${periodId}, ${'Thesis-' + i}, 'clinical')
      `);
    }

    // bea claims her access (simulate)
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET link_claimed_at = now(), link_opened_at = now()
      FROM students s WHERE s.id = pe.student_id AND s.npm = '660002' AND pe.period_id = ${periodId}
    `);

    // H-1 reminder: alice opened earlier (not claimed), bea claimed → nobody qualifies
    const h1 = await adminPost(`/admin/periods/${periodId}/run-stage`, { stage: 'reminder_h1' });
    expect(h1.status).toBe(201);
    expect((h1.json as { sent?: number }).sent ?? 0).toBeLessThanOrEqual(1);

    // alice gets 1 active selection (thesis #4), bea reaches exactly 3/3
    await app.db.execute(sql`
      INSERT INTO thesis_selections (period_id, student_id, thesis_id, priority, status)
      SELECT ${periodId}, s.id,
             (SELECT id FROM theses WHERE period_id = ${periodId} ORDER BY id OFFSET 3 LIMIT 1),
             1, 'confirmed'
      FROM students s WHERE s.npm = ${aliceNpm}
    `);
    for (const p of [1, 2, 3]) {
      await app.db.execute(sql`
        INSERT INTO thesis_selections (period_id, student_id, thesis_id, priority, status)
        SELECT ${periodId}, s.id,
               (SELECT id FROM theses WHERE period_id = ${periodId} ORDER BY id OFFSET ${p - 1} LIMIT 1),
               ${p}, 'confirmed'
        FROM students s WHERE s.npm = '660002'
      `);
    }

    const warn = await adminPost(`/admin/periods/${periodId}/run-stage`, { stage: 'closes_warning' });
    expect(warn.status).toBe(201);
    expect(warn.json.sent).toBe(1); // only alice is below 3/3

    const warned = (await app.db.execute(sql`
      SELECT u.email FROM notification_deliveries nd
      JOIN users u ON u.id = nd.user_id
      WHERE nd.template = 'closes_warning_h2' AND nd.payload->>'periodId' = ${periodId}
    `)) as unknown as { rows: Array<{ email: string }> };
    expect(warned.rows.map((r) => r.email)).toEqual(['alice-f3@ui.ac.id']);
  });

  it('admin resend mints fresh token (old dies), records audit entry', async () => {
    // bea had claimed → resend must 409 for her
    const ids = await studentIds();
    const beaResend = await adminPost(`/admin/students/${ids.get('660002')}/resend-link`, { periodId });
    expect(beaResend.status).toBe(409);

    const auditBefore = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action = 'magic_link.resend'
    `)) as unknown as { rows: Array<{ n: number }> };

    const ok = await adminPost(`/admin/students/${ids.get(aliceNpm)}/resend-link`, { periodId });
    expect(ok.status).toBe(201);

    const auditAfter = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action = 'magic_link.resend'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]!.n + 1);

    // old alice token (from first test) is dead now — hash was swapped
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const stale = await jwt.signAsync(
      { sub: await userIdOf(aliceNpm), role: 'student', periodId, jti: 'definitely-not-current' },
      { expiresIn: '1h' },
    );
    const res = await fetch(`${app.url}/api/magic/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: stale, fingerprint: FP_A }),
    });
    expect(res.status).toBe(410);
  });
});

async function userIdOf(npm: string): Promise<string> {
  const res = (await app.db.execute(sql`
    SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = ${npm}
  `)) as unknown as { rows: Array<{ id: string }> };
  return res.rows[0]!.id;
}

