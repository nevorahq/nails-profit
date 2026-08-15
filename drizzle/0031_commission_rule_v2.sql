CREATE TYPE "public"."commission_base" AS ENUM('full_price', 'after_discount');--> statement-breakpoint
ALTER TYPE "public"."commission_type" ADD VALUE 'hybrid';--> statement-breakpoint
CREATE TABLE "commission_rule_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"commission_rule_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_rule" DROP CONSTRAINT "commission_rule_shape";--> statement-breakpoint
ALTER TABLE "visit" DROP CONSTRAINT "visit_commission_shape";--> statement-breakpoint
ALTER TABLE "commission_rule" ADD COLUMN "base" "commission_base" DEFAULT 'after_discount' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "commissionable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "commission_base" "commission_base";--> statement-breakpoint
ALTER TABLE "commission_rule_service" ADD CONSTRAINT "commission_rule_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_service" ADD CONSTRAINT "commission_rule_service_commission_rule_id_commission_rule_id_fk" FOREIGN KEY ("commission_rule_id") REFERENCES "public"."commission_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_service" ADD CONSTRAINT "commission_rule_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_service" ADD CONSTRAINT "commission_rule_service_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_service" ADD CONSTRAINT "commission_rule_service_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rule_service_idx" ON "commission_rule_service" USING btree ("commission_rule_id","service_id");--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_shape" CHECK (("commission_rule"."type"::text = 'fixed' and "commission_rule"."fixed_amount_minor" is not null and "commission_rule"."basis_points" is null)
        or ("commission_rule"."type"::text in ('percentage', 'percentage_after_materials') and "commission_rule"."basis_points" is not null and "commission_rule"."fixed_amount_minor" is null)
        or ("commission_rule"."type"::text = 'hybrid' and "commission_rule"."basis_points" is not null and "commission_rule"."fixed_amount_minor" is not null));--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_commission_shape" CHECK (("visit"."commission_type"::text = 'fixed' and "visit"."commission_fixed_amount_minor" is not null and "visit"."commission_basis_points" is null)
        or ("visit"."commission_type"::text in ('percentage', 'percentage_after_materials') and "visit"."commission_basis_points" is not null and "visit"."commission_fixed_amount_minor" is null)
        or ("visit"."commission_type"::text = 'hybrid' and "visit"."commission_basis_points" is not null and "visit"."commission_fixed_amount_minor" is not null));--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
ALTER TABLE "commission_rule_service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commission_rule_service" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "commission_rule_service_tenant_isolation" ON "commission_rule_service"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028` for
-- what happens when they are left to whichever role ran the migration.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "commission_rule_service" OWNER TO "nail_profit"';
    EXECUTE 'ALTER TYPE public."commission_base" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "commission_rule_service" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "commission_rule_service" TO "nail_profit_app"';
  END IF;
END
$grants$;
