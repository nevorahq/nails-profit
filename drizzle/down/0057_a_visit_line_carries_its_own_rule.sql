-- Rollback for 0057: a visit line carries the commission rule it is paid under.
--
-- Drops the per-line terms. Lines of a visit with one service lose nothing: the
-- same rule is on the visit, and re-costing them reads it from there. A visit of
-- several services under different rules would be re-costed under its first
-- service's rule — so run this only before any such visit has been closed, or
-- accept that a correction to one afterwards pays the master differently. The
-- snapshots already written are untouched either way.

ALTER TABLE "visit_line" DROP CONSTRAINT IF EXISTS "visit_line_commission_non_negative";--> statement-breakpoint
ALTER TABLE "visit_line" DROP CONSTRAINT IF EXISTS "visit_line_commission_shape";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "commission_base";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "commission_fixed_amount_minor";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "commission_basis_points";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "commission_type";--> statement-breakpoint
ALTER TABLE "visit_line" DROP COLUMN IF EXISTS "commission_rule_id";
