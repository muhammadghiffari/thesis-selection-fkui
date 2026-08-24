-- F3: magic link claim + device-binding state on the per-period enrollment.
-- magic_link_token_hash already stores sha256(jti) of the ACTIVE link.

ALTER TABLE "period_enrollments" ADD COLUMN IF NOT EXISTS "link_claimed_at" timestamptz;
ALTER TABLE "period_enrollments" ADD COLUMN IF NOT EXISTS "device_fingerprint_hash" text;
