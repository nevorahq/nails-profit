-- Rollback for 0053_a_service_no_longer_asks_for_a_chair.
--
-- Restores the column, not the flags: every row comes back as false. That is
-- the honest rollback here, because the flag was removed for having no way to
-- be satisfied — no screen and no endpoint ever created a workplace row, so a
-- service marked as needing one simply refused to be booked online.
ALTER TABLE "specialist_service" ADD COLUMN "requires_workplace" boolean DEFAULT false NOT NULL;
