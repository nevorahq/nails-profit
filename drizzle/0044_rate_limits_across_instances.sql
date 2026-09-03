-- Rate limit counters that survive the instance that counted them.
--
-- The limiter kept its windows in a `Map` in the process. On Netlify each
-- request may be answered by a different lambda, so "ten an hour" was ten per
-- lambda per hour: a caller refused by one instance was served by the next, and
-- the same limit refused an honest client at random. Counting in the database
-- is what makes the number in `lib/rate-limit.ts` mean what it says.
--
-- The table carries no `organization_id` — the public limiter runs before a
-- slug is resolved — so it is outside tenant RLS by design, and the grants
-- below are written by hand rather than left to a policy. See 0035 for why
-- ownership is stated rather than assumed: on a deployment whose migration role
-- is Supabase's `postgres`, a created table reaches `anon` and `authenticated`
-- and never reaches the application role at all.

CREATE TABLE "rate_limit_window" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"window_expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_window_expiry_idx" ON "rate_limit_window" USING btree ("window_expires_at");--> statement-breakpoint

DO $owner$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit')
     AND (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.rate_limit_window'::regclass) <> 'nail_profit'
  THEN
    EXECUTE 'ALTER TABLE "rate_limit_window" OWNER TO nail_profit';
  END IF;
END
$owner$;--> statement-breakpoint

DO $postgrest$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "rate_limit_window" FROM anon';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "rate_limit_window" FROM authenticated';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON "rate_limit_window" FROM service_role';
  END IF;
END
$postgrest$;--> statement-breakpoint

REVOKE ALL ON "rate_limit_window" FROM PUBLIC;--> statement-breakpoint

-- The application counts its own requests, so it writes here as well as reads:
-- one upsert per limited request is the whole interaction.
DO $app_grant$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_window" TO nail_profit_app';
  END IF;
END
$app_grant$;
