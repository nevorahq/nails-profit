-- Rollback for 0034_long_gauntlet (epic E3.1, Material Fast Setup).
--
-- Reverses the migration in the opposite order it was applied: dependent
-- objects first, then the columns, then the types nothing references any more.
--
-- What this deliberately does not preserve: a material created from a template
-- loses `template_id`, `kind` and `source`, and its price versions lose
-- `price_source`. That data only exists because 0034 created the columns, so
-- there is nowhere to put it — which is the honest meaning of rolling back an
-- additive migration, and the reason the up-migration keeps every new column
-- defaulted and nullable. Nothing financial is touched: prices, package sizes
-- and completed visits are untouched by both directions.
--
-- `booking_idempotency_key.result` goes with it. Any in-flight retry that would
-- have replayed from it re-executes instead; the natural key on `material` is
-- gone too by then, so a duplicated paste is caught by the application's own
-- lookup rather than by the index.

DROP POLICY IF EXISTS "material_template_read_only" ON "material_template";--> statement-breakpoint

DROP INDEX IF EXISTS "material_natural_key";--> statement-breakpoint

ALTER TABLE "material" DROP CONSTRAINT IF EXISTS "material_template_id_material_template_id_fk";--> statement-breakpoint
ALTER TABLE "material" DROP COLUMN IF EXISTS "match_key";--> statement-breakpoint
ALTER TABLE "material" DROP COLUMN IF EXISTS "template_id";--> statement-breakpoint
ALTER TABLE "material" DROP COLUMN IF EXISTS "source";--> statement-breakpoint
ALTER TABLE "material" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint

ALTER TABLE "material_price_version" DROP COLUMN IF EXISTS "price_source";--> statement-breakpoint
ALTER TABLE "booking_idempotency_key" DROP COLUMN IF EXISTS "result";--> statement-breakpoint

DROP TABLE IF EXISTS "material_template";--> statement-breakpoint

-- Last: a type cannot be dropped while a column still uses it, so these follow
-- every column above.
DROP TYPE IF EXISTS "public"."material_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."material_data_source";
