#!/usr/bin/env bash
# Builds the app, serves it against the _test database through a delaying proxy, and prints
# how many statements every page sends and how long it takes at that distance.
#
#   scripts/perf/run.sh            # 40 ms each way (80 ms round trip), 3 runs per page
#   LATENCY_MS=0 scripts/perf/run.sh
#
# The database is the one named by TEST_DATABASE_URL in .env, and its name must end in _test:
# the script signs up a studio and writes visits into it.
set -euo pipefail
cd "$(dirname "$0")/../.."

LATENCY_MS="${LATENCY_MS:-40}"
APP_PORT="${APP_PORT:-3200}"
export PROXY_PORT="${PROXY_PORT:-55433}"
DIST="${NEXT_DIST_DIR:-.next-perf}"
WORK="$(mktemp -d)"

# `.env` is read by Node rather than sourced: it is a dotenv file, not a shell script, and an
# unquoted value in it would stop a `source` halfway.
TEST_DATABASE_URL="$(node -e 'process.loadEnvFile(".env"); console.log(process.env.TEST_DATABASE_URL ?? "")')"
export TEST_DATABASE_URL

case "$(node -e 'console.log(new URL(process.env.TEST_DATABASE_URL).pathname)')" in
  *_test) ;;
  *) echo "TEST_DATABASE_URL must name a database ending in _test" >&2; exit 1 ;;
esac

TARGET_PORT="$(node -e 'console.log(new URL(process.env.TEST_DATABASE_URL).port || 5432)')"
THROUGH_PROXY="$(node -e '
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.hostname = "127.0.0.1"; url.port = process.env.PROXY_PORT;
  console.log(url.toString());' )"
cleanup() { kill "${PROXY_PID:-}" "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

node scripts/perf/delay-proxy.mjs "$PROXY_PORT" "$TARGET_PORT" "$LATENCY_MS" &
PROXY_PID=$!

export NEXT_DIST_DIR="$DIST" DATABASE_URL="$THROUGH_PROXY" SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= \
  NEXT_PUBLIC_APP_URL="http://localhost:$APP_PORT" BETTER_AUTH_URL="http://localhost:$APP_PORT" \
  DB_QUERY_LOG="$WORK/queries.log"

npx next build >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }
npx next start -p "$APP_PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do curl -sf "http://localhost:$APP_PORT/api/health" >/dev/null && break; sleep 1; done

BASE_URL="http://localhost:$APP_PORT" node scripts/perf/page-queries.mjs
