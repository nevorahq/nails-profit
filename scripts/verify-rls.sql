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
