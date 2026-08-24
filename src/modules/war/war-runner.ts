import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Database } from '../../shared/db/db.module.js';
import type { EmbeddingProvider } from '../../shared/embeddings/embedding-provider.js';

export interface AutoWarOutcome {
  studentUserId: string;
  claimed?: { thesisId: string; title: string; referenceNumber: string | null } | null;
  skipped?: 'no-heartbeat' | 'no-preference' | 'no-available' | 'already-3';
}

/**
 * Server-side auto-war execution (F4 consent + live heartbeat → instant lock
 * at opens_at). Deliberately standalone: the BullMQ expiry-events worker and
 * tests drive this directly.
 *
 * Fairness contract: a student WITHOUT a fresh heartbeat is skipped — the tab
 * was closed, so they war manually like everyone else.
 */
export class WarRunner {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  /** Executes one auto-war pass for a period. Idempotent per student. */
  async runAutoWar(periodId: string): Promise<AutoWarOutcome[]> {
    const armed = await this.db.execute(sql`
      SELECT u.id AS user_id, sp.embedding IS NOT NULL AS has_pref
      FROM period_enrollments pe
      JOIN students s ON s.id = pe.student_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN student_preferences sp ON sp.student_id = s.id AND sp.period_id = pe.period_id
      WHERE pe.period_id = ${periodId}
        AND pe.auto_war_enabled = true
        AND pe.auto_war_consented_at IS NOT NULL
        AND pe.link_claimed_at IS NOT NULL
        AND u.deleted_at IS NULL
    `);

    const outcomes: AutoWarOutcome[] = [];
    for (const row of armed.rows as Array<{ user_id: string; has_pref: boolean }>) {
      const userId = row.user_id;
      if (!(await this.redis.exists(`hb:${userId}:${periodId}`))) {
        outcomes.push({ studentUserId: userId, skipped: 'no-heartbeat' });
        continue;
      }
      const activeCount = (
        await this.db.execute(sql`
          SELECT count(*)::int AS n FROM thesis_selections ts
          JOIN students s ON s.id = ts.student_id
          WHERE s.user_id = ${userId} AND ts.period_id = ${periodId}
            AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
            AND ts.deleted_at IS NULL
        `)
      ).rows[0] as { n: number };
      if ((activeCount?.n ?? 0) >= 3) {
        outcomes.push({ studentUserId: userId, skipped: 'already-3' });
        continue;
      }

      const best = (
        await this.db.execute(sql`
          SELECT t.id, t.title, 1 - (t.embedding <=> sp.embedding) AS score, s.id AS student_id
          FROM student_preferences sp
          JOIN students s ON s.id = sp.student_id
          JOIN users u ON u.id = s.user_id
          CROSS JOIN LATERAL (
            SELECT th.id, th.title, th.embedding
            FROM theses th
            WHERE th.period_id = ${periodId}
              AND th.deleted_at IS NULL
              AND th.embedding IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM thesis_selections act
                WHERE act.thesis_id = th.id
                  AND act.status IN ('locked','confirmed','taken','swap_requested','released_pending')
                  AND act.deleted_at IS NULL
              )
            ORDER BY th.embedding <=> sp.embedding
            LIMIT 1
          ) t
          WHERE u.id = ${userId} AND sp.period_id = ${periodId}
        `)
      ).rows[0] as { id: string; title: string; score: number; student_id: string } | undefined;

      if (!best) {
        outcomes.push({
          studentUserId: userId,
          skipped: (await this.preferenceExists(userId, periodId)) ? 'no-available' : 'no-preference',
        });
        continue;
      }

      // atomic claim+confirm in one statement chain: insert as confirmed with
      // both partial indexes as the race arbiter (Redis lock unnecessary here —
      // DB index is the final truth and this runs once at opens_at)
      const nextPriority = (
        await this.db.execute(sql`
          SELECT COALESCE(MIN(p), 1) AS prio FROM (
            SELECT generate_series(1,3) AS p
            EXCEPT
            SELECT ts.priority FROM thesis_selections ts WHERE ts.student_id = ${best.student_id}
              AND ts.period_id = ${periodId}
              AND ts.status IN ('locked','confirmed','taken','swap_requested','released_pending')
              AND ts.deleted_at IS NULL
          ) avail
        `)
      ).rows[0] as { prio: number };

      const seq = (await this.db.execute(sql`SELECT nextval('ref_number_seq') AS v`)).rows[0] as { v: string };
      const year = (await this.academicYear(periodId)) ?? '0000';
      const ref = `THS-${year}-${String(Number(seq.v)).padStart(6, '0')}`;

      try {
        await this.db.execute(sql`
          INSERT INTO thesis_selections (period_id, student_id, thesis_id, priority, status, confirmed_at, reference_number)
          VALUES (${periodId}, ${best.student_id}, ${best.id}, ${nextPriority.prio}, 'confirmed', now(), ${ref})
        `);
        outcomes.push({
          studentUserId: userId,
          claimed: { thesisId: best.id, title: best.title, referenceNumber: ref },
        });
      } catch {
        outcomes.push({ studentUserId: userId, skipped: 'no-available' });
      }
    }
    return outcomes;
  }

  private async preferenceExists(userId: string, periodId: string): Promise<boolean> {
    const res = await this.db.execute(sql`
      SELECT 1 FROM student_preferences sp
      JOIN students s ON s.id = sp.student_id
      JOIN users u ON u.id = s.user_id
      WHERE u.id = ${userId} AND sp.period_id = ${periodId} LIMIT 1
    `);
    return res.rows.length > 0;
  }

  private async academicYear(periodId: string): Promise<string | null> {
    const res = await this.db.execute(
      sql`SELECT academic_year FROM selection_periods WHERE id = ${periodId}`,
    );
    return ((res.rows[0] as { academic_year?: string })?.academic_year ?? null);
  }

  /** Used by import flows to fill thesis embeddings. */
  async embedThesisText(title: string, description: string | null): Promise<number[]> {
    return this.embeddings.embed(`${title}. ${description ?? ''}`);
  }
}
