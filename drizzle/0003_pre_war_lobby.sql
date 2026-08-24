-- F4: pre-war lobby — AI preference capture + auto-war opt-in state.

CREATE TABLE IF NOT EXISTS "student_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_id" uuid NOT NULL REFERENCES "students"("id"),
  "period_id" uuid NOT NULL REFERENCES "selection_periods"("id"),
  "interest_text" text NOT NULL,
  "embedding" vector(1536),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_preferences_period_id_student_id_key'
  ) THEN
    ALTER TABLE "student_preferences"
      ADD CONSTRAINT student_preferences_period_id_student_id_key UNIQUE ("period_id", "student_id");
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "period_enrollments" ADD COLUMN IF NOT EXISTS "auto_war_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "period_enrollments" ADD COLUMN IF NOT EXISTS "auto_war_consented_at" timestamptz;
