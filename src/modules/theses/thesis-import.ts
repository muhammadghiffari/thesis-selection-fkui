import type { RawRow } from '../students/student-import.js';
import type { ResearchTrack } from '../students/student-import.js';

export interface IncomingThesis {
  title: string;
  lecturerFullName: string;
  track: string;
  description: string;
  maxClaims: number | null;
}

export type RowErrors = Record<string, string>;

export interface ValidatedThesisRow {
  line: number;
  data: IncomingThesis;
  errors: RowErrors;
}

const TRACKS: ReadonlyArray<ResearchTrack> = ['clinical', 'basic', 'community'];

function str(row: RawRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return '';
}

/** Pure validator for thesis catalog imports. Titles are admin-only data. */
export function validateThesisRows(rows: RawRow[]): ValidatedThesisRow[] {
  const seenTitles = new Set<string>();

  return rows.map((row, i) => {
    const line = i + 2; // header is line 1
    const data: IncomingThesis = {
      title: str(row, 'title'),
      lecturerFullName: str(row, 'lecturer_full_name', 'lecturer', 'supervisor'),
      track: str(row, 'track').toLowerCase(),
      description: str(row, 'description'),
      maxClaims: row.max_claims !== undefined && row.max_claims!.trim() !== '' ? Number(row.max_claims) : null,
    };
    const errors: RowErrors = {};

    if (!data.title) errors.title = 'title is required';

    if (!TRACKS.includes(data.track as ResearchTrack)) {
      errors.track = `track must be one of ${TRACKS.join(', ')}`;
    }

    if (!data.lecturerFullName) errors.lecturer_full_name = 'lecturer_full_name is required';

    if (data.maxClaims === null) {
      data.maxClaims = 1;
    } else if (!Number.isInteger(data.maxClaims) || data.maxClaims < 1) {
      errors.max_claims = 'max_claims must be a positive integer';
    }

    const dedupeKey = `${data.track}::${data.title.toLowerCase()}`;
    if (!errors.title && !errors.track) {
      if (seenTitles.has(dedupeKey)) errors.title = 'duplicate title within file';
      else seenTitles.add(dedupeKey);
    }

    return { line, data, errors };
  });
}
