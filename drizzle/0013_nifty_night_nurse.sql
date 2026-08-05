CREATE TYPE "public"."booking_actor" AS ENUM('client', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."booking_hold_status" AS ENUM('active', 'converted', 'expired', 'released');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('public_booking', 'staff', 'rebooking', 'waitlist', 'import', 'api');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_confirmation', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TABLE "booking_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"workplace_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_hold_status" DEFAULT 'active' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"converted_booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_hold_interval" CHECK ("booking_hold"."ends_at" > "booking_hold"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "booking_idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"service_id" uuid,
	"add_on_id" uuid,
	"name_snapshot" jsonb NOT NULL,
	"price_minor" bigint NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_line_price_non_negative" CHECK ("booking_line"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"workplace_id" uuid,
	"client_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'pending_confirmation' NOT NULL,
	"source" "booking_source" NOT NULL,
	"confirmation_due_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "booking_actor",
	"cancellation_reason" text,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_interval" CHECK ("booking"."ends_at" > "booking"."starts_at"),
	CONSTRAINT "booking_cancellation_shape" CHECK (("booking"."status" = 'cancelled' and "booking"."cancelled_at" is not null and "booking"."cancelled_by" is not null)
        or ("booking"."status" <> 'cancelled' and "booking"."cancelled_at" is null and "booking"."cancelled_by" is null))
);
--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_workplace_id_workplace_id_fk" FOREIGN KEY ("workplace_id") REFERENCES "public"."workplace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_converted_booking_id_booking_id_fk" FOREIGN KEY ("converted_booking_id") REFERENCES "public"."booking"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_idempotency_key" ADD CONSTRAINT "booking_idempotency_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_idempotency_key" ADD CONSTRAINT "booking_idempotency_key_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_add_on_id_add_on_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_on"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line" ADD CONSTRAINT "booking_line_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_workplace_id_workplace_id_fk" FOREIGN KEY ("workplace_id") REFERENCES "public"."workplace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_hold_token_idx" ON "booking_hold" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "booking_hold_specialist_idx" ON "booking_hold" USING btree ("specialist_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_hold_expiry_idx" ON "booking_hold" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_idempotency_key_idx" ON "booking_idempotency_key" USING btree ("organization_id","scope","idempotency_key");--> statement-breakpoint
CREATE INDEX "booking_idempotency_created_idx" ON "booking_idempotency_key" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "booking_line_booking_idx" ON "booking_line" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_org_starts_idx" ON "booking" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_specialist_starts_idx" ON "booking" USING btree ("specialist_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_location_starts_idx" ON "booking" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_client_idx" ON "booking" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE set null ON UPDATE no action;

--> statement-breakpoint
-- Section 7.5, the last line of defence.
--
-- The application checks for a conflict inside an advisory lock and answers
-- SLOT_UNAVAILABLE. These constraints are what holds when two transactions get
-- past that check at the same instant: a specialist cannot be in two places at
-- once no matter how the race is lost. btree_gist is what lets a uuid equality
-- share an index with a range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- Only `pending_confirmation` and `confirmed` occupy the specialist. A
-- cancelled booking has to be allowed to overlap a new one — otherwise the slot
-- it freed could never be resold.
ALTER TABLE "booking" ADD CONSTRAINT "booking_specialist_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "specialist_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" IN ('pending_confirmation', 'confirmed'));--> statement-breakpoint

-- A chair cannot hold two clients either, when the service needs one.
ALTER TABLE "booking" ADD CONSTRAINT "booking_workplace_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "workplace_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("workplace_id" IS NOT NULL AND "status" IN ('pending_confirmation', 'confirmed'));--> statement-breakpoint

-- Active holds get their own constraint. Expiry cannot be part of it: `now()`
-- is not immutable, so a stale hold is marked expired by the next request that
-- touches the specialist and by the sweep job, never by the index.
ALTER TABLE "booking_hold" ADD CONSTRAINT "booking_hold_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "specialist_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'active');--> statement-breakpoint

ALTER TABLE "booking" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_tenant_isolation" ON "booking"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "booking_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_line_tenant_isolation" ON "booking_line"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "booking_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_hold" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_hold_tenant_isolation" ON "booking_hold"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE "booking_idempotency_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_idempotency_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_idempotency_key_tenant_isolation" ON "booking_idempotency_key"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
