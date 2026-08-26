-- Removing the material engine.
--
-- The columns become `text` before the enum is recreated, which is what makes
-- the two UPDATEs below possible and necessary: PostgreSQL cannot drop a value
-- from an enum, so the type is rebuilt without `percentage_after_materials`,
-- and any row still holding that value would fail the cast back. Rewriting them
-- to `percentage` keeps the rate they were agreed at — «40% после материалов»
-- becomes «40%», which is what the arithmetic now does anyway, since there are
-- no materials left to take off first. It pays the master more, and that is the
-- honest reading of a rule whose subtrahend no longer exists.
--
-- The tables go with CASCADE because `consumption` and `recipe_item` are the
-- only things pointing at them; nothing outside the material engine holds a
-- reference. `financial_snapshot` keeps every visit it ever costed — it loses
-- three columns, not rows.
--
-- There is deliberately no file under `drizzle/down/` for this migration, and
-- `scripts/migrate-down.mjs` will refuse it for exactly that reason. Eight
-- tables of history are dropped here and nothing in a rollback file could bring
-- their rows back; one that restored only the empty shape would report success
-- while leaving every past visit costed as «material cost unknown». Going back
-- means restoring a backup, and the tooling should say so rather than pretend
-- otherwise.
--
-- not-backward-compatible: the material engine is removed from the product in
-- the same release, so there is no previous application version to keep working
-- — the build that reads `material`, `recipe` and `consumption` is the one this
-- release replaces. Rolling the application back therefore needs the database
-- rolled back with it, from a backup.

ALTER TABLE "consumption" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_price_version" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_purchase" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_stock_check" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_template" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe_item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "consumption" CASCADE;--> statement-breakpoint
DROP TABLE "material_price_version" CASCADE;--> statement-breakpoint
DROP TABLE "material_purchase" CASCADE;--> statement-breakpoint
DROP TABLE "material_stock_check" CASCADE;--> statement-breakpoint
DROP TABLE "material_template" CASCADE;--> statement-breakpoint
DROP TABLE "material" CASCADE;--> statement-breakpoint
DROP TABLE "recipe_item" CASCADE;--> statement-breakpoint
DROP TABLE "recipe" CASCADE;--> statement-breakpoint
ALTER TABLE "commission_rule" DROP CONSTRAINT "commission_rule_shape";--> statement-breakpoint
ALTER TABLE "financial_snapshot" DROP CONSTRAINT "financial_snapshot_material_source";--> statement-breakpoint
ALTER TABLE "visit" DROP CONSTRAINT "visit_commission_shape";--> statement-breakpoint
ALTER TABLE "commission_rule" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "visit" ALTER COLUMN "commission_type" SET DATA TYPE text;--> statement-breakpoint
UPDATE "commission_rule" SET "type" = 'percentage' WHERE "type" = 'percentage_after_materials';--> statement-breakpoint
UPDATE "visit" SET "commission_type" = 'percentage' WHERE "commission_type" = 'percentage_after_materials';--> statement-breakpoint
DROP TYPE "public"."commission_type";--> statement-breakpoint
CREATE TYPE "public"."commission_type" AS ENUM('percentage', 'fixed', 'hybrid');--> statement-breakpoint
ALTER TABLE "commission_rule" ALTER COLUMN "type" SET DATA TYPE "public"."commission_type" USING "type"::"public"."commission_type";--> statement-breakpoint
ALTER TABLE "visit" ALTER COLUMN "commission_type" SET DATA TYPE "public"."commission_type" USING "commission_type"::"public"."commission_type";--> statement-breakpoint
ALTER TABLE "pilot_interaction" ALTER COLUMN "decision_type" SET DATA TYPE text;--> statement-breakpoint
-- Deleted rather than nulled: `pilot_interaction_shape` requires a `decision`
-- to name its type, so a null would violate the constraint, and the other two
-- types would claim a decision the founder never recorded. These are pilot
-- operations telemetry, not financial records — no report reads them.
DELETE FROM "pilot_interaction" WHERE "decision_type" = 'material_consumption';--> statement-breakpoint
DROP TYPE "public"."pilot_decision_type";--> statement-breakpoint
CREATE TYPE "public"."pilot_decision_type" AS ENUM('price', 'service_composition');--> statement-breakpoint
ALTER TABLE "pilot_interaction" ALTER COLUMN "decision_type" SET DATA TYPE "public"."pilot_decision_type" USING "decision_type"::"public"."pilot_decision_type";--> statement-breakpoint
ALTER TABLE "financial_snapshot" DROP COLUMN "material_cost_minor";--> statement-breakpoint
ALTER TABLE "financial_snapshot" DROP COLUMN "normative_material_cost_minor";--> statement-breakpoint
ALTER TABLE "financial_snapshot" DROP COLUMN "material_usage_source";--> statement-breakpoint
ALTER TABLE "visit" DROP COLUMN "standard_material_usage_known";--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_shape" CHECK (("commission_rule"."type"::text = 'fixed' and "commission_rule"."fixed_amount_minor" is not null and "commission_rule"."basis_points" is null)
        or ("commission_rule"."type"::text = 'percentage' and "commission_rule"."basis_points" is not null and "commission_rule"."fixed_amount_minor" is null)
        or ("commission_rule"."type"::text = 'hybrid' and "commission_rule"."basis_points" is not null and "commission_rule"."fixed_amount_minor" is not null));--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_commission_shape" CHECK (("visit"."commission_type"::text = 'fixed' and "visit"."commission_fixed_amount_minor" is not null and "visit"."commission_basis_points" is null)
        or ("visit"."commission_type"::text = 'percentage' and "visit"."commission_basis_points" is not null and "visit"."commission_fixed_amount_minor" is null)
        or ("visit"."commission_type"::text = 'hybrid' and "visit"."commission_basis_points" is not null and "visit"."commission_fixed_amount_minor" is not null));--> statement-breakpoint
DROP TYPE "public"."material_costing_mode";--> statement-breakpoint
DROP TYPE "public"."material_data_source";--> statement-breakpoint
DROP TYPE "public"."material_kind";--> statement-breakpoint
DROP TYPE "public"."material_stock_check_basis";--> statement-breakpoint
DROP TYPE "public"."material_unit";