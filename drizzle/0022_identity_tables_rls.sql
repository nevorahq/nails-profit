-- The six identity tables are not tenant-owned: they answer "who is this" and
-- "which organizations exist", which are the questions asked *before* a tenant
-- context exists. No migration ever gave them RLS, and on a plain PostgreSQL
-- box that is the end of it — no RLS means no restriction.
--
-- Supabase is not a plain PostgreSQL box. It enables row level security on new
-- tables in `public` on its own, and a table with RLS enabled and no policy
-- denies everything to every role except the owner. The owner is the migration
-- role, so migrations kept working and the application — connecting as
-- `nail_profit_app` — could not read a user to sign in or write a session.
--
-- Rather than turning RLS back off and depending on Supabase never doing it
-- again, the intent is written down: RLS on, and one policy naming the role
-- that is allowed through. Grants alone would keep PostgREST's `anon` and
-- `authenticated` out, since these tables are owned by `nail_profit` and
-- inherit none of Supabase's default privileges; the policy means a stray grant
-- would not be enough to reach them either.
--
-- Not FORCEd, deliberately: the migration role and the operational scripts run
-- as the owner and must keep seeing every row.
--
-- Requires `nail_profit_app` to exist — docker/postgres/init.sql locally,
-- scripts/supabase-init.sql in production, both run before the first migration.

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_application_access" ON "user"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "session_application_access" ON "session"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "account_application_access" ON "account"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "verification_application_access" ON "verification"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- `membership` is the exemption scripts/verify-rls.sql already documents: it
-- answers which organization a user belongs to, so scoping it by the tenant
-- setting would make the lookup that establishes the tenant return nothing.
-- It is filtered by user_id on every read instead.
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "membership_application_access" ON "membership"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- `organization` carries no organization_id of its own; rows are reached
-- through membership, and the tenant-owned tables that reference it are the
-- ones under org-scoped policies.
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_application_access" ON "organization"
  FOR ALL TO nail_profit_app
  USING (true) WITH CHECK (true);
