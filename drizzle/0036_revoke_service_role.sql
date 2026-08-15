-- The third Supabase API role, which 0035 missed.
--
-- 0035 revoked `material_template` from `anon` and `authenticated` and stopped
-- there. `service_role` is the third grantee Supabase attaches to a table
-- created by `postgres`, and `scripts/verify-rls.sql` checks all three — so the
-- table stayed reachable through the project's service key until this.
--
-- Worth being precise about why it matters, since `service_role` is not
-- anonymous: it is the role behind Supabase's own admin API surface, and it
-- bypasses RLS. Any code path that reaches the database with the service key
-- reads this table without the tenant policy applying. The catalogue itself is
-- product data and not a secret, but the rule this project enforces is that the
-- application role is the only way into `public` — an exception granted by
-- accident is the kind that later gets relied on.
--
-- Written as its own migration rather than as an edit to 0035, because 0035 has
-- already been applied: a migration that has run is history, and editing one to
-- make it look correct is how a file stops describing what actually happened.
--
-- Guarded and idempotent, like 0035: these roles do not exist on a plain
-- PostgreSQL box, which is what development and the test suite run against.
DO $service_role$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON "material_template" FROM service_role';
  END IF;
END
$service_role$;
