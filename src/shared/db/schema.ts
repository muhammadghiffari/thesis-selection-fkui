import { boolean, index, inet, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Mirrors docs/SCHEMA.sql — canonical DDL lives in drizzle/0000_init.sql
 * (triggers, partitions and partial indexes are hand-authored there).
 */

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  passwordHash: text('password_hash'),
  role: text().notNull().default('student'),
  totpSecret: text('totp_secret'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const students = pgTable('students', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  npm: text().notNull().unique(),
  fullName: text('full_name').notNull(),
  classType: text('class_type').notNull(),
  researchTrack: text('research_track').notNull(),
  deviceFingerprint: jsonb('device_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const lecturers = pgTable('lecturers', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  fullName: text('full_name').notNull(),
  expertiseTags: text('expertise_tags').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** Canonical per-period timing/capacity configuration (AGENTS.md rule 4/5). */
export interface PeriodSettings {
  lock_duration_sec: number;
  undo_window_sec: number;
  grace_period_sec: number;
  required_selections: number;
  attempts_default: number;
  watch_max: number;
  mode: 'first_come' | 'lottery';
}

export const DEFAULT_PERIOD_SETTINGS: PeriodSettings = {
  lock_duration_sec: 30,
  undo_window_sec: 15,
  grace_period_sec: 60,
  required_selections: 3,
  attempts_default: 4,
  watch_max: 10,
  mode: 'first_come',
};

export const selectionPeriods = pgTable('selection_periods', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  academicYear: text('academic_year').notNull(),
  status: text().notNull().default('draft'),
  opensAt: timestamp('opens_at', { withTimezone: true }),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  settings: jsonb()
    .notNull()
    .$type<PeriodSettings>()
    .default(sql`${JSON.stringify(DEFAULT_PERIOD_SETTINGS)}::jsonb`),
  clonedFrom: uuid('cloned_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const theses = pgTable(
  'theses',
  {
    id: uuid().primaryKey().defaultRandom(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => selectionPeriods.id),
    lecturerId: uuid('lecturer_id').references(() => lecturers.id),
    title: text().notNull(),
    track: text().notNull(),
    description: text(),
    maxClaims: integer('max_claims').notNull().default(1),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('idx_theses_period').on(t.periodId).where(sql`deleted_at IS NULL`)],
);

export const periodEnrollments = pgTable(
  'period_enrollments',
  {
    id: uuid().primaryKey().defaultRandom(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => selectionPeriods.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id),
    accessFrom: timestamp('access_from', { withTimezone: true }),
    accessUntil: timestamp('access_until', { withTimezone: true }),
    magicLinkTokenHash: text('magic_link_token_hash'),
    linkSentAt: timestamp('link_sent_at', { withTimezone: true }),
    linkOpenedAt: timestamp('link_opened_at', { withTimezone: true }),
    attemptsLeft: integer('attempts_left').notNull().default(4),
    reminderStage: integer('reminder_stage').notNull().default(0),
    linkClaimedAt: timestamp('link_claimed_at', { withTimezone: true }),
    deviceFingerprintHash: text('device_fingerprint_hash'),
    autoWarEnabled: boolean('auto_war_enabled').notNull().default(false),
    autoWarConsentedAt: timestamp('auto_war_consented_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_enrollment_period_student').on(t.periodId, t.studentId)],
);

/** Active statuses guarded by partial unique indexes (see 0000_init.sql). */
export const ACTIVE_SELECTION_STATUSES = [
  'locked',
  'confirmed',
  'taken',
  'swap_requested',
  'released_pending',
] as const;

export const thesisSelections = pgTable('thesis_selections', {
  id: uuid().primaryKey().defaultRandom(),
  periodId: uuid('period_id')
    .notNull()
    .references(() => selectionPeriods.id),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id),
  thesisId: uuid('thesis_id')
    .notNull()
    .references(() => theses.id),
  priority: integer().notNull(),
  status: text().notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  idempotencyKey: uuid('idempotency_key').unique(),
  referenceNumber: text('reference_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const swapRequests = pgTable('swap_requests', {
  id: uuid().primaryKey().defaultRandom(),
  selectionId: uuid('selection_id')
    .notNull()
    .references(() => thesisSelections.id),
  idempotencyKey: uuid('idempotency_key').unique(),
  category: text().notNull(),
  reasonDetail: text('reason_detail').notNull(),
  status: text().notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  decisionNote: text('decision_note'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
});

export const thesisWatchers = pgTable(
  'thesis_watchers',
  {
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id),
    thesisId: uuid('thesis_id')
      .notNull()
      .references(() => theses.id),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_watcher_student_thesis').on(t.studentId, t.thesisId)],
);

export const integrityFlags = pgTable('integrity_flags', {
  id: uuid().primaryKey().defaultRandom(),
  selectionId: uuid('selection_id')
    .notNull()
    .references(() => thesisSelections.id),
  score: integer().notNull(),
  signals: jsonb().notNull(),
  level: text().notNull(),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  outcome: text(),
  decisionNote: text('decision_note'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activityLogs = pgTable('activity_logs', {
  id: uuid().notNull().defaultRandom(),
  actorId: uuid('actor_id'),
  actorRole: text('actor_role'),
  action: text().notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  metadata: jsonb(),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const supportTickets = pgTable('support_tickets', {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid('student_id').references(() => students.id),
  subject: text().notNull(),
  messages: jsonb().notNull().default([]),
  channel: text().notNull(),
  status: text().notNull().default('open'),
  assignedAdminId: uuid('assigned_admin_id').references(() => users.id),
  context: jsonb(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  channel: text().notNull(),
  template: text().notNull(),
  payload: jsonb(),
  status: text().notNull().default('queued'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  error: text(),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const studentPreferences = pgTable(
  'student_preferences',
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id),
    periodId: uuid('period_id')
      .notNull()
      .references(() => selectionPeriods.id),
    interestText: text('interest_text').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_preference_period_student').on(t.periodId, t.studentId)],
);

export const exportJobs = pgTable('export_jobs', {
  id: uuid().primaryKey().defaultRandom(),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => users.id),
  kind: text().notNull(),
  periodId: uuid('period_id')
    .notNull()
    .references(() => selectionPeriods.id),
  status: text().notNull().default('queued'),
  filePath: text('file_path'),
  error: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
