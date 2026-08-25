import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { REDIS } from '../../shared/redis/redis.module.js';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { EMAIL_PROVIDER } from '../../shared/notifications/notifications-infra.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import type { AuthUser } from '../identity/auth-user.js';
import { IntegrityScorer } from './scorer.js';

interface QueueParams {
  level?: 'high' | 'medium';
  periodId?: string;
  page: number;
  pageSize: number;
  lecturerUserId?: string;
}

@Injectable()
export class IntegrityService {
  readonly scorer: IntegrityScorer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.scorer = new IntegrityScorer(db);
    // confirm → async scoring job (BullMQ; idempotent per selection)
    this.events.on('selection.confirmed', ({ selectionId }) => {
      void (async () => {
        const { createExpiryQueue } = await import('../war/war.tokens.js');
        const queue = createExpiryQueue(process.env.REDIS_URL ?? 'redis://localhost:6379');
        await queue.add(
          'score_selection',
          { type: 'score_selection', selectionId },
          { delay: 250, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
        );
      })().catch(() => undefined);
    });
  }

  /** Runs scoring + HIGH notifications. Used by worker AND directly by tests. */
  async runScore(
    selectionId: string,
  ): Promise<{ score: number; level: string; skipped?: 'already-reviewed' }> {
    const result = await this.scorer.scoreSelection(selectionId);
    if (result.level === 'high' && !result.skipped) {
      await this.notifyHighOnce(selectionId, result.score, result.signals);
    }
    if (result.level !== 'clean') {
      this.events.emit('integrity.flagged', { selectionId, level: result.level, score: result.score });
    }
    return { score: result.score, level: result.level };
  }

  /**
   * HIGH → notify admin(s)+lecturer exactly ONCE per selection.
   * Delivery-existence check makes retries/re-scores duplicate-proof.
   */
  private async notifyHighOnce(
    selectionId: string,
    score: number,
    signals: unknown,
  ): Promise<void> {
    const already = await this.db.execute(sql`
      SELECT 1 FROM notification_deliveries
      WHERE template = 'integrity_high'
        AND payload->>'selectionId' = ${selectionId}
      LIMIT 1
    `);
    if (already.rows.length > 0) return;

    const recipients = await this.db.execute(sql`
      SELECT u.id, u.email FROM users u WHERE u.role = 'admin' AND u.deleted_at IS NULL
      UNION
      SELECT u.id, u.email
      FROM users u
      JOIN lecturers l ON l.user_id = u.id
      WHERE u.deleted_at IS NULL AND l.id IN (
        SELECT th.lecturer_id FROM theses th
        JOIN thesis_selections ts ON ts.thesis_id = th.id
        WHERE ts.id = ${selectionId} AND th.lecturer_id IS NOT NULL
      )
    `);

    for (const r of recipients.rows as Array<{ id: string; email: string }>) {
      const [delivery] = await this.db.execute(sql`
        INSERT INTO notification_deliveries (user_id, channel, template, payload, status)
        VALUES (${r.id}, 'email', 'integrity_high',
                ${JSON.stringify({ selectionId, score, signals })}::jsonb, 'queued')
        RETURNING id
      `).then((res) => res.rows as Array<{ id: string }>);

      try {
        await this.email.send({
          to: r.email,
          subject: `[INTEGRITY-HIGH] Selection flagged (${score})`,
          body: `<p>A selection scored HIGH (${score}) and requires mandatory manual review.</p>`,
          deliveryId: delivery?.id,
        });
        if (delivery) {
          await this.db.execute(sql`
            UPDATE notification_deliveries SET status='sent', sent_at=now() WHERE id=${delivery.id}
          `);
        }
      } catch {
        if (delivery) {
          await this.db.execute(sql`UPDATE notification_deliveries SET status='failed' WHERE id=${delivery.id}`);
        }
      }
    }
  }

  /** Lecturer dashboard — OWN theses only. */
  async ownTheses(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.execute(sql`
      SELECT th.id AS "thesisId", th.title, th.track,
             s.full_name AS "holderName", s.npm AS "holderNpm",
             ts.status AS "selectionStatus", ts.priority,
             ts.confirmed_at AS "confirmedAt", ts.reference_number AS "referenceNumber",
             pe.attempts_left AS "attemptsLeft",
             (SELECT count(*)::int FROM integrity_flags f WHERE f.selection_id = ts.id AND f.level = 'high') AS "highAlerts"
      FROM theses th
      JOIN lecturers l ON l.id = th.lecturer_id AND l.user_id = ${userId}
      LEFT JOIN thesis_selections ts ON ts.thesis_id = th.id
        AND ts.deleted_at IS NULL
        AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
      LEFT JOIN students s ON s.id = ts.student_id
      LEFT JOIN period_enrollments pe ON pe.student_id = s.id AND pe.period_id = th.period_id
      WHERE th.deleted_at IS NULL
      ORDER BY th.title
    `);
    return rows.rows as Array<Record<string, unknown>>;
  }

  /** Integrity queue. lecturers scoped to own theses via user_id join. */
  async queue(params: QueueParams): Promise<{
    rows: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const scope = params.lecturerUserId
      ? sql`AND th.lecturer_id IN (SELECT l.id FROM lecturers l WHERE l.user_id = ${params.lecturerUserId})`
      : sql``;
    const levelFilter = params.level ? sql`AND f.level = ${params.level}` : sql``;
    const periodFilter = params.periodId ? sql`AND ts.period_id = ${params.periodId}` : sql``;
    const where = sql`${levelFilter} ${periodFilter}`;

    const totals = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM integrity_flags f
      JOIN thesis_selections ts ON ts.id = f.selection_id
      JOIN theses th ON th.id = ts.thesis_id
      WHERE (f.outcome IS NULL OR f.outcome = 'pending') ${where} ${scope}
    `);
    const rows = await this.db.execute(sql`
      SELECT f.id, f.score, f.level, f.signals, f.created_at AS "createdAt",
             f.outcome, f.decision_note AS "decisionNote",
             ts.id AS "selectionId", ts.status AS "selectionStatus",
             th.title, th.id AS "thesisId",
             s.full_name AS "studentName", s.npm, s.research_track AS "studentTrack",
             th.track AS "thesisTrack"
      FROM integrity_flags f
      JOIN thesis_selections ts ON ts.id = f.selection_id
      JOIN students s ON s.id = ts.student_id
      JOIN theses th ON th.id = ts.thesis_id
      WHERE (f.outcome IS NULL OR f.outcome = 'pending') ${where} ${scope}
      ORDER BY f.score DESC, f.created_at DESC
      LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
    `);

    return {
      rows: rows.rows as Array<Record<string, unknown>>,
      total: ((totals.rows[0] as { n: number } | undefined)?.n) ?? 0,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /** Scoping guard for lecturer resolves — 404 when not theirs. */
  async assertFlagOwnedByLecturer(flagId: string, lecturerUserId: string): Promise<void> {
    const check = await this.db.execute(sql`
      SELECT 1 FROM integrity_flags f
      JOIN thesis_selections ts ON ts.id = f.selection_id
      JOIN theses th ON th.id = ts.thesis_id
      JOIN lecturers l ON l.id = th.lecturer_id
      WHERE f.id = ${flagId} AND l.user_id = ${lecturerUserId}
      LIMIT 1
    `);
    if (check.rows.length === 0) throw new NotFoundException('Flag not found for your theses');
  }

  /**
   * Resolve with MANDATORY note. outcome=revoked asks the swap module (owner
   * of that transition) to revoke via the bus — NO direct cross-module call.
   */
  async resolve(
    user: AuthUser,
    flagId: string,
    outcome: 'false_positive' | 'investigate' | 'revoked',
    note: string,
  ): Promise<{ resolved: true }> {
    const flag = (
      (await this.db.execute(sql`
        SELECT f.id, ts.id AS "selectionId", ts.status, ts.period_id AS "periodId", ts.thesis_id AS "thesisId"
        FROM integrity_flags f
        JOIN thesis_selections ts ON ts.id = f.selection_id
        WHERE f.id = ${flagId}
        LIMIT 1
      `))
    ).rows[0] as
      | { id: string; selectionId: string; status: string; periodId: string; thesisId: string }
      | undefined;
    if (!flag) throw new NotFoundException('Flag not found');

    await this.db.execute(sql`
      UPDATE integrity_flags
      SET outcome = ${outcome}, decision_note = ${note.trim()}, decided_at = now(),
          reviewed_by = ${user.sub}
      WHERE id = ${flagId}
    `);

    if (outcome === 'revoked') {
      this.events.emit('swap.revoke_requested', {
        selectionId: flag.selectionId,
        reason: `Integrity review: ${note.trim()}`,
        actorId: user.sub,
      });
    }

    await this.audit.log({ id: user.sub, role: user.role }, 'integrity.resolve', 'integrity_flag', flagId, {
      outcome,
      note: note.trim(),
      selectionId: flag.selectionId,
    });
    return { resolved: true };
  }
}
