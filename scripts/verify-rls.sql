-- Tenant isolation checks. Run as the application role (DATABASE_URL), never as
-- the migration owner: FORCE ROW LEVEL SECURITY applies to the owner too, but
-- running as the app role is what the application actually does.
--
-- Drizzle does not generate RLS, so every new tenant-owned table needs its
-- policy written by hand. The structural check below is what catches the table
-- where someone forgot.

BEGIN;

-- 1. Structural: every table carrying organization_id must be protected.
--
-- `membership` is the one deliberate exception. It answers "which organization
-- does this user belong to", which is the question asked *before* any tenant
-- context exists — putting it behind the org-scoped policy would make the
-- lookup return nothing and lock everyone out. It is filtered by user_id on
-- every read instead. Keep this list at one entry; anything else added here
-- should be a policy instead of an exemption.
DO $structure$
DECLARE
  offenders text;
  exempt CONSTANT text[] := ARRAY['membership'];
BEGIN
  SELECT string_agg(c.relname || ' (' ||
           CASE WHEN NOT c.relrowsecurity THEN 'RLS disabled'
                WHEN NOT c.relforcerowsecurity THEN 'RLS not forced'
                ELSE 'no policy' END || ')', ', ' ORDER BY c.relname)
    INTO offenders
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND NOT (c.relname = ANY (exempt))
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant tables without working RLS: %', offenders;
  END IF;
END
$structure$;

-- 1b. Structural: no application table may be reachable by Supabase's own API
-- roles.
--
-- RLS is not the only way to lose a table. A migration run as `postgres`
-- instead of the migration role creates the table under Supabase's default
-- privileges, which grant `anon`, `authenticated` and `service_role` full
-- access — and `anon` is what PostgREST hands an unauthenticated caller of the
-- project's REST endpoint. The table still has its tenant policy, still passes
-- the check above, and is still exposed to a role the application never uses.
--
-- The same mistake also leaves the table owned by `postgres`, so the app role
-- gets no grant at all and every query fails with "permission denied" — loud,
-- unlike the exposure, which is silent. Both are caught here.
--
-- On a plain PostgreSQL box these roles do not exist and the query is empty,
-- which is the correct answer there.
--
-- Read from `pg_class.relacl`, not `information_schema.role_table_grants`: that
-- view shows a row only when the current role is the grantor or the grantee, so
-- run as the application role — which is how this script must run — it reports
-- an empty set no matter who else was granted what. The catalogue is visible to
-- everyone and states the whole ACL.
DO $api_roles$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT c.relname || ' (' || pg_get_userbyid(a.grantee) || ')', ', ')
    INTO offenders
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Tables granted to Supabase API roles: %', offenders;
  END IF;
END
$api_roles$;

-- 1c. Structural: the application must be able to read every table it owns the
-- use of.
--
-- The other half of the mistake above, and the half that was actually shipped:
-- a table created by `postgres` rather than by `nail_profit` never receives the
-- default privileges granted to the application role, so the application gets
-- nothing at all. The check above passed — the table was exposed to `anon`,
-- which it caught only after the fact — while every render of the page that
-- read it died with "permission denied".
--
-- Checked against `current_user` because this script must run as the
-- application role, so the question it asks is exactly the question the
-- application asks: can I read this table?
DO $app_grants$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offenders
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND NOT has_table_privilege(current_user, c.oid, 'SELECT');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables the application role cannot read: %. A migration run as the wrong role creates tables the default privileges never reach.',
      offenders;
  END IF;
END
$app_grants$;

-- 1d. Structural: row-level security without a policy is a table nobody can
-- use.
--
-- The checks above ask whether tenant tables are protected. This one asks the
-- opposite question, and it exists because nobody was asking it: `rate_limit_window`
-- carries no `organization_id`, so 1a skipped it, the grants were right so 1c
-- passed, and the table still refused every write the application made. RLS had
-- been switched on by the platform — Supabase does that for new tables in
-- `public` — and a migration that never mentioned RLS created no policy to go
-- with it. Enabled with no policy means denied to everyone who is not the owner.
--
-- Locally the same migration produced a table with RLS off, so the suites were
-- green against a table configured differently from the one in production. That
-- is the failure this catches: not a missing policy in the abstract, but a
-- migration that leaves the answer to the environment.
DO $rls_without_policy$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offenders
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables with row-level security and no policy: %. Enabled without a policy denies every role but the owner.',
      offenders;
  END IF;
END
$rls_without_policy$;

-- 2. Behavioural: rows must not cross organizations.
INSERT INTO organization (id, name, type)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'RLS test A', 'solo'),
  ('00000000-0000-4000-8000-000000000002', 'RLS test B', 'studio');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);
INSERT INTO service (id, organization_id, name)
VALUES ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', '{"ru":"Видимая услуга"}'::jsonb);

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000002', true);
INSERT INTO service (id, organization_id, name)
VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000002', '{"ru":"Скрытая услуга"}'::jsonb);

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);

DO $verify$
DECLARE
  visible_count integer;
  cross_tenant_updates integer;
  leaked integer;
BEGIN
  SELECT count(*) INTO visible_count FROM service;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS failed: expected 1 visible service, got %', visible_count;
  END IF;

  UPDATE service SET name = '{"ru":"не должно обновиться"}'::jsonb
  WHERE id = '00000000-0000-4000-8000-000000000022';
  GET DIAGNOSTICS cross_tenant_updates = ROW_COUNT;
  IF cross_tenant_updates <> 0 THEN
    RAISE EXCEPTION 'RLS failed: cross-tenant update affected % rows', cross_tenant_updates;
  END IF;

  -- Writing another tenant's id must be refused outright, not silently dropped.
  BEGIN
    INSERT INTO service (organization_id, name)
    VALUES ('00000000-0000-4000-8000-000000000002', '{"ru":"Контрабанда"}'::jsonb);
    RAISE EXCEPTION 'RLS failed: insert into another organization succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- 3. Fail closed: with no tenant context set, nothing is visible at all.
  PERFORM set_config('app.current_organization_id', '', true);
  SELECT count(*) INTO leaked FROM service;
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'RLS failed: % rows visible without a tenant context', leaked;
  END IF;
END
$verify$;

ROLLBACK;

SELECT 'tenant isolation verified' AS result;
