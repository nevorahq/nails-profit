-- Restores tenant isolation on a database that has the tables but not the
-- policies. Run as the migration role, which owns them; `verify-rls.sql` next
-- to this file checks the result as the application role, which is the role
-- that matters.
--
-- Not a new rule — the one already in `drizzle/`, replayed where it never
-- landed. Production was found on 09.09.2026 with ROW LEVEL SECURITY disabled
-- on all forty-two tables carrying `organization_id`. Nothing in the product
-- filters by `organization_id` in a `WHERE` clause: `db/tenant.ts` sets
-- `app.current_organization_id` and the policies do the filtering, so with them
-- absent every organization read every other organization's rows. It surfaced
-- as two studios' addresses on one owner's booking screen.
--
-- `0045_rate_limit_window_rls.sql` is both the precedent and the explanation:
-- environments disagree about the RLS default, and a schema pushed rather than
-- migrated arrives with the tables and without the raw SQL that follows them.
--
-- The list is derived rather than written out, and derived by the same rule
-- `verify-rls.sql` checks: every table in `public` with an `organization_id`.
-- A hand-kept list is a list that goes stale on the next table, which is the
-- failure this is repairing. `membership` is the one exclusion, for the reason
-- stated there — it answers "which organization does this user belong to",
-- asked before any tenant context exists.
--
-- Writing one policy for all of them is safe because they are one policy: all
-- forty-two are defined in `drizzle/` with an identical body and the name
-- `<table>_tenant_isolation`. The tables whose policy differs — the identity
-- tables, `material_template`, `rate_limit_window` — carry no
-- `organization_id` and so are never reached by the loop.
--
-- Idempotent, so it may be run against a database that is already correct:
-- ENABLE and FORCE are no-ops when already set, and each policy is dropped by
-- name before being written.

DO $rls$
DECLARE
  target text;
  scoped CONSTANT text :=
    '"organization_id" = nullif(current_setting(''app.current_organization_id'', true), '''')::uuid';
  repaired int := 0;
BEGIN
  FOR target IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
     WHERE c.relkind = 'r'
       AND c.relname <> 'membership'
     ORDER BY c.relname
  LOOP
    -- FORCE as well as ENABLE: without it the owner is exempt, and the owner is
    -- the role that runs the migrations and the maintenance scripts.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_tenant_isolation', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
      target || '_tenant_isolation', target, scoped, scoped
    );
    repaired := repaired + 1;
  END LOOP;

  RAISE NOTICE 'tenant policies written: %', repaired;
END
$rls$;
