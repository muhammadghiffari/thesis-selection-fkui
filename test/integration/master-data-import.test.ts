import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F2 master-data import/export flows over real HTTP:
 * preview/commit validation edges for students + theses.
 */

let app: TestApp;
const ADMIN = { email: 'md-admin@fkui.or.id', password: 'admin-pass-123' };
let periodId = '';

beforeAll(async () => {
  app = await startTestApp();
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
}, 300_000);

afterAll(async () => {
  await app?.close();
});

function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function admin(): Promise<string> {
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function postJson(path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function uploadPreview(path: string, token: string, file: { name: string; type: string; data: Buffer | Blob }) {
  const form = new FormData();
  form.append('file', new Blob([file.data as unknown as Uint8Array], { type: file.type }), file.name);
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: authed(token),
    body: form,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function csv(rows: string[]): Buffer {
  return Buffer.from(['npm,full_name,email,class_type,research_track', ...rows].join('\n'));
}

async function xlsx(rows: Array<Array<string | number>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('students');
  ws.addRow(['npm', 'full_name', 'email', 'class_type', 'research_track']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

interface PreviewRow {
  line: number;
  errors: Record<string, string>;
  data: Record<string, string>;
}
function rowsOf(json: Record<string, unknown>): PreviewRow[] {
  return json.rows as PreviewRow[];
}

describe('student import — validation edge cases', () => {
  let token = '';
  beforeAll(async () => {
    token = await admin();
    const period = await postJson('/admin/periods', token, {
      name: `Import Period ${crypto.randomUUID()}`,
      academicYear: '2026/2027',
    });
    periodId = period.json.id as string;
  });

  it('happy path via xlsx: all rows valid and committed', async () => {
    const buf = await xlsx([
      [900001, 'Budi Santoso', 'budi-1@ui.ac.id', 'regular', 'clinical'],
      [900002, 'Siti Aminah', 'siti-1@ui.ac.id', 'kki', 'community'],
    ]);
    const preview = await uploadPreview('/admin/students/import/preview', token, {
      name: 'cohort.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: buf,
    });
    expect(preview.status).toBe(201);
    expect(preview.json.valid).toBe(2);

    const commit = await postJson('/admin/students/import/commit', token, {
      rows: rowsOf(preview.json).map((r) => r.data),
    });
    expect(commit.status).toBe(201);
    expect((commit.json.inserted as unknown[]).length).toBe(2);
    expect(commit.json.skipped).toEqual([]);
  });

  it('marks non-numeric NPM and wrong-domain email invalid', async () => {
    const preview = await uploadPreview('/admin/students/import/preview', token, {
      name: 'bad.csv',
      type: 'text/csv',
      data: csv(['12a3,Bad NPM,badnpm@ui.ac.id,regular,clinical', '900003,Wrong Domain,wrong@gmail.com,regular,basic']),
    });
    const rows = rowsOf(preview.json);
    expect(rows[0]?.errors.npm).toMatch(/strictly numeric/);
    expect(rows[1]?.errors.email).toMatch(/must end with/);
  });

  it('detects duplicates within the file (by npm and by email)', async () => {
    const preview = await uploadPreview('/admin/students/import/preview', token, {
      name: 'dups.csv',
      type: 'text/csv',
      data: csv([
        '900010,Dup One,dup-one@ui.ac.id,regular,clinical',
        '900010,Dup Two,dup-two@ui.ac.id,regular,clinical',
        '900011,Dup Three,dup-one@ui.ac.id,regular,clinical',
      ]),
    });
    const rows = rowsOf(preview.json);
    expect(rows[0]?.errors).toEqual({});
    expect(rows[1]?.errors.npm).toMatch(/within file/);
    expect(rows[2]?.errors.email).toMatch(/within file/);
  });

  it('detects duplicates against the database', async () => {
    // npm 900001 was committed in the happy-path test above
    const preview = await uploadPreview('/admin/students/import/preview', token, {
      name: 'dbdup.csv',
      type: 'text/csv',
      data: csv(['900001,DB Dup,budi-1@ui.ac.id,regular,clinical']),
    });
    const rows = rowsOf(preview.json);
    expect(rows[0]?.errors.npm).toMatch(/database/);
    expect(rows[0]?.errors.email).toMatch(/database/);
  });

  it('commit re-validates: only valid rows land, invalid reported skipped', async () => {
    const commit = await postJson('/admin/students/import/commit', token, {
      rows: [
        { npm: '900050', fullName: 'Valid Row', email: 'valid-row@ui.ac.id', classType: 'regular', researchTrack: 'basic' },
        { npm: '90x051', fullName: 'Bad Row', email: 'bad-row@ui.ac.id', classType: 'regular', researchTrack: 'basic' },
      ],
    });
    expect(commit.status).toBe(201);
    expect((commit.json.inserted as unknown[]).length).toBe(1);
    expect((commit.json.skipped as unknown[]).length).toBe(1);
  });

  it('empty file → 400; wrong extension → 400; oversized → 400', async () => {
    const empty = await uploadPreview('/admin/students/import/preview', token, {
      name: 'empty.csv',
      type: 'text/csv',
      data: Buffer.from(''),
    });
    expect(empty.status).toBe(400);

    const wrongExt = await uploadPreview('/admin/students/import/preview', token, {
      name: 'data.txt',
      type: 'text/plain',
      data: Buffer.from('hello'),
    });
    expect(wrongExt.status).toBe(400);
    expect(JSON.stringify(wrongExt.json)).toMatch(/Unsupported file type/);

    const big = await uploadPreview('/admin/students/import/preview', token, {
      name: 'huge.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Buffer.alloc(6 * 1024 * 1024, 7),
    });
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.json)).toMatch(/too large/i);
  });
});

describe('thesis import (admin-only surface)', () => {
  it('commits valid theses, resolves lecturer names, rejects bad tracks/dups vs DB', async () => {
    const token = await admin();

    const preview = await uploadPreview(`/admin/theses/import/preview?periodId=${periodId}`, token, {
      name: 'theses.csv',
      type: 'text/csv',
      data: Buffer.from(
        [
          'title,track,lecturer_full_name,max_claims',
          'Biomarkers of X in Y,clinical,dr. Ali,2',
          'Community nutrition model,community,dr. Ali,1',
          'Bad track row,molecular,dr. Budi,1',
        ].join('\n'),
      ),
    });
    expect(preview.status).toBe(201);
    const rows = rowsOf(preview.json);
    expect(rows[2]?.errors.track).toBeDefined();

    const commit = await postJson('/admin/theses/import/commit', token, {
      periodId,
      rows: rows.filter((r) => Object.keys(r.errors).length === 0).map((r) => ({
        title: r.data.title,
        track: r.data.track,
        // validated rows expose camelCase fields regardless of CSV headers
        lecturerFullName: r.data.lecturerFullName,
        maxClaims: Number(r.data.maxClaims),
      })),
    });
    expect(commit.status).toBe(201);
    expect((commit.json.inserted as unknown[]).length).toBe(2);
  });

  it('rejects duplicate title vs DB on second commit', async () => {
    const token = await admin();
    const commit = await postJson('/admin/theses/import/commit', token, {
      periodId,
      rows: [{ title: 'Biomarkers of X in Y', track: 'clinical', lecturerFullName: 'dr. Ali', maxClaims: 1 }],
    });
    expect(commit.status).toBe(201);
    expect((commit.json.skipped as Array<{ errors: Record<string, string> }>)[0]?.errors.title).toMatch(
      /already exists/,
    );
  });
});
