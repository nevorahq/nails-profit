CREATE TYPE "public"."pilot_decision_type" AS ENUM('price', 'service_composition', 'material_consumption');--> statement-breakpoint
CREATE TYPE "public"."pilot_enrollment_status" AS ENUM('pending', 'active', 'paused', 'completed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."pilot_interaction_kind" AS ENUM('onboarding', 'interview', 'profit_review', 'support', 'decision');--> statement-breakpoint
CREATE TYPE "public"."pilot_issue_category" AS ENUM('financial', 'technical', 'privacy', 'support');--> statement-breakpoint
CREATE TYPE "public"."pilot_issue_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."pilot_wave" AS ENUM('demo', 'design_partner', 'first_paid', 'extended');--> statement-breakpoint
CREATE TABLE "pilot_enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wave" "pilot_wave" NOT NULL,
	"status" "pilot_enrollment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"monthly_price_minor" bigint,
	"billing_currency" "currency",
	"renewed_second_month" boolean,
	"renewal_recorded_at" timestamp with time zone,
	"operator_ref" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_enrollment_payment_shape" CHECK (("pilot_enrollment"."monthly_price_minor" is null and "pilot_enrollment"."billing_currency" is null)
        or ("pilot_enrollment"."monthly_price_minor" >= 0 and "pilot_enrollment"."billing_currency" is not null and "pilot_enrollment"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "pilot_interaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "pilot_interaction_kind" NOT NULL,
	"duration_minutes" integer,
	"decision_type" "pilot_decision_type",
	"recorded_by" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_interaction_shape" CHECK (("pilot_interaction"."duration_minutes" is null or "pilot_interaction"."duration_minutes" > 0)
        and (("pilot_interaction"."kind" = 'decision' and "pilot_interaction"."decision_type" is not null)
          or ("pilot_interaction"."kind" <> 'decision' and "pilot_interaction"."decision_type" is null)))
);
--> statement-breakpoint
CREATE TABLE "pilot_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issue_code" text NOT NULL,
	"category" "pilot_issue_category" NOT NULL,
	"severity" integer NOT NULL,
	"status" "pilot_issue_status" DEFAULT 'open' NOT NULL,
	"recorded_by" text NOT NULL,
	"resolved_by" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_issue_severity" CHECK ("pilot_issue"."severity" between 1 and 3),
	CONSTRAINT "pilot_issue_resolution_shape" CHECK (("pilot_issue"."status" = 'open' and "pilot_issue"."resolved_at" is null and "pilot_issue"."resolved_by" is null)
        or ("pilot_issue"."status" = 'resolved' and "pilot_issue"."resolved_at" is not null and "pilot_issue"."resolved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "pilot_product_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"actor_user_id" text,
	"actor_role" "member_role",
	"source" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_product_event_version_positive" CHECK ("pilot_product_event"."event_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "pilot_enrollment" ADD CONSTRAINT "pilot_enrollment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_interaction" ADD CONSTRAINT "pilot_interaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_issue" ADD CONSTRAINT "pilot_issue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_product_event" ADD CONSTRAINT "pilot_product_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_product_event" ADD CONSTRAINT "pilot_product_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pilot_enrollment_org_idx" ON "pilot_enrollment" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pilot_interaction_org_time_idx" ON "pilot_interaction" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pilot_issue_org_code_idx" ON "pilot_issue" USING btree ("organization_id","issue_code");--> statement-breakpoint
CREATE INDEX "pilot_issue_org_status_idx" ON "pilot_issue" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pilot_product_event_dedupe_idx" ON "pilot_product_event" USING btree ("organization_id","event_name","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "pilot_product_event_org_time_idx" ON "pilot_product_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
ALTER TABLE "pilot_enrollment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_enrollment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pilot_enrollment_tenant_isolation" ON "pilot_enrollment"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pilot_product_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_product_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pilot_product_event_tenant_isolation" ON "pilot_product_event"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pilot_interaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_interaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pilot_interaction_tenant_isolation" ON "pilot_interaction"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pilot_issue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_issue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pilot_issue_tenant_isolation" ON "pilot_issue"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
