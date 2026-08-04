BEGIN;

INSERT INTO organization (id, name, type)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'RLS test A', 'solo'),
  ('00000000-0000-4000-8000-000000000002', 'RLS test B', 'studio');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);
INSERT INTO material (id, organization_id, name, base_unit)
VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Visible material', 'ml');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000002', true);
INSERT INTO material (id, organization_id, name, base_unit)
VALUES ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'Hidden material', 'g');

SELECT set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);

DO $verify$
DECLARE
  visible_count integer;
  cross_tenant_updates integer;
BEGIN
  SELECT count(*) INTO visible_count FROM material;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS failed: expected 1 visible row, got %', visible_count;
  END IF;

  UPDATE material SET name = 'must not update'
  WHERE id = '00000000-0000-4000-8000-000000000012';
  GET DIAGNOSTICS cross_tenant_updates = ROW_COUNT;
  IF cross_tenant_updates <> 0 THEN
    RAISE EXCEPTION 'RLS failed: cross-tenant update affected % rows', cross_tenant_updates;
  END IF;
END
$verify$;

ROLLBACK;

SELECT 'tenant isolation verified' AS result;
