#!/bin/sh
# Runs `next dev` against the LOCAL database, never the one in `.env`.
#
# `.env` in this repository points `DATABASE_URL` at production Supabase, so a
# plain `npm run dev` connects the app to live data. Next.js does not overwrite
# a variable that is already in the environment, so exporting it here wins over
# the file — which is the opposite of how `drizzle-kit` behaves, and the reason
# that trap is worth a script rather than a remembered incantation.
#
# It prints what it connected to, and that line is not decoration. Next's own
# banner says «Environments: .env», which is true and reads as «I am on the URL
# in .env» — the opposite of what happened. An afternoon went into establishing
# from the outside that a dev server was on the test database and not on
# production; the answer was always one line the process could have said itself.
set -eu

: "${LOCAL_DATABASE_URL:=postgres://nail_profit_app:nail_profit_app@localhost:55432/nail_profit_test}"

# Host, not a substring of the whole URL. `*localhost*` also matches a password,
# a database name and `?options=localhost`, so the old guard would have waved
# through `postgres://u:p@db.example.com/app?application_name=localhost`.
host=$(printf '%s' "$LOCAL_DATABASE_URL" |
  sed -e 's|^[a-zA-Z+.-]*://||' -e 's|^[^@/]*@||' -e 's|[/?].*$||' -e 's|:[0-9]*$||' -e 's|^\[\(.*\)\]$|\1|')

case "$host" in
  localhost|127.0.0.1|::1) ;;
  *)
    echo "refusing to start: LOCAL_DATABASE_URL points at \"$host\", which is not this machine" >&2
    exit 1
    ;;
esac

# Everything after the last slash, minus the query — «55432/nail_profit_test» is
# what distinguishes the two local databases from each other, and the name is
# the half that matters when a suite has just truncated one of them.
where=$(printf '%s' "$LOCAL_DATABASE_URL" | sed -e 's|^.*@||' -e 's|?.*$||')

DATABASE_URL="$LOCAL_DATABASE_URL"
export DATABASE_URL

echo "database: $where  (exported DATABASE_URL; the production URL in .env is ignored)"
echo "warning:  the test suites TRUNCATE this database — a run wipes whatever you set up here"

exec npm run dev
