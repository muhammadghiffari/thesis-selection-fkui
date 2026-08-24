export const STAGE = {
  NONE: 0,
  INITIAL_H7: 1,
  REMINDER_H1: 2,
  REMINDER_H1H: 3,
  NUDGE_T10: 4,
} as const;

export type StageKey =
  | 'initial_h7'
  | 'reminder_h1'
  | 'reminder_h1h'
  | 'nudge_t10'
  | 'closes_warning';

export const STAGE_KEYS: StageKey[] = [
  'initial_h7',
  'reminder_h1',
  'reminder_h1h',
  'nudge_t10',
  'closes_warning',
];

/** Monotonic reminder_stage values persisted on period_enrollments. */
export const STAGE_VALUE: Record<StageKey, number> = {
  initial_h7: STAGE.INITIAL_H7,
  reminder_h1: STAGE.REMINDER_H1,
  reminder_h1h: STAGE.REMINDER_H1H,
  nudge_t10: STAGE.NUDGE_T10,
  closes_warning: 0, // guarded via prior-delivery existence instead
};

export const TEMPLATE: Record<StageKey, string> = {
  initial_h7: 'magic_link',
  reminder_h1: 'magic_link_reminder_h1',
  reminder_h1h: 'magic_link_reminder_h1h',
  nudge_t10: 'war_nudge_t10',
  closes_warning: 'closes_warning_h2',
};

export const SUBJECT: Record<StageKey, string> = {
  initial_h7: 'Your thesis selection access link',
  reminder_h1: 'Reminder: selection opens in 1 day',
  reminder_h1h: 'Reminder: selection opens in 1 hour',
  nudge_t10: 'Selection opens in 10 minutes',
  closes_warning: 'Action needed: selection closes in 2 hours',
};

export const BODY: Record<StageKey, string> = {
  initial_h7: 'Your personal access link is ready. Opening it binds it to your device.',
  reminder_h1: 'You have not opened your access link yet.',
  reminder_h1h: 'Selection opens in one hour — open your link now.',
  nudge_t10: '',
  closes_warning: 'You have fewer than the required claims. Complete your selection now.',
};
