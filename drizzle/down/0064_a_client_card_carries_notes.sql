-- Rollback for 0064: a client card carries notes.
--
-- The notes go with the column. The previous version neither reads nor writes
-- them, and keeping a column of free text about people that no screen shows and
-- no erasure empties would be worse than losing it.

ALTER TABLE "client" DROP CONSTRAINT IF EXISTS "client_notes_length";
ALTER TABLE "client" DROP COLUMN IF EXISTS "notes";
