-- Rollback for 0063: a request reaches the studio's phone.
--
-- The devices go, and so do the queued messages addressed to them: the previous
-- version has no sender for `push` and would dead-letter every one as a template
-- it cannot render.
--
-- `push` stays in `notification_channel`. PostgreSQL cannot drop an enum value
-- without rebuilding the type under two tables, and a value nothing writes any
-- more costs nothing. 0063 adds it with `IF NOT EXISTS`, so applying it again
-- after this rollback finds the value already there and carries on.
--
-- Addresses created while 0063 was live keep their twelve-hour window. Their
-- owners never chose it, but undoing it would shorten requests already in the
-- calendar, and the previous version reads the column without caring which.

DELETE FROM "notification_outbox" WHERE "channel"::text = 'push';
DROP TABLE IF EXISTS "push_subscription";
ALTER TABLE "booking" DROP COLUMN IF EXISTS "staff_reminded_version";
ALTER TABLE "booking_settings" ALTER COLUMN "confirmation_ttl_minutes" SET DEFAULT 120;
