import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { thesisSelections } from '../../shared/db/schema.js';

export const MAX_WATCHES = 10;

/** States a title must be in for watcher subscriptions (AGENTS.md rule 7). */
const WATCHABLE = ['swap_requested', 'released_pending'];

@Injectable()
export class WatchersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async subscribe(userId: string, thesisId: string): Promise<{ subscribed: true; count: number }> {
    const [thesis] = await this.db
      .select({ status: thesisSelections.status })
      .from(thesisSelections)
      .where(and(eq(thesisSelections.id, thesisId), isNull(thesisSelections.deletedAt)))
      .limit(1);
    if (!thesis) throw new NotFoundException('Thesis not found');
    if (!WATCHABLE.includes(thesis.status)) {
      throw new ConflictException(
        `Only titles in swap_requested/pending_release can be watched (current: ${thesis.status})`,
      );
    }

    const counts = (
      await this.db.execute(sql`
        SELECT count(*)::int AS n FROM thesis_watchers w
        JOIN students s ON s.id = w.student_id
        WHERE s.user_id = ${userId}
      `)
    ).rows as Array<{ n: number }>;
    if ((counts[0]?.n ?? 0) >= MAX_WATCHES) {
      throw new ConflictException(`Watch limit reached (${MAX_WATCHES})`);
    }

    // idempotent: unique(student_id, thesis_id) → ON CONFLICT DO NOTHING
    await this.db.execute(sql`
      INSERT INTO thesis_watchers (student_id, thesis_id)
      SELECT s.id, ${thesisId} FROM students s WHERE s.user_id = ${userId}
      ON CONFLICT (student_id, thesis_id) DO NOTHING
    `);

    const after = (
      await this.db.execute(sql`
        SELECT count(*)::int AS n FROM thesis_watchers w
        JOIN students s ON s.id = w.student_id WHERE s.user_id = ${userId}
      `)
    ).rows as Array<{ n: number }>;
    return { subscribed: true, count: after[0]?.n ?? 0 };
  }

  async unsubscribe(userId: string, thesisId: string): Promise<{ removed: true }> {
    await this.db.execute(sql`
      DELETE FROM thesis_watchers w USING students s
      WHERE s.id = w.student_id AND s.user_id = ${userId} AND w.thesis_id = ${thesisId}
    `);
    return { removed: true };
  }

  async listMine(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.execute(sql`
      SELECT th.id AS "thesisId", th.title, w.notified_at AS "notifiedAt", ts.status AS "selectionStatus"
      FROM thesis_watchers w
      JOIN students s ON s.id = w.student_id
      JOIN users u ON u.id = s.user_id
      JOIN theses th ON th.id = w.thesis_id
      LEFT JOIN LATERAL (
        SELECT status FROM thesis_selections ts
        WHERE ts.thesis_id = th.id AND ts.deleted_at IS NULL
          AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
        LIMIT 1
      ) ts ON TRUE
      WHERE u.id = ${userId}
      ORDER BY w.created_at DESC
    `);
    return rows.rows as Array<Record<string, unknown>>;
  }
}
