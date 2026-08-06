ALTER TABLE "client" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "privacy_version" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "consented_at" timestamp with time zone;