ALTER TYPE "public"."notification_channel" ADD VALUE IF NOT EXISTS 'push';--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booking_settings" ALTER COLUMN "confirmation_ttl_minutes" SET DEFAULT 720;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "staff_reminded_version" integer;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscription_endpoint_idx" ON "push_subscription" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscription_user_idx" ON "push_subscription" USING btree ("organization_id","user_id");
-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited: Supabase turns RLS on for new tables in `public`, and a
-- migration that stays silent leaves the application locked out of a table its
-- own tests — on a plain PostgreSQL box, where RLS defaults off — say is fine.
ALTER TABLE "push_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "push_subscription_tenant_isolation" ON "push_subscription"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "push_subscription" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "push_subscription" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "push_subscription" TO "nail_profit_app"';
  END IF;
END
$grants$;
