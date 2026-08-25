CREATE TYPE "public"."billing_provider" AS ENUM('paddle', 'lemon_squeezy');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'paused', 'canceled');--> statement-breakpoint
CREATE TABLE "billing_provider_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_price_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"manage_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_provider_event" ADD CONSTRAINT "billing_provider_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_event_provider_id_idx" ON "billing_provider_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_subscription_org_idx" ON "organization_subscription" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_subscription_provider_sub_idx" ON "organization_subscription" USING btree ("provider","provider_subscription_id");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
-- `scripts/verify-rls.sql` fails the build if this block is forgotten.
ALTER TABLE "billing_provider_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_provider_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_provider_event_tenant_isolation" ON "billing_provider_event"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "organization_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_subscription_tenant_isolation" ON "organization_subscription"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants stated rather than inherited, the pattern migration 0028
-- established (most recently repeated in 0038). Whether these tables end up
-- defended must not depend on which URL happened to be in the shell: run as
-- Supabase's `postgres` they would be created under that role's default
-- privileges, which grant `anon`, `authenticated` and `service_role`
-- everything, and leave `nail_profit_app` with no grant at all. It has already
-- happened twice in this repository — `expense` and `material_template`.
--
-- Idempotent and guarded on each role existing, so a plain PostgreSQL box
-- without Supabase's roles runs the whole block as a no-op.
DO $grants$
DECLARE
  api_role text;
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['billing_provider_event', 'organization_subscription'] LOOP
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