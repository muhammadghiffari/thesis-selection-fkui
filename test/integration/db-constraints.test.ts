import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/shared/db/db.module.js';
import { startPostgres, type PgFixture } from '../helpers/spin-postgres.js';

/**
 * F1 Definition of Done: migrations run clean and a smoke test proves
 * the two partial unique indexes reject duplicate active selections.
 */

let pg: PgFixture;
let redis: StartedRedisContainer;

beforeAll(async () => {
  pg = await startPostgres();
  redis = await new RedisContainer('redis:7-alpine').start();
}, 300_000);

afterAll(async () => {
  await pg?.end();
  await redis?.stop().catch(() => undefined);
});

// ---------- seed helpers ----------
async function seedStudent(db: Database, email: string): Promise<{ userId: string; studentId: string }> {
  const [user] = await db.execute(
    sql`INSERT INTO users (email, role) VALUES (${email}, 'student') RETURNING id`,
  ).then((r) => r.rows as { id: string }[]);
  const [student] = await db.execute(
    sql`INSERT INTO students (user_id, npm, full_name, class_type, research_track)
        VALUES (${user!.id}, ${crypto.randomUUID()}, 'Test Student', 'regular', 'clinical')
        RETURNING id`,
  ).then((r) => r.rows as { id: string }[]);
  return { userId: user!.id, studentId: student!.id };
}

interface PeriodThesis {
  periodId: string;
  thesisIds: string[];
}

async function seedPeriodWithTheses(db: Database, count: number): Promise<PeriodThesis> {
  const [period] = await db.execute(
    sql`INSERT INTO selection_periods (name, academic_year, status) VALUES ('Test', '2026/2027', 'open') RETURNING id`,
  ).then((r) => r.rows as { id: string }[]);

  const thesisIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const [thesis] = await db.execute(
      sql`INSERT INTO theses (period_id, title, track) VALUES (${period!.id}, ${'Title ' + crypto.randomUUID()}, 'clinical') RETURNING id`,
    ).then((r) => r.rows as { id: string }[]);
    thesisIds.push(thesis!.id);
  }
  return { periodId: period!.id, thesisIds };
}

function insertSelection(db: Database, cols: {
  periodId: string;
  studentId: string;
  thesisId: string;
  priority: number;
  status?: string;
}) {
  return db.execute(sql`
    INSERT INTO thesis_selections (period_id, student_id, thesis_id, priority, status)
    VALUES (${cols.periodId}, ${cols.studentId}, ${cols.thesisId}, ${cols.priority},
            ${cols.status ?? 'confirmed'})
  `);
}

/**
 * Drizzle wraps driver errors in DrizzleQueryError; the real Postgres
 * fields (code, message, constraint) live on the cause chain.
 */
interface PgErr {
  code?: string;
  message?: string;
  constraint?: string;
  cause?: unknown;
}

function pgError(err: unknown): PgErr {
  let cur: PgErr | undefined = err as PgErr;
  while (cur && cur.code === undefined && cur.cause !== undefined) {
    cur = cur.cause as PgErr;
  }
  return cur ?? {};
}

function constraintOf(err: unknown): string | undefined {
  return pgError(err).constraint;
}

// ---------- tests ----------

describe('DB constraints — student email domain trigger', () => {
  it('accepts @ui.ac.id students', async () => {
    const { userId } = await seedStudent(pg.db, `ok-${crypto.randomUUID()}@ui.ac.id`);
    expect(userId).toBeTruthy();
  });

  it('rejects non-@ui.ac.id students at DB level', async () => {
    const err: unknown = await seedStudent(pg.db, `bad-${crypto.randomUUID()}@gmail.com`).then(
      () => null,
      (e) => e,
    );
    const pgErr = pgError(err);
    expect(pgErr.code).toBe('23514');
    expect(pgErr.message).toContain('Student email must end with @ui.ac.id');
  });

  it('allows non-student roles on any domain', async () => {
    const email = `admin-${crypto.randomUUID()}@fkui.or.id`;
    await expect(pg.db.execute(sql`INSERT INTO users (email, role) VALUES (${email}, 'admin')`)).resolves.toBeTruthy();
  });
});

describe('DB constraints — partial unique index smoke test (F1 DoD)', () => {
  it('Guard 1: rejects two ACTIVE selections on the same thesis', async () => {
    const s1 = await seedStudent(pg.db, `s1-${crypto.randomUUID()}@ui.ac.id`);
    const s2 = await seedStudent(pg.db, `s2-${crypto.randomUUID()}@ui.ac.id`);
    const { periodId, thesisIds } = await seedPeriodWithTheses(pg.db, 1);

    await insertSelection(pg.db, { periodId, studentId: s1.studentId, thesisId: thesisIds[0]!, priority: 1 });

    let caught: unknown;
    try {
      await insertSelection(pg.db, { periodId, studentId: s2.studentId, thesisId: thesisIds[0]!, priority: 1 });
    } catch (err) {
      caught = err;
    }
    expect(constraintOf(caught)).toBe('one_active_per_thesis');
  });

  it('Guard 1: expired selection frees the thesis again', async () => {
    const { periodId, thesisIds } = await seedPeriodWithTheses(pg.db, 1);
    const s1 = await seedStudent(pg.db, `s3-${crypto.randomUUID()}@ui.ac.id`);
    const s2 = await seedStudent(pg.db, `s4-${crypto.randomUUID()}@ui.ac.id`);

    await insertSelection(pg.db, { periodId, studentId: s1.studentId, thesisId: thesisIds[0]!, priority: 1 });
    // first owner's lock expires
    await pg.db.execute(sql`
      UPDATE thesis_selections SET status = 'expired'
      WHERE student_id = ${s1.studentId}
    `);

    await expect(
      insertSelection(pg.db, { periodId, studentId: s2.studentId, thesisId: thesisIds[0]!, priority: 2 }),
    ).resolves.toBeTruthy();
  });

  it('Guard 2: rejects same student + period + priority while active', async () => {
    const s = await seedStudent(pg.db, `s5-${crypto.randomUUID()}@ui.ac.id`);
    const { periodId, thesisIds } = await seedPeriodWithTheses(pg.db, 2);

    await insertSelection(pg.db, { periodId, studentId: s.studentId, thesisId: thesisIds[0]!, priority: 1 });

    let caught: unknown;
    try {
      await insertSelection(pg.db, { periodId, studentId: s.studentId, thesisId: thesisIds[1]!, priority: 1 });
    } catch (err) {
      caught = err;
    }
    expect(constraintOf(caught)).toBe('one_active_per_priority');
  });

  it('Guard 2: allows priorities 1..3 for one student and blocks a 4th slot value', async () => {
    const s = await seedStudent(pg.db, `s6-${crypto.randomUUID()}@ui.ac.id`);
    const { periodId, thesisIds } = await seedPeriodWithTheses(pg.db, 4);

    for (const p of [1, 2, 3]) {
      await insertSelection(pg.db, { periodId, studentId: s.studentId, thesisId: thesisIds[p - 1]!, priority: p });
    }

    // exactly-3 rule backstop: priority outside 1..3 violates CHECK
    const err: unknown = await insertSelection(pg.db, {
      periodId,
      studentId: s.studentId,
      thesisId: thesisIds[3]!,
      priority: 4,
    }).then(
      () => null,
      (e) => e,
    );
    expect(pgError(err).code).toBe('23514');
  });

  it('soft-deleted selections do not block re-claiming', async () => {
    const s = await seedStudent(pg.db, `s7-${crypto.randomUUID()}@ui.ac.id`);
    const { periodId, thesisIds } = await seedPeriodWithTheses(pg.db, 2);

    await insertSelection(pg.db, { periodId, studentId: s.studentId, thesisId: thesisIds[0]!, priority: 1 });
    await pg.db.execute(sql`
      UPDATE thesis_selections SET deleted_at = now()
      WHERE student_id = ${s.studentId} AND thesis_id = ${thesisIds[0]}
    `);

    await expect(
      insertSelection(pg.db, { periodId, studentId: s.studentId, thesisId: thesisIds[1]!, priority: 1 }),
    ).resolves.toBeTruthy();
  });
});

describe('activity_logs monthly partitions', () => {
  it('ensure_activity_log_partition creates a usable partition', async () => {
    await pg.db.execute(sql`SELECT ensure_activity_log_partition('2027-03-01'::date)`);

    const res = await pg.db.execute(sql`
      SELECT to_regclass('activity_logs_2027_03') AS reg
    `);
    expect((res.rows[0] as { reg: string | null }).reg).toBe('activity_logs_2027_03');

    await expect(
      pg.db.execute(sql`
        INSERT INTO activity_logs (action, entity_type, created_at)
        VALUES ('test.insert', 'test', '2027-03-15T00:00:00Z')
      `),
    ).resolves.toBeTruthy();
  });

  it('current-month partition exists from migration', async () => {
    const res = await pg.db.execute(sql`
      SELECT to_regclass('activity_logs_' || to_char(date_trunc('month', now()), 'YYYY_MM')) AS reg
    `);
    expect((res.rows[0] as { reg: string | null }).reg).not.toBeNull();
  });
});

describe('redis connectivity (health-indicator sanity)', () => {
  it('answers PING', async () => {
    expect((await redis.executeCliCmd('PING')).trim()).toBe('PONG');
  });
});
