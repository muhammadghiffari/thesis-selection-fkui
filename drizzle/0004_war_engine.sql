-- F5: war engine — receipt reference numbers on selections.

ALTER TABLE "thesis_selections" ADD COLUMN IF NOT EXISTS "reference_number" text;
