import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertUploadable, parseSpreadsheet } from '../../src/shared/parsing/spreadsheet.js';
import ExcelJS from 'exceljs';

describe('assertUploadable', () => {
  it('accepts .xlsx and .csv', () => {
    expect(assertUploadable('students.xlsx', 10)).toBe('.xlsx');
    expect(assertUploadable('students.CSV', 10)).toBe('.csv');
  });

  it('rejects wrong extensions and oversized files', () => {
    expect(() => assertUploadable('virus.exe', 10)).toThrow(BadRequestException);
    expect(() => assertUploadable('huge.xlsx', 6 * 1024 * 1024)).toThrow(/too large/i);
  });
});

describe('parseSpreadsheet', () => {
  it('parses csv with header row and skips blank lines', async () => {
    const csv = Buffer.from('npm,email\n001,a@ui.ac.id\n\n002,b@ui.ac.id\n');
    const rows = await parseSpreadsheet(csv, '.csv');
    expect(rows).toEqual([
      { npm: '001', email: 'a@ui.ac.id' },
      { npm: '002', email: 'b@ui.ac.id' },
    ]);
  });

  it('parses xlsx via exceljs including numeric cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['npm', 'full_name']);
    ws.addRow([1234567, 'Budi Santoso']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseSpreadsheet(buf, '.xlsx');
    expect(rows).toEqual([{ npm: '1234567', full_name: 'Budi Santoso' }]);
  });

  it('empty file → 400', async () => {
    await expect(parseSpreadsheet(Buffer.from(''), '.csv')).rejects.toThrow(BadRequestException);
    await expect(parseSpreadsheet(Buffer.from('npm,email\n'), '.csv')).rejects.toThrow(/No data rows/);
  });
});
