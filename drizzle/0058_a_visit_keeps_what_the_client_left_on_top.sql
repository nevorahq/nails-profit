-- A visit keeps what the client left on top.
--
-- One column on `visit`, not a line: the revenue of a visit is the sum of its
-- lines, and a tip is the one sum that must stay out of it. It is the master's
-- whole, so it reaches no margin, no commission base and no tax; only the
-- acquirer's fee, charged on everything that went through the terminal, is
-- costed on it, and that is the code's business rather than the schema's.
--
-- Not null with default 0: every visit closed before reads as «no tip», and the
-- previous version's inserts, which do not name the column, keep working. That
-- is what lets this run before the code that writes it is deployed.

ALTER TABLE "visit" ADD COLUMN "tip_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_tip_non_negative" CHECK ("visit"."tip_minor" >= 0);