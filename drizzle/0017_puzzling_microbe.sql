CREATE TYPE "public"."booking_verification_mode" AS ENUM('off', 'code');--> statement-breakpoint
CREATE TABLE "booking_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"destination" text NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_verification_attempts" CHECK ("booking_verification"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ALTER COLUMN "booking_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD COLUMN "verification_mode" "booking_verification_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD COLUMN "verification_ttl_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD COLUMN "reminder_lead_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "verification_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_verification" ADD CONSTRAINT "booking_verification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_verification" ADD CONSTRAINT "booking_verification_hold_id_booking_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."booking_hold"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_verification_hold_idx" ON "booking_verification" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "booking_verification_expiry_idx" ON "booking_verification" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_verification_id_booking_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."booking_verification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_verification_ttl" CHECK ("booking_settings"."verification_ttl_minutes" between 3 and 60);--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_reminder_lead" CHECK ("booking_settings"."reminder_lead_minutes" between 0 and 10080);--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_target" CHECK (("notification_outbox"."booking_id" is not null) <> ("notification_outbox"."verification_id" is not null));--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies.
ALTER TABLE "booking_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_verification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_verification_tenant_isolation" ON "booking_verification"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);