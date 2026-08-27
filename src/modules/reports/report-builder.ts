import * as ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db.module.js';

export type ExportKind =
  | 'final_selections'
  | 'final_selections_pdf'
  | 'swap_history'
  | 'integrity_summary';

const HEADERS_FINAL = ['NPM', 'Student', 'Priority', 'Title', 'Lecturer', 'Confirmed at (UTC)', 'Reference'];
const HEADERS_SWAPS = ['Requested at (UTC)', 'Student', 'NPM', 'Title', 'Category', 'Detail', 'Status', 'Decision note', 'Decided at (UTC)'];

/**
 * Report builders — framework-free, driven by the BullMQ export worker and
 * by tests. PDF uses Puppeteer lazily; when a browser binary is unavailable
 * the job fails with a clear, retryable error rather than crashing.
 */
export class ReportBuilder {
  constructor(
    private readonly db: Database,
    private readonly periodId: string,
  ) {}

  async build(kind: ExportKind): Promise<{ buffer: Buffer; filename: string }> {
    switch (kind) {
      case 'final_selections':
        return this.xlsx(await this.finalSelectionRows(), HEADERS_FINAL, 'final-selections');
      case 'final_selections_pdf':
        return this.pdf(await this.finalSelectionRows(), this.periodId);
      case 'swap_history':
        return this.xlsx(await this.swapHistoryRows(), HEADERS_SWAPS, 'swap-history');
      case 'integrity_summary':
        return this.xlsx(await this.integritySummaryRows(this.periodId), ['Level', 'Count'], 'integrity-summary');
    }
  }

  /** One row per claimed title, students ordered by NPM then priority. */
  private async finalSelectionRows(): Promise<Array<Array<string | number | null>>> {
    const res = await this.db.execute(sql`
      SELECT s.npm, s.full_name AS student, ts.priority, th.title,
             COALESCE(l.full_name, 'TBA') AS lecturer,
             to_char(ts.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS confirmed_at,
             ts.reference_number
      FROM thesis_selections ts
      JOIN students s ON s.id = ts.student_id
      JOIN theses th ON th.id = ts.thesis_id
      LEFT JOIN lecturers l ON l.id = th.lecturer_id
      WHERE ts.period_id = ${this.periodId}
        AND ts.status IN ('confirmed','taken','swap_requested','released_pending')
        AND ts.deleted_at IS NULL
      ORDER BY s.npm, ts.priority
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => [
      String(r.npm),
      String(r.student),
      Number(r.priority),
      String(r.title),
      String(r.lecturer),
      r.confirmed_at ? String(r.confirmed_at) : null,
      (r.reference_number as string | null) ?? null,
    ]);
  }

  private async swapHistoryRows(): Promise<Array<Array<string | number | null>>> {
    const res = await this.db.execute(sql`
      SELECT to_char(r.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS requested_at,
             s.full_name AS student, s.npm, th.title, r.category, r.reason_detail AS detail,
             r.status, COALESCE(r.decision_note,'') AS decision_note,
             CASE WHEN r.decided_at IS NULL THEN NULL
                  ELSE to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') END AS decided_at
      FROM swap_requests r
      JOIN thesis_selections ts ON ts.id = r.selection_id
      JOIN students s ON s.id = ts.student_id
      JOIN theses th ON th.id = ts.thesis_id
      WHERE ts.period_id = ${this.periodId}
      ORDER BY r.requested_at
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => [
      String(r.requested_at),
      String(r.student),
      String(r.npm),
      String(r.title),
      String(r.category),
      String(r.detail),
      String(r.status),
      String(r.decision_note),
      r.decided_at ? String(r.decided_at) : null,
    ]);
  }

  /** AGGREGATE ONLY — no raw signals leave the system in exports. */
  private async integritySummaryRows(periodId: string): Promise<Array<Array<string | number>>> {
    const res = await this.db.execute(sql`
      SELECT level, count(*)::int AS n FROM integrity_flags f
      JOIN thesis_selections ts ON ts.id = f.selection_id
      WHERE ts.period_id = ${this.periodId}
      GROUP BY level
    `);
    const byLevel = Object.fromEntries((res.rows as Array<Record<string, unknown>>).map((r) => [String(r.level), Number(r.n)]));
    return [
      ['HIGH', byLevel['high'] ?? 0],
      ['MEDIUM', byLevel['medium'] ?? 0],
      ['HIGH resolved', await this.resolvedCount(periodId, 'high')],
      ['MEDIUM resolved', await this.resolvedCount(periodId, 'medium')],
      ['HIGH unresolved', (byLevel['high'] ?? 0) - (await this.resolvedCount(periodId, 'high'))],
      ['MEDIUM unresolved', (byLevel['medium'] ?? 0) - (await this.resolvedCount(periodId, 'medium'))],
    ];
  }

  private async resolvedCount(periodId: string, level: string): Promise<number> {
    const res = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM integrity_flags f
      JOIN thesis_selections ts ON ts.id = f.selection_id
      WHERE ts.period_id = ${this.periodId} AND f.level = ${level}
        AND f.outcome IS NOT NULL AND f.outcome <> 'pending'
    `);
    return ((res.rows[0] as { n: number } | undefined)?.n) ?? 0;
  }


  private async xlsx(
    rows: Array<Array<string | number | null>>,
    headers: string[],
    name: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    void this.periodId;
    void this.db;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(name);
    ws.addRow(headers).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns?.forEach((c) => (c.width = 28));
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `${name}.xlsx` };
  }

  /**
   * HTML → PDF via Puppeteer. The browser is REQUIRED only here; environments
   * without chromium fail loudly with 'pdf-browser-unavailable'.
   */
  private async pdf(
    rows: Array<Array<string | number | null>>,
    _periodId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    void _periodId;
    let puppeteer: typeof import('puppeteer');
    try {
      puppeteer = (await import('puppeteer')).default as never;
    } catch {
      throw new Error('pdf-browser-unavailable');
    }
    let executablePath: string | undefined;
    try {
      executablePath = await puppeteer.executablePath();
    } catch {
      throw new Error('pdf-browser-unavailable');
    }

    const html = `<html><body><h1>Final selections</h1>
      <table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:10px">
      <tr>${HEADERS_FINAL.map((h) => `<th>${h}</th>`).join('')}</tr>
      ${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}
      </table></body></html>`;

    let browser: import('puppeteer').Browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Browser was not found') || msg.includes('Could not find expected browser')) {
        throw new Error('pdf-browser-unavailable');
      }
      throw err;
    }

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const buffer = await page.pdf({ format: 'A4', printBackground: false });
      return { buffer: Buffer.from(buffer), filename: 'final-selections.pdf' };
    } finally {
      await browser.close();
    }
  }
}
