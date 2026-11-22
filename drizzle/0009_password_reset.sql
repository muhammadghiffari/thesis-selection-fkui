-- Password reset (staff): single-use hashed tokens, 30-min TTL.
-- Raw token only travels in the emailed link; DB stores sha256 hash.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON "password_reset_tokens"("user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON "password_reset_tokens"("expires_at") WHERE "used_at" IS NULL;
