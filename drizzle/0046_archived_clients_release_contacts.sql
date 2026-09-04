-- A hidden client stops holding its contacts.
--
-- "Delete" in the client list archives: the row stays, its phone and address
-- stay with it, and every screen filters it out. The public booking form did
-- not — it matched on all rows — so a studio that had cleaned its list still
-- saw bookings refused as a contact conflict between two clients it could no
-- longer see, or quietly attached to one of them. And nothing could be done
-- about it from the application, because an archived client is not listed
-- anywhere: not openable, not restorable, its contacts reserved for good.
--
-- The uniqueness that made them reserved is what changes here. Two clients a
-- studio can see still cannot share a number or an address; an archived one no
-- longer occupies either. Restoring it can therefore fail — someone else may
-- hold the contact by then — and the restore path answers that rather than
-- letting the index raise.

DROP INDEX "client_org_phone_idx";--> statement-breakpoint
DROP INDEX "client_org_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_phone_idx" ON "client" USING btree ("organization_id","normalized_phone") WHERE "client"."normalized_phone" is not null and "client"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_org_email_idx" ON "client" USING btree ("organization_id",lower("email")) WHERE "client"."email" is not null and "client"."archived_at" is null;