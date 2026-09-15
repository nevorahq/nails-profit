-- Rollback for 0056_a_studio_puts_its_own_mark_in_the_topbar.
--
-- The logo goes with the table: the bytes were only ever in this row, so this
-- discards a studio's mark rather than restoring an earlier shape. The topbar
-- falls back to the flower on its own — that is what it draws when there is no
-- row — so nothing else has to be undone for the application to keep working.
--
-- Dropping the table takes its policy, its constraints and its grants with it.

DROP TABLE IF EXISTS "organization_logo";
