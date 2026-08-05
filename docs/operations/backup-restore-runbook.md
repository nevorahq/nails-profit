# Backup and restore runbook

## Policy

- Managed PostgreSQL backups run at least daily.
- MVP targets: RPO ≤24 hours and RTO ≤8 hours.
- Backups must be encrypted, access-controlled and stored separately from application credentials.
- A restore drill runs before every schema release and at least monthly during the pilot.
- A backup is not considered valid until it has been restored and checked.

## Automated local/staging drill

The script creates a custom-format dump, restores it into a uniquely named database on the same PostgreSQL cluster, compares table/migration and critical row counts, performs a read transaction and removes the temporary database.

It will not run without an explicit safety flag:

```bash
export BACKUP_SOURCE_DATABASE_URL='postgresql://.../staging'
ALLOW_BACKUP_RESTORE_DRILL=1 npm run ops:backup-drill
```

Use a migration-owner URL. Confirm the hostname and database before setting the flag. Never point the drill at a cluster where the account cannot create and drop a uniquely named temporary database.

Expected final line:

```text
Backup restore drill passed. Temporary database will now be removed.
```

## Managed-provider restore

1. Record incident/change ID, backup timestamp and expected RPO.
2. Restore into a new staging database, never over the source.
3. Apply no new migrations until the restored version is identified.
4. Verify migration count, tenant count and counts for `financial_snapshot`, `visit`, `service` and `material`.
5. Run `npm run test:integration` against the restored database.
6. Start the application against the restored database and verify login, one dashboard, one historical visit and an Owner export.
7. Record start/end time, achieved RPO/RTO, backup ID and any errors.
8. Destroy the restored copy after the evidence is retained without PII.

## Production recovery

Production restore is a change-controlled incident action. Restore into a new database, validate it, switch the application secret to the new URL, monitor health/5xx, and keep the old database read-only until the recovery is accepted. Do not roll application code back to a version incompatible with the restored schema.

## Drill record

For every drill record:

- UTC date and operator;
- source environment and backup identifier, without credentials;
- schema/application commit;
- row-count fingerprint;
- elapsed dump, restore and validation time;
- pass/fail and follow-up owner.

