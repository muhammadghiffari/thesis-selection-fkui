import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import {
  notificationDeliveries,
  periodEnrollments,
  selectionPeriods,
  students,
  users,
} from '../../shared/db/schema.js';
import type { DomainEvents } from '../../shared/event-bus/event-bus.service.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { SESSION_ISSUER, type SessionIssuer } from '../../shared/auth/session.port.js';
import { EMAIL_PROVIDER } from '../../shared/notifications/notifications-infra.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import { createEmailQueue } from './notifications.tokens.js';
import { createExpiryQueue } from '../war/war.tokens.js';
import { hashFingerprint, MagicTokenService } from './magic-token.service.js';
import { StageRunner } from './stage-runner.js';
import type { StageKey } from './stage-definitions.js';

const H = 3_600_000;
const MIN = 60_000;

@Injectable()
export class NotificationsService {
  readonly runner: StageRunner;
  private readonly emailQueue: Queue;
  private readonly expiryQueue: Queue;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(MagicTokenService) private readonly magicTokens: MagicTokenService,
    @Inject(SESSION_ISSUER) private readonly sessions: SessionIssuer,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.runner = new StageRunner(db, email, magicTokens);
    this.emailQueue = createEmailQueue(process.env.REDIS_URL ?? 'redis://localhost:6379');
    this.expiryQueue = createExpiryQueue(process.env.REDIS_URL ?? 'redis://localhost:6379');

    // Cross-module wiring via the bus: periods never import notifications,
    // the war module never sends mail itself.
    this.events.on('period.scheduled', ({ periodId, opensAt }) => {
      void this.scheduleForPeriod(periodId, new Date(opensAt)).catch((err) => {
        console.error('scheduleForPeriod failed', err);
      });
    });
    this.events.on('selection.confirmed', (evt) => {
      void this.sendReceipt(evt).catch((err) => {
        console.error('receipt send failed', err);
      });
    });
  }

  /** Success receipt per confirmed title; final one carries the full summary. */
  private async sendReceipt(evt: DomainEvents['selection.confirmed']): Promise<void> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, evt.userId))
      .limit(1);
    if (!user) return;

    const [delivery] = await this.db
      .insert(notificationDeliveries)
      .values({
        userId: user.id,
        channel: 'email',
        template: 'selection_receipt',
        payload: { periodId: evt.periodId, selectionId: evt.selectionId },
        status: 'queued',
      })
      .returning({ id: notificationDeliveries.id });
    if (!delivery) return;

    try {
      await this.email.send({
        to: user.email,
        subject: `Title confirmed — ${evt.referenceNumber ?? ''}`.trim(),
        body:
          `<p>You confirmed <strong>${evt.thesisTitle}</strong>` +
          `${evt.lecturerName ? ` with ${evt.lecturerName}` : ''}.</p>` +
          `<p>Reference: <strong>${evt.referenceNumber ?? 'pending'}</strong> at ${evt.confirmedAt} (UTC).</p>` +
          `<p>You may undo within 15 seconds or request a swap later.</p>`,
        deliveryId: delivery.id,
      });
      await this.db
        .update(notificationDeliveries)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
    } catch (err) {
      await this.db
        .update(notificationDeliveries)
        .set({ status: 'failed', error: String(err) })
        .where(eq(notificationDeliveries.id, delivery.id));
    }
  }

  /** One delayed job per stage; negative delays clamp to immediate. */
  async scheduleForPeriod(periodId: string, opensAt: Date): Promise<void> {
    const [period] = await this.db
      .select({ closesAt: selectionPeriods.closesAt })
      .from(selectionPeriods)
      .where(eq(selectionPeriods.id, periodId))
      .limit(1);
    if (!period) throw new NotFoundException('period not found');

    const delay = (at: Date): number => Math.max(0, at.getTime() - Date.now());
    const jobs = [
      { name: 'initial_h7', at: new Date(opensAt.getTime() - 7 * 24 * H) },
      { name: 'reminder_h1', at: new Date(opensAt.getTime() - 24 * H) },
      { name: 'reminder_h1h', at: new Date(opensAt.getTime() - H) },
      { name: 'nudge_t10', at: new Date(opensAt.getTime() - 10 * MIN) },
    ] as const;
    const closeJobs =
      period.closesAt !== null
        ? [{ name: 'closes_warning' as const, at: new Date(period.closesAt.getTime() - 2 * H) }]
        : [];

    await this.emailQueue.addBulk(
      [...jobs, ...closeJobs].map((j) => ({
        name: 'stage',
        data: { periodId, stage: j.name },
        opts: { delay: delay(j.at), attempts: 3, backoff: { type: 'exponential' as const, delay: 30_000 } },
      })),
    );

    // F5 auto-war fires exactly at opens_at (heartbeat-gated server-side)
    await this.expiryQueue.add(
      'auto_war',
      { periodId },
      { delay: delay(opensAt), attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
    );
  }

  /** Delegates stage execution to the shared runner (worker uses it directly). */
  runStage(periodId: string, stage: StageKey): Promise<{ sent: number }> {
    return this.runner.runStage(periodId, stage);
  }

  /**
   * First contact with a magic link: binds (or verifies) the device
   * fingerprint and starts the claim TTL clock. Idempotent for same-device.
   */
  async open(
    token: string,
    fingerprint: string,
  ): Promise<{ expiresAt: string; periodId: string }> {
    const payload = await this.magicTokens.verify(token);

    const [enr] = await this.db
      .select()
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .where(and(eq(students.userId, payload.sub), eq(periodEnrollments.periodId, payload.periodId)))
      .limit(1);
    if (!enr || enr.period_enrollments.magicLinkTokenHash !== this.magicTokens.hash(payload.jti)) {
      throw Object.assign(new Error('Unknown or consumed link'), { status: 410 });
    }
    if (enr.period_enrollments.linkClaimedAt) {
      throw Object.assign(new Error('Link already used'), { status: 410 });
    }

    const fpHash = hashFingerprint(fingerprint);
    if (
      enr.period_enrollments.deviceFingerprintHash &&
      enr.period_enrollments.deviceFingerprintHash !== fpHash
    ) {
      // integrity signal — logged, decision belongs to humans later (F8)
      await this.audit.log(null, 'integrity.device_rebind_attempt', 'period_enrollment', enr.period_enrollments.id, {
        periodId: payload.periodId,
      });
      throw Object.assign(new Error('Link bound to another device'), { status: 409 });
    }

    const now = new Date();
    const openedAt = enr.period_enrollments.linkOpenedAt ?? now;
    await this.db
      .update(periodEnrollments)
      .set({
        deviceFingerprintHash: fpHash,
        ...(enr.period_enrollments.linkOpenedAt ? {} : { linkOpenedAt: openedAt }),
      })
      .where(eq(periodEnrollments.id, enr.period_enrollments.id));

    const ttlMs = Number(process.env.MAGIC_LINK_TTL_SEC ?? 900) * 1000;
    return { expiresAt: new Date(openedAt.getTime() + ttlMs).toISOString(), periodId: payload.periodId };
  }

  /** Consumes the link (single-use) and issues a session pair. */
  async claim(
    token: string,
    fingerprint: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = await this.magicTokens.verify(token);

    const [enr] = await this.db
      .select()
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .where(and(eq(students.userId, payload.sub), eq(periodEnrollments.periodId, payload.periodId)))
      .limit(1);
    if (!enr || enr.period_enrollments.magicLinkTokenHash !== this.magicTokens.hash(payload.jti)) {
      throw Object.assign(new Error('Unknown or consumed link'), { status: 410 });
    }
    if (enr.period_enrollments.linkClaimedAt) {
      throw Object.assign(new Error('Link already used'), { status: 410 });
    }

    const fpHash = hashFingerprint(fingerprint);
    if (
      !enr.period_enrollments.deviceFingerprintHash ||
      enr.period_enrollments.linkOpenedAt === null
    ) {
      // first-touch claim: bind + start clock implicitly
      await this.db
        .update(periodEnrollments)
        .set({ deviceFingerprintHash: fpHash, linkOpenedAt: new Date() })
        .where(eq(periodEnrollments.id, enr.period_enrollments.id));
    } else if (enr.period_enrollments.deviceFingerprintHash !== fpHash) {
      await this.audit.log(null, 'integrity.device_rebind_attempt', 'period_enrollment', enr.period_enrollments.id, {
        periodId: payload.periodId,
      });
      throw Object.assign(new Error('Link bound to another device'), { status: 409 });
    }

    // TTL measured from first open
    const openedAt = enr.period_enrollments.linkOpenedAt ?? new Date();
    const ttlMs = Number(process.env.MAGIC_LINK_TTL_SEC ?? 900) * 1000;
    if (Date.now() > openedAt.getTime() + ttlMs) {
      throw new UnauthorizedException('Magic link expired');
    }

    // atomic consumption — replay loses the race here
    const consumed = await this.db
      .update(periodEnrollments)
      .set({ linkClaimedAt: new Date() })
      .where(
        and(eq(periodEnrollments.id, enr.period_enrollments.id), sql`${periodEnrollments.linkClaimedAt} IS NULL`),
      )
      .returning({ id: periodEnrollments.id });
    if (consumed.length === 0) {
      throw Object.assign(new Error('Link already used'), { status: 410 });
    }

    return this.sessions.issueSession(payload.sub, 'student');
  }

  /** Admin resend: fresh token, clears prior binding/open state. Audited by caller. */
  async resend(studentId: string, periodId: string): Promise<{ delivered: true }> {
    const [enr] = await this.db
      .select({
        enrollmentId: periodEnrollments.id,
        userId: students.userId,
        email: users.email,
        fullName: students.fullName,
        claimedAt: periodEnrollments.linkClaimedAt,
      })
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .innerJoin(users, eq(users.id, students.userId))
      .where(and(eq(periodEnrollments.studentId, studentId), eq(periodEnrollments.periodId, periodId)))
      .limit(1);
    if (!enr) throw new NotFoundException('Student is not enrolled in this period');
    if (enr.claimedAt) {
      throw Object.assign(new Error('Student already claimed their access'), { status: 409 });
    }

    const raw = await this.runner.issueLink(enr.enrollmentId);
    await this.db
      .update(periodEnrollments)
      .set({ deviceFingerprintHash: null, linkOpenedAt: null })
      .where(eq(periodEnrollments.id, enr.enrollmentId));

    const [delivery] = await this.db
      .insert(notificationDeliveries)
      .values({
        userId: enr.userId,
        channel: 'email',
        template: 'magic_link_resend',
        payload: { periodId },
        status: 'queued',
      })
      .returning({ id: notificationDeliveries.id });

    if (!delivery) throw new Error('delivery insert failed');
    const linkUrl = `${process.env.APP_URL ?? ''}/magic/${raw}`;
    try {
      await this.email.send({
        to: enr.email,
        subject: 'Your new thesis selection access link',
        body: `<p>Hello ${enr.fullName},</p><p>A new access link was issued for you. Previous links are no longer valid.</p><p><a href="${linkUrl}">Open your selection page</a></p>`,
        deliveryId: delivery.id,
      });
      await this.db
        .update(notificationDeliveries)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
    } catch (err) {
      await this.db
        .update(notificationDeliveries)
        .set({ status: 'failed', error: String(err) })
        .where(eq(notificationDeliveries.id, delivery.id));
      throw err;
    }
    return { delivered: true };
  }

  /** Admin delivery-tracking dashboard rows. */
  async dashboard(periodId: string): Promise<
    Array<{
      studentId: string;
      npm: string;
      fullName: string;
      email: string;
      reminderStage: number;
      linkSentAt: string | null;
      linkOpenedAt: string | null;
      linkClaimedAt: string | null;
      deliveries: number;
      failed: number;
    }>
  > {
    const rows = await this.db
      .select({
        studentId: students.id,
        npm: students.npm,
        fullName: students.fullName,
        email: users.email,
        reminderStage: periodEnrollments.reminderStage,
        linkSentAt: sql<string | null>`(SELECT max(nd.sent_at)::text FROM notification_deliveries nd
             WHERE nd.user_id = ${students.userId} AND nd.template LIKE 'magic_link%')`,
        linkOpenedAt: periodEnrollments.linkOpenedAt,
        linkClaimedAt: periodEnrollments.linkClaimedAt,
        deliveries: sql<number>`(SELECT count(*)::int FROM notification_deliveries nd WHERE nd.user_id = ${students.userId})`,
        failed: sql<number>`(SELECT count(*)::int FROM notification_deliveries nd WHERE nd.user_id = ${students.userId} AND nd.status = 'failed')`,
      })
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .innerJoin(users, eq(users.id, students.userId))
      .where(eq(periodEnrollments.periodId, periodId))
      .orderBy(asc(students.npm));

    return rows.map((r) => ({
      ...r,
      linkOpenedAt: r.linkOpenedAt ? new Date(r.linkOpenedAt).toISOString() : null,
      linkClaimedAt: r.linkClaimedAt ? new Date(r.linkClaimedAt).toISOString() : null,
    }));
  }
}
