-- Rollback for 0048_a_master_card_carries_a_photo.
--
-- The photos go with the table, and there is nowhere else they exist: the bytes
-- were only ever in this row. So this rollback discards data rather than
-- restoring a previous shape, and a studio that has set faces will be back to
-- letters on circles with no way to get them again.
--
-- Dropping the table takes its policy, its constraints and its grants with it,
-- which is why none of those are named here.

DROP TABLE IF EXISTS "specialist_avatar";
