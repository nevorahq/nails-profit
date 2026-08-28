-- Deleting an account, and the one UPDATE the append-only rule has to allow.
--
-- `financial_snapshot.created_by` references `user` with ON DELETE SET NULL, so
-- erasing an account asks Postgres to null that column on every snapshot the
-- person ever wrote. That is an UPDATE, and migration 0006 refuses every UPDATE
-- on this table — which meant `DELETE FROM "user"` failed with «financial
-- snapshot is append-only», and the account deletion introduced with
-- `/api/v1/account/delete` could never complete for anybody who had closed a
-- visit. The failure surfaced as a bare 500.
--
-- What 0006 is protecting is quoted there: "an UPDATE here would silently
-- rewrite a past month's profit and nothing downstream would notice". Forgetting
-- who wrote a snapshot changes no figure — the revenue, the margin and the
-- commission are exactly as they were, and the visit still says what happened.
-- So the rule narrows by precisely one case: `created_by` going from somebody to
-- nobody, with every other column identical. The jsonb comparison is the whole
-- guarantee — an UPDATE that nulls the author *and* touches an amount is still
-- refused, as is one that merely reassigns the author to a different account.
CREATE OR REPLACE FUNCTION financial_snapshot_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.created_by IS NOT NULL
    AND NEW.created_by IS NULL
    AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'financial_snapshot is append-only: write a new version instead of %', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
