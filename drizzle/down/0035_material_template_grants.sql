-- Rollback for 0035_material_template_grants.
--
-- Takes back only the grant this migration added. Ownership is deliberately not
-- restored to `postgres`: the previous owner was an accident of which URL ran
-- the migration, not a decision, and handing the table back to a role with
-- BYPASSRLS would undo the isolation rather than restore a state worth having.
--
-- The PostgREST revokes are not undone either, for the same reason: re-granting
-- `anon` and `authenticated` access to a table would be reintroducing the
-- exposure, not rolling back a change.

REVOKE SELECT ON "material_template" FROM nail_profit_app;
