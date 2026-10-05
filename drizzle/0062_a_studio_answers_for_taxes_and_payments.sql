-- A studio answers for its taxes and its payments.
--
-- «Как вы платите налоги?» and «Как платят клиенты?» are two steps of the
-- month's guide, and «не плачу с визита» is an answer as much as a rate is —
-- one that writes no rule, so it has to be written down somewhere. Until a
-- studio has answered both, the report says its profit is shown before taxes
-- and the bank's fee.
--
-- A studio that has ever written a rule has answered already, an ended VAT
-- rate or an archived terminal included: somebody looked at the question and
-- chose. Backfilled at the first such rule's creation, so the date says when
-- the answer was given rather than when this migration ran. Payroll
-- contributions are a different question and answer neither.
--
-- Nullable, so the previous version, which names neither column, keeps writing
-- organizations.

ALTER TABLE "organization" ADD COLUMN "taxes_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "payments_answered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "organization" AS o SET "taxes_answered_at" = (
  SELECT min(r."created_at") FROM "tax_rule" AS r
  WHERE r."organization_id" = o."id" AND r."kind"::text IN ('vat', 'turnover')
)
WHERE o."taxes_answered_at" IS NULL;--> statement-breakpoint
UPDATE "organization" AS o SET "payments_answered_at" = (
  SELECT min(m."created_at") FROM "payment_method" AS m
  WHERE m."organization_id" = o."id"
)
WHERE o."payments_answered_at" IS NULL;
