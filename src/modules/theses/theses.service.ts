import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { and, asc, count, eq, ilike, isNull, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { lecturers, theses } from '../../shared/db/schema.js';
import { validateThesisRows } from './thesis-import.js';

interface ThesisListQuery {
  periodId: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ThesesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(q: ThesisListQuery) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const conditions = [eq(theses.periodId, q.periodId), isNull(theses.deletedAt)];
    if (q.search) conditions.push(ilike(theses.title, `%${q.search}%`));
    const where = and(...conditions);

    const totals = await this.db.select({ total: count() }).from(theses).where(where);
    const total = totals[0]?.total ?? 0;
    const rows = await this.db
      .select({
        id: theses.id,
        title: theses.title,
        track: theses.track,
        description: theses.description,
        maxClaims: theses.maxClaims,
        lecturerName: lecturers.fullName,
        createdAt: theses.createdAt,
      })
      .from(theses)
      .leftJoin(lecturers, eq(lecturers.id, theses.lecturerId))
      .where(where)
      .orderBy(asc(theses.title))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { rows, total, page, pageSize };
  }

  /** Re-validates and commits; find-or-create lecturer by lower(full_name). */
  async commitImport(
    periodId: string,
    rows: Array<{
      title: string;
      track: string;
      lecturerFullName: string;
      description?: string;
      maxClaims?: number | null;
    }>,
  ): Promise<{
    inserted: Array<{ id: string | null; title: string }>;
    skipped: Array<{ line: number; errors: Record<string, string> }>;
  }> {
    const normalized = rows.map((r) => ({
      title: String(r.title ?? ''),
      track: String(r.track ?? ''),
      lecturer_full_name: String(r.lecturerFullName ?? ''),
      description: String(r.description ?? ''),
      max_claims: r.maxClaims === undefined || r.maxClaims === null ? '' : String(r.maxClaims),
    }));
    const validated = validateThesisRows(normalized);

    // DB duplicate check for titles already in this period
    const titles = normalized.map((r) => r.title.toLowerCase()).filter(Boolean);
    let existingTitles = new Set<string>();
    if (titles.length > 0) {
      const found = await this.db
        .select({ title: theses.title })
        .from(theses)
        .where(and(eq(theses.periodId, periodId), isNull(theses.deletedAt)));
      existingTitles = new Set(found.map((f) => f.title.toLowerCase()));
    }

    const inserted: Array<{ id: string | null; title: string }> = [];
    const skipped: Array<{ line: number; errors: Record<string, string> }> = [];
    const lecturerCache = new Map<string, string>();

    for (const v of validated) {
      if (Object.keys(v.errors).length > 0) {
        skipped.push({ line: v.line, errors: v.errors });
        continue;
      }
      if (existingTitles.has(v.data.title.toLowerCase())) {
        skipped.push({ line: v.line, errors: { title: 'title already exists in this period' } });
        continue;
      }
      existingTitles.add(v.data.title.toLowerCase());

      const lecturerId = await this.resolveLecturer(v.data.lecturerFullName, lecturerCache);
      const [row] = await this.db
        .insert(theses)
        .values({
          periodId,
          title: v.data.title,
          track: v.data.track,
          description: v.data.description || null,
          maxClaims: v.data.maxClaims ?? 1,
          lecturerId,
        })
        .returning({ id: theses.id });
      inserted.push({ id: row?.id ?? null, title: v.data.title });
    }

    return { inserted, skipped };
  }

  private async resolveLecturer(fullName: string, cache: Map<string, string>): Promise<string | null> {
    const key = fullName.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const [existing] = await this.db
      .select({ id: lecturers.id })
      .from(lecturers)
      .where(sql`lower(${lecturers.fullName}) = ${key}`)
      .limit(1);

    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      const [created] = await this.db
        .insert(lecturers)
        .values({ fullName })
        .returning({ id: lecturers.id });
      if (!created) throw new Error('lecturer insert returned no row');
      id = created.id;
    }
    cache.set(key, id);
    return id;
  }

  async exportXlsx(periodId: string): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('theses');
    ws.columns = [
      { header: 'title', key: 'title', width: 60 },
      { header: 'track', key: 'track', width: 14 },
      { header: 'lecturer_full_name', key: 'lecturerName', width: 30 },
      { header: 'description', key: 'description', width: 50 },
      { header: 'max_claims', key: 'maxClaims', width: 12 },
    ];

    let exported = 0;
    for (let page = 1; exported < 10_000; page++) {
      const { rows } = await this.list({ periodId, page, pageSize: 100 });
      if (rows.length === 0) break;
      for (const r of rows as Array<Record<string, unknown>>) ws.addRow(r);
      exported += rows.length;
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
