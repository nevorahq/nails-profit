CREATE TYPE "public"."material_stock_check_basis" AS ENUM('bucket', 'measured');--> statement-breakpoint
CREATE TABLE "material_purchase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"package_quantity" integer NOT NULL,
	"package_size_milli_units" bigint NOT NULL,
	"unit_package_cost_minor" bigint NOT NULL,
	"total_cost_minor" bigint GENERATED ALWAYS AS (package_quantity * unit_package_cost_minor) STORED,
	"currency" "currency" NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supplier" text,
	"note" text,
	"price_version_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_purchase_quantity_positive" CHECK ("material_purchase"."package_quantity" > 0),
	CONSTRAINT "material_purchase_size_positive" CHECK ("material_purchase"."package_size_milli_units" > 0),
	CONSTRAINT "material_purchase_cost_non_negative" CHECK ("material_purchase"."unit_package_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "material_stock_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"observed_quantity_milli_units" bigint NOT NULL,
	"basis" "material_stock_check_basis" DEFAULT 'bucket' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_stock_check_non_negative" CHECK ("material_stock_check"."observed_quantity_milli_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "material_purchase" ADD CONSTRAINT "material_purchase_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchase" ADD CONSTRAINT "material_purchase_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchase" ADD CONSTRAINT "material_purchase_price_version_id_material_price_version_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."material_price_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchase" ADD CONSTRAINT "material_purchase_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_stock_check" ADD CONSTRAINT "material_stock_check_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_stock_check" ADD CONSTRAINT "material_stock_check_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_stock_check" ADD CONSTRAINT "material_stock_check_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_purchase_org_material_idx" ON "material_purchase" USING btree ("organization_id","material_id","purchased_at");--> statement-breakpoint
CREATE INDEX "material_stock_check_org_material_idx" ON "material_stock_check" USING btree ("organization_id","material_id","checked_at");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
-- `scripts/verify-rls.sql` fails the build if this block is forgotten.
ALTER TABLE "material_purchase" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_purchase" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "material_purchase_tenant_isolation" ON "material_purchase"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "material_stock_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "material_stock_check" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "material_stock_check_tenant_isolation" ON "material_stock_check"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants stated rather than inherited, the pattern migration 0028
-- established. Whether these tables end up defended must not depend on which
-- URL happened to be in the shell: run as Supabase's `postgres` they would be
-- created under that role's default privileges, which grant `anon`,
-- `authenticated` and `service_role` everything, and leave `nail_profit_app`
-- with no grant at all. It has already happened twice in this repository —
-- `expense` and `material_template`.
--
-- Idempotent and guarded on each role existing, so a plain PostgreSQL box
-- without Supabase's roles runs the whole block as a no-op.
DO $grants$
DECLARE
  api_role text;
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['material_purchase', 'material_stock_check'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
      EXECUTE format('ALTER TABLE %I OWNER TO "nail_profit"', target);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', target, api_role);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO "nail_profit_app"', target);
    END IF;
  END LOOP;
END
$grants$;