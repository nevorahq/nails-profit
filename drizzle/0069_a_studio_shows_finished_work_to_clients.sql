CREATE TABLE "gallery_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_photo_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gallery_photo" ADD CONSTRAINT "gallery_photo_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_photo" ADD CONSTRAINT "gallery_photo_visit_photo_id_visit_photo_id_fk" FOREIGN KEY ("visit_photo_id") REFERENCES "public"."visit_photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_photo" ADD CONSTRAINT "gallery_photo_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_photo" ADD CONSTRAINT "gallery_photo_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_photo_visit_photo_idx" ON "gallery_photo" USING btree ("visit_photo_id");--> statement-breakpoint
CREATE INDEX "gallery_photo_org_idx" ON "gallery_photo" USING btree ("organization_id","created_at");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited — see `drizzle/0066`: Supabase turns RLS on for new
-- tables in `public`, and a migration that stays silent leaves the application
-- locked out of a table its own tests say is fine.
ALTER TABLE "gallery_photo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gallery_photo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gallery_photo_tenant_isolation" ON "gallery_photo"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    ALTER TABLE "gallery_photo" OWNER TO "nail_profit";
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "gallery_photo" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "gallery_photo" TO "nail_profit_app";
  END IF;
END
$grants$;
