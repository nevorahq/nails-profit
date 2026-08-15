-- A template may now decline to state its packaging.
--
-- The catalogue became a list of generic materials — "База", "Гель-лак",
-- "Акриловая пудра" — and generic materials have no one package size: base coat
-- is sold in 8, 12, 15 and 35 ml bottles. Storing one of them would put an
-- unverified number into the denominator of every cost derived from that
-- material, which is the plausible-but-wrong figure section 8.8.1 refuses to
-- produce. Null says "the catalogue does not know"; the owner enters the size
-- of the bottle actually in front of them.
--
-- The check follows the column: still positive when present, absent when not.
--
-- NOT generated verbatim by drizzle-kit. Its diff also contained
--
--     ALTER TABLE "material" drop column "match_key";
--     ALTER TABLE "material" ADD COLUMN "match_key" text GENERATED ALWAYS AS (…) STORED;
--
-- for a generated expression that did not change — drizzle-kit re-emits
-- generated columns it cannot compare. Dropping `match_key` takes
-- `material_natural_key` with it, and the re-add does not bring the index back,
-- so those two statements would have quietly removed every tenant's protection
-- against duplicate materials. Both are deleted.

ALTER TABLE "material_template" DROP CONSTRAINT "material_template_size_positive";--> statement-breakpoint
ALTER TABLE "material_template" ALTER COLUMN "package_size_milli_units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "material_template" ADD CONSTRAINT "material_template_size_positive" CHECK ("material_template"."package_size_milli_units" is null or "material_template"."package_size_milli_units" > 0);
