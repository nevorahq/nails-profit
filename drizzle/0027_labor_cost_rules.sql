CREATE TYPE "public"."labor_cost_basis" AS ENUM('fixed_monthly', 'percent_revenue');--> statement-breakpoint
CREATE TYPE "public"."labor_cost_recipient" AS ENUM('owner', 'specialist');--> statement-breakpoint
CREATE TABLE "labor_cost_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient" "labor_cost_recipient" NOT NULL,
	"specialist_id" uuid,
	"label" text,
	"basis" "labor_cost_basis" NOT NULL,
	"amount_minor" bigint,
	"basis_points" integer,
	"payroll_tax_basis_points" integer DEFAULT 0 NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labor_cost_rule_shape" CHECK (("labor_cost_rule"."basis" = 'fixed_monthly' and "labor_cost_rule"."amount_minor" is not null and "labor_cost_rule"."basis_points" is null)
        or ("labor_cost_rule"."basis" = 'percent_revenue' and "labor_cost_rule"."basis_points" is not null and "labor_cost_rule"."amount_minor" is null)),
	CONSTRAINT "labor_cost_rule_recipient" CHECK (("labor_cost_rule"."recipient" = 'specialist') = ("labor_cost_rule"."specialist_id" is not null)),
	CONSTRAINT "labor_cost_rule_non_negative" CHECK (("labor_cost_rule"."amount_minor" is null or "labor_cost_rule"."amount_minor" >= 0)
        and ("labor_cost_rule"."basis_points" is null or "labor_cost_rule"."basis_points" >= 0)
        and "labor_cost_rule"."payroll_tax_basis_points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "withdrawal_reserve_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "labor_cost_rule" ADD CONSTRAINT "labor_cost_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_rule" ADD CONSTRAINT "labor_cost_rule_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_rule" ADD CONSTRAINT "labor_cost_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_rule" ADD CONSTRAINT "labor_cost_rule_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "labor_cost_rule_lookup_idx" ON "labor_cost_rule" USING btree ("organization_id","recipient","active_from");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
-- `scripts/verify-rls.sql` fails the build if this block is forgotten.
ALTER TABLE "labor_cost_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "labor_cost_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "labor_cost_rule_tenant_isolation" ON "labor_cost_rule"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
