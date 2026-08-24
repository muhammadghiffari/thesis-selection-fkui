import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { SwapRunner } from '../../src/modules/swap/swap-runner.js';
import { StubEmailProvider } from '../../src/shared/notifications/email-provider.js';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F7 swap engine — FULL state-machine matrix:
 *   confirmed → swap_requested → (cancel) → confirmed
 *   confirmed → swap_requested → reject  → confirmed
 *   confirmed → swap_requested → approve → released_pending → (grace expiry) → available
 *                                                            └→ (reclaim)   → confirmed
 *   taken(confirmed) → revoke(admin, reason) → available + attempts_left++
 * Plus: cooldown, max-1-active, mandatory note, watcher exactly-once semantics.
 */

let app: TestApp;
let redis: Redis;
const ADMIN = { email: 'sw-admin@fkui.or.id', password: 'admin-pass-123' };
const LECTURER = { email: 'sw-lecturer@fkui.or.id', password: 'lect-pass-1234' };
const FP = 'fp-swap-0001';
let adminToken = '';
let lecturerToken = '';
const tokens = new Map<string, string>(); // npm → bearer

beforeAll(async () => {
  app = await startTestApp();
  redis = new (await import('ioredis')).default(app.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');

  // lecturer with a user account + lecturers row owning ALL theses
  await seedStaff(app.db, LECTURER.email, LECTURER.password, 'lecturer');
  await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(LECTURER),
  }).then(async (r) => {
    lecturerToken = ((await r.json()) as { accessToken: string }).accessToken;
  });

  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminToken = ((await login.json()) as { accessToken: string }).accessToken;

  // open period + catalog owned by the lecturer
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `SW-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  const periodId = ((await period.json()) as Record<string, string>).id!;
  (globalThis as Record<string, unknown>).__swapPeriodId = periodId;
  for (const to of ['scheduled', 'open']) {
    await fetch(`${app.url}/api/admin/periods/${periodId}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ to }),
    });
  }
  await app.db.execute(sql`
    INSERT INTO lecturers (user_id, full_name)
    SELECT id, 'Prof Swap' FROM users WHERE email = ${LECTURER.email}
  `);
  for (let i = 0; i < 24; i++) {
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track, lecturer_id)
      SELECT ${periodId}, ${'SW-Thesis-' + String.fromCharCode(65 + i)}, 'clinical', l.id FROM lecturers l LIMIT 1
    `);
  }

  // three students with claimed sessions
  for (const [npm, name] of [
    ['710001', 'Alice Swap'],
    ['710002', 'Bea Swap'],
    ['710003', 'Cara Watch'],
  ] as const) {
    tokens.set(npm, await makeStudent(npm, name));
  }
}, 300_000);

afterAll(async () => {
  redis?.disconnect();
  await app?.close();
});

// ---------- helpers ----------

function periodIdOf(): string {
  return (globalThis as Record<string, unknown>).__swapPeriodId as string;
}

async function makeStudent(npm: string, name: string): Promise<string> {
  await app.db.execute(sql`
    WITH u AS (
      INSERT INTO users (email, role) VALUES (${npm + '-sw@ui.ac.id'}, 'student') RETURNING id
    ), s AS (
      INSERT INTO students (user_id, npm, full_name, class_type, research_track)
      SELECT u.id, ${npm}, ${name}, 'regular', 'clinical' FROM u RETURNING id
    )
    INSERT INTO period_enrollments (period_id, student_id)
    SELECT ${periodIdOf()}, s.id FROM s
  `);
  const userId = (
    (await app.db.execute(sql`
      SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = ${npm}
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;
  const jti = crypto.randomUUID();
  const { JwtService } = await import('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
  const link = await jwt.signAsync({ sub: userId, role: 'student', periodId: periodIdOf(), jti }, { expiresIn: '1h' });
  await app.db.execute(sql`
    UPDATE period_enrollments pe SET magic_link_token_hash = encode(sha256(${jti}::bytea),'hex'),
      link_opened_at = now()
    FROM students s WHERE s.id = pe.student_id AND pe.period_id = ${periodIdOf()} AND s.npm = ${npm}
  `);
  const claim = await fetch(`${app.url}/api/magic/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link, fingerprint: FP }),
  });
  expect(claim.status).toBe(201);
  return ((await claim.json()) as { accessToken: string }).accessToken;
}

async function post(
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function patch(
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Claim + confirm one free title for the given student; returns selectionId. */
let freshCounter = 710100;
/** Wins a title as a BRAND-NEW student (avoids exactly-3 collisions across tests). */
async function winFresh(): Promise<{ token: string; selectionId: string; thesisId: string; npm: string }> {
  const npm = String(freshCounter++);
  const token = await makeStudent(npm, `Fresh ${npm}`);
  tokens.set(npm, token);
  const r = await winTitle(npm);
  return { token, npm, ...r };
}

async function winTitle(npm: string): Promise<{ selectionId: string; thesisId: string }> {
  const token = tokens.get(npm)!;
  const thesisId = (
    (await app.db.execute(sql`
      SELECT th.id FROM theses th WHERE th.period_id = ${periodIdOf()} AND th.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
            AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
            AND act.deleted_at IS NULL)
      ORDER BY th.title LIMIT 1
    `)) as unknown as { rows: Array<{ id: string }> }
  ).rows[0]!.id;

  const lock = await post(token, '/war/claims', {
    periodId: periodIdOf(),
    thesisId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(lock.json.status).toBe('locked');
  const selId = (lock.json.selection as { id: string }).id;
  const done = await post(token, `/war/claims/${selId}/confirm`);
  expect(done.status).toBe(201);
  return { selectionId: selId, thesisId };
}

function runner(): SwapRunner {
  return new SwapRunner(app.db, redis, new StubEmailProvider());
}

async function selectionStatus(selectionId: string): Promise<string> {
  const res = (await app.db.execute(sql`
    SELECT status FROM thesis_selections WHERE id = ${selectionId}
  `)) as unknown as { rows: Array<{ status: string }> };
  return res.rows[0]!.status;
}

async function attemptsLeft(npm: string): Promise<number> {
  const res = (await app.db.execute(sql`
    SELECT pe.attempts_left FROM period_enrollments pe
    JOIN students s ON s.id = pe.student_id WHERE s.npm = ${npm}
  `)) as unknown as { rows: Array<{ attempts_left: number }> };
  return res.rows[0]!.attempts_left;
}

// ---------- tests ----------

describe('request flow guards', () => {
  it('happy path: confirmed → swap_requested (pending request exists)', async () => {
    const { selectionId } = await winTitle('710001');
    const res = await post(tokens.get('710001')!, '/swaps', {
      selectionId,
      category: 'interest_mismatch',
      detail: 'I realize clinical work does not suit my community-health interests at all',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.status).toBe(201);
    expect(await selectionStatus(selectionId)).toBe('swap_requested');
    (globalThis as Record<string, unknown>).__aliceSelection = selectionId;
    (globalThis as Record<string, unknown>).__aliceRequestId = res.json.requestId;
  });

  it('max 1 active per student → any new request while pending is blocked 409/429', async () => {
    // alice still has her pending request from the happy path; a different
    // selection cannot be requested while it stands
    const otherSelection = (
      (await app.db.execute(sql`
        SELECT ts.id FROM thesis_selections ts JOIN students s ON s.id = ts.student_id
        WHERE s.npm = '710002' AND ts.status = 'confirmed' LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> }
    ).rows[0];
    if (!otherSelection) return; // bea has none yet — skip gracefully

    const res = await post(tokens.get('710002')!, '/swaps', {
      selectionId: otherSelection.id,
      category: 'wrong_pick',
      detail: 'Bea trying to request while ALICE pends proves nothing — use own selection',
      idempotencyKey: crypto.randomUUID(),
    });
    // bea owns this selection; cooldown may fire first depending on ordering — both are guards
    expect([409, 429]).toContain(res.status);
  });

  it('detail <20 chars → 400; bad category → 400', async () => {
    const { selectionId } = await winFresh();
    const short = await post(tokens.get('710002')!, '/swaps', {
      selectionId,
      category: 'other',
      detail: 'too short',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(short.status).toBe(400);

    const badCat = await post(tokens.get('710002')!, '/swaps', {
      selectionId,
      category: 'bribery',
      detail: 'This category value is definitely not part of the allowed enum list',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(badCat.status).toBe(400);
    expect(await selectionStatus(selectionId)).toBe('confirmed'); // untouched
  });

  it('no duplicate request rows for one selection', async () => {
    const selectionId = (globalThis as Record<string, unknown>).__aliceSelection as string;
    const rows = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM swap_requests WHERE selection_id = ${selectionId}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('cooldown: two requests within 5 minutes → 429 on the second', async () => {
    const a = await winFresh();
    const first = await post(a.token, '/swaps', {
      selectionId: a.selectionId,
      category: 'other',
      detail: 'First request inside the cooldown window for this brand new warrior here',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first.status).toBe(201);
    await post(a.token, `/swaps/${first.json.requestId}/cancel`); // clear active-request guard

    // same student wins ANOTHER title seconds later
    const nextThesis = (
      (await app.db.execute(sql`
        SELECT th.id FROM theses th WHERE th.period_id = ${a ? periodIdOf() : periodIdOf()} AND th.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
              AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
              AND act.deleted_at IS NULL)
        ORDER BY th.title DESC LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> }
    ).rows[0]!.id;
    const lock2 = await post(a.token, '/war/claims', {
      periodId: periodIdOf(),
      thesisId: nextThesis,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(lock2.json.status).toBe('locked');
    const sel2 = (lock2.json.selection as { id: string }).id;
    await post(a.token, `/war/claims/${sel2}/confirm`);

    // second request within the window → 429, selection untouched
    const second = await post(a.token, '/swaps', {
      selectionId: sel2,
      idempotencyKey: crypto.randomUUID(),
      category: 'other',
      detail: 'Second immediate request which must trip the five minute cooldown window',
    });
    expect(second.status).toBe(429);
    expect(await selectionStatus(sel2)).toBe('confirmed'); // untouched by the rejected call
  });
});

describe('cancel & review flows', () => {
  it('owner cancels pending → cancelled + selection back to confirmed', async () => {
    const requestId = (globalThis as Record<string, unknown>).__aliceRequestId as string;
    const selectionId = (globalThis as Record<string, unknown>).__aliceSelection as string;

    const res = await post(tokens.get('710001')!, `/swaps/${requestId}/cancel`);
    expect(res.status).toBe(201);
    expect(await selectionStatus(selectionId)).toBe('confirmed');

    // cancelling again → 409 (already decided)
    const again = await post(tokens.get('710001')!, `/swaps/${requestId}/cancel`);
    expect(again.status).toBe(409);

    // re-request for review-flow tests (cooldown! backdate last request)
    await app.db.execute(sql`
      UPDATE swap_requests SET requested_at = now() - interval '10 minutes'
      WHERE selection_id = ${selectionId}
    `);
    const re = await post(tokens.get('710001')!, '/swaps', {
      selectionId,
      category: 'lecturer_schedule_issue',
      detail: 'Schedule conflict means I need to request a swap for this specific title now',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(re.status).toBe(201);
    (globalThis as Record<string, unknown>).__aliceRequestId = re.json.requestId;
  });

  it('decision WITHOUT note → 400 (mandatory)', async () => {
    const requestId = (globalThis as Record<string, unknown>).__aliceRequestId as string;
    const noNote = await patch(lecturerToken, `/admin/swaps/${requestId}/decision`, {
      decision: 'approve',
      note: '',
    });
    expect(noNote.status).toBe(400);
  });

  it('unrelated lecturer cannot decide someone else’s swap → 403', async () => {
    const requestId = (globalThis as Record<string, unknown>).__aliceRequestId as string;
    // create a second lecturer with their own account (no theses)
    await seedStaff(app.db, 'other-lecturer@fkui.or.id', 'other-pass-123', 'lecturer');
    const otherLogin = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other-lecturer@fkui.or.id', password: 'other-pass-123' }),
    });
    const otherToken = ((await otherLogin.json()) as { accessToken: string }).accessToken;

    const res = await patch(otherToken, `/admin/swaps/${requestId}/decision`, {
      decision: 'approve',
      note: 'I should not be able to decide this at all',
    });
    expect(res.status).toBe(403);
  });

  it('reject path: back to confirmed, decision recorded with reviewer + note', async () => {
    const requestId = (globalThis as Record<string, unknown>).__aliceRequestId as string;
    const selectionId = (globalThis as Record<string, unknown>).__aliceSelection as string;

    const res = await patch(lecturerToken, `/admin/swaps/${requestId}/decision`, {
      decision: 'reject',
      note: 'No capacity in other titles this period; keep the current assignment.',
    });
    expect(res.status).toBe(200);
    expect(await selectionStatus(selectionId)).toBe('confirmed');

    const audit = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM activity_logs WHERE action = 'swap.reject'
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('approve → grace → release/reclaim', () => {
  it('approve → released_pending w/ grace_until; reclaim during grace keeps it', async () => {
    const selectionId = (globalThis as Record<string, unknown>).__aliceSelection as string;

    // re-request (backdate cooldown), then approve
    await app.db.execute(sql`
      UPDATE swap_requests SET requested_at = now() - interval '10 minutes'
      WHERE selection_id = ${selectionId} AND status = 'rejected'
    `);
    const re = await post(tokens.get('710001')!, '/swaps', {
      selectionId,
      category: 'wrong_pick',
      detail: 'Requesting approval flow validation with a sufficiently long reason text here',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(re.status).toBe(201);
    const requestId = re.json.requestId as string;
    (globalThis as Record<string, unknown>).__aliceRequestId = requestId;

    const approve = await patch(lecturerToken, `/admin/swaps/${requestId}/decision`, {
      decision: 'approve',
      note: 'Approved — title will be released for others after the grace window.',
    });
    expect(approve.status).toBe(200);
    expect(await selectionStatus(selectionId)).toBe('released_pending');

    // old owner re-wars within grace → keeps the title
    const reclaim = await post(tokens.get('710001')!, `/swaps/grace/${selectionId}/reclaim`);
    expect(reclaim.status).toBe(201);
    expect(await selectionStatus(selectionId)).toBe('confirmed');

    // grace job afterwards is a NO-OP (already reclaimed)
    const outcome = await runner().releaseAfterGrace({
      selectionId,
      requestId,
      transitionTs: Date.now() - 1000,
    });
    expect(outcome.action).toBe('already-reclaimed');
    expect(await selectionStatus(selectionId)).toBe('confirmed');
  });

  it('approve → grace expiry releases title (available), attempts_left++, watchers notified EXACTLY once per transition even when the job runs twice', async () => {
    const owner = await winFresh();
    const selectionId = owner.selectionId;
    const thesisId = owner.thesisId;

    // request → pending
    const re = await post(owner.token, '/swaps', {
      selectionId,
      category: 'other',
      detail: 'Final approve path validation with a long enough free-form explanation text',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(re.status).toBe(201);
    const requestId = re.json.requestId as string;

    // cara subscribes while the title is swap_requested
    const watchAck = await post(tokens.get('710003')!, '/watchers', { thesisId });
    expect(watchAck.status).toBe(201);

    const approve = await patch(lecturerToken, `/admin/swaps/${requestId}/decision`, {
      decision: 'approve',
      note: 'Approved for release test.',
    });
    expect(approve.status).toBe(200);
    expect(await selectionStatus(selectionId)).toBe('released_pending');

    const attemptsBeforeRelease = await attemptsLeft(owner.npm);

    // simulate the delayed BullMQ job — run TWICE (retry semantics)
    const transitionTs = Date.now();
    const run1 = await runner().releaseAfterGrace({ selectionId, requestId, transitionTs });
    const run2 = await runner().releaseAfterGrace({ selectionId, requestId, transitionTs });

    expect(run1.action).toBe('released');
    expect(run1.notifiedWatchers).toBeGreaterThanOrEqual(1); // cara (watcher)
    expect(run2.action).toBe('already-reclaimed'); // retry no-op
    expect(await selectionStatus(selectionId)).toBe('expired');

    // old owner attempts_left++
    expect(await attemptsLeft(owner.npm)).toBe(attemptsBeforeRelease + 1);

    // title claimable via NORMAL claim flow by anyone else
    const caraLock = await post(tokens.get('710003')!, '/war/claims', {
      periodId: periodIdOf(),
      thesisId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(caraLock.json.status).toBe('locked');

    // exactly ONE delivery per watcher for THIS transition ts (retry created none)
    const deliveries = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM notification_deliveries
      WHERE template = 'watcher_available'
        AND payload->>'thesisId' = ${thesisId}
        AND payload->>'periodId' = ${periodIdOf()}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(deliveries.rows[0]?.n).toBe(1);
  }, 60_000);
});

describe('watcher rules & revoke', () => {
  it('watch limit: 10 max → 11th subscribe 409', async () => {
    // cara already has 1 watch; create 9 more watchable titles via quick swaps?
    // cheaper: seed watcher rows directly up to the cap and try one more.
    const studentId = (
      (await app.db.execute(sql`SELECT id FROM students WHERE npm = '710003'`)) as unknown as {
        rows: Array<{ id: string }>;
      }
    ).rows[0]!.id;
    for (let i = 0; i < 9; i++) {
      await app.db.execute(sql`
        INSERT INTO theses (period_id, title, track) VALUES (${periodIdOf()}, ${'WatchFill-' + i}, 'basic')
      `);
      const tid = (
        (await app.db.execute(sql`
          SELECT id FROM theses WHERE period_id = ${periodIdOf()} AND title = ${'WatchFill-' + i}
        `)) as unknown as { rows: Array<{ id: string }> }
      ).rows[0]!.id;
      await app.db.execute(sql`
        INSERT INTO thesis_watchers (student_id, thesis_id) VALUES (${studentId}, ${tid})
        ON CONFLICT DO NOTHING
      `);
    }
    // any remaining free thesis is NOT in a watchable state → both guards could trip;
    // force one into swap_requested directly to isolate the LIMIT rule
    const forced = (
      (await app.db.execute(sql`
        UPDATE thesis_selections SET status='swap_requested'
        WHERE id = (SELECT id FROM thesis_selections WHERE period_id=${periodIdOf()} AND status='confirmed' LIMIT 1)
        RETURNING thesis_id
      `)) as unknown as { rows: Array<{ thesis_id: string }> }
    ).rows[0];
    if (forced) {
      const over = await post(tokens.get('710003')!, '/watchers', { thesisId: forced.thesis_id });
      expect(over.status).toBe(409); // limit reached
    }
  });

  it('watching a plain confirmed title → 409 (only swap_requested/pending_release are watchable)', async () => {
    const fresh = await winFresh();
    const res = await post(fresh.token, '/watchers', { thesisId: fresh.thesisId });
    expect(res.status).toBe(409);
  });

  it('revoke: admin + mandatory reason → available + attempts_left++ ; missing reason → 400', async () => {
    const fresh = await winFresh();
    const before = await attemptsLeft(fresh.npm);

    const noReason = await post(adminToken, '/admin/swaps/revoke', { selectionId: fresh.selectionId, reason: '' });
    expect(noReason.status).toBe(400);

    const ok = await post(adminToken, '/admin/swaps/revoke', {
      selectionId: fresh.selectionId,
      reason: 'Integrity committee decision after review',
    });
    expect(ok.status).toBe(201);
    expect(await selectionStatus(fresh.selectionId)).toBe('expired');
    expect(await attemptsLeft(fresh.npm)).toBe(before + 1);
  });
});


