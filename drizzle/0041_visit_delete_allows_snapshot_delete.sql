-- Deleting a visit, and what the append-only rule was actually protecting.
--
-- `financial_snapshot_no_update_or_delete` (migration 0006) refused UPDATE and
-- DELETE alike, on the reasoning quoted there: "an UPDATE here would silently
-- rewrite a past month's profit and nothing downstream would notice". That
-- argument is about a figure changing under a report that has already been
-- read — and it is untouched here. UPDATE stays impossible, so a snapshot can
-- still only be superseded by a new version, never edited.
--
-- DELETE is the different case. It arrives through `visit` — the snapshot has
-- `ON DELETE cascade` — and a visit is deleted only by an owner or a manager,
-- through an endpoint that refuses any visit which closed an appointment and
-- writes the amounts into `audit_event` before the row goes. Nothing
-- disappears quietly: the month's total changes because somebody said this
-- visit did not happen, and the audit trail says who and what it was worth.
--
-- The function is left as it is, so the message it raises still names the
-- operation that hit it.
DROP TRIGGER IF EXISTS "financial_snapshot_no_update_or_delete" ON "financial_snapshot";--> statement-breakpoint
CREATE TRIGGER "financial_snapshot_no_update_or_delete"
  BEFORE UPDATE ON "financial_snapshot"
  FOR EACH ROW EXECUTE FUNCTION financial_snapshot_is_append_only();
