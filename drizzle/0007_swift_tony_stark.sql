ALTER TABLE "visit" ADD COLUMN "commission_type" "commission_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "commission_basis_points" integer;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "commission_fixed_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_commission_shape" CHECK (("visit"."commission_type" = 'fixed' and "visit"."commission_fixed_amount_minor" is not null and "visit"."commission_basis_points" is null)
        or ("visit"."commission_type" <> 'fixed' and "visit"."commission_basis_points" is not null and "visit"."commission_fixed_amount_minor" is null));