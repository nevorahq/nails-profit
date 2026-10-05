-- A service carries what it uses up.
--
-- Materials come back into the cost of a service as one sum per service and per
-- add-on — no catalogue, no recipe, no units, no stock: everything migration
-- 0040 removed stays removed. Whether those sums count at all is the studio's
-- choice, month by month, in `materials_costing_period` (see
-- `domain/materials-mode.ts`): by default a studio keeps counting its purchases
-- as the month's costs, exactly as it does today.
--
-- Every column is nullable and nothing is backfilled. Null on a service is «not
-- given»; on a visit line and a snapshot it is «closed before this existed».
-- The previous version of the code neither reads nor writes any of it, which is
-- what lets this run before the code that uses it is deployed.

CREATE TYPE "public"."materials_costing_mode" AS ENUM('purchases', 'per_service');--> statement-breakpoint
CREATE TABLE "materials_costing_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mode" "materials_costing_mode" NOT NULL,
	"effective_from" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_costing_period_month_start" CHECK (extract(day from "materials_costing_period"."effective_from") = 1)
);
--> statement-breakpoint
ALTER TABLE "add_on" ADD COLUMN "materials_minor" bigint;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "materials_minor" bigint;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "materials_minor" bigint;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "materials_minor" bigint;--> statement-breakpoint
ALTER TABLE "materials_costing_period" ADD CONSTRAINT "materials_costing_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials_costing_period" ADD CONSTRAINT "materials_costing_period_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials_costing_period" ADD CONSTRAINT "materials_costing_period_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "materials_costing_period_month_idx" ON "materials_costing_period" USING btree ("organization_id","effective_from");--> statement-breakpoint
ALTER TABLE "add_on" ADD CONSTRAINT "add_on_materials_non_negative" CHECK ("add_on"."materials_minor" is null or "add_on"."materials_minor" >= 0);--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_materials_non_negative" CHECK ("service"."materials_minor" is null or "service"."materials_minor" >= 0);--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_materials_non_negative" CHECK ("visit_line"."materials_minor" is null or "visit_line"."materials_minor" >= 0);
--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies; see
-- `scripts/verify-rls.sql`, which fails the build without this block.
ALTER TABLE "materials_costing_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "materials_costing_period" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "materials_costing_period_tenant_isolation" ON "materials_costing_period"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "materials_costing_period" OWNER TO "nail_profit"';
    EXECUTE 'ALTER TYPE "materials_costing_mode" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "materials_costing_period" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "materials_costing_period" TO "nail_profit_app"';
  END IF;
END
$grants$;
