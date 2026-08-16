-- Rollback for 0038: estimated stock.
--
-- Both tables are purely additive and nothing outside them depends on their
-- rows: `material_purchase.price_version_id` points *at* the price history, not
-- the other way round, so the cost basis a visit was snapshotted from survives
-- this untouched. Dropping them loses the purchase log and the counts, and puts
-- the estimated balance back to "unknown" — which is what every workspace saw
-- before the migration.
--
-- Policies and grants go with the tables; the enum has to be named separately
-- because a type outlives the column that used it.

DROP TABLE IF EXISTS "material_stock_check";--> statement-breakpoint
DROP TABLE IF EXISTS "material_purchase";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."material_stock_check_basis";
