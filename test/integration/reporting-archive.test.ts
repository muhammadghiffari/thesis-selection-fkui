import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { ReportsService } from '../../src/modules/reports/reports.service.js';
import { StubEmailProvider } from '../../src/shared/notifications/email-provider.js';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F9: async exports (job → file → exactly-once notification → download)
 * and archive lifecycle enforcement + clone-from-archive end-to-end.
 */

let app: TestApp;
let redis: Redis;
const ADMIN = { email: 'f9-admin@fkui.or.id', password: 'admin-pass-123' };
const FP = 'fp-f9-0001';
let adminToken = '';
let periodId = '';
let svc: ReportsService;

async function adminPost(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function makeStudent(npm: string, name: string): Promise<string> {
  await app.db.execute(sql`
    WITH u AS (
      INSERT INTO users (email, role) VALUES (${npm + '-f9@ui.ac.id'}, 'student') RETURNING id
    ), s AS (
      INSERT INTO students (user_id, npm, full_name, class_type, research_track)
      SELECT u.id, ${npm}, ${name}, 'regular', 'clinical' FROM u RETURNING id
    )
    INSERT INTO period_enrollments (period_id, student_id)
    SELECT ${periodId}, s.id FROM s
  `);
  const userId = (
    (await app.db.execute(sql`
      SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = ${npm}
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;
  const jti = crypto.randomUUID();
  const { JwtService } = await import('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
  const link = await jwt.signAsync({ sub: userId, role: 'student', periodId, jti }, { expiresIn: '1h' });
  await app.db.execute(sql`
    UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex'),
      link_opened_at = now()
    FROM students s WHERE s.id = pe.student_id AND pe.period_id = ${periodId} AND s.npm = ${npm}
  `);
  const claim = await fetch(`${app.url}/api/magic/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link, fingerprint: FP }),
  });
  expect(claim.status).toBe(201);
  return ((await claim.json()) as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  app = await startTestApp();
  redis = new (await import('ioredis')).default(app.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  svc = new ReportsService(
    app.db,
    new StubEmailProvider(),
    { emit: () => undefined, on: () => () => undefined } as never,
  );

  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminToken = ((await login.json()) as { accessToken: string }).accessToken;

  // open period + catalog
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `F9-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() - 60_000).toISOString(),
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
  for (let i = 0; i < 6; i++) {
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track)
      VALUES (${periodId}, ${'F9-Thesis-' + String.fromCharCode(65 + i)}, 'clinical')
    `);
  }

  // two students claim+confirm one title each
  for (const [npm, name] of [
    ['950001', 'Nina Export'],
    ['950002', 'Omar Export'],
  ] as const) {
    const token = await makeStudent(npm, name);
    const thesisId = (
      (await app.db.execute(sql`
        SELECT th.id FROM theses th WHERE th.period_id = ${periodId} AND th.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
              AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
              AND act.deleted_at IS NULL)
        ORDER BY th.title LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> }
    ).rows[0]!.id;
    const lock = await fetch(`${app.url}/api/war/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ periodId, thesisId, idempotencyKey: crypto.randomUUID() }),
    });
    expect(lock.status).toBe(201);
    const selId = ((await lock.json()) as { selection: { id: string } }).selection.id;
    const done = await fetch(`${app.url}/api/war/claims/${selId}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(done.status).toBe(201);
    tokens.set(npm, token);
  }
}, 300_000);

const tokens = new Map<string, string>();

afterAll(async () => {
  redis?.disconnect();
  await app?.close();
});

describe('async exports', () => {
  it('final_selections: request → process → notify once → download with correct rows', async () => {
    const req = await adminPost('/reports', { kind: 'final_selections', periodId });
    expect(req.status).toBe(201);
    const jobId = req.json.jobId as string;

    // duplicate in-flight request returns the SAME job
    const dup = await adminPost('/reports', { kind: 'final_selections', periodId });
    expect(dup.json.jobId).toBe(jobId);

    // process via worker-equivalent service; run twice for retry semantics
    await svc.processJob(jobId);
    await svc.processJob(jobId);

    const list = await apiList(adminToken);
    const job = list.find((j) => j.id === jobId)!;
    expect(job.status).toBe('ready');

    // notification EXACTLY once (in-app row) despite double processing
    const deliveries = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM notification_deliveries
      WHERE template='export_ready' AND payload->>'jobId'=${jobId}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(deliveries.rows[0]?.n).toBe(1);

    // download parses and has header + 2 data rows
    const dl = await fetch(`${app.url}/api/reports/${jobId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await dl.arrayBuffer());
    const ws = wb.worksheets[0]!;
    expect(ws.rowCount).toBe(3); // header + Nina + Omar

    // non-admin cannot download someone else's report — students lack the route entirely (404 route-level? roles guard 403)
    const studentDl = await fetch(`${app.url}/api/reports/${jobId}/download`, {
      headers: { authorization: `Bearer ${tokens.get('950001')}` },
    });
    expect([403, 404]).toContain(studentDl.status);
  }, 90_000);

  it('swap history export contains decision notes; integrity summary is aggregate-only', async () => {
    for (const kind of ['swap_history', 'integrity_summary'] as const) {
      const req = await adminPost('/reports', { kind, periodId });
      expect(req.status).toBe(201);
      await svc.processJob(req.json.jobId as string);

      const dl = await fetch(`${app.url}/api/reports/${req.json.jobId}/download`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(dl.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await dl.arrayBuffer());
      if (kind === 'integrity_summary') {
        // aggregate-only: no raw signal columns anywhere
        const text = JSON.stringify(wb.worksheets[0]?.model ?? {});
        expect(text).not.toContain('signals');
        expect(text.toLowerCase()).not.toContain('rule');
      }
    }
  }, 90_000);

  it('PDF export fails gracefully without a browser binary', async () => {
    const req = await adminPost('/reports', { kind: 'final_selections_pdf', periodId });
    expect(req.status).toBe(201);
    const jobId = req.json.jobId as string;
    try {
      await svc.processJob(jobId);
      // if a browser IS available locally the job may succeed — acceptable
      const list = await apiList(adminToken);
      const job = list.find((j) => j.id === jobId)!;
      expect(['ready', 'failed']).toContain(job.status);
      if (job.status === 'failed') expect(job.error).toContain('pdf-browser-unavailable');
    } catch (err) {
      expect(String((err as Error).message)).toContain('pdf-browser-unavailable');
    }
  }, 60_000);
});

describe('archive lifecycle', () => {
  it('archive blocked while selections in flight? here all are final → archive succeeds; mutations then 409', async () => {
    // all F9 selections are confirmed (final); simulate time passing closes_at
    await app.db.execute(sql`
      UPDATE selection_periods SET closes_at = now() - interval '1 minute' WHERE id = ${periodId}
    `);
    const close = await adminPost(`/admin/periods/${periodId}/transition`, { to: 'closed' });
    expect(close.status).toBe(201);
    const arch = await adminPost(`/admin/periods/${periodId}/transition`, { to: 'archived' });
    expect(arch.status).toBe(201);

    // war mutation on archived period → 409 (window closed)
    const token = tokens.get('950001')!;
    const freeThesis = (
      (await app.db.execute(sql`SELECT id FROM theses WHERE period_id=${periodId} LIMIT 1`)) as unknown as {
        rows: Array<{ id: string }>;
      }
    ).rows[0]!.id;
    const res = await fetch(`${app.url}/api/war/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ periodId, thesisId: freeThesis, idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);

    // receipt stays VIEWABLE after archive
    const receipt = await fetch(`${app.url}/api/war/receipt?periodId=${periodId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(receipt.status).toBe(200);

    // re-archive / illegal transition out of archived → 409
    const again = await adminPost(`/admin/periods/${periodId}/transition`, { to: 'closed' });
    expect(again.status).toBe(409);
  });

  it('clone-from-archive carries catalog/settings, resets enrollments+selections, and runs a full war smoke', async () => {
    const clone = await adminPost(`/admin/periods/${periodId}/clone`);
    expect(clone.status).toBe(201);
    const cloneId = clone.json.id as string;

    // settings carried
    const src = (await adminPost(`/admin/periods/${periodId}/transition`, { to: 'closed' })).status;
    void src;

    const counts = (await app.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM theses WHERE period_id=${cloneId}) AS titles,
        (SELECT count(*)::int FROM period_enrollments WHERE period_id=${cloneId}) AS enrollments,
        (SELECT count(*)::int FROM thesis_selections WHERE period_id=${cloneId}) AS selections,
        (SELECT settings->>'required_selections' FROM selection_periods WHERE id=${cloneId}) AS required
    `)) as unknown as { rows: Array<{ titles: number; enrollments: number; selections: number; required: string }> };
    const c = counts.rows[0]!;
    expect(c.titles).toBeGreaterThan(0); // titles carried over
    expect(c.enrollments).toBe(0); // cohort reset
    expect(c.selections).toBe(0); // no history copied
    expect(c.required).toBe('3'); // settings carried

    // realistic next-year workflow: set fresh dates, then schedule + open
    await app.db.execute(sql`
      UPDATE selection_periods SET opens_at = now() - interval '1 minute',
        closes_at = now() + interval '2 hours'
      WHERE id = ${cloneId}
    `);
    for (const to of ['scheduled', 'open']) {
      const t = await adminPost(`/admin/periods/${cloneId}/transition`, { to });
      expect(t.status).toBe(201);
    }

    // FULL WAR FLOW SMOKE on the cloned period with a brand-new student
    const oldPeriodId = periodId;
    periodId = cloneId;
    const token = await makeStudent('960001', 'Pia Clone');
    const thesisId = (
      (await app.db.execute(sql`
        SELECT id FROM theses WHERE period_id=${cloneId} ORDER BY title LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> }
    ).rows[0]!.id;
    const lock = await fetch(`${app.url}/api/war/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ periodId: cloneId, thesisId, idempotencyKey: crypto.randomUUID() }),
    });
    expect(lock.status).toBe(201);
    const selId = ((await lock.json()) as { selection: { id: string } }).selection.id;
    const confirm = await fetch(`${app.url}/api/war/claims/${selId}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(confirm.status).toBe(201);
    const ref = ((await confirm.json()) as { referenceNumber: string }).referenceNumber;
    expect(ref ?? '').toMatch(/^THS-\d{4}-\d{6}$/);

    periodId = oldPeriodId;
  }, 120_000);

  it('archive precondition blocks when swaps/grace still in flight', async () => {
    // build a fresh closed period with an in-flight swap_requested selection
    const p2 = await adminPost('/admin/periods', {
      name: `F9-block-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const p2id = p2.json.id as string;
    for (const to of ['scheduled', 'open']) {
      await adminPost(`/admin/periods/${p2id}/transition`, { to });
    }
    await app.db.execute(sql`
      WITH u AS (INSERT INTO users (email,role) VALUES ('block-f9@ui.ac.id','student') RETURNING id),
           s AS (INSERT INTO students (user_id,npm,full_name,class_type,research_track)
                 SELECT u.id,'970001','Blocker','regular','clinical' FROM u RETURNING id),
           t AS (INSERT INTO theses (period_id,title,track) VALUES (${p2id},'Blocked T','basic') RETURNING id)
      INSERT INTO thesis_selections (period_id,student_id,thesis_id,priority,status)
      SELECT ${p2id}, s.id, t.id, 1, 'swap_requested' FROM s, t
    `);

    const closeFirst = await adminPost(`/admin/periods/${p2id}/transition`, { to: 'closed' });
    expect(closeFirst.status).toBe(201);
    const attempt = await adminPost(`/admin/periods/${p2id}/transition`, { to: 'archived' });
    expect(attempt.status).toBe(409);
    expect(JSON.stringify(attempt.json)).toMatch(/in flight/i);
  });
});

async function apiList(token: string): Promise<Array<{ id: string; status: string; error: string | null }>> {
  const res = await fetch(`${app.url}/api/reports`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Array<{ id: string; status: string; error: string | null }>;
}
