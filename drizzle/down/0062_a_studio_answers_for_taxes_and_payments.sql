-- Rollback for 0062: a studio answers for its taxes and its payments.
--
-- Drops both columns. The previous version reads neither; what it loses is
-- only the answers that wrote no rule («не плачу с визита»), which nothing
-- before this release asked for.

ALTER TABLE "organization" DROP COLUMN IF EXISTS "payments_answered_at";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "taxes_answered_at";
