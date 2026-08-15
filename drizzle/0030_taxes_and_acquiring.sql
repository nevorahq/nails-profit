CREATE TYPE "public"."payment_method_kind" AS ENUM('cash', 'card', 'transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."tax_kind" AS ENUM('vat', 'turnover', 'payroll');--> statement-breakpoint
CREATE TABLE "payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "payment_method_kind" NOT NULL,
	"commission_basis_points" integer DEFAULT 0 NOT NULL,
	"fixed_fee_minor" bigint DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_method_non_negative" CHECK ("payment_method"."commission_basis_points" >= 0 and "payment_method"."fixed_fee_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "tax_kind" NOT NULL,
	"basis_points" integer NOT NULL,
	"remittable" boolean DEFAULT true NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rule_basis_points_range" CHECK ("tax_rule"."basis_points" >= 0 and "tax_rule"."basis_points" <= 10000),
	CONSTRAINT "tax_rule_active_range" CHECK ("tax_rule"."active_to" is null or "tax_rule"."active_to" > "tax_rule"."active_from")
);
--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "net_revenue_minor" bigint;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "vat_minor" bigint;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "turnover_tax_minor" bigint;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "payment_commission_minor" bigint;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "payroll_tax_minor" bigint;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "refund_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "payment_commission_basis_points_snapshot" integer;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "payment_fixed_fee_minor_snapshot" bigint;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "tax_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rule" ADD CONSTRAINT "tax_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rule" ADD CONSTRAINT "tax_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rule" ADD CONSTRAINT "tax_rule_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_method_org_idx" ON "payment_method" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_default_idx" ON "payment_method" USING btree ("organization_id") WHERE "payment_method"."is_default" and "payment_method"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "tax_rule_lookup_idx" ON "tax_rule" USING btree ("organization_id","kind","active_from");--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_payment_method_id_payment_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_refund_within_charged" CHECK ("visit_line"."refund_minor" >= 0 and "visit_line"."refund_minor" <= "visit_line"."price_minor" - "visit_line"."discount_minor");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
-- `scripts/verify-rls.sql` fails the build if this block is forgotten.
ALTER TABLE "payment_method" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_method" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payment_method_tenant_isolation" ON "payment_method"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "tax_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tax_rule_tenant_isolation" ON "tax_rule"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated instead of inherited — carried from the start
-- this time rather than repaired afterwards, as `drizzle/0028` had to be.
--
-- `MIGRATION_DATABASE_URL` may be Supabase's `postgres` superuser rather than
-- the schema owner. A table created under it inherits Supabase's default
-- privileges: `anon`, `authenticated` and `service_role` get everything, and
-- `anon` is what PostgREST hands an unauthenticated caller. The same slip
-- leaves the application role with no grant at all.
--
-- Every statement is idempotent and guarded on the role existing, so a plain
-- PostgreSQL box without Supabase's roles runs it as a no-op.
DO $grants$
DECLARE
  api_role text;
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['payment_method', 'tax_rule'] LOOP
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

  -- The enums the two tables are typed by, for the same reason.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    FOREACH target IN ARRAY ARRAY['payment_method_kind', 'tax_kind'] LOOP
      EXECUTE format('ALTER TYPE public.%I OWNER TO "nail_profit"', target);
    END LOOP;
  END IF;
END
$grants$;
