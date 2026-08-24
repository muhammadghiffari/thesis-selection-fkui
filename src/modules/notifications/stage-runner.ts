import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db.module.js';
import {
  notificationDeliveries,
  periodEnrollments,
  selectionPeriods,
  students,
  users,
} from '../../shared/db/schema.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import type { MagicTokenService } from './magic-token.service.js';
import { STAGE_VALUE, TEMPLATE, SUBJECT, BODY, type StageKey } from './stage-definitions.js';

/** Active selections per enrollment row (correlated). */
const ACTIVE_SELECTIONS = sql`(
  SELECT count(*) FROM thesis_selections ts
  WHERE ts.student_id = students.id
    AND ts.period_id = period_enrollments.period_id
    AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
    AND ts.deleted_at IS NULL
)`;

export interface StageCandidate {
  enrollmentId: string;
  userId: string;
  email: string;
  fullName: string;
}

/**
 * Executes delivery stages against the database. Deliberately framework-free:
 * the Nest NotificationsService AND the BullMQ worker process drive this same
 * class — single source of truth for exactly-once semantics.
 */
export class StageRunner {
  constructor(
    private readonly db: Database,
    private readonly email: EmailProvider,
    private readonly magicTokens: MagicTokenService,
  ) {}

  /** Ensures every active student has an enrollment row for the period. */
  async ensureEnrollments(periodId: string): Promise<number> {
    const result = await this.db.execute(sql`
      INSERT INTO period_enrollments (period_id, student_id)
      SELECT ${periodId}, s.id FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE u.deleted_at IS NULL
      ON CONFLICT (period_id, student_id) DO NOTHING
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Runs one stage for a period. Exactly-once per student:
   * email stages claim an atomic `reminder_stage` slot before sending;
   * the closes warning is guarded by prior-delivery existence.
   */
  async runStage(periodId: string, stage: StageKey): Promise<{ sent: number }> {
    if (stage === 'initial_h7') await this.ensureEnrollments(periodId);
    const candidates = await this.candidates(periodId, stage);
    let sent = 0;

    for (const c of candidates) {
      let deliveryId: string | undefined;

      if (stage === 'closes_warning') {
        // exactly-once via unique-ish existence check inside the insert guard
        const already = await this.db
          .select({ id: notificationDeliveries.id })
          .from(notificationDeliveries)
          .where(
            and(
              eq(notificationDeliveries.userId, c.userId),
              eq(notificationDeliveries.template, TEMPLATE[stage]),
              sql`${notificationDeliveries.payload}->>'periodId' = ${periodId}`,
            ),
          )
          .limit(1);
        if (already.length > 0) continue;
      } else {
        // atomic slot claim — a retry finds reminder_stage already >= target
        const target = STAGE_VALUE[stage];
        const claimed = await this.db
          .update(periodEnrollments)
          .set({ reminderStage: target })
          .where(
            and(
              eq(periodEnrollments.id, c.enrollmentId),
              sql`${periodEnrollments.reminderStage} < ${target}`,
            ),
          )
          .returning({ id: periodEnrollments.id });
        if (claimed.length === 0) continue;
      }

      try {
        const [row] = await this.db
          .insert(notificationDeliveries)
          .values({
            userId: c.userId,
            channel: stage === 'nudge_t10' ? 'in_app' : 'email',
            template: TEMPLATE[stage],
            payload: { periodId },
            status: 'queued',
          })
          .returning({ id: notificationDeliveries.id });
        deliveryId = row?.id;
        if (!deliveryId) continue;

        if (stage !== 'nudge_t10') {
          // initial mints the personal link; later emails mint a fresh jti
          // (hash swap invalidates older emailed URLs — desired posture)
          const raw = await this.issueLink(c.enrollmentId);
          const linkUrl = `${process.env.APP_URL ?? ''}/magic/${raw}`;
          await this.email.send({
            to: c.email,
            subject: SUBJECT[stage],
            body: `<p>Hello ${c.fullName},</p><p>${BODY[stage]}</p><p><a href="${linkUrl}">Open your selection page</a></p>`,
            deliveryId,
          });
        }

        await this.db
          .update(notificationDeliveries)
          .set({ status: 'sent', sentAt: new Date() })
          .where(eq(notificationDeliveries.id, deliveryId));
        sent += 1;
      } catch (err) {
        if (deliveryId) {
          await this.db
            .update(notificationDeliveries)
            .set({ status: 'failed', error: String(err) })
            .where(eq(notificationDeliveries.id, deliveryId));
        }
      }
    }
    return { sent };
  }

  /** Mints a fresh single-use link token and stores its hash on the enrollment. */
  async issueLink(enrollmentId: string): Promise<string> {
    const [enr] = await this.db
      .select({
        userId: students.userId,
        periodId: periodEnrollments.periodId,
        closesAt: selectionPeriods.closesAt,
      })
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .where(eq(periodEnrollments.id, enrollmentId))
      .limit(1);
    if (!enr) throw new Error('enrollment not found');

    const jti = randomUUID();
    const cap = enr.closesAt ?? new Date(Date.now() + 30 * 86_400_000);
    const maxAge = new Date(Date.now() + Number(process.env.MAGIC_LINK_MAX_AGE_DAYS ?? 30) * 86_400_000);
    const expiresAt = cap < maxAge ? cap : maxAge;

    const raw = await this.magicTokens.sign(
      { sub: enr.userId, periodId: enr.periodId, jti },
      expiresAt,
    );
    await this.db
      .update(periodEnrollments)
      .set({ magicLinkTokenHash: this.magicTokens.hash(jti) })
      .where(eq(periodEnrollments.id, enrollmentId));
    return raw;
  }

  private async candidates(periodId: string, stage: StageKey): Promise<StageCandidate[]> {
    const base = () =>
      this.db
        .select({
          enrollmentId: periodEnrollments.id,
          userId: students.userId,
          email: users.email,
          fullName: students.fullName,
        })
        .from(periodEnrollments)
        .innerJoin(students, eq(students.id, periodEnrollments.studentId))
        .innerJoin(users, eq(users.id, students.userId));

    if (stage === 'closes_warning') {
      return base()
        .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
        .where(
          and(
            eq(periodEnrollments.periodId, periodId),
            isNull(users.deletedAt),
            sql`${ACTIVE_SELECTIONS} < COALESCE(${selectionPeriods.settings}->>'required_selections', '3')::int`,
          ),
        );
    }

    // email/nudge stages consider all enrolled actives; the atomic stage-slot
    // claim above provides exactly-once per run.
    return base().where(and(eq(periodEnrollments.periodId, periodId), isNull(users.deletedAt)));
  }
}
