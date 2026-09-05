-- The booking grid moves to hours and their multiples.
--
-- The step was five to sixty minutes, built for a studio offering many short
-- starts. What these studios sell is one appointment of an hour or more, and a
-- grid finer than the service is a page of start times that collapse into the
-- same booking the moment a duration is applied. So the list becomes 60, 90,
-- 120 and 150, and the default becomes an hour.
--
-- Existing rows move first. Every value below sixty is outside the new set, and
-- a constraint added over rows that violate it fails — drizzle applies a run in
-- one transaction, so it would take every migration beside it down too. They
-- are raised rather than lowered: a coarser grid offers fewer start times and
-- never one the studio cannot staff, where rounding down would invent starts
-- inside an appointment already sold. What a studio had chosen is not recorded
-- anywhere, so this is not reversible by the rollback beside it.
--
-- The grid is counted from local midnight, not from the opening hour. Sixty
-- divides every hour, so an opening time always lands on it; ninety and a
-- hundred and fifty do not, and a studio choosing one of those sees the first
-- slot of the day arrive after it opens — 09:00 or 10:00 for a shift that
-- starts at 08:00.

UPDATE "booking_settings" SET "slot_step_minutes" = 60 WHERE "slot_step_minutes" NOT IN (60, 90, 120, 150);--> statement-breakpoint
ALTER TABLE "booking_settings" DROP CONSTRAINT "booking_settings_step";--> statement-breakpoint
ALTER TABLE "booking_settings" ALTER COLUMN "slot_step_minutes" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_step" CHECK ("booking_settings"."slot_step_minutes" in (60, 90, 120, 150));
