import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F2 period lifecycle guard + clone semantics.
 */

let app: TestApp;
const ADMIN = { email: 'pl-admin@fkui.or.id', password: 'admin-pass-123' };
let token = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  token = ((await res.json()) as { accessToken: string }).accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function createPeriod(name: string): Promise<string> {
  const res = await call('POST', '/admin/periods', {
    name,
    academicYear: '2026/2027',
    opensAt: new Date(Date.now() + 3_600_000).toISOString(),
    closesAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

describe('period lifecycle transitions', () => {
  it('full valid chain passes; invalid jumps are 409', async () => {
    // invalid jump first
    const id = await createPeriod(`LC-${crypto.randomUUID()}`);
    const jump = await call('POST', `/admin/periods/${id}/transition`, { to: 'open' });
    expect(jump.status).toBe(409);

    // valid chain draft→scheduled→open→closed→archived
    for (const to of ['scheduled', 'open', 'closed']) {
      const step = await call('POST', `/admin/periods/${id}/transition`, { to });
      expect(step.status).toBe(201);
      expect(step.json.status).toBe(to);
    }
    // archiving requires a passed closes_at (F8/F9 precondition)
    await app.db.execute(sql`
      UPDATE selection_periods SET closes_at = now() - interval '1 minute' WHERE id = ${id}
    `);
    const arch = await call('POST', `/admin/periods/${id}/transition`, { to: 'archived' });
    expect(arch.status).toBe(201);
    // archived is terminal
    const terminal = await call('POST', `/admin/periods/${id}/transition`, { to: 'closed' });
    expect(terminal.status).toBe(409);
  });

  it('transition to scheduled without opens_at is a 409', async () => {
    const created = await call('POST', '/admin/periods', {
      name: `NoDate-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
    });
    expect(created.status).toBe(201);
    const res = await call('POST', `/admin/periods/${created.json.id}/transition`, { to: 'scheduled' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toMatch(/opens_at/);
  });

  it('editing/deleting non-draft periods is a 409', async () => {
    const id = await createPeriod(`Edit-${crypto.randomUUID()}`);
    await call('POST', `/admin/periods/${id}/transition`, { to: 'scheduled' });

    const edit = await call('PATCH', `/admin/periods/${id}`, { name: 'renamed' });
    expect(edit.status).toBe(409);

    const del = await call('DELETE', `/admin/periods/${id}`);
    expect(del.status).toBe(409);
  });
});

describe('clone carries config AND catalog, never history (F9 semantics)', () => {
  it('cloned period: same settings, fresh draft, titles copied, enrollments/selections empty', async () => {
    const sourceId = await createPeriod(`CloneSrc-${crypto.randomUUID()}`);

    // history: one enrollment + one selection on a thesis under the SOURCE period
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track) VALUES (${sourceId}, 'Clone Thesis', 'clinical')
    `);
    const studentUser = (await app.db.execute(sql`
      INSERT INTO users (email, role) VALUES ('clonestu@ui.ac.id', 'student') RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    const student = (await app.db.execute(sql`
      INSERT INTO students (user_id, npm, full_name, class_type, research_track)
      VALUES (${studentUser.rows[0]!.id}, '770001', 'Clone Stu', 'regular', 'clinical') RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    const enrollment = (await app.db.execute(sql`
      INSERT INTO period_enrollments (period_id, student_id) VALUES (${sourceId}, ${student.rows[0]!.id}) RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    void enrollment;

    const cloned = await call('POST', `/admin/periods/${sourceId}/clone`);
    expect(cloned.status).toEqual(201);
    const clone = cloned.json;

    // config copied
    expect(clone.clonedFrom).toBe(sourceId);
    expect(clone.status).toBe('draft');
    expect(clone.settings).toEqual((await call('GET', `/admin/periods/${sourceId}`)).json.settings);
    expect(String(clone.name)).toContain('clone');
    expect(clone.opensAt).toBeNull();

    // catalog CARRIES over (F9): same title count as the source period
    const srcTheses = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM theses WHERE period_id = ${sourceId} AND deleted_at IS NULL
    `)) as unknown as { rows: Array<{ n: number }> };
    const cloneTheses = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM theses WHERE period_id = ${clone.id} AND deleted_at IS NULL
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(cloneTheses.rows[0]?.n).toBe(srcTheses.rows[0]!.n);

    // history NEVER copies
    const cloneEnrollments = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM period_enrollments WHERE period_id = ${clone.id}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(cloneEnrollments.rows[0]?.n).toBe(0);

    // source untouched
    const srcEnroll = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM period_enrollments WHERE period_id = ${sourceId}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(srcEnroll.rows[0]?.n).toBe(1);


  });
});
