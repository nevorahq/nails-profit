-- A studio confirms what it opens with.
--
-- Registration used to publish the booking page on the spot, priced and timed
-- by the product's own suggestions: a manicure at 200 and a week nobody chose.
-- `setup_confirmed_at` is the moment the owner looked at those and said yes;
-- until it is set the app asks first, and only that answer can open the page.
-- `wants_online_booking` keeps the registration tick as an intention.
--
-- Every organization that exists already is backfilled as confirmed at its own
-- creation: those studios are working, and sending them back to a first-day
-- screen — or reading their published pages as unconfirmed — would be a change
-- they discover rather than one they asked for. Nullable and defaulted, so the
-- previous version, which names neither column, keeps writing organizations.

ALTER TABLE "organization" ADD COLUMN "setup_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "wants_online_booking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organization" SET "setup_confirmed_at" = "created_at" WHERE "setup_confirmed_at" IS NULL;
