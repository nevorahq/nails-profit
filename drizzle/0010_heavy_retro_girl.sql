ALTER TABLE "user" ADD COLUMN "legal_accepted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "privacy_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "privacy_acknowledged_at" timestamp with time zone;