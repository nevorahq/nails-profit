-- A studio puts its own mark in the topbar.
--
-- The flower beside the studio's name is `BrandMark`, drawn in
-- `components/icons.tsx` and identical in every salon in the deployment. It is
-- the product's mark standing in for the studio's, and this table is how a
-- studio replaces it with its own. No row means the flower, which is what keeps
-- uploading optional and makes removing a logo a finished action rather than a
-- blank square.
--
-- A table rather than a column on `organization`, because `organization` is read
-- with a bare `select()` in `requireWorkspace`, in the app layout, in the JSON
-- export and in a dozen endpoints besides. A column would have carried the
-- picture through all of them to be drawn by one.
--
-- The bytes go in Postgres for the reason migration 0048 gives for a master's
-- face: there is no object store in this deployment, and one square per studio
-- at the size the browser re-encodes to is nothing beside the visits table. The
-- size constraint is what keeps that sentence true.

CREATE TABLE "organization_logo" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logo_mime" CHECK ("organization_logo"."mime_type" in ('image/webp', 'image/jpeg', 'image/png')),
	CONSTRAINT "organization_logo_size" CHECK (octet_length("organization_logo"."bytes") between 1 and 524288)
);
--> statement-breakpoint
ALTER TABLE "organization_logo" ADD CONSTRAINT "organization_logo_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logo" ADD CONSTRAINT "organization_logo_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logo" ADD CONSTRAINT "organization_logo_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies. The
-- primary key is also the tenant column here, so `scripts/verify-rls.sql` finds
-- this table by the same `organization_id` it finds every other one by — and
-- would have failed the build if this block were missing.
ALTER TABLE "organization_logo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_logo" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_logo_tenant_isolation" ON "organization_logo"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "organization_logo" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "organization_logo" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization_logo" TO "nail_profit_app"';
  END IF;
END
$grants$;
