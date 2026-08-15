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
-- `material_template` was created by `postgres` in migration 0034, so the
-- default privileges granted while acting as `nail_profit` never applied and
-- the application got nothing at all. The check above passed — the table was
-- exposed to `anon`, which it caught only after the fact — while every render
-- of /app/materials died with "permission denied for table material_template".
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

-- 2. Behavioural: rows must not cross organizations.
INSERT INTO organization (id, name, type)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'RLS test A', 'solo'),
  ('00000000-0000-4000-8000-000000000002', 'RLS test B', 'studio');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);
INSERT INTO material (id, organization_id, name, base_unit)
VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Visible material', 'ml');
INSERT INTO service (id, organization_id, name)
VALUES ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', '{"ru":"Видимая услуга"}'::jsonb);

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000002', true);
INSERT INTO material (id, organization_id, name, base_unit)
VALUES ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'Hidden material', 'g');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);

DO $verify$
DECLARE
  visible_count integer;
  cross_tenant_updates integer;
  leaked integer;
BEGIN
  SELECT count(*) INTO visible_count FROM material;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS failed: expected 1 visible material, got %', visible_count;
  END IF;

  SELECT count(*) INTO visible_count FROM service;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS failed: expected 1 visible service, got %', visible_count;
  END IF;

  UPDATE material SET name = 'must not update'
  WHERE id = '00000000-0000-4000-8000-000000000012';
  GET DIAGNOSTICS cross_tenant_updates = ROW_COUNT;
  IF cross_tenant_updates <> 0 THEN
    RAISE EXCEPTION 'RLS failed: cross-tenant update affected % rows', cross_tenant_updates;
  END IF;

  -- Writing another tenant's id must be refused outright, not silently dropped.
  BEGIN
    INSERT INTO material (organization_id, name, base_unit)
    VALUES ('00000000-0000-4000-8000-000000000002', 'Smuggled', 'ml');
    RAISE EXCEPTION 'RLS failed: insert into another organization succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- 3. Fail closed: with no tenant context set, nothing is visible at all.
  PERFORM set_config('app.current_organization_id', '', true);
  SELECT (SELECT count(*) FROM material) + (SELECT count(*) FROM service) INTO leaked;
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'RLS failed: % rows visible without a tenant context', leaked;
  END IF;
END
$verify$;

ROLLBACK;

SELECT 'tenant isolation verified' AS result;
