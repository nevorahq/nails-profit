-- Rollback for 0066: a visit keeps photos of the work.
--
-- The rows go, and with them the only record of which objects are in the
-- bucket. Empty the bucket's `<organization>/` prefixes by hand first (or run
-- the maintenance job until `storage_deletion` is empty), otherwise the photos
-- outlive the rows that would have erased them with their client.

DROP TABLE IF EXISTS "visit_photo";
DROP TABLE IF EXISTS "storage_deletion";
