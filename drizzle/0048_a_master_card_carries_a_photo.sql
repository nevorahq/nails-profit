-- A master's card carries a photo.
--
-- The calendar's day columns and the visits list have been drawing a face for
-- some time, reading `user.image` through the account a specialist card is
-- linked to. Nothing has ever written that column: sign-in is email and
-- password only, there are no social providers to bring a picture along, so
-- every avatar in the application has been a letter on a circle.
--
-- The photo lands on the card instead of on the account, and in a table of its
-- own instead of a column on `specialist`.
--
-- On the card, because a studio records masters who never sign in — those rows
-- have a null `user_id`, and a face hung off the account would have skipped
-- exactly them. It also makes the picture the owner's to set, which is what the
-- screen that manages these cards is already for.
--
-- In its own table, because `specialist` is read with a bare `select()` both by
-- the screen that lists people and by the organization's JSON export. Half a
-- megabyte per row would have travelled through both.
--
-- The bytes go in Postgres because there is no object store in this deployment
-- and adding one is a bucket, a policy and a second secret to rotate. Twenty
-- masters at the size a re-encoded square actually takes is under a megabyte;
-- the size constraint is what keeps that sentence true.

CREATE TABLE "specialist_avatar" (
	"specialist_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_avatar_mime" CHECK ("specialist_avatar"."mime_type" in ('image/webp', 'image/jpeg', 'image/png')),
	CONSTRAINT "specialist_avatar_size" CHECK (octet_length("specialist_avatar"."bytes") between 1 and 524288)
);
--> statement-breakpoint
ALTER TABLE "specialist_avatar" ADD CONSTRAINT "specialist_avatar_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_avatar" ADD CONSTRAINT "specialist_avatar_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_avatar" ADD CONSTRAINT "specialist_avatar_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_avatar" ADD CONSTRAINT "specialist_avatar_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_avatar_org_idx" ON "specialist_avatar" USING btree ("organization_id");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
ALTER TABLE "specialist_avatar" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_avatar" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "specialist_avatar_tenant_isolation" ON "specialist_avatar"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "specialist_avatar" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "specialist_avatar" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "specialist_avatar" TO "nail_profit_app"';
  END IF;
END
$grants$;
