import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ROWS = 5_000;

const ALLOWED_EXTENSIONS = ['.xlsx', '.csv'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export function assertUploadable(filename: string, size: number): AllowedExtension {
  const lower = filename.toLowerCase();
  const ext = ALLOWED_EXTENSIONS.find((e) => lower.endsWith(e));
  if (!ext) {
    throw new BadRequestException(`Unsupported file type — upload one of: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new BadRequestException(`File too large — max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  return ext;
}

/**
 * Parses an uploaded spreadsheet into header-keyed string rows.
 * ponytail: all cells coerced to trimmed strings; formulas/number formats
 * beyond that are not preserved — fine for master-data imports.
 */
export async function parseSpreadsheet(buffer: Buffer, ext: AllowedExtension): Promise<Record<string, string>[]> {
  if (ext === '.csv') {
    const records: string[][] = parse(buffer, { skip_empty_lines: true, trim: true });
    return fromMatrix(records);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('Workbook has no sheets');

  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cellText(cell);
    });
    matrix.push(values);
  });
  return fromMatrix(matrix);
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // rich text / hyperlink
    if ('result' in v) return String(v.result ?? ''); // formula result
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

function fromMatrix(records: unknown[][]): Record<string, string>[] {
  const [headerRow, ...dataRows] = records as string[][];
  if (!headerRow || headerRow.length === 0) throw new BadRequestException('File is empty');

  const headers = headerRow.map((h, i) => String(h ?? '').trim().toLowerCase() || `column_${i + 1}`);
  const rows = dataRows
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
  if (rows.length === 0) throw new BadRequestException('No data rows found');
  if (rows.length > MAX_ROWS) throw new BadRequestException(`Too many rows — max ${MAX_ROWS}`);
  return rows;
}
