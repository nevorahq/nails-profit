CREATE TABLE "staff_notice_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"booking_id" uuid NOT NULL,
	"seen_through" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_notice_read" ADD CONSTRAINT "staff_notice_read_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notice_read" ADD CONSTRAINT "staff_notice_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notice_read" ADD CONSTRAINT "staff_notice_read_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_notice_read_reader_idx" ON "staff_notice_read" USING btree ("organization_id","user_id","booking_id");

-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited: Supabase turns RLS on for new tables in `public`, and a
-- migration that stays silent leaves the application locked out of a table its
-- own tests — on a plain PostgreSQL box, where RLS defaults off — say is fine.
ALTER TABLE "staff_notice_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_notice_read" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "staff_notice_read_tenant_isolation" ON "staff_notice_read"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "staff_notice_read" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "staff_notice_read" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "staff_notice_read" TO "nail_profit_app"';
  END IF;
END
$grants$;
