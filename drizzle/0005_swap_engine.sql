-- F7: swap engine — idempotent request creation.

ALTER TABLE "swap_requests" ADD COLUMN IF NOT EXISTS "idempotency_key" uuid UNIQUE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_swap_requests_selection ON "swap_requests"("selection_id");
