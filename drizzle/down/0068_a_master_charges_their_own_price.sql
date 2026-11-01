-- Rollback for 0068: a master charges their own price.
--
-- Every master's own price goes with the column, and the service's price
-- applies to everyone again. Bookings and visits already written keep the
-- prices they were snapshotted with; only what is booked afterwards changes.

ALTER TABLE "specialist_service" DROP CONSTRAINT IF EXISTS "specialist_service_price_non_negative";
ALTER TABLE "specialist_service" DROP COLUMN IF EXISTS "price_override_minor";
