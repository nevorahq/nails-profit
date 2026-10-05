-- Rollback for 0065: a booking names the visit it followed.
--
-- The link goes; the appointments keep `source = rebooking`, which the previous
-- version still writes and reads. Only the return rate loses what it counted.

DROP INDEX IF EXISTS "booking_rebooked_from_idx";
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_rebooked_from_booking_id_booking_id_fk";
ALTER TABLE "booking" DROP COLUMN IF EXISTS "rebooked_from_booking_id";
