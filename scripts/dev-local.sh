#!/bin/sh
# Runs `next dev` against the LOCAL database, never the one in `.env`.
#
# `.env` in this repository points `DATABASE_URL` at production Supabase, so a
# plain `npm run dev` connects the app to live data. Next.js does not overwrite
# a variable that is already in the environment, so exporting it here wins over
# the file — which is the opposite of how `drizzle-kit` behaves, and the reason
# that trap is worth a script rather than a remembered incantation.
set -eu

: "${LOCAL_DATABASE_URL:=postgres://nail_profit_app:nail_profit_app@localhost:55432/nail_profit_test}"

case "$LOCAL_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "refusing to start: LOCAL_DATABASE_URL is not a local database" >&2; exit 1 ;;
esac

DATABASE_URL="$LOCAL_DATABASE_URL"
export DATABASE_URL

exec npm run dev
