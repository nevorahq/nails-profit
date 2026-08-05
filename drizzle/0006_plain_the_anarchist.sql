CREATE TYPE "public"."visit_status" AS ENUM('completed', 'adjusted');--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_phone" text,
	"email" text,
	"locale" "locale",
	"anonymized_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"material_name_snapshot" text NOT NULL,
	"base_unit_snapshot" "material_unit" NOT NULL,
	"normative_quantity_milli_units" bigint NOT NULL,
	"actual_quantity_milli_units" bigint,
	"package_price_minor_snapshot" bigint,
	"package_size_milli_units_snapshot" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumption_normative_non_negative" CHECK ("consumption"."normative_quantity_milli_units" >= 0),
	CONSTRAINT "consumption_actual_non_negative" CHECK ("consumption"."actual_quantity_milli_units" is null or "consumption"."actual_quantity_milli_units" >= 0),
	CONSTRAINT "consumption_package_size_positive" CHECK ("consumption"."package_size_milli_units_snapshot" is null or "consumption"."package_size_milli_units_snapshot" > 0)
);
--> statement-breakpoint
CREATE TABLE "financial_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"snapshot_version" integer NOT NULL,
	"formula_version" text NOT NULL,
	"currency" "currency" NOT NULL,
	"revenue_minor" bigint NOT NULL,
	"material_cost_minor" bigint,
	"normative_material_cost_minor" bigint,
	"commission_minor" bigint,
	"contribution_margin_minor" bigint,
	"margin_basis_points" integer,
	"profit_per_hour_minor" bigint,
	"duration_minutes" integer,
	"estimated_duration" boolean DEFAULT false NOT NULL,
	"incomplete_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "financial_snapshot_version_positive" CHECK ("financial_snapshot"."snapshot_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "visit_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"service_id" uuid,
	"add_on_id" uuid,
	"name_snapshot" jsonb NOT NULL,
	"price_minor" bigint NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_line_price_non_negative" CHECK ("visit_line"."price_minor" >= 0),
	CONSTRAINT "visit_line_discount_within_price" CHECK ("visit_line"."discount_minor" >= 0 and "visit_line"."discount_minor" <= "visit_line"."price_minor")
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"specialist_id" uuid NOT NULL,
	"service_id" uuid,
	"completed_at" timestamp with time zone NOT NULL,
	"planned_duration_minutes" integer NOT NULL,
	"actual_duration_minutes" integer,
	"status" "visit_status" DEFAULT 'completed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_planned_duration_positive" CHECK ("visit"."planned_duration_minutes" > 0),
	CONSTRAINT "visit_actual_duration_positive" CHECK ("visit"."actual_duration_minutes" is null or "visit"."actual_duration_minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption" ADD CONSTRAINT "consumption_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption" ADD CONSTRAINT "consumption_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption" ADD CONSTRAINT "consumption_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption" ADD CONSTRAINT "consumption_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption" ADD CONSTRAINT "consumption_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD CONSTRAINT "financial_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD CONSTRAINT "financial_snapshot_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD CONSTRAINT "financial_snapshot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_add_on_id_add_on_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_on"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_org_idx" ON "client" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_phone_idx" ON "client" USING btree ("organization_id","normalized_phone") WHERE "client"."normalized_phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_email_idx" ON "client" USING btree ("organization_id",lower("email")) WHERE "client"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "consumption_visit_material_idx" ON "consumption" USING btree ("visit_id","material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_snapshot_visit_version_idx" ON "financial_snapshot" USING btree ("visit_id","snapshot_version");--> statement-breakpoint
CREATE INDEX "financial_snapshot_org_idx" ON "financial_snapshot" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "visit_line_visit_idx" ON "visit_line" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_org_completed_idx" ON "visit" USING btree ("organization_id","completed_at");--> statement-breakpoint
CREATE INDEX "visit_specialist_idx" ON "visit" USING btree ("specialist_id","completed_at");
--> statement-breakpoint
-- RLS is hand-written: Drizzle does not generate it. verify-rls.sql fails the
-- build if a tenant table ever reaches production without this block.
--> statement-breakpoint
ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "client_tenant_isolation" ON "client"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "visit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "visit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "visit_tenant_isolation" ON "visit"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "visit_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "visit_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "visit_line_tenant_isolation" ON "visit_line"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "consumption" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "consumption" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "consumption_tenant_isolation" ON "consumption"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "financial_snapshot" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "financial_snapshot" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "financial_snapshot_tenant_isolation" ON "financial_snapshot"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
-- Section 11.2 and 8.8.1: a financial snapshot is append-only. Enforced in the
-- database rather than by convention, because an UPDATE here would silently
-- rewrite a past month's profit and nothing downstream would notice.
CREATE OR REPLACE FUNCTION financial_snapshot_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'financial_snapshot is append-only: write a new version instead of %', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER financial_snapshot_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "financial_snapshot"
  FOR EACH ROW EXECUTE FUNCTION financial_snapshot_is_append_only();
