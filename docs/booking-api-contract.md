# Online Booking API contract — roadmap §7.6

## Status

The §7.6 route set is implemented and protected by an executable source-level contract in `tests/booking-api-contract.test.ts`. Runtime E2E suites cover authorization, tenant isolation, validation envelopes, concurrency, idempotency and lifecycle transitions.

This status closes the technical API section, not Gate 7. Public production rollout remains controlled by `PUBLIC_BOOKING_ENABLED` and each organization's `booking_access`.

## Common contract

- Base path: `/api/v1`.
- JSON requests use `content-type: application/json`.
- All timestamps are ISO 8601 UTC strings; location timezone is returned separately where a wall-clock display needs it.
- Success: `{ "data": ..., "request_id": "..." }`.
- Failure: `{ "error": { "code": "...", "message": "...", "field_errors"?: [...], "details"?: ... }, "request_id": "..." }`.
- Every response carries `x-request-id`; support starts from that ID, never from copied client PII.
- Unknown, paused and unpublished public organizations are intentionally indistinguishable.
- Public mutations use independent rate-limit buckets. Suspicious repeated mutation failures can require the proof-of-work challenge.
- Cookie-authenticated staff mutations reject cross-site browser requests through the shared membership guard.

## Idempotency and optimistic concurrency

`Idempotency-Key` is required for:

- `POST /public/booking/{slug}/bookings`;
- `POST /public/bookings/{token}/reschedule`;
- `POST /bookings`.

The same key and payload replay the original result; the same key with another payload returns `409`. Booking updates/reschedules use the current integer `version` and return `VERSION_CONFLICT` when a stale client attempts to overwrite a newer state.

## Public API

Public routes require no account. Slug, hold and manage tokens are the only external identifiers; internal organization IDs, client contacts, notes and complete staff schedules are never returned.

| Method | Path | Purpose |
|---|---|---|
| GET | `/public/booking/{slug}` | Safe profile, published locations and notification channel |
| GET | `/public/booking/{slug}/catalog` | Bookable services, add-ons and eligible specialists |
| GET | `/public/booking/{slug}/availability` | Available slots for a local date/filter set |
| POST | `/public/booking/{slug}/holds` | Five-minute resource hold |
| POST | `/public/booking/{slug}/bookings` | Atomically convert a verified hold into a booking |
| POST | `/public/booking/{slug}/verify` | Request or confirm a one-time contact code |
| GET | `/public/bookings/{token}` | Purpose-bound safe booking view |
| POST | `/public/bookings/{token}/reschedule` | Move to a slot returned by Availability Engine |
| POST | `/public/bookings/{token}/cancel` | Cancel after optimistic version check |

With `NOTIFICATION_PROVIDER=resend`, profile returns `notification_channel=email`, public email is required and the code verifies that normalized email. Phone remains a client contact; the application does not promise or enqueue SMS.

## Internal API

Staff routes require an active session, active pilot access where enforcement is enabled, tenant membership, booking feature access and the RBAC scope of the caller.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/bookings` | Filtered list and atomic staff creation |
| GET/PATCH | `/bookings/{id}` | Card and non-lifecycle optimistic update |
| POST | `/bookings/{id}/confirm` | Confirm a pending request |
| POST | `/bookings/{id}/reschedule` | Transactional move with alternatives on conflict |
| POST | `/bookings/{id}/cancel` | Cancel with controlled reason/actor |
| POST | `/bookings/{id}/no-show` | Record a no-show |
| POST | `/bookings/{id}/complete` | Create/link a visit through the shared profit snapshot flow |
| GET/PUT | `/availability/rules` | Read or replace weekly schedules |
| GET/POST/DELETE | `/availability/exceptions` | Read, create or remove schedule exceptions |

`POST /bookings/{id}/manage-link` is an additive §7.7 endpoint: it reissues a manage link through the notification outbox and never returns the raw token to staff.

## Compatibility rule

Changes within `/api/v1` are additive: optional response fields and new stable error codes may be added. Removing/renaming fields, changing status semantics, weakening idempotency or accepting a different timestamp interpretation requires a new API version and migration plan.

