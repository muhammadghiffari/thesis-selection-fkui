import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { thesisSelections } from '../../src/shared/db/schema.js';
import type Redis from 'ioredis';
import { IntegrityScorer } from '../../src/modules/integrity/scorer.js';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F8 integrity scoring + supervisor scoping.
 * Rules consume PERSISTED signals; weights sum; banding notifies/queues/hides;
 * lecturer scoping enforced; resolve requires note + audits; NO auto-revoke.
 */

let app: TestApp;
let redis: Redis;
const ADMIN = { email: 'ig-admin@fkui.or.id', password: 'admin-pass-123' };
const LEC_A = { email: 'leca@fkui.or.id', password: 'leca-pass-1234' };
const LEC_B = { email: 'lecb@fkui.or.id', password: 'lecb-pass-1234' };
let adminToken = '';
let lecAToken = '';
let lecBToken = '';
let periodId = '';
let scorer: IntegrityScorer;

async function seedConfirmed(opts: {
  npm: string;
  studentTrack: string;
  thesisTrack: string;
  fingerprint?: string | null;
  ip?: string | null;
  lockMsAgo?: number;
  confirmedMsAgo?: number;
  titleSuffix?: string;
}): Promise<{ selectionId: string; thesisId: string; userId: string }> {
  const suffix = opts.titleSuffix ?? crypto.randomUUID().slice(0, 4);

  const userId = (
    (await app.db.execute(sql`
      INSERT INTO users (email, role) VALUES (${opts.npm + '-ig@ui.ac.id'}, 'student') RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;

  const studentId = (
    (await app.db.execute(sql`
      INSERT INTO students (user_id, npm, full_name, class_type, research_track)
      VALUES (${userId}, ${opts.npm}, ${'IG ' + suffix}, 'regular', ${opts.studentTrack}) RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;

  await app.db.execute(sql`
    INSERT INTO period_enrollments (period_id, student_id, device_fingerprint_hash, link_claimed_at)
    VALUES (${periodId}, ${studentId}, ${opts.fingerprint ?? null}, now())
  `);

  const thesisId = (
    (await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track)
      VALUES (${periodId}, ${'IG-Thesis-' + suffix}, ${opts.thesisTrack}) RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;

  const selectionRows = await app.db
    .insert(thesisSelections)
    .values({
      periodId,
      studentId,
      thesisId,
      priority: 1,
      status: 'confirmed',
      idempotencyKey: crypto.randomUUID(),
      ...(opts.lockMsAgo !== undefined ? { createdAt: new Date(Date.now() - opts.lockMsAgo) } : {}),
      ...(opts.confirmedMsAgo !== undefined ? { confirmedAt: new Date(Date.now() - opts.confirmedMsAgo) } : {}),
      ...(opts.ip ? { ipAddress: opts.ip } : {}),
    })
    .returning({ id: thesisSelections.id });
  const selectionId = selectionRows[0]!.id;

  return { selectionId, thesisId, userId };
}

beforeAll(async () => {
  app = await startTestApp();
  redis = new (await import('ioredis')).default(app.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  scorer = new IntegrityScorer(app.db);

  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  await seedStaff(app.db, LEC_A.email, LEC_A.password, 'lecturer');
  await seedStaff(app.db, LEC_B.email, LEC_B.password, 'lecturer');
  for (const [tok, creds] of [
    ['adminToken', ADMIN],
    ['lecAToken', LEC_A],
    ['lecBToken', LEC_B],
  ] as const) {
    const res = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (tok === 'adminToken') adminToken = ((await res.json()) as { accessToken: string }).accessToken;
    if (tok === 'lecAToken') lecAToken = ((await res.json()) as { accessToken: string }).accessToken;
    if (tok === 'lecBToken') lecBToken = ((await res.json()) as { accessToken: string }).accessToken;
  }

  // open period
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `IG-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() - 3_600_000).toISOString(),
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  periodId = ((await period.json()) as Record<string, string>).id!;
  for (const to of ['scheduled', 'open']) {
    await fetch(`${app.url}/api/admin/periods/${periodId}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ to }),
    });
  }

  // two lecturers rows bound to their accounts; A owns half the catalog, B the rest
  await app.db.execute(sql`
    INSERT INTO lecturers (user_id, full_name) SELECT id, 'Lecturer A' FROM users WHERE email = ${LEC_A.email};
  `);
  await app.db.execute(sql`
    INSERT INTO lecturers (user_id, full_name) SELECT id, 'Lecturer B' FROM users WHERE email = ${LEC_B.email};
  `);

  // pre-open attempt audit rows for a specific user (rule 5) — seeded per-test instead
}, 300_000);

afterAll(async () => {
  redis?.disconnect();
  await app?.close();
});

describe('scoring rules consume persisted signals with correct weights', () => {
  it('track mismatch fires +25 as a SOFT flag (selection stays confirmed)', async () => {
    const sel = await seedConfirmed({ npm: '800001', studentTrack: 'community', thesisTrack: 'clinical' });
    const result = await scorer.scoreSelection(sel.selectionId);
    const rules = result.signals.map((s) => s.rule);
    expect(rules).toContain('track_mismatch');
    expect(result.signals.find((s) => s.rule === 'track_mismatch')?.points).toBe(25);
    expect(result.score).toBe(25); // clean band → flag cleared
    const status = (
      (await app.db.execute(sql`SELECT status FROM thesis_selections WHERE id = ${sel.selectionId}`)) as unknown as {
        rows: Array<{ status: string }>;
      }
    ).rows[0]!.status;
    expect(status).toBe('confirmed'); // never blocked, never auto-revoked
  });

  it('duplicate device fingerprint fires +25 for BOTH sharers', async () => {
    const fp = 'dup-fingerprint-hash-' + crypto.randomUUID().slice(0, 6);
    const a = await seedConfirmed({ npm: '800002', studentTrack: 'clinical', thesisTrack: 'clinical', fingerprint: fp });
    const b = await seedConfirmed({ npm: '800003', studentTrack: 'basic', thesisTrack: 'basic', fingerprint: fp });

    const ra = await scorer.scoreSelection(a.selectionId);
    const rb = await scorer.scoreSelection(b.selectionId);
    expect(ra.signals.some((s) => s.rule === 'duplicate_device')).toBe(true);
    expect(rb.signals.some((s) => s.rule === 'duplicate_device')).toBe(true);
    expect(ra.score >= 25 && rb.score >= 25).toBe(true);
  });

  it('ip sharing fires +20 only when >2 users share the prefix', async () => {
    await seedConfirmed({ npm: '800004', studentTrack: 'clinical', thesisTrack: 'clinical', ip: '152.118.24.0' });
    await seedConfirmed({ npm: '800005', studentTrack: 'clinical', thesisTrack: 'clinical', ip: '152.118.24.0' });
    const third = await seedConfirmed({ npm: '800006', studentTrack: 'clinical', thesisTrack: 'clinical', ip: '152.118.24.0' });
    const r3 = await scorer.scoreSelection(third.selectionId);
    expect(r3.signals.find((s) => s.rule === 'ip_sharing')?.points).toBe(20);
    expect((r3.signals.find((s) => s.rule === 'ip_sharing')?.evidence as { usersOnIp: number }).usersOnIp).toBe(3);
  });

  it('lock-to-confirm <2s fires +15', async () => {
    const sel = await seedConfirmed({
      npm: '800007',
      studentTrack: 'clinical',
      thesisTrack: 'clinical',
      lockMsAgo: 5_000,
      confirmedMsAgo: 4_200, // 800ms after lock
    });
    const result = await scorer.scoreSelection(sel.selectionId);
    const fast = result.signals.find((s) => s.rule === 'fast_confirm');
    expect(fast?.points).toBe(15);
    expect((fast?.evidence as { milliseconds: number }).milliseconds).toBeLessThan(2000);
  });

  it('pre-opens_at attempts (+15) and device rebinds (+20) come from activity_logs', async () => {
    const sel = await seedConfirmed({ npm: '800008', studentTrack: 'clinical', thesisTrack: 'clinical' });

    // persist both signals exactly like F3/F5 producers do
    await app.db.execute(sql`
      INSERT INTO activity_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
      SELECT s.user_id, 'student', 'integrity.preopen_attempt', 'period_enrollment', pe.id,
             jsonb_build_object('periodId', pe.period_id)
      FROM students s JOIN period_enrollments pe ON pe.student_id = s.id
      WHERE s.npm = '800008'
    `);
    await app.db.execute(sql`
      INSERT INTO activity_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
      SELECT s.user_id, 'student', 'integrity.device_rebind_attempt', 'period_enrollment', pe.id,
             jsonb_build_object('periodId', pe.period_id)
      FROM students s JOIN period_enrollments pe ON pe.student_id = s.id
      WHERE s.npm = '800008'
    `);

    const result = await scorer.scoreSelection(sel.selectionId);
    const rules = Object.fromEntries(result.signals.map((s) => [s.rule, s.points]));
    expect(rules['preopen_attempt']).toBe(15);
    expect(rules['rebind_attempt']).toBe(20);
  });

  it('weights SUM correctly → HIGH band at ≥70 with all signals present', async () => {
    // track mismatch(25) + fast confirm(15) + rebind(20) = 60 MEDIUM…
    const base = await seedConfirmed({
      npm: '800010',
      studentTrack: 'community',
      thesisTrack: 'clinical',
      lockMsAgo: 6_000,
      confirmedMsAgo: 5_500,
      ip: '10.9.9.9',
    });
    await app.db.execute(sql`
      INSERT INTO activity_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
      SELECT s.user_id, 'student', 'integrity.device_rebind_attempt', 'period_enrollment', pe.id, '{}'::jsonb
      FROM students s JOIN period_enrollments pe ON pe.student_id = s.id WHERE s.npm = '800010'
    `);
    // push over 70: duplicate device with another holder
    const twinFp = 'high-twin-' + crypto.randomUUID().slice(0, 5);
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET device_fingerprint_hash = ${twinFp}
      FROM students s WHERE s.id = pe.student_id AND s.npm = '800010'
    `);
    await seedConfirmed({ npm: '800011', studentTrack: 'basic', thesisTrack: 'basic', fingerprint: twinFp });

    const result = await scorer.scoreSelection(base.selectionId);
    const sum = result.signals.reduce((acc, s) => acc + s.points, 0);
    expect(result.score).toBe(Math.min(100, sum));
    expect(result.level).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(70);
  });
});

describe('banding behavior via service runner (worker-equivalent)', () => {
  let svc: import('../../src/modules/integrity/integrity.service.js').IntegrityService;

  beforeAll(async () => {
    const mod = await import('../../src/modules/integrity/integrity.service.js');
    svc = new mod.IntegrityService(
      app.db,
      { async send() { return { providerId: 'test' }; } },
      { emit: () => undefined, on: () => () => undefined } as never,
      { log: () => undefined } as never,
      redis,
    );
  });

  it('HIGH notifies admins+lecturer ONCE — retry/re-score is duplicate-proof', async () => {
    // craft HIGH: track mismatch(25)+fast(15)+rebind(20)+duplicate(25) = 85
    const fp = 'high-band-' + crypto.randomUUID().slice(0, 5);
    const owner = await seedConfirmed({
      npm: '800012',
      studentTrack: 'community',
      thesisTrack: 'clinical',
      fingerprint: fp,
      lockMsAgo: 5_000,
      confirmedMsAgo: 4_500,
    });
    await seedConfirmed({ npm: '800013', studentTrack: 'basic', thesisTrack: 'basic', fingerprint: fp });
    await app.db.execute(sql`
      INSERT INTO activity_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
      SELECT s.user_id, 'student', 'integrity.device_rebind_attempt', 'period_enrollment', pe.id, '{}'::jsonb
      FROM students s JOIN period_enrollments pe ON pe.student_id = s.id WHERE s.npm = '800012'
    `);

    const run1 = await svc.runScore(owner.selectionId);
    expect(run1.level).toBe('high');

    const deliveries1 = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM notification_deliveries
      WHERE template='integrity_high' AND payload->>'selectionId'=${owner.selectionId}
    `)) as unknown as { rows: Array<{ n: number }> };

    // re-run (job retry / re-confirm path)
    const run2 = await svc.runScore(owner.selectionId);
    expect(run2.level === 'high' || run2.skipped === 'already-reviewed').toBe(true);

    const deliveries2 = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM notification_deliveries
      WHERE template='integrity_high' AND payload->>'selectionId'=${owner.selectionId}
    `)) as unknown as { rows: Array<{ n: number }> };

    expect(deliveries1.rows[0]?.n).toBeGreaterThan(0);
    expect(deliveries2.rows[0]?.n).toBe(deliveries1.rows[0]?.n); // unchanged

    // NO auto-revoke ever
    const status = (
      (await app.db.execute(sql`SELECT status FROM thesis_selections WHERE id=${owner.selectionId}`)) as unknown as {
        rows: Array<{ status: string }>;
      }
    ).rows[0]!.status;
    expect(status).toBe('confirmed');
  }, 60_000);

  it('MEDIUM queues; CLEAN stays hidden from dashboards', async () => {
    // medium: track mismatch alone = 25? no → need 40..69: mismatch(25)+fast(15)=40
    const med = await seedConfirmed({
      npm: '800014',
      studentTrack: 'community',
      thesisTrack: 'clinical',
      lockMsAgo: 5_000,
      confirmedMsAgo: 4_400,
    });
    const rMed = await svc.runScore(med.selectionId);
    expect(rMed.level).toBe('medium');
    const inQueue = await svc.queue({ level: 'medium', page: 1, pageSize: 100 });
    expect(inQueue.rows.some((r) => r.selectionId === med.selectionId)).toBe(true);

    // clean: no signals → no flag row at all
    const clean = await seedConfirmed({ npm: '800015', studentTrack: 'clinical', thesisTrack: 'clinical' });
    const rClean = await svc.runScore(clean.selectionId);
    expect(rClean.level).toBe('clean');
    const flags = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM integrity_flags WHERE selection_id=${clean.selectionId}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(flags.rows[0]?.n).toBe(0);
  }, 60_000);

  it('lecturer scoping: A cannot see or resolve B-scoped flags; resolve without note → 400; actions audited; revoked outcome really revokes via bus', async () => {
    // B owns a flagged selection (track mismatch + fast = MEDIUM)
    const bSel = await seedConfirmed({
      npm: '800016',
      studentTrack: 'community',
      thesisTrack: 'clinical',
      lockMsAgo: 5_000,
      confirmedMsAgo: 4_300,
      titleSuffix: 'B-owned',
    });
    // assign THIS thesis to lecturer B explicitly
    await app.db.execute(sql`
      UPDATE theses SET lecturer_id = (SELECT l.id FROM lecturers l
        JOIN users u ON u.id = l.user_id WHERE u.email = ${LEC_B.email})
      WHERE id = ${bSel.thesisId}
    `);
    await svc.runScore(bSel.selectionId);

    // B sees it
    const bQueue = await svc.queue({ lecturerUserId: (await userOf(LEC_B.email)), page: 1, pageSize: 100 });
    const bFlag = bQueue.rows.find((r) => r.selectionId === bSel.selectionId) as { id: string } | undefined;
    expect(bFlag).toBeTruthy();

    // A's HTTP queue must NOT contain B's flag (server-side scoping)
    const aHttp = await fetch(`${app.url}/api/lecturer/integrity?page=1&pageSize=100`, {
      headers: { authorization: `Bearer ${lecAToken}` },
    });
    const aRows = ((await aHttp.json()) as { rows: Array<{ selectionId: string }> }).rows;
    expect(aRows.some((r) => r.selectionId === bSel.selectionId)).toBe(false);

    // A resolving B's flag over HTTP → 404 (scoped out)
    const crossResolve = await fetch(`${app.url}/api/lecturer/integrity/${bFlag!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lecAToken}` },
      body: JSON.stringify({ outcome: 'investigate', note: 'scope probe note' }),
    });
    expect([403, 404]).toContain(crossResolve.status);

    // resolve without note → 400 (even for the rightful owner)
    const noNote = await fetch(`${app.url}/api/lecturer/integrity/${bFlag!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lecBToken}` },
      body: JSON.stringify({ outcome: 'investigate', note: '' }),
    });
    expect(noNote.status).toBe(400);

    // B resolves properly → audited
    const ok = await fetch(`${app.url}/api/lecturer/integrity/${bFlag!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lecBToken}` },
      body: JSON.stringify({ outcome: 'investigate', note: 'Spoke with the student; legitimate.' }),
    });
    expect(ok.status).toBe(201);
    const audit = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action='integrity.resolve'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(audit.rows[0]?.n).toBeGreaterThan(0);

    // revoked outcome REALLY revokes through the bus (swap module performs it)
    const cSel = await seedConfirmed({
      npm: '800017',
      studentTrack: 'community',
      thesisTrack: 'clinical',
      lockMsAgo: 5_000,
      confirmedMsAgo: 4_300,
      titleSuffix: 'C-owned-revoke',
    });
    // put under lecturer A so A can resolve it
    await app.db.execute(sql`
      UPDATE theses SET lecturer_id = (SELECT l.id FROM lecturers l
        JOIN users u ON u.id = l.user_id WHERE u.email = ${LEC_A.email})
      WHERE id = ${cSel.thesisId}
    `);
    const rC = await svc.runScore(cSel.selectionId);
    expect(rC.level).toBe('medium');
    const aQueueHttp = await fetch(`${app.url}/api/lecturer/integrity?page=1&pageSize=100`, {
      headers: { authorization: `Bearer ${lecAToken}` },
    });
    const aFlag = ((await aQueueHttp.json()) as { rows: Array<{ id: string; selectionId: string }> })
      .rows.find((r) => r.selectionId === cSel.selectionId)!;

    const attemptsBefore = (
      (await app.db.execute(sql`
        SELECT pe.attempts_left FROM period_enrollments pe
        JOIN students s ON s.id = pe.student_id WHERE s.npm = '800017'
      `)) as unknown as { rows: Array<{ attempts_left: number }> }
    ).rows[0]!.attempts_left;

    const revokeResolve = await fetch(`${app.url}/api/lecturer/integrity/${aFlag.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lecAToken}` },
      body: JSON.stringify({ outcome: 'revoked', note: 'Confirmed misconduct after review.' }),
    });
    expect(revokeResolve.status).toBe(201);

    // bus-driven revoke is async — allow a beat
    await new Promise((r) => setTimeout(r, 300));
    const finalStatus = (
      (await app.db.execute(sql`SELECT status FROM thesis_selections WHERE id=${cSel.selectionId}`)) as unknown as {
        rows: Array<{ status: string }>;
      }
    ).rows[0]!.status;
    expect(finalStatus).toBe('expired');
    const attemptsAfter = (
      (await app.db.execute(sql`
        SELECT pe.attempts_left FROM period_enrollments pe
        JOIN students s ON s.id = pe.student_id WHERE s.npm = '800017'
      `)) as unknown as { rows: Array<{ attempts_left: number }> }
    ).rows[0]!.attempts_left;
    expect(attemptsAfter).toBe(attemptsBefore + 1);
  }, 90_000);
});

async function userOf(email: string): Promise<string> {
  const res = (await app.db.execute(sql`SELECT id FROM users WHERE email=${email}`)) as unknown as {
    rows: Array<{ id: string }>;
  };
  return res.rows[0]!.id;
}
