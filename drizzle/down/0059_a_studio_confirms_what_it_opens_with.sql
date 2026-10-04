-- Rollback for 0059: a studio confirms what it opens with.
--
-- Drops both columns. Nothing else reads them, and the previous version
-- publishes at registration again; a studio registered meanwhile that never
-- confirmed keeps its page closed until the owner opens it in «Онлайн-запись».

ALTER TABLE "organization" DROP COLUMN IF EXISTS "wants_online_booking";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "setup_confirmed_at";
