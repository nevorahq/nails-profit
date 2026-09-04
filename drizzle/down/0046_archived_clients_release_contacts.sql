-- Rollback for 0046_archived_clients_release_contacts.
--
-- Back to uniqueness that counts archived rows. It can fail, and legitimately:
-- once archived clients stopped reserving their contacts, a live client may
-- have taken one, and the old index cannot be built over both. Resolve the
-- duplicate before rolling back rather than having this file pick a winner.
DROP INDEX "client_org_phone_idx";--> statement-breakpoint
DROP INDEX "client_org_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_phone_idx" ON "client" USING btree ("organization_id","normalized_phone") WHERE "client"."normalized_phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_email_idx" ON "client" USING btree ("organization_id",lower("email")) WHERE "client"."email" is not null;
