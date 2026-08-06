CREATE TYPE "public"."booking_access_purpose" AS ENUM('manage', 'verify');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'processing', 'sent', 'retry', 'dead_letter');--> statement-breakpoint
CREATE TABLE "booking_access_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"purpose" "booking_access_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"template" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_attempts" CHECK ("notification_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "specialist" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_access_token" ADD CONSTRAINT "booking_access_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_access_token" ADD CONSTRAINT "booking_access_token_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_access_token_hash_idx" ON "booking_access_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "booking_access_token_booking_idx" ON "booking_access_token" USING btree ("booking_id","purpose");--> statement-breakpoint
CREATE INDEX "booking_access_token_expiry_idx" ON "booking_access_token" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_idempotency_idx" ON "notification_outbox" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_delivery_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
ALTER TABLE "booking_access_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_access_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_access_token_tenant_isolation" ON "booking_access_token"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_outbox_tenant_isolation" ON "notification_outbox"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
