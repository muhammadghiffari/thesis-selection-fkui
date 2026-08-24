import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { and, asc, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { notificationDeliveries, periodEnrollments, students, users } from '../../shared/db/schema.js';
import type { ListQueryDto } from './students.controller.js';
import { validateStudentRows, type IncomingStudent, type ValidatedStudentRow } from './student-import.js';

export interface BulkActionInput {
  /** student table IDs */
  studentIds: string[];
  action: 'assign_slots' | 'send_magic_links' | 'reset_attempts' | 'deactivate';
  periodId?: string;
  attempts?: number;
}

const DEFAULT_ATTEMPTS = 4;
const PAGE_SIZE_CAP = 100;
const EXPORT_ROW_CAP = 10_000;

@Injectable()
export class StudentsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(q: ListQueryDto): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }> {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, PAGE_SIZE_CAP);
    const conditions = [isNull(users.deletedAt)];

    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(
        or(ilike(students.fullName, term), ilike(students.npm, term), ilike(users.email, term))!,
      );
    }
    if (q.classType) conditions.push(eq(students.classType, q.classType));
    if (q.track) conditions.push(eq(students.researchTrack, q.track));

    const where = and(...conditions);
    const totals = await this.db
      .select({ total: count() })
      .from(students)
      .innerJoin(users, eq(users.id, students.userId))
      .where(where);
    const total = totals[0]?.total ?? 0;

    const rows = await this.db
      .select({
        id: students.id,
        npm: students.npm,
        fullName: students.fullName,
        email: users.email,
        classType: students.classType,
        researchTrack: students.researchTrack,
        createdAt: students.createdAt,
      })
      .from(students)
      .innerJoin(users, eq(users.id, students.userId))
      .where(where)
      .orderBy(asc(students.npm))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { rows, total, page, pageSize };
  }

  /** Runs the pure validator with DB duplicate context. */
  async validateAgainstDb(parsed: Record<string, string>[]): Promise<ValidatedStudentRow[]> {
    const emails = parsed.map((r) => (r['email'] ?? '').trim().toLowerCase()).filter(Boolean);
    const npms = parsed.map((r) => (r['npm'] ?? '').trim()).filter(Boolean);
    const existing = await this.existingIdentifiers(npms, emails);
    return validateStudentRows(parsed, existing);
  }

  async existingIdentifiers(npms: string[], emails: string[]): Promise<{ npms: Set<string>; emails: Set<string> }> {
    const sets = { npms: new Set<string>(), emails: new Set<string>() };
    if (npms.length === 0 && emails.length === 0) return sets;

    const found = await this.db
      .select({ npm: students.npm, email: users.email })
      .from(students)
      .innerJoin(users, eq(users.id, students.userId))
      .where(
        or(
          npms.length > 0 ? inArray(students.npm, npms) : undefined,
          emails.length > 0 ? inArray(users.email, emails) : undefined,
        ),
      );
    for (const row of found) {
      sets.npms.add(row.npm);
      sets.emails.add(row.email.toLowerCase());
    }
    return sets;
  }

  /**
   * Re-validates every incoming row against CURRENT database state (the
   * client may hold stale data), inserts valid ones, reports skipped ones.
   */
  async commitImport(rows: IncomingStudent[]): Promise<{
    inserted: Array<{ id: string | null; npm: string }>;
    skipped: Array<{ line: number; errors: Record<string, string> }>;
  }> {
    const normalized = rows.map((r) => ({
      npm: String(r.npm ?? ''),
      full_name: String(r.fullName ?? ''),
      email: String(r.email ?? ''),
      class_type: String(r.classType ?? ''),
      research_track: String(r.researchTrack ?? ''),
    }));
    const validated = await this.validateAgainstDb(normalized);
    const valid = validated.filter((v) => Object.keys(v.errors).length === 0);

    const inserted: Array<{ id: string | null; npm: string }> = [];
    for (const v of valid) {
      inserted.push({ id: await this.insertStudent(v.data), npm: v.data.npm });
    }

    return {
      inserted,
      skipped: validated
        .filter((v) => Object.keys(v.errors).length > 0)
        .map((v) => ({ line: v.line, errors: v.errors })),
    };
  }

  /** One user(role=student) + one student row per imported entry. */
  private async insertStudent(data: IncomingStudent): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: data.email.toLowerCase(), role: 'student' })
        .returning({ id: users.id });
      if (!user) throw new Error('user insert returned no row');

      const [student] = await tx
        .insert(students)
        .values({
          userId: user.id,
          npm: data.npm,
          fullName: data.fullName,
          classType: data.classType,
          researchTrack: data.researchTrack,
        })
        .returning({ id: students.id });
      return student?.id ?? null;
    });
  }

  async exportXlsx(q: ListQueryDto): Promise<Buffer> {
    // ponytail: sequential paging capped at EXPORT_ROW_CAP — plenty for a
    // faculty cohort (~300-600); switch to a single windowed query when needed.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('students');
    ws.columns = [
      { header: 'npm', key: 'npm', width: 18 },
      { header: 'full_name', key: 'fullName', width: 32 },
      { header: 'email', key: 'email', width: 34 },
      { header: 'class_type', key: 'classType', width: 12 },
      { header: 'research_track', key: 'researchTrack', width: 16 },
    ];

    let exported = 0;
    for (let page = 1; exported < EXPORT_ROW_CAP; page++) {
      const { rows } = await this.list({ ...q, page, pageSize: PAGE_SIZE_CAP });
      if (rows.length === 0) break;
      for (const r of rows as Array<Record<string, string>>) ws.addRow(r);
      exported += rows.length;
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * All actions write absolute values → repeating them yields the same final
   * state (idempotent).
   */
  async bulkAction(input: BulkActionInput): Promise<{ affected: number }> {
    const ids = input.studentIds;
    switch (input.action) {
      case 'deactivate': {
        // soft-delete the student's USER account (role-guarded to students)
        const updated = await this.db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(
                users.id,
                this.db.select({ uid: students.userId }).from(students).where(inArray(students.id, ids)),
              ),
              eq(users.role, 'student'),
            ),
          )
          .returning({ id: users.id });
        return { affected: updated.length };
      }

      case 'send_magic_links': {
        return this.queueMagicLinkIntents(ids, input.periodId);
      }

      case 'assign_slots':
      case 'reset_attempts': {
        const periodId = requirePeriod(input.periodId);
        const attempts = input.attempts ?? DEFAULT_ATTEMPTS;

        const targets = await this.db
          .select({ id: students.id })
          .from(students)
          .where(and(inArray(students.id, ids), isNull(students.deletedAt)));
        if (targets.length === 0) return { affected: 0 };

        // upsert enrollment slots; absolute value → running twice changes nothing
        await this.db
          .insert(periodEnrollments)
          .values(targets.map((t) => ({ periodId, studentId: t.id, attemptsLeft: attempts })))
          .onConflictDoUpdate({
            target: [periodEnrollments.periodId, periodEnrollments.studentId],
            set: { attemptsLeft: sql`excluded.attempts_left` },
          });
        return { affected: targets.length };
      }
    }
  }

  /**
   * Records send intent as queued notification_deliveries (real sending lands
   * with F3 magic-link scheduler). Idempotent: existing queued intent per
   * student suppresses duplicates.
   */
  private async queueMagicLinkIntents(studentIds: string[], periodId?: string) {
    const pid = requirePeriod(periodId);
    const targets = await this.db
      .select({ userId: students.userId })
      .from(students)
      .where(and(inArray(students.id, studentIds), isNull(students.deletedAt)));
    if (targets.length === 0) return { affected: 0 };

    const userIds = targets.map((t) => t.userId);
    const queued = await this.db
      .select({ userId: notificationDeliveries.userId })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.template, 'magic_link'),
          eq(notificationDeliveries.status, 'queued'),
          isNull(notificationDeliveries.openedAt),
          inArray(notificationDeliveries.userId, userIds),
        ),
      );
    const already = new Set(queued.map((r) => r.userId));
    const fresh = userIds.filter((uid) => !already.has(uid));

    if (fresh.length > 0) {
      await this.db.insert(notificationDeliveries).values(
        fresh.map((userId) => ({
          userId,
          channel: 'email',
          template: 'magic_link',
          payload: { periodId: pid },
          status: 'queued',
        })),
      );
    }
    return { affected: fresh.length };
  }
}

function requirePeriod(periodId?: string): string {
  if (!periodId) throw new BadRequestException('periodId is required for this action');
  return periodId;
}
