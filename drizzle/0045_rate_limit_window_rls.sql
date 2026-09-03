-- Row-level security on the limit counters, stated rather than inherited.
--
-- 0044 said nothing about RLS, and the environments disagreed about the
-- default. A plain PostgreSQL box leaves it off; Supabase turns it on for new
-- tables in `public`. The application role is neither the owner nor a
-- superuser, so on production it met a table with RLS enabled and no policy at
-- all — which refuses everything, INSERT included — while locally and in CI the
-- same migration produced a table with RLS off and every test passed.
--
-- The disagreement surfaced as `rate_limit.unavailable` on every request and no
-- rate limiting whatsoever, because the limiter fails open. A migration that
-- leaves this to the environment leaves the tests exercising a different table
-- from the one that runs.
--
-- RLS stays on rather than being switched off. This table has no tenant to
-- filter by, so the policy is simply "the application may use it" — but bound
-- to the role, so a future accidental grant to `anon` still reaches nothing.

DO $rls$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    -- No application role to write a policy for. Enabling RLS here would deny
    -- every caller, which is worse than leaving the table as it was found.
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE "rate_limit_window" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS "rate_limit_window_app" ON "rate_limit_window"';
  EXECUTE 'CREATE POLICY "rate_limit_window_app" ON "rate_limit_window" '
       || 'FOR ALL TO nail_profit_app USING (true) WITH CHECK (true)';
END
$rls$;
