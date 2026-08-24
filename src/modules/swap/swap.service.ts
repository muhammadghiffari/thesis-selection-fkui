import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { lecturers, selectionPeriods, students, swapRequests, thesisSelections } from '../../shared/db/schema.js';
import { EMAIL_PROVIDER } from '../../shared/notifications/notifications-infra.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import { REDIS } from '../../shared/redis/redis.module.js';
import { createThrottle } from '../../shared/throttle/throttle.js';
import type { AuthUser } from '../identity/auth-user.js';
import { SwapRunner } from './swap-runner.js';

export const SWAP_COOLDOWN_SEC = 300;

const CATEGORIES = ['wrong_pick', 'interest_mismatch', 'lecturer_schedule_issue', 'other'] as const;

function pgCode(err: unknown): string | undefined {
  let cur = err as { code?: string; cause?: unknown };
  while (cur && typeof cur.code !== 'string' && cur.cause !== undefined) {
    cur = cur.cause as typeof cur;
  }
  return cur?.code;
}

@Injectable()
export class SwapService {
  readonly runner: SwapRunner;
  private readonly throttle: ReturnType<typeof createThrottle>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.runner = new SwapRunner(db, redis, email);
    this.throttle = createThrottle(redis, 'rl:swap', 10, SWAP_COOLDOWN_SEC);
  }

  /**
   * taken/confirmed --swap_request--> swap_requested.
   * Guards: category/detail shape, ownership, machine state, max-1-active
   * per student, 5-minute cooldown between any of this student's requests.
   */
  async request(
    user: AuthUser,
    input: { selectionId: string; category: string; detail: string; idempotencyKey: string },
  ): Promise<{ requestId: string }> {
    if (!CATEGORIES.includes(input.category as (typeof CATEGORIES)[number])) {
      throw new BadRequestException(`category must be one of ${CATEGORIES.join(', ')}`);
    }
    if (input.detail.trim().length < 20) {
      throw new BadRequestException('detail must be at least 20 characters');
    }

    const [replay] = await this.db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(eq(swapRequests.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (replay) return { requestId: replay.id };

    await this.throttle.assertAllowed(user.sub);

    const sel = await this.ownedSelection(user.sub, input.selectionId);
    if (sel.status !== 'confirmed' && sel.status !== 'taken') {
      throw new ConflictException(`Cannot request a swap from status '${sel.status}'`);
    }
    await this.assertNoPendingRequest(user.sub);
    await this.assertCooldownOk(user.sub);

    try {
      const [row] = await this.db
        .insert(swapRequests)
        .values({
          selectionId: input.selectionId,
          category: input.category,
          reasonDetail: input.detail.trim(),
          idempotencyKey: input.idempotencyKey,
        })
        .returning({ id: swapRequests.id });
      if (!row) throw new Error('insert returned no row');

      await this.db
        .update(thesisSelections)
        .set({ status: 'swap_requested' })
        .where(
          and(eq(thesisSelections.id, input.selectionId), eq(thesisSelections.status, sel.status)),
        );

      this.events.emit('swap.requested', { periodId: sel.periodId, thesisId: sel.thesisId });
      await this.audit.log({ id: user.sub, role: user.role }, 'swap.request', 'swap_request', row.id, {
        category: input.category,
        selectionId: input.selectionId,
      });
      return { requestId: row.id };
    } catch (err) {
      if (pgCode(err) === '23505') {
        const [winner] = await this.db
          .select({ id: swapRequests.id })
          .from(swapRequests)
          .where(eq(swapRequests.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (winner) return { requestId: winner.id };
      }
      throw err;
    }
  }

  /** swap_requested --cancel--> confirmed. Owner only, until decided. */
  async cancel(user: AuthUser, requestId: string): Promise<{ cancelled: true }> {
    const req = await this.ownRequest(user.sub, requestId, ['pending']);
    const cancelledAt = new Date();
    await this.db
      .update(swapRequests)
      .set({ status: 'cancelled', cancelledAt })
      .where(and(eq(swapRequests.id, requestId), eq(swapRequests.status, 'pending')));
    await this.restoreSelection(req.selectionId);
    this.events.emit('swap.cancelled', { periodId: req.periodId, thesisId: req.thesisId });
    await this.audit.log({ id: user.sub, role: user.role }, 'swap.cancel', 'swap_request', requestId, null);
    return { cancelled: true };
  }

  /**
   * Review with MANDATORY note. Lecturers only their own theses; admins all.
   * approve → released_pending + grace job; reject → back to confirmed.
   */
  async decide(
    user: AuthUser,
    requestId: string,
    decision: 'approve' | 'reject',
    note: string,
  ): Promise<{ decided: true }> {
    if (!note || note.trim().length < 3) {
      throw new BadRequestException('A written decision note is mandatory');
    }
    const req = await this.reviewableRequest(requestId, user);

    const now = new Date();
    if (decision === 'approve') {
      const [p] = await this.db
        .select({ settings: selectionPeriods.settings })
        .from(selectionPeriods)
        .innerJoin(thesisSelections, eq(thesisSelections.periodId, selectionPeriods.id))
        .where(eq(thesisSelections.id, req.selectionId))
        .limit(1);
      const graceSec =
        ((p?.settings as { grace_period_sec?: number } | null)?.grace_period_sec) ?? 60;
      const graceUntil = new Date(now.getTime() + graceSec * 1000);

      await this.db
        .update(thesisSelections)
        .set({ status: 'released_pending' })
        .where(and(eq(thesisSelections.id, req.selectionId), eq(thesisSelections.status, 'swap_requested')));
      await this.db
        .update(swapRequests)
        .set({ status: 'approved', reviewedBy: user.sub, decisionNote: note.trim(), decidedAt: now, graceUntil })
        .where(and(eq(swapRequests.id, requestId), eq(swapRequests.status, 'pending')));

      this.events.emit('swap.approved', {
        periodId: req.periodId,
        thesisId: req.thesisId,
        graceUntil: graceUntil.toISOString(),
      });

      // delayed BullMQ job at grace end — NO cron anywhere
      const { createExpiryQueue } = await import('../war/war.tokens.js');
      const queue = createExpiryQueue(process.env.REDIS_URL ?? 'redis://localhost:6379');
      await queue.add(
        'grace_expiry',
        {
          type: 'grace_expiry',
          selectionId: req.selectionId,
          requestId,
          transitionTs: Date.now(),
        },
        { delay: graceSec * 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    } else {
      await this.db
        .update(swapRequests)
        .set({ status: 'rejected', reviewedBy: user.sub, decisionNote: note.trim(), decidedAt: now })
        .where(and(eq(swapRequests.id, requestId), eq(swapRequests.status, 'pending')));
      await this.restoreSelection(req.selectionId);
      this.events.emit('swap.rejected', { periodId: req.periodId, thesisId: req.thesisId });
    }

    await this.audit.log({ id: user.sub, role: user.role }, `swap.${decision}`, 'swap_request', requestId, {
      note: note.trim(),
      selectionId: req.selectionId,
    });
    void this.throttle.record(user.sub);
    return { decided: true };
  }

  /** Old owner re-wars their own title DURING grace → keeps it. */
  async reclaim(user: AuthUser, selectionId: string): Promise<{ reclaimed: true }> {
    const sel = await this.ownedSelection(user.sub, selectionId);
    if (sel.status !== 'released_pending') {
      throw new ConflictException(`Nothing to reclaim from status '${sel.status}'`);
    }
    if (!sel.graceUntil || sel.graceUntil.getTime() <= Date.now()) {
      throw Object.assign(new Error('Grace period has expired'), { status: 410 });
    }
    await this.db
      .update(thesisSelections)
      .set({ status: 'confirmed' })
      .where(and(eq(thesisSelections.id, selectionId), eq(thesisSelections.status, 'released_pending')));
    this.events.emit('swap.reclaimed', { periodId: sel.periodId, thesisId: sel.thesisId });
    await this.audit.log({ id: user.sub, role: user.role }, 'swap.reclaim', 'thesis_selection', selectionId, null);
    return { reclaimed: true };
  }

  /** taken --revoke(reason)--> available (+attempts_left++). Admin here; lecturers arrive F8. */
  async revoke(adminUser: AuthUser, selectionId: string, reason: string): Promise<{ revoked: true }> {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('A revocation reason is mandatory');
    }
    const [sel] = await this.db
      .select({
        id: thesisSelections.id,
        status: thesisSelections.status,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
        studentId: thesisSelections.studentId,
      })
      .from(thesisSelections)
      .where(and(eq(thesisSelections.id, selectionId), isNull(thesisSelections.deletedAt)))
      .limit(1);
    if (!sel) throw new NotFoundException('Selection not found');
    if (!['confirmed', 'taken', 'swap_requested'].includes(sel.status)) {
      throw new ConflictException(`Cannot revoke from status '${sel.status}'`);
    }

    await this.db
      .update(thesisSelections)
      .set({ status: 'expired' })
      .where(and(eq(thesisSelections.id, selectionId), eq(thesisSelections.status, sel.status)));
    await this.bumpAttempts(sel.studentId, sel.periodId);
    this.events.emit('war.available', { periodId: sel.periodId, thesisId: sel.thesisId });
    await this.runner.notifyWatchers({
      periodId: sel.periodId,
      thesisId: sel.thesisId,
      transitionTs: Date.now(),
    });
    await this.audit.log(
      { id: adminUser.sub, role: adminUser.role },
      'selection.revoke',
      'thesis_selection',
      selectionId,
      { reason: reason.trim(), periodId: sel.periodId },
    );
    return { revoked: true };
  }

  async listMine(user: AuthUser): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.execute(sql`
      SELECT r.id, r.category, r.reason_detail AS "reasonDetail", r.status, r.requested_at AS "requestedAt",
             r.decided_at AS "decidedAt", r.decision_note AS "decisionNote", r.grace_until AS "graceUntil",
             th.title, ts.status AS "selectionStatus"
      FROM swap_requests r
      JOIN thesis_selections ts ON ts.id = r.selection_id
      JOIN students s ON s.id = ts.student_id
      JOIN users u ON u.id = s.user_id
      JOIN theses th ON th.id = ts.thesis_id
      WHERE u.id = ${user.sub}
      ORDER BY r.requested_at DESC
      LIMIT 50
    `);
    return rows.rows as Array<Record<string, unknown>>;
  }

  /** Pending queue: lecturers see own theses, admins everything. */
  async reviewQueue(user: AuthUser): Promise<Array<Record<string, unknown>>> {
    const scope =
      user.role === 'admin'
        ? sql`TRUE`
        : sql`th.lecturer_id IN (SELECT l.id FROM lecturers l WHERE l.user_id = ${user.sub})`;
    const rows = await this.db.execute(sql`
      SELECT r.id, r.category, r.reason_detail AS "reasonDetail", r.requested_at AS "requestedAt",
             s.full_name AS "studentName", s.npm, th.title
      FROM swap_requests r
      JOIN thesis_selections ts ON ts.id = r.selection_id
      JOIN students s ON s.id = ts.student_id
      JOIN theses th ON th.id = ts.thesis_id
      WHERE r.status = 'pending' AND ${scope}
      ORDER BY r.requested_at ASC
      LIMIT 100
    `);
    return rows.rows as Array<Record<string, unknown>>;
  }

  // ---------- internals ----------

  private async restoreSelection(selectionId: string): Promise<void> {
    await this.db
      .update(thesisSelections)
      .set({ status: 'confirmed' })
      .where(and(eq(thesisSelections.id, selectionId), eq(thesisSelections.status, 'swap_requested')));
  }

  private async bumpAttempts(studentId: string, periodId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE period_enrollments pe SET attempts_left = attempts_left + 1
      WHERE pe.student_id = ${studentId} AND pe.period_id = ${periodId}
    `);
  }

  private async ownedSelection(userId: string, selectionId: string) {
    const [row] = await this.db
      .select({
        id: thesisSelections.id,
        status: thesisSelections.status,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
      })
      .from(thesisSelections)
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(and(eq(thesisSelections.id, selectionId), eq(students.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException('Selection not found');

    // grace deadline lives on the latest APPROVED request for this selection
    const [reqRow] = await this.db
      .select({ graceUntil: swapRequests.graceUntil })
      .from(swapRequests)
      .where(and(eq(swapRequests.selectionId, selectionId), eq(swapRequests.status, 'approved')))
      .orderBy(desc(swapRequests.requestedAt))
      .limit(1);

    return { ...row, graceUntil: reqRow?.graceUntil ?? null };
  }

  private async assertNoPendingRequest(userId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .innerJoin(thesisSelections, eq(thesisSelections.id, swapRequests.selectionId))
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(and(eq(students.userId, userId), eq(swapRequests.status, 'pending')))
      .limit(1);
    if (row) throw new ConflictException('You already have an active swap request');
  }

  private async assertCooldownOk(userId: string): Promise<void> {
    const recent = await this.db.execute(sql`
      SELECT 1 FROM swap_requests r
      JOIN thesis_selections ts ON ts.id = r.selection_id
      JOIN students s ON s.id = ts.student_id
      WHERE s.user_id = ${userId}
        AND r.requested_at > now() - (${SWAP_COOLDOWN_SEC} * INTERVAL '1 second')
      LIMIT 1
    `);
    if (recent.rows.length > 0) {
      throw Object.assign(new Error('Cooldown — wait 5 minutes between requests'), { status: 429 });
    }
  }

  private async ownRequest(userId: string, requestId: string, allowed: string[]) {
    const [row] = await this.db
      .select({
        id: swapRequests.id,
        status: swapRequests.status,
        selectionId: swapRequests.selectionId,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
      })
      .from(swapRequests)
      .innerJoin(thesisSelections, eq(thesisSelections.id, swapRequests.selectionId))
      .innerJoin(students, eq(students.id, thesisSelections.studentId))
      .where(and(eq(swapRequests.id, requestId), eq(students.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException('Swap request not found');
    if (!allowed.includes(row.status)) {
      throw new ConflictException(`Request is ${row.status} — cannot perform this action`);
    }
    return row;
  }

  private async reviewableRequest(requestId: string, user: AuthUser) {
    const [row] = await this.db
      .select({
        id: swapRequests.id,
        status: swapRequests.status,
        selectionId: swapRequests.selectionId,
        periodId: thesisSelections.periodId,
        thesisId: thesisSelections.thesisId,
        lecturerUserId: lecturers.userId,
      })
      .from(swapRequests)
      .innerJoin(thesisSelections, eq(thesisSelections.id, swapRequests.selectionId))
      .leftJoin(lecturers, eq(lecturers.id, sql`(SELECT th.lecturer_id FROM theses th WHERE th.id = ${thesisSelections.thesisId})`))
      .where(eq(swapRequests.id, requestId))
      .limit(1);
    if (!row) throw new NotFoundException('Swap request not found');
    if (row.status !== 'pending') throw new ConflictException(`Request already ${row.status}`);
    if (user.role === 'lecturer' && (!row.lecturerUserId || row.lecturerUserId !== user.sub)) {
      throw new ForbiddenException('Not your thesis');
    }
    return row;
  }
}
