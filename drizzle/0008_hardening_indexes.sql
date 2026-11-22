-- Hardening indexes (OWASP A04 availability + query performance).
-- Every index is IF NOT EXISTS so the migration is idempotent and safe to
-- re-run on deploys. Covers the hottest query patterns observed in services:
-- war-room catalog, per-student selections, reviewer queues, audit trails.

CREATE INDEX IF NOT EXISTS idx_students_user ON "students"("user_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_lecturers_user ON "lecturers"("user_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_periods_status_opens ON "selection_periods"("status", "opens_at") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_theses_lecturer ON "theses"("lecturer_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_theses_track ON "theses"("period_id", "track") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON "period_enrollments"("student_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_enrollments_period ON "period_enrollments"("period_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_enrollments_magic_hash ON "period_enrollments"("magic_link_token_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_selections_period_status ON "thesis_selections"("period_id", "status") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_selections_student_period ON "thesis_selections"("student_id", "period_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_selections_locked_until ON "thesis_selections"("locked_until") WHERE "status" = 'locked' AND "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_selections_created ON "thesis_selections"("created_at") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_swap_status_created ON "swap_requests"("status", "requested_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_swap_reviewed_by ON "swap_requests"("reviewed_by");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_watchers_thesis ON "thesis_watchers"("thesis_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_integrity_selection ON "integrity_flags"("selection_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_integrity_level_created ON "integrity_flags"("level", "created_at") WHERE "decided_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_audit_actor ON "activity_logs"("actor_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_audit_entity ON "activity_logs"("entity_type", "entity_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_audit_action ON "activity_logs"("action");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_student_status ON "support_tickets"("student_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON "support_tickets"("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON "support_tickets"("assigned_admin_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_refresh_expires ON "refresh_tokens"("expires_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_notifications_user_status ON "notification_deliveries"("user_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON "notification_deliveries"("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_exports_requested_status ON "export_jobs"("requested_by", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_exports_period_status ON "export_jobs"("period_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_preferences_period ON "student_preferences"("period_id");
