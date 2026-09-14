-- Rollback for 0054_the_studio_hears_its_own_moves.
--
-- PostgreSQL cannot take a label back out of an enum, so the two labels stay
-- where they are. Harmless on their own — nothing constrains on them and no
-- code without this migration writes them.
--
-- What can be undone is what used them. A feed row of a kind the running build
-- has never heard of renders as its own key instead of a sentence, and a queued
-- message naming one of the three new templates dead-letters as
-- `template_unknown` on its way to somebody's inbox. Both are cleared here; a
-- message already sent is history and stays.
--
-- Compared through `::text` so the statement does not depend on the labels
-- existing, which is the same reason check constraints in this project do.
DELETE FROM "staff_notice"
 WHERE "kind"::text IN ('staff_booked', 'request_expired');--> statement-breakpoint
DELETE FROM "notification_outbox"
 WHERE "template" IN (
         'booking.staff_assigned',
         'booking.staff_freed',
         'booking.staff_request_expired'
       )
   AND "status"::text IN ('pending', 'retry');
