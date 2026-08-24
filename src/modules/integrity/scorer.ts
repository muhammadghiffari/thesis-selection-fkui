import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db.module.js';

export interface IntegritySignal {
  rule: string;
  points: number;
  evidence: Record<string, unknown>;
}

export const WEIGHTS = {
  track_mismatch: 25,
  duplicate_device: 25,
  ip_sharing: 20,
  fast_confirm: 15,
  preopen_attempt: 15,
  rebind_attempt: 20,
} as const;

/**
 * Rule-based integrity scorer (PRD §5.10). Consumes PERSISTED signals only:
 *  - students.research_track vs theses.track            (+25, soft flag)
 *  - enrollment device_fingerprint_hash duplicates      (+25)
 *  - truncated IP shared by >2 users in period          (+20)
 *  - thesis_selections created_at → confirmed_at <2s    (+15)
 *  - activity_logs preopen_attempt rows for the owner   (+15)
 *  - activity_logs device_rebind_attempt rows           (+20)
 *
 * Idempotent per selection: unreviewed flags are replaced; reviewed ones
 * are never touched (re-scoring after human action is a no-op).
 */
export class IntegrityScorer {
  constructor(private readonly db: Database) {}

  async scoreSelection(selectionId: string): Promise<{
    score: number;
    level: 'high' | 'medium' | 'clean';
    signals: IntegritySignal[];
    skipped?: 'already-reviewed';
  }> {
    const sel = (
      await this.db.execute(sql`
        SELECT ts.id, ts.student_id, ts.status, ts.created_at, ts.confirmed_at,
               ts.ip_address::text AS ip_address, ts.period_id,
               s.research_track, s.user_id,
               th.track AS thesis_track, th.title
        FROM thesis_selections ts
        JOIN students s ON s.id = ts.student_id
        JOIN theses th ON th.id = ts.thesis_id
        WHERE ts.id = ${selectionId}
      `)
    ).rows[0] as
      | {
          id: string;
          student_id: string;
          status: string;
          created_at: string;
          confirmed_at: string | null;
          ip_address: string | null;
          period_id: string;
          research_track: string;
          user_id: string;
          thesis_track: string;
          title: string;
        }
      | undefined;
    if (!sel) throw new Error(`selection ${selectionId} not found`);

    // never touch flags a human has already reviewed
    const reviewed = await this.db.execute(sql`
      SELECT 1 FROM integrity_flags
      WHERE selection_id = ${selectionId} AND outcome IS NOT NULL AND outcome <> 'pending'
      LIMIT 1
    `);
    if (reviewed.rows.length > 0) {
      return { score: 0, level: 'clean', signals: [], skipped: 'already-reviewed' };
    }

    const signals: IntegritySignal[] = [];

    // 1. track mismatch — SOFT FLAG ONLY (never blocks anything system-side)
    if (sel.research_track !== sel.thesis_track) {
      signals.push({
        rule: 'track_mismatch',
        points: WEIGHTS.track_mismatch,
        evidence: { studentTrack: sel.research_track, thesisTrack: sel.thesis_track },
      });
    }

    // 2. duplicate device fingerprint (same hash bound by >1 student in period)
    const dupDevice = await this.db.execute(sql`
      SELECT count(DISTINCT pe.student_id)::int AS n
      FROM period_enrollments pe
      WHERE pe.period_id = ${sel.period_id}
        AND pe.device_fingerprint_hash IS NOT NULL
        AND pe.device_fingerprint_hash IN (
          SELECT pe2.device_fingerprint_hash FROM period_enrollments pe2
          JOIN students s2 ON s2.id = pe2.student_id
          WHERE pe2.period_id = ${sel.period_id} AND s2.id = ${sel.student_id}
            AND pe2.device_fingerprint_hash IS NOT NULL
        )
    `);
    const dupCount = ((dupDevice.rows[0] as { n: number } | undefined)?.n) ?? 1;
    if (dupCount > 1) {
      signals.push({
        rule: 'duplicate_device',
        points: WEIGHTS.duplicate_device,
        evidence: { distinctStudentsSharingFingerprint: dupCount },
      });
    }

    // 3. IP sharing — truncated IPs grouped; >2 distinct users on one IP
    if (sel.ip_address) {
      const ipUsers = await this.db.execute(sql`
        SELECT count(DISTINCT ts.student_id)::int AS n
        FROM thesis_selections ts
        WHERE ts.period_id = ${sel.period_id}
          AND ts.deleted_at IS NULL
          AND host(ts.ip_address)::text = ${truncateIp(sel.ip_address)}
      `);
      const ipCount = ((ipUsers.rows[0] as { n: number } | undefined)?.n) ?? 1;
      if (ipCount > 2) {
        signals.push({
          rule: 'ip_sharing',
          points: WEIGHTS.ip_sharing,
          evidence: { ipPrefix: truncateIp(sel.ip_address), usersOnIp: ipCount },
        });
      }
    }

    // 4. lock-to-confirm under 2 seconds
    if (sel.confirmed_at && sel.created_at) {
      const ms = new Date(sel.confirmed_at).getTime() - new Date(sel.created_at).getTime();
      if (ms >= 0 && ms < 2000) {
        signals.push({
          rule: 'fast_confirm',
          points: WEIGHTS.fast_confirm,
          evidence: { milliseconds: ms },
        });
      }
    }

    // 5/6. persisted audit signals for this user's enrollments in this period
    const auditSignals = await this.db.execute(sql`
      SELECT action, count(*)::int AS n FROM activity_logs al
      WHERE al.action IN ('integrity.preopen_attempt', 'integrity.device_rebind_attempt')
        AND al.entity_type = 'period_enrollment'
        AND al.entity_id IN (
          SELECT pe.id FROM period_enrollments pe
          JOIN students s ON s.id = pe.student_id
          WHERE s.user_id = ${sel.user_id} AND pe.period_id = ${sel.period_id}
        )
      GROUP BY action
    `);
    for (const row of auditSignals.rows as Array<{ action: string; n: number }>) {
      if (row.action === 'integrity.preopen_attempt') {
        signals.push({
          rule: 'preopen_attempt',
          points: WEIGHTS.preopen_attempt,
          evidence: { attempts: row.n },
        });
      }
      if (row.action === 'integrity.device_rebind_attempt') {
        signals.push({
          rule: 'rebind_attempt',
          points: WEIGHTS.rebind_attempt,
          evidence: { attempts: row.n },
        });
      }
    }

    const score = Math.min(
      100,
      signals.reduce((acc, s) => acc + s.points, 0),
    );
    const level: 'high' | 'medium' | 'clean' = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'clean';

    if (level === 'clean') {
      await this.clearUnreviewed(selectionId);
      return { score, level, signals };
    }

    await this.persistFlag(selectionId, sel.user_id, score, level, signals);
    return { score, level, signals };
  }

  private async clearUnreviewed(selectionId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM integrity_flags
      WHERE selection_id = ${selectionId} AND (outcome IS NULL OR outcome = 'pending')
    `);
  }

  private async persistFlag(
    selectionId: string,
    _userId: string,
    score: number,
    level: 'high' | 'medium',
    signals: IntegritySignal[],
  ): Promise<void> {
    await this.clearUnreviewed(selectionId);
    await this.db.execute(sql`
      INSERT INTO integrity_flags (selection_id, score, signals, level, outcome)
      VALUES (${selectionId}, ${score}, ${JSON.stringify({ rules: signals })}::jsonb, ${level}, 'pending')
    `);
  }
}

/** Privacy: store only /24 (v4) or /48 (v6) prefixes — enough for sharing analysis. */
export function truncateIp(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return parts.slice(0, 3).join(':') + '::';
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
}
