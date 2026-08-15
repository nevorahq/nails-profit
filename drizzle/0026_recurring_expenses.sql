ALTER TABLE "expense" ADD COLUMN "is_recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "recurring_from" date;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "recurring_to" date;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_recurring_shape" CHECK (not "expense"."is_recurring" or "expense"."recurring_from" is not null);--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_recurring_order" CHECK ("expense"."recurring_to" is null or "expense"."recurring_from" is null or "expense"."recurring_to" >= "expense"."recurring_from");