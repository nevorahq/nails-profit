DROP INDEX "expense_org_idx";--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "spent_on" date DEFAULT CURRENT_DATE NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_org_idx" ON "expense" USING btree ("organization_id","spent_on");