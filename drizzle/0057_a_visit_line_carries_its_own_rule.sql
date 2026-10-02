-- A visit line carries the commission rule it is paid under.
--
-- A visit held one service, so it held one rule, copied onto `visit`. A visit
-- of a manicure and a pedicure can fall under two — a master's default and an
-- exception for one service — and the rule is now chosen per service and
-- copied onto that service's lines.
--
-- Additive and nullable: every existing line keeps null in all five columns and
-- goes on falling under its visit's rule, which is exactly what it was costed
-- at. Old code reading the table with a bare select() gets five extra columns
-- and ignores them; old code inserting a line leaves them null. That is what
-- lets this run before the code that writes them is deployed.
--
-- `commission_rule_id` has no foreign key on purpose: it groups lines that
-- share one fixed amount, and a closed visit's costing must not depend on a
-- row elsewhere.

ALTER TABLE "visit_line" ADD COLUMN "commission_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "commission_type" "commission_type";--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "commission_basis_points" integer;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "commission_fixed_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "visit_line" ADD COLUMN "commission_base" "commission_base";--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_commission_shape" CHECK (("visit_line"."commission_rule_id" is null and "visit_line"."commission_type" is null and "visit_line"."commission_basis_points" is null
          and "visit_line"."commission_fixed_amount_minor" is null and "visit_line"."commission_base" is null)
        or ("visit_line"."commission_rule_id" is not null and "visit_line"."commission_base" is not null and (
          ("visit_line"."commission_type"::text = 'fixed' and "visit_line"."commission_fixed_amount_minor" is not null and "visit_line"."commission_basis_points" is null)
          or ("visit_line"."commission_type"::text = 'percentage' and "visit_line"."commission_basis_points" is not null and "visit_line"."commission_fixed_amount_minor" is null)
          or ("visit_line"."commission_type"::text = 'hybrid' and "visit_line"."commission_basis_points" is not null and "visit_line"."commission_fixed_amount_minor" is not null))));--> statement-breakpoint
ALTER TABLE "visit_line" ADD CONSTRAINT "visit_line_commission_non_negative" CHECK (("visit_line"."commission_basis_points" is null or "visit_line"."commission_basis_points" >= 0)
        and ("visit_line"."commission_fixed_amount_minor" is null or "visit_line"."commission_fixed_amount_minor" >= 0));