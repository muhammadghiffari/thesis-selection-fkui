-- F10: Support chat — support_chunks for FAQ RAG pipeline.
-- support_tickets already exists from 0000_init.sql; this migration only adds
-- the vector store for rule chunks.

CREATE TABLE IF NOT EXISTS "support_chunks" (
  "id"         text PRIMARY KEY,            -- stable slug (rules-content.ts id field)
  "category"   text NOT NULL,
  "content"    text NOT NULL,
  "embedding"  vector(1536),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- Approximate nearest-neighbor index for cosine similarity search.
-- Using ivfflat with 10 lists (appropriate for ≤ 100 chunks).
CREATE INDEX IF NOT EXISTS idx_support_chunks_embedding
  ON "support_chunks" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 10);
