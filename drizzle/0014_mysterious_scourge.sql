-- Gate 7: "перенос, отмена и завершение оставляют audit trail и не создают
-- дубли". A booking closes into at most one visit. Closing it twice would
-- double its revenue in every report, and the application check that prevents
-- that is one retry or one concurrent request away from being raced.
--
-- Partial, because a visit recorded by hand has no booking to be unique on, and
-- there are years of those.
CREATE UNIQUE INDEX "visit_booking_idx" ON "visit" USING btree ("booking_id") WHERE "visit"."booking_id" is not null;
