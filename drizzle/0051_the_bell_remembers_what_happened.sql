CREATE TYPE "public"."staff_notice_kind" AS ENUM('client_booked', 'client_rescheduled', 'client_cancelled', 'client_released', 'staff_rescheduled', 'staff_cancelled');--> statement-breakpoint
CREATE TABLE "staff_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "staff_notice_kind" NOT NULL,
	"specialist_id" uuid NOT NULL,
	"actor_user_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "notices_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_notice_org_created_idx" ON "staff_notice" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "staff_notice_specialist_idx" ON "staff_notice" USING btree ("specialist_id","created_at");--> statement-breakpoint
CREATE INDEX "staff_notice_booking_idx" ON "staff_notice" USING btree ("booking_id");

-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited: Supabase turns RLS on for new tables in `public`, and a
-- migration that stays silent leaves the application locked out of a table its
-- own tests — on a plain PostgreSQL box, where RLS defaults off — say is fine.
ALTER TABLE "staff_notice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_notice" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "staff_notice_tenant_isolation" ON "staff_notice"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "staff_notice" OWNER TO "nail_profit"';
    EXECUTE 'ALTER TYPE "staff_notice_kind" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "staff_notice" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "staff_notice" TO "nail_profit_app"';
  END IF;
END
$grants$;
