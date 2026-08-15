ALTER TABLE "specialist" ADD COLUMN "is_principal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "currency" "currency" DEFAULT 'MDL' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "master_is_principal" boolean;--> statement-breakpoint

-- Backfill the currency from the organization that owns the visit.
--
-- The column defaults to 'MDL' so that the previous version's inserts keep
-- working, but a default is not an answer: an organization on EUR has always
-- charged in EUR, and every visit it already closed was in EUR too. Re-costing
-- hardcoded "MDL", so those visits' later snapshots carry the wrong currency —
-- this puts the visits themselves right, and `recalculateVisitProfit` reads
-- from here from now on.
UPDATE "visit" AS v
   SET "currency" = o."currency"
  FROM "organization" AS o
 WHERE o."id" = v."organization_id"
   AND v."currency" <> o."currency";--> statement-breakpoint

-- `master_is_principal` is deliberately NOT backfilled here.
--
-- The flag it would copy from does not exist yet — it is created three
-- statements above, false for everyone — so an UPDATE now would write "no" for
-- every visit ever closed and call it an answer. NULL is the honest value: the
-- question had not been asked when these visits closed.
--
-- Marking a specialist as a principal fills in their own NULL rows once, from
-- `app/api/v1/specialists/[id]/route.ts`. Rows that already carry true or false
-- are never touched, so no closed visit ever changes its answer — only rows
-- that never had one get filled.
