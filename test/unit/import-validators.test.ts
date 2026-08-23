import { describe, expect, it } from 'vitest';
import { validateStudentRows } from '../../src/modules/students/student-import.js';
import { validateThesisRows } from '../../src/modules/theses/thesis-import.js';

const OK = { npm: '123', full_name: 'Budi', email: 'budi@ui.ac.id', class_type: 'regular', research_track: 'clinical' };

describe('validateStudentRows', () => {
  it('accepts a clean row and normalizes email case', () => {
    const [row] = validateStudentRows([{ ...OK, email: 'BUDI@UI.AC.ID' }], { npms: new Set(), emails: new Set() });
    expect(row?.errors).toEqual({});
    expect(row?.data.email).toBe('budi@ui.ac.id');
  });

  it('rejects non-numeric NPM and wrong-domain emails', () => {
    const [a, b] = validateStudentRows(
      [{ ...OK, npm: '12a3' }, { ...OK, npm: '456', email: 'x@gmail.com' }],
      { npms: new Set(), emails: new Set() },
    );
    expect(a?.errors.npm).toMatch(/strictly numeric/);
    expect(b?.errors.email).toMatch(/must end with/);
  });

  it('detects in-file duplicates by npm AND by email', () => {
    const rows = validateStudentRows([structuredClone(OK), structuredClone(OK)], {
      npms: new Set(),
      emails: new Set(),
    });
    expect(rows[0]?.errors).toEqual({});
    expect(rows[1]?.errors.npm).toMatch(/within file/);
    expect(rows[1]?.errors.email).toMatch(/within file/);
  });

  it('detects duplicates vs database sets', () => {
    const [row] = validateStudentRows([structuredClone(OK)], {
      npms: new Set(['123']),
      emails: new Set(['other@ui.ac.id']),
    });
    expect(row?.errors.npm).toMatch(/database/);
  });

  it('rejects invalid enum values', () => {
    const [row] = validateStudentRows([{ ...OK, class_type: 'vip', research_track: 'quantum' }], {
      npms: new Set(),
      emails: new Set(),
    });
    expect(row?.errors.classType).toBeDefined();
    expect(row?.errors.research_track).toBeDefined();
  });
});

describe('validateThesisRows', () => {
  it('defaults max_claims to 1 and requires title/track/lecturer', () => {
    const [good, bad] = validateThesisRows([
      { title: 'T', track: 'CLINICAL', lecturer_full_name: 'dr. X' },
      { title: '', track: 'nope', lecturer_full_name: '' },
    ]);
    expect(good?.errors).toEqual({});
    expect(good?.data.maxClaims).toBe(1);
    expect(bad?.errors.title).toBeDefined();
    expect(bad?.errors.track).toBeDefined();
    expect(bad?.errors.lecturer_full_name).toBeDefined();
  });

  it('flags duplicate titles within the file (same track)', () => {
    const rows = validateThesisRows([
      { title: 'Same', track: 'basic', lecturer_full_name: 'A' },
      { title: 'same', track: 'basic', lecturer_full_name: 'B' },
    ]);
    expect(rows[1]?.errors.title).toMatch(/duplicate/);
  });

  it('rejects non-integer or <1 max_claims', () => {
    const [row] = validateThesisRows([{ title: 'T', track: 'basic', lecturer_full_name: 'A', max_claims: '2.5' }]);
    expect(row?.errors.max_claims).toBeDefined();
  });
});
