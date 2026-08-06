-- Supabase equivalent of docker/postgres/init.sql, run once per project in the
-- SQL Editor (as `postgres`) BEFORE the first `npm run db:migrate`.
--
-- Two roles, same split as local development: `nail_profit` owns the schema and
-- runs migrations, `nail_profit_app` is what the application connects as. The
-- split is what makes RLS mean anything — Supabase's own `postgres` role has
-- BYPASSRLS, so an application running as `postgres` would silently see every
-- tenant's rows despite FORCE ROW LEVEL SECURITY.
--
-- Replace both passwords before running, with a different one for each role.
-- Generate them with `openssl rand -base64 24 | tr -d '/+='` so nothing needs
-- URL-encoding in the connection string. Do not commit the filled-in file.
--
-- Re-running is safe: the roles are created only if absent, and every grant
-- below is idempotent.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit') THEN
    CREATE ROLE nail_profit
      WITH LOGIN PASSWORD 'REPLACE_MIGRATION_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
    CREATE ROLE nail_profit_app
      WITH LOGIN PASSWORD 'REPLACE_APP_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$roles$;

GRANT CONNECT ON DATABASE postgres TO nail_profit, nail_profit_app;

-- drizzle-kit records applied migrations in its own `drizzle` schema, so the
-- migration role needs CREATE on the database, not just on `public`.
GRANT CREATE ON DATABASE postgres TO nail_profit;
GRANT USAGE, CREATE ON SCHEMA public TO nail_profit;
GRANT USAGE ON SCHEMA public TO nail_profit_app;

-- Postgres 16 grants the creator ADMIN OPTION on a new role but not INHERIT,
-- and `ALTER DEFAULT PRIVILEGES FOR ROLE nail_profit` checks inherited
-- privileges — hence "permission denied to change default privileges" without
-- this. Granting membership explicitly restores the pre-16 behaviour, and
-- `SET ROLE` below then removes the need for the `FOR ROLE` clause entirely.
GRANT nail_profit TO CURRENT_USER;

SET ROLE nail_profit;

-- Everything the migration role creates from here on is reachable by the app
-- role. This is the statement that has to exist before migrations run.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nail_profit_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nail_profit_app;

RESET ROLE;

-- After `npm run db:migrate`, confirm PostgREST cannot reach any of it. Supabase
-- exposes `public` through the `anon` and `authenticated` roles, and `account`
-- holds password hashes. Tables created by `nail_profit` inherit none of
-- Supabase's default grants — this query proves it, and must return no rows.
--
--   SELECT c.relname
--     FROM pg_class c
--    WHERE c.relnamespace = 'public'::regnamespace
--      AND c.relkind = 'r'
--      AND (has_table_privilege('anon', c.oid, 'SELECT')
--           OR has_table_privilege('authenticated', c.oid, 'SELECT'));
