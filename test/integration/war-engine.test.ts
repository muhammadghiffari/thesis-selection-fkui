import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { HashingEmbeddingProvider } from '../../src/shared/embeddings/embedding-provider.js';
import { WarRunner } from '../../src/modules/war/war-runner.js';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';

/**
 * F5 WAR ENGINE — Definition of Done:
 * 100 virtual users claiming the SAME title simultaneously → exactly 1
 * winner, 99 instant losses, zero double-claims, no orphan locks.
 * Plus: undo-window race, reorder transactionality, 4th-claim rejection,
 * idempotent retries, pre-open 403s, auto-war heartbeat gating.
 */

let app: TestApp;
let redis: Redis;
const ADMIN = { email: 'f5-admin@fkui.or.id', password: 'admin-pass-123' };
const FP = 'fp-war-0001';
let adminToken = '';
let periodId = '';
const embeddings = new HashingEmbeddingProvider();

function vecLit(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Bulk-creates a student with enrollment + session; returns bearer token. */
async function makeWarrior(npm: string, name: string): Promise<string> {
  await app.db.execute(sql`
    WITH u AS (
      INSERT INTO users (email, role) VALUES (${npm + '-war@ui.ac.id'}, 'student') RETURNING id
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
  redis = new Redis(app.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined); // teardown races produce benign EPIPE noise
  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  const login = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminToken = ((await login.json()) as { accessToken: string }).accessToken;

  // OPEN war period: opens_at slightly in the past
  const period = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `F5-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }),
  });
  periodId = ((await period.json()) as Record<string, string>).id!;
  for (const to of ['scheduled', 'open']) {
    const t = await fetch(`${app.url}/api/admin/periods/${periodId}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ to }),
    });
    expect(t.status).toBe(201);
  }

  // catalog of 12 theses with embeddings (topic A vs topic B clusters)
  const topicA = await embeddings.embed('community nutrition maternal health field survey');
  const topicB = await embeddings.embed('clinical biostatistics trial epidemiology methods');
  for (let i = 0; i < 12; i++) {
    const emb = i % 2 === 0 ? topicA : topicB;
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track, embedding)
      VALUES (${periodId}, ${'Thesis ' + String.fromCharCode(65 + i) + '-' + crypto.randomUUID().slice(0, 4)}, 'clinical',
              ${vecLit(emb)}::vector)
    `);
  }

  // scheduled (pre-open) period for secrecy guard checks
  const locked = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `F5-locked-${crypto.randomUUID()}`,
      academicYear: '2026/2027',
      opensAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      closesAt: new Date(Date.now() + 96 * 3_600_000).toISOString(),
    }),
  });
  const lockedPeriodId = ((await locked.json()) as Record<string, string>).id!;
  await fetch(`${app.url}/api/admin/periods/${lockedPeriodId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ to: 'scheduled' }),
  });
  (globalThis as Record<string, unknown>).__lockedPeriodId = lockedPeriodId;
}, 300_000);

afterAll(async () => {
  redis?.disconnect();
  await app?.close();
});

async function warriorPost(
  accessToken: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${app.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    ms: Date.now() - started,
  };
}

describe('THE RACE — 100 users, one title', () => {
  it('exactly 1 winner, 99 instant losses, zero double-claims, no orphan locks', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 100; i++) {
      tokens.push(await makeWarrior(String(900000 + i), `Warrior ${i}`));
    }
    const contested = (
      (await app.db.execute(sql`
        SELECT id FROM theses WHERE period_id = ${periodId} ORDER BY title LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> }
    ).rows[0]!.id;

    // fire simultaneously
    const attempts = await Promise.all(
      tokens.map((t) =>
        warriorPost(t, '/war/claims', {
          periodId,
          thesisId: contested,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    );

    const winners = attempts.filter((r) => r.status === 201 && r.json.status === 'locked');
    const losers = attempts.filter((r) => r.json.status === 'lost');
    const errors = attempts.filter((r) => r.status >= 500);

    expect(errors.length).toBe(0);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(99);

    // latency: p95 of ALL claim responses
    const latencies = attempts.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    console.log(`RACE p50=${latencies[49]}ms p95=${p95}ms max=${latencies.at(-1)}ms`);

    // identify winner via their npm (tokens[i] ↔ npm 900000+i)
    const selectionId = (winners[0]!.json.selection as { id: string }).id;
    const ownerNpm = (
      (await app.db.execute(sql`
        SELECT s.npm FROM thesis_selections ts JOIN students s ON s.id = ts.student_id
        WHERE ts.id = ${selectionId}
      `)) as unknown as { rows: Array<{ npm: string }> }
    ).rows[0]!.npm;
    const winToken = tokens[Number(ownerNpm) - 900000]!;

    // winner confirms → exactly ONE active row on the thesis, zero locks left
    const done = await warriorPost(winToken, `/war/claims/${selectionId}/confirm`);
    expect(done.status).toBe(201);
    expect(String((done.json as { referenceNumber?: string }).referenceNumber)).toMatch(/^THS-/);

    const state = (await app.db.execute(sql`
      SELECT status, count(*)::int AS n FROM thesis_selections
      WHERE thesis_id = ${contested} AND deleted_at IS NULL GROUP BY status
    `)) as unknown as { rows: Array<{ status: string; n: number }> };
    const byStatus = Object.fromEntries(state.rows.map((r) => [r.status, r.n]));
    expect(byStatus['confirmed']).toBe(1); // zero double-claims
    expect(byStatus['locked']).toBeUndefined(); // no orphan locks

    // redis lock released on confirm
    expect(await redis.exists(`lock:${periodId}:${contested}`)).toBe(0);

    // losers got structured fallback shape
    for (const l of losers.slice(0, 5)) {
      expect('fallback' in l.json).toBe(true);
    }
  }, 240_000);
});

describe('claim lifecycle rules', () => {
  let aliceToken = '';

  beforeAll(async () => {
    aliceToken = await makeWarrior('700001', 'Alice Claimer');
  });

  it('pre-open periods are 403 (secrecy holds on war endpoints)', async () => {
    const lockedPeriodId = (globalThis as Record<string, unknown>).__lockedPeriodId as string;
    const res = await warriorPost(aliceToken, '/war/claims', {
      periodId: lockedPeriodId,
      thesisId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.status).toBe(403);
  });

  it('idempotent retry returns the same lock without a second row', async () => {
    const thesis = (await freeThesis())!;
    const key = crypto.randomUUID();
    const first = await warriorPost(aliceToken, '/war/claims', {
      periodId,
      thesisId: thesis.id,
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.json.status).toBe('locked');

    const retry = await warriorPost(aliceToken, '/war/claims', {
      periodId,
      thesisId: thesis.id,
      idempotencyKey: key,
    });
    expect(retry.status).toBe(201);
    expect(retry.json.selection).toEqual(first.json.selection); // byte-identical incl. lockedUntil
    expect((retry.json.selection as { lockedUntil: string }).lockedUntil).toBe(
      (first.json.selection as { lockedUntil: string }).lockedUntil,
    );

    const rows = (await app.db.execute(sql`
      SELECT count(*)::int AS n FROM thesis_selections WHERE idempotency_key = ${key}
    `)) as unknown as { rows: Array<{ n: number }> };
    expect(rows.rows[0]?.n).toBe(1);

    // release for next tests
    const selId = (first.json.selection as { id: string }).id;
    await warriorPost(aliceToken, `/war/claims/${selId}/release`);
  });

  it('rejects the 4th active claim with 409', async () => {
    // fill all three slots with confirmed selections
    for (let i = 0; i < 3; i++) {
      const thesis = await freeThesis();
      const lock = await warriorPost(aliceToken, '/war/claims', {
        periodId,
        thesisId: thesis!.id,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(lock.json.status).toBe('locked');
      const selId = (lock.json.selection as { id: string }).id;
      const done = await warriorPost(aliceToken, `/war/claims/${selId}/confirm`);
      expect(done.status).toBe(201);
    }
    const fourth = await warriorPost(aliceToken, '/war/claims', {
      periodId,
      thesisId: (await freeThesis())!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(fourth.status).toBe(409);
  });

  it('undo works inside window and is rejected after it expires (server-timed)', async () => {
    // fresh student to avoid the full slot set above
    const token2 = await makeWarrior('700002', 'Bob Undo');

    const t1 = await freeThesis();
    const lock1 = await warriorPost(token2, '/war/claims', {
      periodId,
      thesisId: t1!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    const sel1 = (lock1.json.selection as { id: string }).id;
    await warriorPost(token2, `/war/claims/${sel1}/confirm`);

    const undoInWindow = await warriorPost(token2, `/war/claims/${sel1}/undo`);
    expect(undoInWindow.status).toBe(201);
    // in-window undo FREED the title again
    const freedIds = ((await app.db.execute(sql`
      SELECT th.id FROM theses th
      WHERE th.period_id = ${periodId} AND th.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
            AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
            AND act.deleted_at IS NULL)
    `)) as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
    expect(freedIds).toContain(t1!.id);

    // second round: a DIFFERENT thesis, backdate beyond the 15s window
    let t2 = await freeThesis();
    while (t2!.id === t1!.id) {
      await app.db.execute(sql`
        INSERT INTO theses (period_id, title, track)
        VALUES (${periodId}, ${'Extra-' + crypto.randomUUID().slice(0, 6)}, 'basic')
      `);
      t2 = await freeThesis();
      if (t2!.id !== t1!.id) break;
    }
    const lock2 = await warriorPost(token2, '/war/claims', {
      periodId,
      thesisId: t2!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    const sel2 = (lock2.json.selection as { id: string }).id;
    await warriorPost(token2, `/war/claims/${sel2}/confirm`);
    await app.db.execute(sql`
      UPDATE thesis_selections SET confirmed_at = now() - interval '16 seconds' WHERE id = ${sel2}
    `);

    const undoLate = await warriorPost(token2, `/war/claims/${sel2}/undo`);
    expect(undoLate.status).toBe(410);

    // t1 was freed by the in-window undo → another student can win it
    const relock = await warriorPost(await makeWarrior('700003', 'Cara Relock'), '/war/claims', {
      periodId,
      thesisId: t1!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(relock.json.status).toBe('locked');
  });

  it('reorder permutes priorities atomically; invalid permutations rejected without changes', async () => {
    const token3 = await makeWarrior('700004', 'Dee Reorder');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const thesis = await freeThesis();
      const lock = await warriorPost(token3, '/war/claims', {
        periodId,
        thesisId: thesis!.id,
        idempotencyKey: crypto.randomUUID(),
      });
      ids.push((lock.json.selection as { id: string }).id);
      await warriorPost(token3, `/war/claims/${ids[i]!}/confirm`);
    }

    const before = (await app.db.execute(sql`
      SELECT id, priority FROM thesis_selections WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY priority
    `)) as unknown as { rows: Array<{ id: string; priority: number }> };

    // reorder: reverse
    const patch = await fetch(`${app.url}/api/war/selections/order`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token3}` },
      body: JSON.stringify({ periodId, order: [ids[2], ids[1], ids[0]] }),
    });
    expect(patch.status).toBe(200);

    const after = (await app.db.execute(sql`
      SELECT id, priority FROM thesis_selections WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY priority
    `)) as unknown as { rows: Array<{ id: string; priority: number }> };
    expect(after.rows.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(after.rows.every((r, idx) => r.priority === idx + 1)).toBe(true);
    expect(after.rows.every((r) => before.rows.some((b) => b.id === r.id))).toBe(true);

    // invalid permutation (unknown id) → 409, unchanged state
    const bad = await fetch(`${app.url}/api/war/selections/order`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token3}` },
      body: JSON.stringify({ periodId, order: [crypto.randomUUID(), ids[1], ids[0]] }),
    });
    expect(bad.status).toBe(409);
    const unchanged = (await app.db.execute(sql`
      SELECT id, priority FROM thesis_selections WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY priority
    `)) as unknown as { rows: Array<{ id: string; priority: number }> };
    expect(unchanged.rows.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('receipt lists confirmed titles with THS reference numbers', async () => {
    const receipt = await fetch(`${app.url}/api/war/receipt?periodId=${periodId}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const body = (await receipt.json()) as {
      count: number;
      complete: boolean;
      selections: Array<{ referenceNumber: string | null }>;
    };
    expect(receipt.status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(3);
    expect(body.complete).toBe(true);
    expect(body.selections.every((s) => /^THS-\d{4}-\d{6}$/.test(s.referenceNumber ?? ''))).toBe(true);
  });

  it('losses carry a preference-matched fallback suggestion that is available', async () => {
    const loser = await makeWarrior('700005', 'Eve Loser');
    // preference close to topic B cluster
    await app.db.execute(sql`
      INSERT INTO student_preferences (student_id, period_id, interest_text, embedding)
      SELECT s.id, ${periodId}, 'clinical biostatistics trial epidemiology methods',
             ${vecLit(await embeddings.embed('clinical biostatistics trial epidemiology methods'))}::vector
      FROM students s WHERE s.npm = '700005'
    `);

    // take a topic-B thesis with another student first
    const topicBFree = (await app.db.execute(sql`
      SELECT th.id, th.title, th.embedding FROM theses th
      WHERE th.period_id = ${periodId} AND th.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
            AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
            AND act.deleted_at IS NULL)
      ORDER BY th.embedding <=> ${vecLit(await embeddings.embed('clinical biostatistics'))}::vector LIMIT 1
    `)) as unknown as { rows: Array<{ id: string; title: string }> };

    const taker = await makeWarrior('700006', 'Frank Taker');
    const takeLock = await warriorPost(taker, '/war/claims', {
      periodId,
      thesisId: topicBFree.rows[0]!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    const takeSel = (takeLock.json.selection as { id: string }).id;
    await warriorPost(taker, `/war/claims/${takeSel}/confirm`);

    // eve taps the TAKEN thesis → structured loss with available fallback
    const loss = await warriorPost(loser, '/war/claims', {
      periodId,
      thesisId: topicBFree.rows[0]!.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(loss.json.status).toBe('lost');
    const fb = loss.json.fallback as { thesisId: string; title: string } | null;
    expect(fb).toBeTruthy();
    expect(fb!.thesisId).not.toBe(topicBFree.rows[0]!.id); // never suggests taken titles
  });

  it('auto-war claims best match ONLY with fresh heartbeat', async () => {
    const runner = new WarRunner(app.db, redis, embeddings);

    await makeWarrior('700007', 'Gita Auto');
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET auto_war_enabled = true, auto_war_consented_at = now()
      FROM students s WHERE s.id = pe.student_id AND s.npm = '700007'
    `);
    await app.db.execute(sql`
      INSERT INTO student_preferences (student_id, period_id, interest_text, embedding)
      SELECT s.id, ${periodId}, 'clinical trial methods statistics',
             ${vecLit(await embeddings.embed('clinical trial methods statistics'))}::vector
      FROM students s WHERE s.npm = '700007'
    `);
    await redis.set(`hb:${await userIdOf('700007')}:${periodId}`, '1', 'EX', 60);

    await makeWarrior('700008', 'Hana NoTab');
    await app.db.execute(sql`
      UPDATE period_enrollments pe SET auto_war_enabled = true, auto_war_consented_at = now()
      FROM students s WHERE s.id = pe.student_id AND s.npm = '700008'
    `);
    await app.db.execute(sql`
      INSERT INTO student_preferences (student_id, period_id, interest_text, embedding)
      SELECT s.id, ${periodId}, 'anything at all really',
             ${vecLit(await embeddings.embed('clinical trial methods statistics'))}::vector
      FROM students s WHERE s.npm = '700008'
    `);

    const outcomes = await runner.runAutoWar(periodId);
    const gitaId = await userIdOf('700007');
    const hanaId = await userIdOf('700008');
    const gita = outcomes.find((o) => o.studentUserId === gitaId);
    const hana = outcomes.find((o) => o.studentUserId === hanaId);

    expect(gita?.claimed).toBeTruthy();
    expect(gita?.claimed?.referenceNumber ?? '').toMatch(/^THS-\d{4}-\d{6}$/);
    expect(hana?.skipped).toBe('no-heartbeat');
  });
});

async function userIdOf(npm: string): Promise<string> {
  const res = (await app.db.execute(sql`
    SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.npm = ${npm}
  `)) as unknown as { rows: Array<{ id: string }> };
  return res.rows[0]!.id;
}

async function freeThesis(): Promise<{ id: string } | null> {
  const res = (await app.db.execute(sql`
    SELECT th.id FROM theses th
    WHERE th.period_id = ${periodId} AND th.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM thesis_selections act WHERE act.thesis_id = th.id
          AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
          AND act.deleted_at IS NULL)
    ORDER BY th.title LIMIT 1
  `)) as unknown as { rows: Array<{ id: string }> };
  return res.rows[0] ?? null;
}
