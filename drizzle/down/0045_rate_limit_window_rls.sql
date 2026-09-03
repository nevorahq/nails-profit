-- Rollback for 0045_rate_limit_window_rls.
--
-- Back to what 0044 left behind: no policy, and RLS in whatever state the
-- environment defaults to. Turning RLS off outright would be a different table
-- from the one 0044 created on Supabase, and a rollback is meant to undo a
-- change rather than to pick a side the original never picked.
DROP POLICY IF EXISTS "rate_limit_window_app" ON "rate_limit_window";
