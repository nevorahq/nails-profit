-- Rollback for 0036_revoke_service_role.
--
-- Deliberately empty of effect. Re-granting `service_role` access to an
-- application table would reintroduce the exposure this migration closed, which
-- is not a rollback of a change but a reversal of a fix. The statement below
-- exists so the file is not empty and the rollback runner has something to
-- record.
SELECT 1;
