import { parseStudentDomains } from '../../shared/config/configuration.js';

export type StudentClassType = 'regular' | 'kki';
export type ResearchTrack = 'clinical' | 'basic' | 'community';

export interface RawRow {
  [column: string]: string | undefined;
}

export interface IncomingStudent {
  npm: string;
  fullName: string;
  email: string;
  classType: string;
  researchTrack: string;
}

export type RowErrors = Record<string, string>;

export interface ValidatedStudentRow {
  line: number;
  data: IncomingStudent;
  errors: RowErrors;
}

const NPM_NUMERIC = /^[0-9]+$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(row: RawRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return '';
}

/** Pure validator: format rules + duplicate detection (in-file AND vs DB sets). */
export function validateStudentRows(
  rows: RawRow[],
  existing: { npms: Set<string>; emails: Set<string> },
  domains: string[] = parseStudentDomains(process.env.STUDENT_DOMAINS),
): ValidatedStudentRow[] {
  const seenNpms = new Set<string>();
  const seenEmails = new Set<string>();
  const allowed = domains.map((d) => `@${d.toLowerCase()}`);

  return rows.map((row, i) => {
    const line = i + 2; // header is line 1
    const data: IncomingStudent = {
      npm: str(row, 'npm'),
      fullName: str(row, 'full_name', 'fullName', 'name'),
      email: str(row, 'email').toLowerCase(),
      classType: str(row, 'class_type', 'classType').toLowerCase(),
      researchTrack: str(row, 'research_track', 'researchTrack').toLowerCase(),
    };
    const errors: RowErrors = {};

    if (!data.npm) errors.npm = 'npm is required';
    else if (!NPM_NUMERIC.test(data.npm)) errors.npm = 'npm must be strictly numeric';

    if (!data.fullName) errors.fullName = 'full_name is required';

    if (!data.email) errors.email = 'email is required';
    else if (!EMAIL_SHAPE.test(data.email)) errors.email = 'email is not a valid address';
    else if (!allowed.some((d) => data.email.endsWith(d))) {
      errors.email = `email must end with ${allowed.join('|')}`;
    }

    if (!['regular', 'kki'].includes(data.classType)) {
      errors.classType = 'class_type must be regular or kki';
    }
    if (!['clinical', 'basic', 'community'].includes(data.researchTrack)) {
      errors.research_track = 'research_track must be clinical, basic or community';
    }

    if (!errors.npm) {
      if (seenNpms.has(data.npm)) errors.npm = `duplicate npm within file`;
      else seenNpms.add(data.npm);
      if (existing.npms.has(data.npm)) errors.npm = `npm already exists in database`;
    }
    if (!errors.email) {
      if (seenEmails.has(data.email)) errors.email = `duplicate email within file`;
      else seenEmails.add(data.email);
      if (existing.emails.has(data.email)) errors.email = `email already exists in database`;
    }

    return { line, data, errors };
  });
}

export function countValid(rows: ValidatedStudentRow[]): number {
  return rows.filter((r) => Object.keys(r.errors).length === 0).length;
}
