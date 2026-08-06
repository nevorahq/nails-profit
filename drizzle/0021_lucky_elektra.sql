DROP INDEX "pilot_product_event_dedupe_idx";--> statement-breakpoint
ALTER TABLE "pilot_product_event" ADD COLUMN "session_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "pilot_product_event_session_idx" ON "pilot_product_event" USING btree ("session_key","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pilot_product_event_dedupe_idx" ON "pilot_product_event" USING btree ("organization_id","event_name","entity_type","entity_id","session_key");