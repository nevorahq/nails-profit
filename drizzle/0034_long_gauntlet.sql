CREATE TYPE "public"."material_data_source" AS ENUM('manual', 'template', 'bulk_paste', 'import');--> statement-breakpoint
CREATE TYPE "public"."material_kind" AS ENUM('sku', 'aggregate');--> statement-breakpoint
CREATE TABLE "material_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"brand" text,
	"name" jsonb NOT NULL,
	"system_key" text,
	"category" text NOT NULL,
	"package_size_milli_units" bigint NOT NULL,
	"base_unit" "material_unit" NOT NULL,
	"kind" "material_kind" DEFAULT 'sku' NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"profiles" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_template_size_positive" CHECK ("material_template"."package_size_milli_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_idempotency_key" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "material_price_version" ADD COLUMN "price_source" "material_data_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "kind" "material_kind" DEFAULT 'sku' NOT NULL;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "source" "material_data_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "template_id" uuid;--> statement-breakpoint
-- Over `name` alone. A material carries no brand column — the brand lives on
-- the template it may have come from, and a template is not what the owner
-- typed. Folding a brand into the key here would mean two rows named "База"
-- could coexist as long as one of them once pointed at a different template,
-- which is precisely the duplicate this index exists to stop.
ALTER TABLE "material" ADD COLUMN "match_key" text GENERATED ALWAYS AS (lower(regexp_replace(name, '[^0-9a-zа-яîăâșț]+', '', 'gi'))) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "material_template_slug_idx" ON "material_template" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "material_template_core_idx" ON "material_template" USING btree ("is_core","sort_order");--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_template_id_material_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."material_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The unique index below is the first thing in this schema to assert that two
-- materials in one organization cannot share a name. Nothing enforced it
-- before, so a database that already broke the rule would fail here with
-- PostgreSQL's own message — "could not create unique index" plus one example
-- key — which names neither the organization nor the materials involved.
--
-- Fail with the list instead. An operator who has to merge duplicates by hand
-- needs to know which rows, and a migration that stops before it has changed
-- anything is a migration that can simply be re-run afterwards.
DO $duplicates$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('org %s: %L (%s) ×%s', organization_id, example, base_unit, copies), '; ')
    INTO offenders
    FROM (
      SELECT organization_id, base_unit, min(name) AS example, count(*) AS copies
        FROM "material"
       WHERE archived_at IS NULL
       GROUP BY organization_id, match_key, base_unit
      HAVING count(*) > 1
    ) AS duplicates;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate materials block the natural key: %', offenders
      USING HINT = 'Archive the copies, or give them distinct names, then re-run the migration.';
  END IF;
END
$duplicates$;--> statement-breakpoint
CREATE UNIQUE INDEX "material_natural_key" ON "material" USING btree ("organization_id","match_key","base_unit") WHERE "material"."archived_at" is null;--> statement-breakpoint

-- `material_template` is product data, not tenant data: it has no
-- organization_id, so the tenant policy every other table carries has nothing
-- to compare against. What it needs instead is the guarantee of E3.1 §3.4 —
-- readable by everyone, writable by no tenant.
--
-- Two independent layers, because either alone fails open in a plausible way.
-- The REVOKE stops the writes that `init.sql`'s blanket grant would otherwise
-- allow; the SELECT-only policy means that re-granting the table by accident
-- (a future `GRANT ... ON ALL TABLES`, which is how the grant arrived in the
-- first place) still would not let the application insert a row.
--
-- Not FORCEd, deliberately, and for the same reason as migration 0022: the
-- migration role owns the table and the seeding command runs as that role.
-- Seeding is the only writer this table is meant to have.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "material_template" FROM nail_profit_app;--> statement-breakpoint
ALTER TABLE "material_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "material_template_read_only" ON "material_template"
  FOR SELECT TO nail_profit_app
  USING (true);