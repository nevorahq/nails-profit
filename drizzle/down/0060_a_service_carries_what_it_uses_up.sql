-- Rollback for 0060: a service carries what it uses up.
--
-- Drops the four columns, the history of modes and its type. What was typed on
-- services and snapshotted on visits is lost; the previous version reads none
-- of it, and a month costed per service reads, after the rollback, as one
-- counted by purchases — its visits keep the margin they were snapshotted
-- with, and its purchases count as costs again.

DROP TABLE IF EXISTS "materials_costing_period";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."materials_costing_mode";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "materials_minor";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN IF EXISTS "materials_minor";--> statement-breakpoint
ALTER TABLE "financial_snapshot" DROP COLUMN IF EXISTS "materials_minor";--> statement-breakpoint
ALTER TABLE "add_on" DROP COLUMN IF EXISTS "materials_minor";
