CREATE TYPE "public"."material_costing_mode" AS ENUM('quantity', 'services_per_package', 'fixed_per_service');--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD COLUMN "material_usage_source" text;--> statement-breakpoint
ALTER TABLE "material_price_version" ADD COLUMN "costing_mode" "material_costing_mode" DEFAULT 'quantity' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "completion_key" text;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "completion_fingerprint" text;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "standard_material_usage_known" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_completion_key_idx" ON "visit" USING btree ("organization_id","completion_key");--> statement-breakpoint
ALTER TABLE "financial_snapshot" ADD CONSTRAINT "financial_snapshot_material_source" CHECK ("financial_snapshot"."material_usage_source" is null or "financial_snapshot"."material_usage_source" in ('standard', 'actual'));