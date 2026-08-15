-- Ownership and grants for `labor_cost_rule`, stated instead of inherited.
--
-- Hand-written: there is no schema change here for Drizzle to generate. The
-- previous migration created the table, and *who ran it* decided what the table
-- was worth defending. Run as the migration owner it inherits the right owner
-- and the right grants; run as Supabase's `postgres` superuser it is created
-- under that role's default privileges, which grant `anon`, `authenticated` and
-- `service_role` everything — and `anon` is what PostgREST hands an
-- unauthenticated caller of the project's REST endpoint. The tenant policy is
-- still in place and still correct, and the table is still reachable by a role
-- the application never uses.
--
-- The same slip leaves the table owned by `postgres`, so `nail_profit_app` gets
-- no grant at all and every query fails with "permission denied" — loud, unlike
-- the exposure, which is silent.
--
-- `scripts/verify-rls.sql` catches both and fails the build. This migration is
-- what it takes to make the answer not depend on which URL was in the shell.
--
-- Every statement is idempotent and guarded on the role existing, so a plain
-- PostgreSQL box without Supabase's roles runs it as a no-op.

DO $grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
    EXECUTE 'ALTER TABLE "labor_cost_rule" OWNER TO "nail_profit"';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "labor_cost_rule" FROM %I', api_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "labor_cost_rule" TO "nail_profit_app"';
  END IF;
END
$grants$;
