-- `material_template` was created by the wrong role, and the grants followed.
--
-- `supabase-init.sql` makes the application role reachable by every table the
-- migration role creates, through `ALTER DEFAULT PRIVILEGES` set while acting
-- as `nail_profit`. Default privileges are recorded per creating role, so they
-- only apply to tables `nail_profit` actually creates. On a deployment whose
-- MIGRATION_DATABASE_URL connects as Supabase's own `postgres` — which is the
-- state this project has been in — migration 0034 created the table as
-- `postgres` instead, and it inherited two things it should never have had:
--
--   * no privileges at all for `nail_profit_app`, so the application could not
--     read the catalogue and every material page raised "permission denied";
--   * the full Supabase grant set for `anon` and `authenticated`, which is the
--     PostgREST surface `supabase-init.sql` explicitly checks stays empty.
--
-- The REVOKE in 0034 removed nothing, because there was nothing granted to
-- `nail_profit_app` to remove. It read as protection and was not.
--
-- Fixed here rather than by hand in the SQL editor, so that a fresh deployment
-- of this repository ends up in the same state as this one. Every statement is
-- idempotent and safe on a database where the table was already created
-- correctly — which is what the local test database looks like.

-- Ownership first: everything else follows from it, and it is what makes the
-- default privileges apply to any future ALTER of this table.
DO $owner$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit')
     AND (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.material_template'::regclass) <> 'nail_profit'
  THEN
    EXECUTE 'ALTER TABLE "material_template" OWNER TO nail_profit';
  END IF;
END
$owner$;--> statement-breakpoint

-- Close the PostgREST surface. Guarded because `anon` and `authenticated` are
-- Supabase's roles and do not exist on a plain PostgreSQL box, which is what
-- development and the test suite run against.
DO $postgrest$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "material_template" FROM anon';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "material_template" FROM authenticated';
  END IF;
END
$postgrest$;--> statement-breakpoint

REVOKE ALL ON "material_template" FROM PUBLIC;--> statement-breakpoint

-- And the grant the application actually needs, stated outright rather than
-- inherited from a default privilege that may or may not have been in force.
-- Read only: the catalogue is product data, seeded by the migration role, and
-- E3.1 §3.4 requires that no tenant can write it.
GRANT SELECT ON "material_template" TO nail_profit_app;
