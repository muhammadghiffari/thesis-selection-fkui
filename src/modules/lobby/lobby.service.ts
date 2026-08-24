import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import {
  periodEnrollments,
  selectionPeriods,
  studentPreferences,
  students,
} from '../../shared/db/schema.js';
import { EMBEDDING_PROVIDER } from '../../shared/embeddings/embeddings-infra.module.js';
import type { EmbeddingProvider } from '../../shared/embeddings/embedding-provider.js';

export interface LobbyView {
  serverTime: string;
  period: {
    id: string;
    name: string;
    status: string;
    opensAt: string | null;
    closesAt: string | null;
  };
  /** Server-side countdown inputs — client renders WIB from these + serverTime skew. */
  secondsUntilOpen: number | null;
  secondsUntilClose: number | null;
  autoWar: { enabled: boolean; consentedAt: string | null };
  preference: { text: string; updatedAt: string } | null;
}

const PREFERENCE_MIN = 20;
const PREFERENCE_MAX = 2000;

@Injectable()
export class LobbyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async view(userId: string, periodId: string): Promise<LobbyView> {
    const [row] = await this.db
      .select({
        enrollmentId: periodEnrollments.id,
        autoWarEnabled: periodEnrollments.autoWarEnabled,
        autoWarConsentedAt: periodEnrollments.autoWarConsentedAt,
        periodId: selectionPeriods.id,
        name: selectionPeriods.name,
        status: selectionPeriods.status,
        opensAt: selectionPeriods.opensAt,
        closesAt: selectionPeriods.closesAt,
      })
      .from(periodEnrollments)
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .where(and(eq(students.userId, userId), eq(periodEnrollments.periodId, periodId)))
      .limit(1);
    if (!row) throw new NotFoundException('No enrollment for this period');

    const now = Date.now();
    const pref = await this.preference(userId, periodId);

    return {
      // single clock source: everything derives from THIS timestamp
      serverTime: new Date(now).toISOString(),
      period: {
        id: row.periodId,
        name: row.name,
        status: row.status,
        opensAt: row.opensAt?.toISOString() ?? null,
        closesAt: row.closesAt?.toISOString() ?? null,
      },
      secondsUntilOpen: row.opensAt ? Math.max(0, Math.floor((row.opensAt.getTime() - now) / 1000)) : null,
      secondsUntilClose: row.closesAt ? Math.max(0, Math.floor((row.closesAt.getTime() - now) / 1000)) : null,
      autoWar: {
        enabled: row.autoWarEnabled,
        consentedAt: row.autoWarConsentedAt?.toISOString() ?? null,
      },
      preference: pref,
    };
  }

  async savePreference(userId: string, periodId: string, text: string): Promise<{ saved: true }> {
    const trimmed = text.trim();
    if (trimmed.length < PREFERENCE_MIN) {
      throw new BadRequestException(`Describe your interests in at least ${PREFERENCE_MIN} characters`);
    }
    if (trimmed.length > PREFERENCE_MAX) {
      throw new BadRequestException(`Keep it under ${PREFERENCE_MAX} characters`);
    }
    const student = await this.studentByUser(userId, periodId);

    const embedding = await this.embeddings.embed(trimmed);
    await this.db
      .insert(studentPreferences)
      .values({ studentId: student, periodId, interestText: trimmed, embedding })
      .onConflictDoUpdate({
        target: [studentPreferences.periodId, studentPreferences.studentId],
        set: { interestText: trimmed, embedding, updatedAt: new Date() },
      });
    return { saved: true };
  }

  async preference(
    userId: string,
    periodId: string,
  ): Promise<{ text: string; updatedAt: string } | null> {
    const [row] = await this.db
      .select({ text: studentPreferences.interestText, updatedAt: studentPreferences.updatedAt })
      .from(studentPreferences)
      .innerJoin(students, eq(students.id, studentPreferences.studentId))
      .where(and(eq(students.userId, userId), eq(studentPreferences.periodId, periodId)))
      .limit(1);
    return row ? { text: row.text, updatedAt: row.updatedAt.toISOString() } : null;
  }

  /**
   * Explicit pre-confirm consent for auto-war. Enabling requires the consent
   * flag in the same request; disabling is always allowed.
   */
  async setAutoWar(
    userId: string,
    periodId: string,
    input: { enabled: boolean; consent?: boolean },
  ): Promise<{ enabled: boolean; consentedAt: string | null }> {
    if (input.enabled && input.consent !== true) {
      throw new BadRequestException('Explicit consent is required to enable auto-war');
    }
    const enrollmentId = await this.enrollmentIdByUser(userId, periodId);

    const consentedAt = input.enabled ? new Date() : null;
    await this.db
      .update(periodEnrollments)
      .set({ autoWarEnabled: input.enabled, ...(input.enabled ? { autoWarConsentedAt: consentedAt } : {}) })
      .where(eq(periodEnrollments.id, enrollmentId));

    await this.audit.log(
      null,
      input.enabled ? 'auto_war.opt_in' : 'auto_war.opt_out',
      'period_enrollment',
      enrollmentId,
      { periodId },
    );
    return { enabled: input.enabled, consentedAt: consentedAt?.toISOString() ?? null };
  }

  private async studentByUser(userId: string, _periodId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(eq(students.userId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }

  private async enrollmentIdByUser(userId: string, periodId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: periodEnrollments.id })
      .from(periodEnrollments)
      .innerJoin(students, eq(students.id, periodEnrollments.studentId))
      .where(and(eq(students.userId, userId), eq(periodEnrollments.periodId, periodId)))
      .limit(1);
    if (!row) throw new NotFoundException('No enrollment for this period');
    return row.id;
  }
}
