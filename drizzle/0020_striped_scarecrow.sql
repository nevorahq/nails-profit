CREATE TYPE "public"."notification_provider_status" AS ENUM('accepted', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "notification_provider_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"event_type" "notification_provider_status" NOT NULL,
	"event_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "provider_status" "notification_provider_status";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "provider_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_provider_event" ADD CONSTRAINT "notification_provider_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_provider_event" ADD CONSTRAINT "notification_provider_event_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_provider_event_provider_id_idx" ON "notification_provider_event" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "notification_provider_event_notification_idx" ON "notification_provider_event" USING btree ("notification_id","event_created_at");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
ALTER TABLE "notification_provider_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_provider_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_provider_event_tenant_isolation" ON "notification_provider_event"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
