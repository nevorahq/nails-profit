#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_BACKUP_RESTORE_DRILL:-}" != "1" ]]; then
  echo "Refusing to create a temporary restore database. Set ALLOW_BACKUP_RESTORE_DRILL=1 after verifying the target cluster." >&2
  exit 2
fi

for tool in node pg_dump pg_restore psql createdb dropdb; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool is missing: $tool" >&2
    exit 2
  fi
done

source_url="${BACKUP_SOURCE_DATABASE_URL:-${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}}"
if [[ -z "$source_url" ]]; then
  echo "Set BACKUP_SOURCE_DATABASE_URL, MIGRATION_DATABASE_URL or DATABASE_URL." >&2
  exit 2
fi

drill_dir="$(mktemp -d)"
drill_name="nail_profit_restore_$(date -u +%Y%m%d%H%M%S)_$$"
dump_file="$drill_dir/backup.dump"
drill_created=0

drill_url="$(node -e '
  const url = new URL(process.argv[1]);
  url.pathname = `/${process.argv[2]}`;
  process.stdout.write(url.toString());
' "$source_url" "$drill_name")"

cleanup() {
  if [[ "$drill_created" == "1" ]]; then
    dropdb --if-exists --maintenance-db="$source_url" "$drill_name" >/dev/null
  fi
  rm -f "$dump_file"
  rmdir "$drill_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "1/5 Creating a custom-format backup"
pg_dump --format=custom --no-owner --no-privileges --file="$dump_file" "$source_url"
pg_restore --list "$dump_file" >/dev/null

echo "2/5 Creating isolated restore database $drill_name"
createdb --maintenance-db="$source_url" "$drill_name"
drill_created=1

echo "3/5 Restoring with stop-on-error"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$drill_url" "$dump_file"

echo "4/5 Comparing schema and critical row counts"
source_fingerprint="$(psql "$source_url" -v ON_ERROR_STOP=1 -Atc '
  select json_build_object(
    '\''tables'\'', (select count(*) from information_schema.tables where table_schema = '\''public'\'' and table_type = '\''BASE TABLE'\''),
    '\''organizations'\'', (select count(*) from organization),
    '\''users'\'', (select count(*) from "user"),
    '\''snapshots'\'', (select count(*) from financial_snapshot),
    '\''bookings'\'', (select count(*) from booking),
    '\''booking_lines'\'', (select count(*) from booking_line),
    '\''booking_holds'\'', (select count(*) from booking_hold),
    '\''booking_tokens'\'', (select count(*) from booking_access_token),
    '\''notification_outbox'\'', (select count(*) from notification_outbox),
    '\''notification_provider_event'\'', (select count(*) from notification_provider_event),
    '\''pilot_enrollments'\'', (select count(*) from pilot_enrollment),
    '\''pilot_events'\'', (select count(*) from pilot_product_event),
    '\''pilot_interactions'\'', (select count(*) from pilot_interaction),
    '\''pilot_issues'\'', (select count(*) from pilot_issue),
    '\''migrations'\'', (select count(*) from drizzle.__drizzle_migrations)
  );
')"
restore_fingerprint="$(psql "$drill_url" -v ON_ERROR_STOP=1 -Atc '
  select json_build_object(
    '\''tables'\'', (select count(*) from information_schema.tables where table_schema = '\''public'\'' and table_type = '\''BASE TABLE'\''),
    '\''organizations'\'', (select count(*) from organization),
    '\''users'\'', (select count(*) from "user"),
    '\''snapshots'\'', (select count(*) from financial_snapshot),
    '\''bookings'\'', (select count(*) from booking),
    '\''booking_lines'\'', (select count(*) from booking_line),
    '\''booking_holds'\'', (select count(*) from booking_hold),
    '\''booking_tokens'\'', (select count(*) from booking_access_token),
    '\''notification_outbox'\'', (select count(*) from notification_outbox),
    '\''notification_provider_event'\'', (select count(*) from notification_provider_event),
    '\''pilot_enrollments'\'', (select count(*) from pilot_enrollment),
    '\''pilot_events'\'', (select count(*) from pilot_product_event),
    '\''pilot_interactions'\'', (select count(*) from pilot_interaction),
    '\''pilot_issues'\'', (select count(*) from pilot_issue),
    '\''migrations'\'', (select count(*) from drizzle.__drizzle_migrations)
  );
')"

if [[ "$source_fingerprint" != "$restore_fingerprint" ]]; then
  echo "Restore verification failed: schema or critical row counts differ." >&2
  exit 1
fi

echo "5/5 Verifying restored database accepts read transactions"
psql "$drill_url" -v ON_ERROR_STOP=1 -c "begin read only; select count(*) from organization; commit;" >/dev/null

echo "Backup restore drill passed. Temporary database will now be removed."
