CREATE TYPE "public"."availability_exception_kind" AS ENUM('available', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."booking_confirmation_mode" AS ENUM('instant', 'manual');--> statement-breakpoint
CREATE TYPE "public"."booking_public_status" AS ENUM('draft', 'published', 'paused');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workplace_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "availability_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" "availability_exception_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_exception_interval" CHECK ("availability_exception"."ends_at" > "availability_exception"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "booking_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"public_status" "booking_public_status" DEFAULT 'draft' NOT NULL,
	"slot_step_minutes" integer DEFAULT 15 NOT NULL,
	"min_lead_minutes" integer DEFAULT 120 NOT NULL,
	"max_advance_days" integer DEFAULT 60 NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 10 NOT NULL,
	"confirmation_mode" "booking_confirmation_mode" DEFAULT 'instant' NOT NULL,
	"confirmation_ttl_minutes" integer DEFAULT 120 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_settings_step" CHECK ("booking_settings"."slot_step_minutes" in (5, 10, 15, 20, 30, 60)),
	CONSTRAINT "booking_settings_lead" CHECK ("booking_settings"."min_lead_minutes" between 0 and 43200),
	CONSTRAINT "booking_settings_advance" CHECK ("booking_settings"."max_advance_days" between 1 and 365),
	CONSTRAINT "booking_settings_buffers" CHECK ("booking_settings"."buffer_before_minutes" between 0 and 240 and "booking_settings"."buffer_after_minutes" between 0 and 240),
	CONSTRAINT "booking_settings_ttl" CHECK ("booking_settings"."confirmation_ttl_minutes" between 15 and 1440)
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text NOT NULL,
	"status" "location_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_rule_weekday" CHECK ("schedule_rule"."weekday" between 1 and 7),
	CONSTRAINT "schedule_rule_interval" CHECK ("schedule_rule"."start_minute" >= 0 and "schedule_rule"."end_minute" <= 1440 and "schedule_rule"."start_minute" < "schedule_rule"."end_minute"),
	CONSTRAINT "schedule_rule_effective_range" CHECK ("schedule_rule"."effective_to" is null or "schedule_rule"."effective_to" > "schedule_rule"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "specialist_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"duration_override_minutes" integer,
	"requires_workplace" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_service_duration_positive" CHECK ("specialist_service"."duration_override_minutes" is null or "specialist_service"."duration_override_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "workplace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "workplace_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exception" ADD CONSTRAINT "availability_exception_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_location" ADD CONSTRAINT "specialist_location_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_location" ADD CONSTRAINT "specialist_location_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_location" ADD CONSTRAINT "specialist_location_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_location" ADD CONSTRAINT "specialist_location_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_location" ADD CONSTRAINT "specialist_location_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_service" ADD CONSTRAINT "specialist_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_service" ADD CONSTRAINT "specialist_service_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_service" ADD CONSTRAINT "specialist_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_service" ADD CONSTRAINT "specialist_service_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_service" ADD CONSTRAINT "specialist_service_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace" ADD CONSTRAINT "workplace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace" ADD CONSTRAINT "workplace_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace" ADD CONSTRAINT "workplace_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace" ADD CONSTRAINT "workplace_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_exception_specialist_idx" ON "availability_exception" USING btree ("specialist_id","starts_at");--> statement-breakpoint
CREATE INDEX "availability_exception_org_idx" ON "availability_exception" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_settings_location_idx" ON "booking_settings" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_org_slug_idx" ON "location" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "location_org_idx" ON "location" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "schedule_rule_specialist_idx" ON "schedule_rule" USING btree ("specialist_id","weekday");--> statement-breakpoint
CREATE INDEX "schedule_rule_location_idx" ON "schedule_rule" USING btree ("location_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_location_pair_idx" ON "specialist_location" USING btree ("specialist_id","location_id");--> statement-breakpoint
CREATE INDEX "specialist_location_location_idx" ON "specialist_location" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_service_pair_idx" ON "specialist_service" USING btree ("specialist_id","service_id");--> statement-breakpoint
CREATE INDEX "specialist_service_service_idx" ON "specialist_service" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "workplace_location_idx" ON "workplace" USING btree ("location_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_location_name_idx" ON "workplace" USING btree ("location_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_idx" ON "organization" USING btree ("slug");

--> statement-breakpoint
-- Tenant isolation for the Phase 7.1 tables. Drizzle does not generate RLS, so
-- every tenant-owned table gets its policy written here; scripts/verify-rls.sql
-- fails the build if one is ever forgotten.
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "location_tenant_isolation" ON "location"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "workplace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workplace" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workplace_tenant_isolation" ON "workplace"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "specialist_location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_location" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "specialist_location_tenant_isolation" ON "specialist_location"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "specialist_service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_service" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "specialist_service_tenant_isolation" ON "specialist_service"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "booking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_settings_tenant_isolation" ON "booking_settings"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "schedule_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "schedule_rule_tenant_isolation" ON "schedule_rule"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "availability_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "availability_exception" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "availability_exception_tenant_isolation" ON "availability_exception"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
