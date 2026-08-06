# Incident response runbook

## Severity

| Severity | Definition | Examples | Initial response |
|---|---|---|---:|
| SEV-1 | Data confidentiality/integrity risk or service unavailable for most users | Cross-tenant access, corrupted financial history, failed production database | 15 minutes |
| SEV-2 | Critical flow unavailable with no safe workaround | Login, visit close, public booking/manage, staff calendar, notification delivery, import confirmation or Owner export fails | 30 minutes |
| SEV-3 | Degraded noncritical flow with a workaround | One report/filter or locale issue | Next business day |

## First 15 minutes

1. Name the incident commander and UTC start time.
2. Preserve evidence: request IDs, deploy SHA, migration version and redacted logs. Do not copy PII into chat or tickets.
3. Stop the blast radius: disable the affected route/feature, pause imports, revoke exposed credentials or put the app in maintenance mode.
4. Check `/api/health`, error rate, database status, recent deploys and migrations.
5. Decide rollback versus forward fix. Never run a destructive rollback migration.
6. Open a communication channel and set the next update time.

## Data or tenant-isolation incident

1. Treat any credible cross-tenant read/write as SEV-1.
2. Disable the affected capability and preserve audit/database logs.
3. Identify affected organization/entity IDs without exporting client data.
4. Rotate credentials or sessions if authorization boundaries may be compromised.
5. Do not delete or edit evidence before scope is understood.
6. Escalate to the privacy/legal owner named in the pilot agreement for notification decisions and deadlines.

## Availability or database incident

1. Verify whether the failure is application, connection pool, database or hosting platform.
2. Pause imports and other write-heavy work before changing limits.
3. For suspected data loss, stop writes and follow the backup restore runbook.
4. Restore into a new database and verify before switching traffic.
5. Monitor health, 5xx and dashboard latency after recovery.

## Online Booking or notification incident

1. Stop expansion to the next pilot organization.
2. For one tenant, lower `booking_access` to `calendar` or `off`; for a fleet incident disable `PUBLIC_BOOKING_ENABLED`.
3. If the provider is failing, set `NOTIFICATIONS_ENABLED=false`. Preserve the outbox and do not replay dead letters until the failure is classified.
4. Verify that existing bookings remain available to staff and the manual visit flow still works.
5. Check active overlaps, holds, queue/job lag, audit trail and provider acceptance using internal IDs only.
6. Resume public access tenant by tenant after regression tests, a production smoke test and release-owner approval.

## Communication template

```text
Status: Investigating | Identified | Monitoring | Resolved
Started: <UTC>
Affected capability: <plain language, no PII>
User impact: <who cannot do what>
Current action: <containment/recovery>
Next update: <UTC>
```

Never promise that no data was affected before the investigation proves it.

## Resolution and follow-up

- Confirm the service and data invariants with automated tests and a user-level smoke test.
- Record root cause, detection gap, timeline, affected scope and recovery evidence.
- Add a regression test or monitor for the failure mode.
- Assign every follow-up an owner and deadline.
- Complete a blameless review within three business days for SEV-1/2.
