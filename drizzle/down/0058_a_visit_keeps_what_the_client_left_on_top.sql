-- Rollback for 0058: a visit keeps what the client left on top.
--
-- Drops the tips. The snapshots written while they existed keep the acquirer's
-- fee they were costed with, so a past month's margin does not move; what is
-- lost is the record of the tips themselves and their line in the cash flow.
-- Before any tip has been entered there is nothing to lose.

ALTER TABLE "visit" DROP CONSTRAINT IF EXISTS "visit_tip_non_negative";--> statement-breakpoint
ALTER TABLE "visit" DROP COLUMN IF EXISTS "tip_minor";
