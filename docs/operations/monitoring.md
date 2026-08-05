# Monitoring and alerts

## Scope

Phase 5 uses structured application logs plus `GET /api/health`. Logs are JSON, include `request_id`, `organization_id` and `user_id` where available, and pass through central PII redaction. The health response checks database connectivity and exposes no deployment or tenant details.

The pilot can run without a vendor-specific SDK. The hosting platform must collect stdout/stderr, probe `/api/health` every minute and route alerts to the founder/on-call contact named in the deployment configuration.

## Required monitors

| Monitor | Window | Warning | Critical | First action |
|---|---:|---:|---:|---|
| Health endpoint | 1 minute | 2 consecutive failures | 5 consecutive failures | Open the incident runbook and check database reachability |
| HTTP 5xx rate | 5 minutes | ≥2% and ≥5 requests | ≥5% and ≥10 requests | Group logs by event and request ID |
| p95 API latency | 10 minutes | >800 ms | >2 s | Identify route and database query regression |
| Dashboard p95 | 10 minutes | >1.5 s | >2 s | Run the performance integration test |
| Rate-limit events | 10 minutes | ≥20 per bucket | ≥100 per bucket | Check abuse versus a broken retry loop |
| Database connections | 5 minutes | ≥70% pool/plan | ≥90% pool/plan | Stop nonessential jobs and inspect slow queries |
| Expired holds not swept | 5 minutes | >20 active holds past `expires_at` | >100 | Check that `ops:booking-maintenance` is running each minute |
| Booking slot conflicts | 10 minutes | ≥10 `booking.slot_conflict` | ≥50 | Normal under load; a spike with no traffic means stale availability |
| Exclusion violations | 1 hour | ≥1 `booking.exclusion_violation` | ≥5 | The application check was bypassed or raced — investigate before the next release |
| Unanswered requests | 1 hour | ≥5 cancelled as `confirmation_expired` | ≥20 | The studio is not seeing its pending requests, or the confirmation TTL is too short |
| Duplicate completion attempts | 1 hour | ≥1 `BOOKING_ALREADY_COMPLETED` | ≥5 | Two people closed one appointment; the unique index held, but the calendar is showing stale state |
| Backup age | 24 hours | >26 hours | >48 hours | Run backup and validate storage lifecycle |
| Restore drill | Per schema release/monthly | Not run in 31 days | Last drill failed | Block release until a passing drill |

## Log events used by alerts

- `request.error` from `instrumentation.ts`;
- `rate_limit.exceeded` from API rate limiting;
- `booking.slot_conflict` and `booking.exclusion_violation` from booking creation and rescheduling;
- `booking.confirmed`, `booking.cancelled`, `booking.no_show` and `booking.completed` from the lifecycle endpoints, which carry the booking id and nothing about the client;
- `booking.maintenance_completed` from the hold sweep, which must appear every minute;
- `health.database_failed` from the public health check;
- audit events in PostgreSQL for export, deletion, invitations and financial changes.

Never alert on raw email, phone, client name, note text, tokens or query strings. A support investigation starts from `request_id` and internal entity IDs.

## Dashboard

The minimum operational dashboard shows request count, 4xx/5xx ratio, p50/p95 latency, health status, rate-limit count, database connection usage and timestamp of the latest successful backup/restore drill. Product analytics must remain separate and contain no PII.

## Verification

Before pilot rollout:

1. Probe `/api/health` and confirm `200`, `cache-control: no-store` and a request ID.
2. Point the app at an unavailable test database and confirm `503`, `retry-after: 30` and a `health.database_failed` log.
3. Trigger a controlled application error and confirm `request.error` contains no submitted email/phone.
4. Trigger a test alert and confirm the on-call recipient acknowledges it.

