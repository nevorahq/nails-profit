-- Rollback for 0067: a rented chair pays rent, not revenue.
--
-- The rent amounts and every payout marked go with their tables, and the
-- visits forget how their master worked when they closed — after this a
-- renter's visits count in the studio's revenue again, as they did before.
-- Export the organization's data first if any of it should be kept.

DROP TABLE IF EXISTS "master_payout";
DROP TABLE IF EXISTS "chair_rent";
ALTER TABLE "visit" DROP COLUMN IF EXISTS "master_cooperation";
