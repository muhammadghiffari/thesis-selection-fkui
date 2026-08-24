import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import {
  periodEnrollments,
  selectionPeriods,
  students,
  thesisSelections,
} from '../../shared/db/schema.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { REDIS } from '../../shared/redis/redis.module.js';
import type { AuthUser } from '../identity/auth-user.js';
import { WarRateLimiter } from './rate-limiter.js';

export const LOCK_TTL_SEC = 30;

export interface ClaimResult {
  status: 'locked' | 'lost' | 'complete';
  selection?: {
    id: string;
    thesisId: string;
    priority: number;
    lockedUntil: string;
  };
  fallback?: { thesisId: string; title: string; score: number } | null;
}

interface MySelectionRow {
  id: string;
  thesisId: string;
  priority: number;
  status: string;
  confirmedAt: Date | null;
  referenceNumber: string | null;
  title: string;
  lecturerName: string | null;
}

function gone(message: string): Error {
  return Object.assign(new Error(message), { status: 410 });
}

function isUniqueViolation(err: unknown): boolean {
  let cur = err as { code?: string; cause?: unknown };
  while (cur && cur.code !== '23505' && cur.cause !== undefined) {
    cur = cur.cause as typeof cur;
  }
  return cur?.code === '23505';
}

@Injectable()
export class WarService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WarRateLimiter) private readonly rateLimiter: WarRateLimiter,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------- guards ----------

  /** War endpoints answer 403 before opens_at (title secrecy) and after closes_at. */
  async assertWarOpen(userId: string, periodId: string): Promise<{ studentId: string; settings: Record<string, unknown> }> {
    const [row] = await this.db
      .select({
        opensAt: selectionPeriods.opensAt,
        closesAt: selectionPeriods.closesAt,
        status: selectionPeriods.status,
        settings: selectionPeriods.settings,
        studentId: students.id,
      })
      .from(periodEnrollments)
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .where(and(eq(students.userId, userId), eq(periodEnrollments.periodId, periodId)))
      .limit(1);
    if (!row) throw new NotFoundException('No enrollment for this period');
    const now = Date.now();
    if (!row.opensAt || row.status === 'draft' || row.status === 'scheduled' || now < row.opensAt.getTime()) {
      throw new ForbiddenException('Selection has not opened yet');
    }
    if (!row.closesAt || now >= row.closesAt.getTime() || row.status !== 'open') {
      throw new ConflictException('Selection window is closed');
    }
    return { studentId: row.studentId, settings: row.settings as unknown as Record<string, unknown> };
  }

  // ---------- catalog ----------

  async catalog(userId: string, periodId: string): Promise<{
    mySelections: MySelectionRow[];
    required: number;
    theses: Array<{
      id: string;
      title: string;
      track: string;
      lecturerName: string | null;
      status: 'available' | 'locked' | 'taken';
      lockedByMe: boolean;
      lockedUntil: string | null;
    }>;
  }> {
    await this.assertWarOpen(userId, periodId);

    const [rows, settingsRows] = await Promise.all([
      this.db.execute(sqlCatalog(periodId, userId)),
      this.db
        .select({ settings: selectionPeriods.settings })
        .from(selectionPeriods)
        .where(eq(selectionPeriods.id, periodId))
        .limit(1),
    ]);
    const mine = await this.mySelections(userId, periodId);

    const theses = (rows.rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      track: String(r.track),
      lecturerName: (r.lecturer_name as string | null) ?? null,
      status: String(r.status) as 'available' | 'locked' | 'taken',
      lockedByMe: Boolean(r.locked_by_me),
      lockedUntil: r.locked_until ? new Date(r.locked_until as string).toISOString() : null,
    }));
    const required =
      ((settingsRows[0]?.settings as { required_selections?: number } | null)?.required_selections) ?? 3;
    return { mySelections: mine, required, theses };
  }

  async mySelections(userId: string, periodId: string): Promise<MySelectionRow[]> {
    const res = await this.db.execute(sqlMine(userId, periodId));
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      thesisId: String(r.thesis_id),
      priority: Number(r.priority),
      status: String(r.status),
      confirmedAt: r.confirmed_at ? new Date(r.confirmed_at as string) : null,
      referenceNumber: (r.reference_number as string | null) ?? null,
      title: String(r.title),
      lecturerName: (r.lecturer_name as string | null) ?? null,
    }));
  }

  // ---------- lock / confirm / undo ----------

  /**
   * Tap = instant lock. Order of truth:
   * 1. rate limit + open-window guards
   * 2. idempotency replay → stored outcome
   * 3. exactly-3 check (active selections count)
   * 4. release my previous locks (one active lock per student)
   * 5. Redis SET NX EX 30s on the thesis — first arrival wins the tap
   * 6. INSERT guarded by both partial unique indexes (DB backstop)
   */
  async claim(
    user: AuthUser,
    input: { periodId: string; thesisId: string; idempotencyKey: string },
  ): Promise<ClaimResult> {
    await this.rateLimiter.assertAllowed(user.sub);
    const ctx = await this.assertWarOpen(user.sub, input.periodId);

    // idempotent replay
    const existing = await this.findByKey(input.idempotencyKey);
    if (existing) return existing.result;

    await this.rateLimiter.recordAction(user.sub);

    // exactly-3 backstop
    const active = await this.activeSelections(ctx.studentId, input.periodId);
    if (active.length >= 3) {
      throw new ConflictException('You already hold 3 titles');
    }

    // one active lock per student: expire my previous locks
    await this.releaseMyLocks(ctx.studentId, input.periodId);

    // 5) atomic tap — first ARRIVAL at server wins
    const lockKey = `lock:${input.periodId}:${input.thesisId}`;
    const acquired = await this.redis.set(lockKey, user.sub, 'EX', LOCK_TTL_SEC, 'NX');
    if (acquired !== 'OK') {
      const fallback = await this.suggestFallback(user.sub, input.periodId);
      return { status: 'lost', fallback };
    }

    try {
      const priority = this.nextFreePriority(active.map((a) => a.priority));
      const [row] = await this.db
        .insert(thesisSelections)
        .values({
          periodId: input.periodId,
          studentId: ctx.studentId,
          thesisId: input.thesisId,
          priority,
          status: 'locked',
          lockedUntil: new Date(Date.now() + LOCK_TTL_SEC * 1000),
          idempotencyKey: input.idempotencyKey,
        })
        .returning({ id: thesisSelections.id });
      if (!row) throw new Error('insert returned no row');

      return {
        status: 'locked',
        selection: {
          id: row.id,
          thesisId: input.thesisId,
          priority,
          lockedUntil: new Date(Date.now() + LOCK_TTL_SEC * 1000).toISOString(),
        },
      };
    } catch (err) {
      // DB backstop fired: someone else's ACTIVE row exists for this thesis or slot.
      await this.redis.del(lockKey).catch(() => undefined);
      if (isUniqueViolation(err)) {
        const fallback = await this.suggestFallback(user.sub, input.periodId);
        return { status: 'lost', fallback };
      }
      throw err;
    }
  }

  /** Confirm converts MY active lock into a win (instant). */
  async confirm(user: AuthUser, selectionId: string): Promise<{ confirmed: true; referenceNumber: string | null }> {
    const sel = await this.myLockedSelection(user.sub, selectionId);
    const refNumber = await this.nextReferenceNumber(sel.periodId);
    const confirmedAt = new Date();

    const updated = await this.db
      .update(thesisSelections)
      .set({ status: 'confirmed', confirmedAt, referenceNumber: refNumber })
      .where(
        and(
          eq(thesisSelections.id, selectionId),
          eq(thesisSelections.status, 'locked'),
          sqlFreshLock(),
        ),
      )
      .returning({ id: thesisSelections.id });

    if (updated.length === 0) throw gone('Lock expired — title released');

    // title exclusion now enforced by the DB partial index (status=confirmed is active)
    await this.redis.del(`lock:${sel.periodId}:${sel.thesisId}`).catch(() => undefined);

    this.events.emit('selection.confirmed', {
      userId: user.sub,
      periodId: sel.periodId,
      selectionId,
      thesisTitle: sel.title,
      lecturerName: sel.lecturerName,
      referenceNumber: refNumber,
      confirmedAt: confirmedAt.toISOString(),
    });
    await this.audit.log({ id: user.sub, role: user.role }, 'selection.confirm', 'thesis_selection', selectionId, {
      periodId: sel.periodId,
      thesisId: sel.thesisId,
    });
    return { confirmed: true, referenceNumber: refNumber };
  }

  /** Abandon a pre-confirm lock. */
  async release(user: AuthUser, selectionId: string): Promise<{ released: true }> {
    const sel = await this.myLockedSelection(user.sub, selectionId);
    await this.db
      .update(thesisSelections)
      .set({ status: 'expired' })
      .where(and(eq(thesisSelections.id, selectionId), eq(thesisSelections.status, 'locked')));
    await this.redis.del(`lock:${sel.periodId}:${sel.thesisId}`).catch(() => undefined);
    return { released: true };
  }

  /** Undo within the configured window after CONFIRM (server-timed). */
  async undo(user: AuthUser, selectionId: string): Promise<{ undone: true }> {
    const [sel] = await this.db
      .select({
        id: thesisSelections.id,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
        status: thesisSelections.status,
        confirmedAt: thesisSelections.confirmedAt,
      })
      .from(thesisSelections)
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(and(eq(thesisSelections.id, selectionId), eq(students.userId, user.sub), isNull(thesisSelections.deletedAt)))
      .limit(1);
    if (!sel) throw new NotFoundException('Selection not found');

    if (sel.status !== 'confirmed') {
      throw new ConflictException('Only confirmed selections can be undone');
    }
    const [period] = await this.db
      .select({ undoSec: selectionPeriods.settings })
      .from(selectionPeriods)
      .where(eq(selectionPeriods.id, sel.periodId))
      .limit(1);
    const undoWindowMs =
      (((period?.undoSec as { undo_window_sec?: number } | null)?.undo_window_sec) ?? 15) * 1000;

    if (!sel.confirmedAt || Date.now() > sel.confirmedAt.getTime() + undoWindowMs) {
      throw gone('Undo window has expired');
    }

    await this.db
      .update(thesisSelections)
      .set({ status: 'expired' })
      .where(and(eq(thesisSelections.id, selectionId), eq(thesisSelections.status, 'confirmed')));
    await this.audit.log({ id: user.sub, role: user.role }, 'selection.undo', 'thesis_selection', selectionId, {
      periodId: sel.periodId,
    });
    return { undone: true };
  }

  // ---------- reorder ----------

  /**
   * Reorder my active selections in ONE transaction: flip inactive → write
   * priorities → restore statuses. CHECK(priority 1..3) forbids temp values,
   * so inactivation (leaves both partial indexes) is how swaps avoid 23505.
   */
  async reorder(user: AuthUser, periodId: string, orderedIds: string[]): Promise<void> {
    await this.assertWarOpen(user.sub, periodId);
    const mine = await this.activeSelectionRows(user.sub, periodId);

    const byId = new Map(mine.map((m) => [m.id, m]));
    if (orderedIds.length !== mine.length || new Set(orderedIds).size !== orderedIds.length ||
        !orderedIds.every((id) => byId.has(id))) {
      throw new ConflictException('Order must be a permutation of your active selections');
    }

    await this.db.transaction(async (tx) => {
      for (const id of orderedIds) {
        await tx
          .update(thesisSelections)
          .set({ status: 'expired' })
          .where(and(eq(thesisSelections.id, id), eq(thesisSelections.status, byId.get(id)!.status)));
      }
      for (const [i, id] of orderedIds.entries()) {
        await tx.update(thesisSelections).set({ priority: i + 1 }).where(eq(thesisSelections.id, id));
      }
      for (const id of orderedIds) {
        await tx
          .update(thesisSelections)
          .set({ status: byId.get(id)!.status })
          .where(eq(thesisSelections.id, id));
      }
    });
  }

  // ---------- receipt ----------

  async receipt(userId: string, periodId: string): Promise<{
    complete: boolean;
    count: number;
    required: number;
    selections: Array<{
      priority: number;
      title: string;
      lecturerName: string | null;
      referenceNumber: string | null;
      confirmedAt: string | null;
    }>;
  }> {
    const mine = await this.mySelections(userId, periodId);
    const confirmed = mine.filter((m) => m.status === 'confirmed' || m.status === 'taken');
    return {
      complete: confirmed.length >= 3,
      count: confirmed.length,
      required: 3,
      selections: confirmed
        .sort((a, b) => a.priority - b.priority)
        .map((m) => ({
          priority: m.priority,
          title: m.title,
          lecturerName: m.lecturerName,
          referenceNumber: m.referenceNumber,
          confirmedAt: m.confirmedAt?.toISOString() ?? null,
        })),
    };
  }

  // ---------- auto-war heartbeat gate ----------

  async heartbeat(userId: string, periodId: string): Promise<{ ok: true }> {
    await this.redis.set(`hb:${userId}:${periodId}`, '1', 'EX', 15);
    return { ok: true };
  }

  async hasFreshHeartbeat(userId: string, periodId: string): Promise<boolean> {
    return (await this.redis.exists(`hb:${userId}:${periodId}`)) === 1;
  }

  // ---------- internals ----------

  private nextFreePriority(takenPriorities: number[]): number {
    for (const p of [1, 2, 3]) {
      if (!takenPriorities.includes(p)) return p;
    }
    throw new ConflictException('You already hold 3 titles');
  }

  private async findByKey(key: string): Promise<{ result: ClaimResult } | null> {
    const [row] = await this.db
      .select({
        id: thesisSelections.id,
        thesisId: thesisSelections.thesisId,
        priority: thesisSelections.priority,
        status: thesisSelections.status,
        lockedUntil: thesisSelections.lockedUntil,
      })
      .from(thesisSelections)
      .where(eq(thesisSelections.idempotencyKey, key))
      .limit(1);
    if (!row) return null;
    if (row.status === 'locked') {
      return {
        result: {
          status: 'locked',
          selection: {
            id: row.id,
            thesisId: row.thesisId,
            priority: row.priority,
            lockedUntil: (row.lockedUntil ?? new Date()).toISOString(),
          },
        },
      };
    }
    if (row.status === 'confirmed') return { result: { status: 'complete' } };
    // expired/released lock replay → treat as loss (must re-tap)
    return { result: { status: 'lost', fallback: null } };
  }

  private async releaseMyLocks(studentId: string, periodId: string): Promise<void> {
    const locked = await this.db
      .select({ id: thesisSelections.id, thesisId: thesisSelections.thesisId })
      .from(thesisSelections)
      .where(
        and(
          eq(thesisSelections.studentId, studentId),
          eq(thesisSelections.periodId, periodId),
          eq(thesisSelections.status, 'locked'),
        ),
      );
    for (const l of locked) {
      await this.db
        .update(thesisSelections)
        .set({ status: 'expired' })
        .where(and(eq(thesisSelections.id, l.id), eq(thesisSelections.status, 'locked')));
      await this.redis.del(`lock:${periodId}:${l.thesisId}`).catch(() => undefined);
    }
  }

  private async activeSelections(studentId: string, periodId: string): Promise<Array<{ id: string; priority: number; thesisId: string }>> {
    return this.db
      .select({
        id: thesisSelections.id,
        priority: thesisSelections.priority,
        thesisId: thesisSelections.thesisId,
      })
      .from(thesisSelections)
      .where(
        and(
          eq(thesisSelections.studentId, studentId),
          eq(thesisSelections.periodId, periodId),
          isActiveStatus(),
        ),
      );
  }

  private async activeSelectionRows(userId: string, periodId: string): Promise<Array<{ id: string; status: string; priority: number }>> {
    return this.db
      .select({ id: thesisSelections.id, status: thesisSelections.status, priority: thesisSelections.priority })
      .from(thesisSelections)
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(
        and(
          eq(students.userId, userId),
          eq(thesisSelections.periodId, periodId),
          isActiveStatus(),
        ),
      );
  }

  private async myLockedSelection(userId: string, selectionId: string): Promise<{
    id: string;
    periodId: string;
    thesisId: string;
    title: string;
    lecturerName: string | null;
  }> {
    const [row] = await this.db
      .select({
        id: thesisSelections.id,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
        status: thesisSelections.status,
        title: sqlTitle(),
        lecturerName: sqlLecturer(),
      })
      .from(thesisSelections)
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(and(eq(thesisSelections.id, selectionId), eq(students.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException('Selection not found');
    if (row.status !== 'locked') throw new ConflictException('Selection is not locked');
    return {
      id: row.id,
      periodId: row.periodId,
      thesisId: row.thesisId,
      title: row.title ?? '',
      lecturerName: row.lecturerName ?? null,
    };
  }

  /**
   * One-click fallback: best AVAILABLE title by cosine similarity against the
   * student's saved preference embedding. Never exposes taken titles.
   */
  private async suggestFallback(
    userId: string,
    periodId: string,
  ): Promise<{ thesisId: string; title: string; score: number } | null> {
    const res = await this.db.execute(sqlFallback(userId, periodId));
    const top = res.rows[0] as { id: string; title: string; score: string | number } | undefined;
    if (!top) return null;
    return { thesisId: String(top.id), title: String(top.title), score: Number(top.score) };
  }

  private async nextReferenceNumber(periodId: string): Promise<string> {
    const [p] = await this.db
      .select({ year: selectionPeriods.academicYear })
      .from(selectionPeriods)
      .where(eq(selectionPeriods.id, periodId))
      .limit(1);
    const seqRes = await this.db.execute(sql`SELECT nextval('ref_number_seq') AS v`);
    const seq = Number((seqRes.rows[0] as { v: string }).v);
    const year = (p?.year ?? '0000').replace(/[^0-9]/g, '').slice(0, 4) || '0000';
    return `THS-${year}-${String(seq).padStart(6, '0')}`;
  }
}

// ---- raw SQL fragments (catalog/fallback need pgvector + anti-joins) ----

function isActiveStatus() {
  return sql`${thesisSelections.status} IN ('locked','confirmed','taken','swap_requested','released_pending')`;
}

function sqlFreshLock() {
  return sql`${thesisSelections.lockedUntil} > now()`;
}

function sqlTitle() {
  return sql<string | null>`(SELECT t.title FROM theses t WHERE t.id = ${thesisSelections.thesisId})`;
}

function sqlLecturer() {
  return sql<string | null>`(SELECT l.full_name FROM theses t LEFT JOIN lecturers l ON l.id = t.lecturer_id WHERE t.id = ${thesisSelections.thesisId})`;
}

/** Catalog with lazy-expired locks treated as available; titles post-open only. */
function sqlCatalog(periodId: string, userId: string) {
  return sql`
    SELECT th.id, th.title, th.track, l.full_name AS lecturer_name,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM thesis_selections act
               WHERE act.thesis_id = th.id
                 AND act.status IN ('confirmed','taken','swap_requested','released_pending')
                 AND act.deleted_at IS NULL
             ) THEN 'taken'
             WHEN s.status = 'locked' AND s.locked_until > now() THEN 'locked'
             ELSE 'available'
           END AS status,
           (s.student_user = ${userId} AND s.status = 'locked' AND s.locked_until > now()) AS locked_by_me,
           CASE WHEN s.status = 'locked' AND s.locked_until > now() THEN s.locked_until ELSE NULL END AS locked_until
    FROM theses th
    LEFT JOIN lecturers l ON l.id = th.lecturer_id
    LEFT JOIN LATERAL (
      SELECT ts.status, ts.locked_until, u.id AS student_user
      FROM thesis_selections ts
      JOIN students st ON st.id = ts.student_id
      JOIN users u ON u.id = st.user_id
      WHERE ts.thesis_id = th.id
        AND ts.status IN ('locked','confirmed')
        AND ts.deleted_at IS NULL
      ORDER BY CASE ts.status WHEN 'confirmed' THEN 0 ELSE 1 END
      LIMIT 1
    ) s ON true
    WHERE th.period_id = ${periodId} AND th.deleted_at IS NULL
    ORDER BY th.title
  `;
}

function sqlMine(userId: string, periodId: string) {
  return sql`
    SELECT ts.id, ts.thesis_id, ts.priority, ts.status, ts.confirmed_at, ts.reference_number,
           th.title, l.full_name AS lecturer_name
    FROM thesis_selections ts
    JOIN students s ON s.id = ts.student_id
    JOIN users u ON u.id = s.user_id
    JOIN theses th ON th.id = ts.thesis_id
    LEFT JOIN lecturers l ON l.id = th.lecturer_id
    WHERE u.id = ${userId} AND ts.period_id = ${periodId}
      AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
      AND ts.deleted_at IS NULL
    ORDER BY ts.priority
  `;
}

/** Fallback ranking: cosine similarity over AVAILABLE titles only. */
function sqlFallback(userId: string, periodId: string) {
  return sql`
    SELECT th.id, th.title,
           1 - (th.embedding <=> sp.embedding) AS score
    FROM student_preferences sp
    JOIN students s ON s.id = sp.student_id
    JOIN users u ON u.id = s.user_id
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.embedding
      FROM theses t
      WHERE t.period_id = ${periodId}
        AND t.deleted_at IS NULL
        AND t.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM thesis_selections act
          WHERE act.thesis_id = t.id
            AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
            AND act.deleted_at IS NULL
        )
    ) th
    WHERE u.id = ${userId} AND sp.period_id = ${periodId}
    ORDER BY th.embedding <=> sp.embedding
    LIMIT 1
  `;
}
