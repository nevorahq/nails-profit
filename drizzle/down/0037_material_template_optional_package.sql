-- Rollback for 0037_material_template_optional_package.
--
-- Restoring NOT NULL needs every row to have a size, and the rows written after
-- this migration deliberately do not. Rather than invent one — the exact thing
-- the migration exists to avoid — the rollback deletes the templates that carry
-- no packaging, and the seed command puts back whatever the file of the older
-- version describes.
--
-- `material.template_id` is ON DELETE SET NULL, so a material built from a
-- deleted template keeps its name, unit, price history and `source`; only the
-- link back to the catalogue goes. Nothing a visit was costed with lives in
-- `material_template`.

DELETE FROM "material_template" WHERE "package_size_milli_units" IS NULL;--> statement-breakpoint

ALTER TABLE "material_template" DROP CONSTRAINT "material_template_size_positive";--> statement-breakpoint
ALTER TABLE "material_template" ALTER COLUMN "package_size_milli_units" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "material_template" ADD CONSTRAINT "material_template_size_positive" CHECK ("material_template"."package_size_milli_units" > 0);
