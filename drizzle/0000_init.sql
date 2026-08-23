-- ============================================================
-- Thesis Selection Platform — init migration
-- Canonical source: docs/SCHEMA.sql (expanded: triggers, partial
-- unique indexes, monthly partitions, reference-number sequence)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

-- ============ IDENTITY & RBAC ============
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL UNIQUE,
  "password_hash" text,
  "role" text NOT NULL DEFAULT 'student' CHECK ("role" IN ('admin','lecturer','student')),
  "totp_secret" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "students" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "npm" text NOT NULL UNIQUE,
  "full_name" text NOT NULL,
  "class_type" text NOT NULL CHECK ("class_type" IN ('regular','kki')),
  "research_track" text NOT NULL CHECK ("research_track" IN ('clinical','basic','community')),
  "device_fingerprint" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

-- DB-level enforcement of the student email domain.
-- ponytail: regex hardcodes @ui.ac.id (canonical SCHEMA.sql behaviour);
-- runtime STUDENT_DOMAINS overrides live in the service layer
-- (src/modules/identity/student-email.service.ts). If multi-domain ever
-- becomes a hard DB requirement, move the allowlist into an app_settings table.
CREATE OR REPLACE FUNCTION check_student_email_domain() RETURNS trigger AS $$
BEGIN
  IF NEW.email !~ '@ui\.ac\.id$' THEN
    RAISE EXCEPTION 'Student email must end with @ui.ac.id'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER trg_check_student_email_domain
BEFORE INSERT OR UPDATE OF email, role ON "users"
FOR EACH ROW
WHEN (NEW."role" = 'student')
EXECUTE FUNCTION check_student_email_domain();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lecturers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "users"("id"),
  "full_name" text NOT NULL,
  "expertise_tags" text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

-- ============ MULTI-PERIOD ============
CREATE TABLE IF NOT EXISTS "selection_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "academic_year" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft'
    CHECK ("status" IN ('draft','scheduled','open','closed','archived')),
  "opens_at" timestamptz,
  "closes_at" timestamptz,
  "settings" jsonb NOT NULL DEFAULT '{"lock_duration_sec":30,"undo_window_sec":15,"grace_period_sec":60,"required_selections":3,"attempts_default":4,"watch_max":10,"mode":"first_come"}'::jsonb,
  "cloned_from" uuid REFERENCES "selection_periods"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "theses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_id" uuid NOT NULL REFERENCES "selection_periods"("id"),
  "lecturer_id" uuid REFERENCES "lecturers"("id"),
  "title" text NOT NULL,
  "track" text NOT NULL CHECK ("track" IN ('clinical','basic','community')),
  "description" text,
  "max_claims" int NOT NULL DEFAULT 1,
  "embedding" vector(1536),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_theses_period ON "theses"("period_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "period_enrollments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_id" uuid NOT NULL REFERENCES "selection_periods"("id"),
  "student_id" uuid NOT NULL REFERENCES "students"("id"),
  "access_from" timestamptz,
  "access_until" timestamptz,
  "magic_link_token_hash" text,
  "link_sent_at" timestamptz,
  "link_opened_at" timestamptz,
  "attempts_left" int NOT NULL DEFAULT 4,
  "reminder_stage" int NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'period_enrollments_period_id_student_id_key'
  ) THEN
    ALTER TABLE "period_enrollments"
      ADD CONSTRAINT period_enrollments_period_id_student_id_key UNIQUE ("period_id", "student_id");
  END IF;
END $$;
--> statement-breakpoint

-- ============ SELECTION ENGINE ============
CREATE TABLE IF NOT EXISTS "thesis_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_id" uuid NOT NULL REFERENCES "selection_periods"("id"),
  "student_id" uuid NOT NULL REFERENCES "students"("id"),
  "thesis_id" uuid NOT NULL REFERENCES "theses"("id"),
  "priority" int NOT NULL CHECK ("priority" BETWEEN 1 AND 3),
  "status" text NOT NULL
    CHECK ("status" IN ('locked','confirmed','taken','swap_requested',
                        'released_pending','expired','revoked')),
  "locked_until" timestamptz,
  "confirmed_at" timestamptz,
  "ip_address" inet,
  "user_agent" text,
  "idempotency_key" uuid UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint

-- Guard 1: one active selection per thesis (race-condition backstop #2)
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_thesis ON "thesis_selections"("thesis_id")
  WHERE "status" IN ('locked','confirmed','taken','swap_requested','released_pending')
  AND "deleted_at" IS NULL;
--> statement-breakpoint

-- Guard 2: one active selection per student per priority slot (max 3 total)
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_priority
  ON "thesis_selections"("student_id", "period_id", "priority")
  WHERE "status" IN ('locked','confirmed','taken','swap_requested','released_pending')
  AND "deleted_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "swap_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "selection_id" uuid NOT NULL REFERENCES "thesis_selections"("id"),
  "category" text NOT NULL CHECK ("category" IN ('wrong_pick','interest_mismatch',
        'lecturer_schedule_issue','other')),
  "reason_detail" text NOT NULL CHECK (length("reason_detail") >= 20),
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending','approved','rejected','cancelled')),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "cancelled_at" timestamptz,
  "reviewed_by" uuid REFERENCES "users"("id"),
  "decision_note" text,
  "decided_at" timestamptz,
  "grace_until" timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "thesis_watchers" (
  "student_id" uuid NOT NULL REFERENCES "students"("id"),
  "thesis_id" uuid NOT NULL REFERENCES "theses"("id"),
  "notified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'thesis_watchers_student_id_thesis_id_key'
  ) THEN
    ALTER TABLE "thesis_watchers"
      ADD CONSTRAINT thesis_watchers_student_id_thesis_id_key UNIQUE ("student_id", "thesis_id");
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integrity_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "selection_id" uuid NOT NULL REFERENCES "thesis_selections"("id"),
  "score" int NOT NULL,
  "signals" jsonb NOT NULL,
  "level" text NOT NULL CHECK ("level" IN ('high','medium')),
  "reviewed_by" uuid REFERENCES "users"("id"),
  "outcome" text CHECK ("outcome" IN ('false_positive','investigate','revoked','pending')),
  "decision_note" text,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ============ AUDIT (append-only, monthly partitions) ============
CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "actor_id" uuid,
  "actor_role" text,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "metadata" jsonb,
  "ip" inet,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint

-- Monthly partition helper. Called by this migration for the initial window
-- and by ops/workers before a month starts (no cron inside the request path).
CREATE OR REPLACE FUNCTION ensure_activity_log_partition(month_start date) RETURNS void AS $$
DECLARE
  partition_name text := 'activity_logs_' || to_char(month_start, 'YYYY_MM');
  month_end date := (month_start + INTERVAL '1 month')::date;
BEGIN
  IF to_regclass(format('%I', partition_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF activity_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, month_end
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

SELECT ensure_activity_log_partition(m)
FROM generate_series(
  date_trunc('month', now())::date,
  (date_trunc('month', now()) + INTERVAL '5 months')::date,
  INTERVAL '1 month'
) AS m;
--> statement-breakpoint

-- ============ SUPPORT & NOTIFICATIONS ============
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_id" uuid REFERENCES "students"("id"),
  "subject" text NOT NULL,
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "channel" text NOT NULL CHECK ("channel" IN ('ai_chat','human','whatsapp')),
  "status" text NOT NULL DEFAULT 'open'
    CHECK ("status" IN ('open','assigned','resolved')),
  "assigned_admin_id" uuid REFERENCES "users"("id"),
  "context" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "users"("id"),
  "channel" text NOT NULL CHECK ("channel" IN ('email','in_app','webhook')),
  "template" text NOT NULL,
  "payload" jsonb,
  "status" text NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued','sent','opened','failed')),
  "sent_at" timestamptz,
  "opened_at" timestamptz,
  "error" text,
  "retry_count" int NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ============ REFERENCE NUMBERS ============
-- Format THS-{academic_year}-{padded seq} assembled in the service layer.
CREATE SEQUENCE IF NOT EXISTS ref_number_seq;
