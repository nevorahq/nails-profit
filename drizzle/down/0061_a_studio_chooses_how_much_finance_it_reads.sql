-- Rollback for 0061: a studio chooses how much finance it reads.
--
-- Drops the column. The previous version reads none of it and shows every
-- studio the detailed reports, which is what all of them saw before.

ALTER TABLE "organization" DROP COLUMN IF EXISTS "detailed_analytics";
