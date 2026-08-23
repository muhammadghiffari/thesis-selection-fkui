import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F2 bulk actions must be idempotent: running twice yields the same
 * final state (no double attempts, no duplicate intents, no errors).
 */

let app: TestApp;
const ADMIN = { email: 'bulk-admin@fkui.or.id', password: 'admin-pass-123' };
let token = '';
let periodId = '';
let studentIds: string[] = [];

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  token = ((await login.json()) as { accessToken: string }).accessToken;

  // import two students to act on
  const commit = await fetch(`${app.url}/api/admin/students/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      rows: [
        { npm: '880001', fullName: 'Bulk One', email: 'bulk1@ui.ac.id', classType: 'regular', researchTrack: 'clinical' },
        { npm: '880002', fullName: 'Bulk Two', email: 'bulk2@ui.ac.id', classType: 'kki', researchTrack: 'basic' },
      ],
    }),
  });
  expect(commit.status).toBe(201);

  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `Bulk-${crypto.randomUUID()}`, academicYear: '2026/2027' }),
  });
  periodId = String((((await period.json()) as { id?: string }).id));

  // capture the student ids created by the import
  const list = await fetch(`${app.url}/api/admin/students?pageSize=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = ((await list.json()) as { rows: Array<{ id: string; npm: string }> }).rows;
  studentIds = rows.filter((r) => ['880001', '880002'].includes(r.npm)).map((r) => r.id);
}, 300_000);

afterAll(async () => {
  await app?.close();
});

async function bulk(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api/admin/students/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, studentIds, periodId }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function enrollmentRows(): Promise<Array<{ attempts_left: number }>> {
  const res = (await app.db.execute(sql`
    SELECT pe.attempts_left FROM period_enrollments pe WHERE pe.period_id = ${periodId}
    ORDER BY pe.attempts_left
  `)) as unknown as { rows: Array<{ attempts_left: number }> };
  return res.rows;
}

describe('bulk actions idempotency', () => {
  it('assign_slots twice → same final state', async () => {
    const first = await bulk({ action: 'assign_slots', attempts: 7 });
    expect(first.status).toBe(201);
    const second = await bulk({ action: 'assign_slots', attempts: 7 });
    expect(second.status).toBe(201);

    const rows = await enrollmentRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.attempts_left === 7)).toBe(true);
  });

  it('reset_attempts twice → back to default value, no extra rows', async () => {
    await bulk({ action: 'assign_slots', attempts: 9 });
    const reset = await bulk({ action: 'reset_attempts' }); // default 4
    const reset2 = await bulk({ action: 'reset_attempts' });
    expect(reset.status).toBe(201);
    expect(reset2.status).toBe(201);
    expect(reset2.json.affected).toBe(2);

    const rows = await enrollmentRows();
    expect(rows.length).toBe(2); // still one row per student
    expect(rows.every((r) => r.attempts_left === 4)).toBe(true);
  });

  it('send_magic_links twice → single queued intent per student', async () => {
    const first = await bulk({ action: 'send_magic_links' });
    const second = await bulk({ action: 'send_magic_links' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.json.affected).toBe(2);
    expect(second.json.affected).toBe(0); // already queued

    const intents = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM notification_deliveries
      WHERE template = 'magic_link' AND status = 'queued'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(intents.rows[0]?.n).toBe(2);
  });

  it('deactivate is idempotent and hides students from listing', async () => {
    const first = await bulk({ action: 'deactivate' });
    const second = await bulk({ action: 'deactivate' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const deleted = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM users u
      JOIN students s ON s.user_id = u.id
      WHERE s.npm IN ('880001','880002') AND u.deleted_at IS NOT NULL
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(deleted.rows[0]?.n).toBe(2);

    const list = await fetch(`${app.url}/api/admin/students?search=88`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await list.json()) as { total: number };
    expect(body.total).toBe(0);

    void eq;
  });
});
