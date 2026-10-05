ALTER TABLE "client" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_notes_length" CHECK (char_length("client"."notes") <= 2000);