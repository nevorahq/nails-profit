CREATE TABLE "storage_deletion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_photo_mime" CHECK ("visit_photo"."mime_type" in ('image/webp', 'image/jpeg', 'image/png')),
	CONSTRAINT "visit_photo_size" CHECK ("visit_photo"."size_bytes" between 1 and 524288),
	CONSTRAINT "visit_photo_dimensions" CHECK ("visit_photo"."width" > 0 and "visit_photo"."height" > 0)
);
--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photo" ADD CONSTRAINT "visit_photo_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_deletion_org_idx" ON "storage_deletion" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "visit_photo_visit_idx" ON "visit_photo" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_photo_org_idx" ON "visit_photo" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_photo_path_idx" ON "visit_photo" USING btree ("storage_path");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited: Supabase turns RLS on for new tables in `public`, and a
-- migration that stays silent leaves the application locked out of a table its
-- own tests — on a plain PostgreSQL box, where RLS defaults off — say is fine.
ALTER TABLE "visit_photo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visit_photo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "visit_photo_tenant_isolation" ON "visit_photo"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "storage_deletion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_deletion" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_deletion_tenant_isolation" ON "storage_deletion"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['visit_photo', 'storage_deletion'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
      EXECUTE format('ALTER TABLE %I OWNER TO "nail_profit"', tenant_table);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', tenant_table, api_role);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO "nail_profit_app"', tenant_table);
    END IF;
  END LOOP;
END
$grants$;
