import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';

/**
 * Standalone swap side-effect executor — driven by the BullMQ expiry-events
 * worker AND by tests (simulated delayed job). Framework-free like
 * StageRunner/WarRunner.
 *
 * Exactly-once watcher notifications: the transition timestamp acts as the
 * idempotency token. A job retry carries the SAME ts → the conditional
 * UPDATE returns nothing → no duplicate sends. A NEW transition carries a
 * newer ts → watchers are notified again ("one notification per transition").
 */
export class SwapRunner {
  constructor(
    private readonly db: Database,
    private readonly redis: {
      publish(channel: string, message: string): Promise<unknown>;
    },
    private readonly email: EmailProvider,
  ) {}

  /**
   * Grace expiry for an approved swap:
   * selection released_pending → expired (title AVAILABLE), old owner's
   * attempts_left++, watchers notified exactly once per transition.
   * No-op when the owner reclaimed during grace.
   */
  async releaseAfterGrace(input: {
    selectionId: string;
    requestId: string;
    /** transition timestamp — also the watcher-notification idempotency token */
    transitionTs: number;
  }): Promise<{
    action: 'released' | 'already-reclaimed' | 'already-released';
    notifiedWatchers: number;
  }> {

    // atomic claim of the expiry work: only one invocation flips the state
    const flipped = await this.db.execute(sql`
      UPDATE thesis_selections ts SET status = 'expired'
      WHERE ts.id = ${input.selectionId} AND ts.status = 'released_pending'
      RETURNING ts.student_id, ts.period_id, ts.thesis_id
    `);
    const sel = flipped.rows[0] as
      | { student_id: string; period_id: string; thesis_id: string }
      | undefined;
    if (!sel) {
      return { action: 'already-reclaimed', notifiedWatchers: 0 };
    }

    void input.requestId;

    // old owner gets a fresh attempt
    await this.db.execute(sql`
      UPDATE period_enrollments pe SET attempts_left = attempts_left + 1
      FROM students s
      WHERE s.id = pe.student_id AND s.id = ${sel.student_id}
        AND pe.period_id = ${sel.period_id}
    `);

    // title is free — live cards update through the same realtime channel
    await this.redis.publish(
      'realtime:events',
      JSON.stringify({
        event: 'war.card',
        room: `lobby:${sel.period_id}`,
        payload: { periodId: sel.period_id, thesisId: sel.thesis_id, status: 'available' },
      }),
    );
    await this.redis.publish(
      'realtime:events',
      JSON.stringify({
        event: 'swap.state',
        room: `thesis:${sel.thesis_id}`,
        payload: { thesisId: sel.thesis_id, state: 'available' },
      }),
    );

    const notified = await this.notifyWatchers({
      periodId: sel.period_id,
      thesisId: sel.thesis_id,
      transitionTs: input.transitionTs,
    });

    return { action: 'released', notifiedWatchers: notified };
  }

  /**
   * One in-app + email notification per watcher per transition-to-available.
   * Idempotent under retries via the transition timestamp.
   */
  async notifyWatchers(input: {
    periodId: string;
    thesisId: string;
    transitionTs: number;
  }): Promise<number> {
    const transitionAt = new Date(input.transitionTs);
    const claimed = await this.db.execute(sql`
      UPDATE thesis_watchers w SET notified_at = ${transitionAt}
      WHERE w.thesis_id = ${input.thesisId}
        AND (w.notified_at IS NULL OR w.notified_at <> ${transitionAt})
      RETURNING w.student_id
    `);

    let sent = 0;
    for (const row of claimed.rows as Array<{ student_id: string }>) {
      const info = (
        await this.db.execute(sql`
          SELECT u.id AS user_id, u.email, s.full_name, th.title
          FROM students s JOIN users u ON u.id = s.user_id
          CROSS JOIN LATERAL (SELECT t.title FROM theses t WHERE t.id = ${input.thesisId}) th
          WHERE s.id = ${row.student_id}
        `)
      ).rows[0] as { user_id: string; email: string; full_name: string; title: string } | undefined;
      if (!info) continue;

      const [delivery] = await this.db.execute(sql`
        INSERT INTO notification_deliveries (user_id, channel, template, payload, status)
        VALUES (${info.user_id}, 'in_app', 'watcher_available',
                ${JSON.stringify({ periodId: input.periodId, thesisId: input.thesisId })}::jsonb,
                'queued')
        RETURNING id
      `).then((r) => r.rows as Array<{ id: string }>);

      // in-app record persists; realtime push rides the same channel contract
      if (delivery) {
        await this.redis.publish(
          'realtime:events',
          JSON.stringify({
            event: 'notification',
            room: `user:${info.user_id}`,
            payload: {
              kind: 'watcher_available',
              thesisId: input.thesisId,
              title: info.title,
            },
          }),
        );
      }

      try {
        await this.email.send({
          to: info.email,
          subject: `"${info.title}" just became available`,
          body: `<p>Hi ${info.full_name},</p><p>A title you are watching is available again — open the war room to claim it.</p>`,
          deliveryId: delivery?.id,
        });
        if (delivery) {
          await this.db.execute(sql`
            UPDATE notification_deliveries SET status='sent', sent_at=now() WHERE id=${delivery.id}
          `);
        }
        sent += 1;
      } catch {
        if (delivery) {
          await this.db.execute(sql`
            UPDATE notification_deliveries SET status='failed' WHERE id=${delivery.id}
          `);
        }
      }
    }
    return sent;
  }
}
