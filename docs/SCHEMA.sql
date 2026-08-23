-- ============================================================
-- Thesis Selection Platform — Final Schema (PostgreSQL 16 + pgvector)
-- Agent must expand this into proper Drizzle migrations with all
-- indexes, constraints, and triggers described here.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============ IDENTITY & RBAC ============
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  password_hash   text,                          -- argon2id; NULL if magic-link-only
  role            text NOT NULL DEFAULT 'student'
                  CHECK (role IN ('admin','lecturer','student')),
  totp_secret     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE students (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  npm              text UNIQUE NOT NULL,
  full_name        text NOT NULL,
  class_type       text NOT NULL CHECK (class_type IN ('regular','kki')),
  research_track   text NOT NULL CHECK (research_track IN ('clinical','basic','community')),
  device_fingerprint jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
-- DB-level enforcement of student email domain:
CREATE OR REPLACE FUNCTION check_student_email_domain() RETURNS trigger AS BEGIN
  IF NEW.email !~ '@ui\.ac\.id$' THEN
    RAISE EXCEPTION 'Student email must end with @ui.ac.id';
  END IF;
  RETURN NEW;
END LANGUAGE plpgsql;
-- (attach as trigger on INSERT/UPDATE joining users+students, or enforce in service layer)

CREATE TABLE lecturers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id),
  full_name       text NOT NULL,
  expertise_tags  text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- ============ MULTI-PERIOD ============
CREATE TABLE selection_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  academic_year text NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','scheduled','open','closed','archived')),
  opens_at      timestamptz,
  closes_at     timestamptz,
  settings      jsonb NOT NULL DEFAULT '{"lock_duration_sec":30,"undo_window_sec":15,
                "grace_period_sec":60,"required_selections":3,"attempts_default":4,
                "watch_max":10,"mode":"first_come"}'::jsonb,
  cloned_from   uuid REFERENCES selection_periods(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE theses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id    uuid NOT NULL REFERENCES selection_periods(id),
  lecturer_id  uuid REFERENCES lecturers(id),
  title        text NOT NULL,
  track        text NOT NULL CHECK (track IN ('clinical','basic','community')),
  description  text,
  max_claims   int NOT NULL DEFAULT 1,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX idx_theses_period ON theses(period_id) WHERE deleted_at IS NULL;

CREATE TABLE period_enrollments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id             uuid NOT NULL REFERENCES selection_periods(id),
  student_id            uuid NOT NULL REFERENCES students(id),
  access_from           timestamptz,
  access_until          timestamptz,
  magic_link_token_hash text,
  link_sent_at          timestamptz,
  link_opened_at        timestamptz,
  attempts_left         int NOT NULL DEFAULT 4,
  reminder_stage        int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(period_id, student_id)
);

-- ============ SELECTION ENGINE ============
CREATE TABLE thesis_selections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id       uuid NOT NULL REFERENCES selection_periods(id),
  student_id      uuid NOT NULL REFERENCES students(id),
  thesis_id       uuid NOT NULL REFERENCES theses(id),
  priority        int NOT NULL CHECK (priority BETWEEN 1 AND 3),
  status          text NOT NULL
                  CHECK (status IN ('locked','confirmed','taken','swap_requested',
                                    'released_pending','expired','revoked')),
  locked_until    timestamptz,
  confirmed_at    timestamptz,
  ip_address      inet,
  user_agent      text,
  idempotency_key uuid UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- Guard 1: one active selection per thesis
CREATE UNIQUE INDEX one_active_per_thesis ON thesis_selections(thesis_id)
  WHERE status IN ('locked','confirmed','taken','swap_requested','released_pending')
  AND deleted_at IS NULL;

-- Guard 2: one active selection per student per priority slot (max 3 total)
CREATE UNIQUE INDEX one_active_per_priority ON thesis_selections(student_id, period_id, priority)
  WHERE status IN ('locked','confirmed','taken','swap_requested','released_pending')
  AND deleted_at IS NULL;

CREATE TABLE swap_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id   uuid NOT NULL REFERENCES thesis_selections(id),
  category       text NOT NULL CHECK (category IN ('wrong_pick','interest_mismatch',
                        'lecturer_schedule_issue','other')),
  reason_detail  text NOT NULL CHECK (length(reason_detail) >= 20),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  reviewed_by    uuid REFERENCES users(id),
  decision_note  text,
  decided_at     timestamptz,
  grace_until    timestamptz
);

CREATE TABLE thesis_watchers (
  student_id  uuid NOT NULL REFERENCES students(id),
  thesis_id   uuid NOT NULL REFERENCES theses(id),
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id, thesis_id)
);

CREATE TABLE integrity_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id  uuid NOT NULL REFERENCES thesis_selections(id),
  score         int NOT NULL,
  signals       jsonb NOT NULL,
  level         text NOT NULL CHECK (level IN ('high','medium')),
  reviewed_by   uuid REFERENCES users(id),
  outcome       text CHECK (outcome IN ('false_positive','investigate','revoked','pending')),
  decision_note text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============ AUDIT (append-only, monthly partitions) ============
CREATE TABLE activity_logs (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  metadata    jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Agent: create monthly partitions via migration helper.

-- ============ SUPPORT & NOTIFICATIONS ============
CREATE TABLE support_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid REFERENCES students(id),
  subject           text NOT NULL,
  messages          jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel           text NOT NULL CHECK (channel IN ('ai_chat','human','whatsapp')),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','assigned','resolved')),
  assigned_admin_id uuid REFERENCES users(id),
  context           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

CREATE TABLE notification_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id),
  channel     text NOT NULL CHECK (channel IN ('email','in_app','webhook')),
  template    text NOT NULL,
  payload     jsonb,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','sent','opened','failed')),
  sent_at     timestamptz,
  opened_at   timestamptz,
  error       text,
  retry_count int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============ REFERENCE NUMBERS ============
CREATE SEQUENCE ref_number_seq;
-- Format: THS-{academic_year}-{padded seq}, generated in service layer.
