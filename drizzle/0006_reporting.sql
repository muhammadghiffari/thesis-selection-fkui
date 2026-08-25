-- F9: async reporting — export job tracking + audit pagination index.

CREATE TABLE IF NOT EXISTS "export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requested_by" uuid NOT NULL REFERENCES "users"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('final_selections','final_selections_pdf','swap_history','integrity_summary')),
  "period_id" uuid NOT NULL REFERENCES "selection_periods"("id"),
  "status" text NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued','processing','ready','failed')),
  "file_path" text,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint

-- Audit viewer pagination fallback (partitions already prune by month when
-- date filters are present; this index serves unbounded newest-first listing).
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON "activity_logs" ("created_at" DESC);
