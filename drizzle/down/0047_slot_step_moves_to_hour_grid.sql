-- Rollback for 0047_slot_step_moves_to_hour_grid.
--
-- The old set comes back, and the fifteen-minute default with it. What does not
-- come back is any studio's previous step: the migration raised the values it
-- could not keep without recording them, so a studio that had been on fifteen
-- minutes stays on sixty until somebody sets it again. Restoring them would be
-- guessing.
--
-- Ninety, a hundred and twenty and a hundred and fifty are what now violates
-- the old constraint, so they come down to sixty before it is added back.

UPDATE "booking_settings" SET "slot_step_minutes" = 60 WHERE "slot_step_minutes" NOT IN (5, 10, 15, 20, 30, 60);--> statement-breakpoint
ALTER TABLE "booking_settings" DROP CONSTRAINT "booking_settings_step";--> statement-breakpoint
ALTER TABLE "booking_settings" ALTER COLUMN "slot_step_minutes" SET DEFAULT 15;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_step" CHECK ("booking_settings"."slot_step_minutes" in (5, 10, 15, 20, 30, 60));
