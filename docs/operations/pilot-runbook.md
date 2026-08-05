# Closed pilot runbook — Phase 6

## Purpose and boundary

Phase 6 validates the existing Costing product with real paying organizations. It does not authorize Online Booking, retention campaigns or other Phase 7 scope. Feature requests are recorded for review and do not become P0 automatically.

Gate 5 must remain healthy throughout the pilot: no open Severity 1–2 defect, financial/RBAC/E2E checks green, alert route acknowledged and a recent restore drill recorded.

## Production configuration

Set these only in the server/operator environment:

```text
PILOT_ACCESS_ENFORCEMENT=true
PILOT_MONTHLY_SUPPORT_CAPACITY_MINUTES=<founder capacity for 30 days>
PILOT_DATABASE_URL=<privileged operator connection; never expose to the app/browser>
```

With access enforcement enabled, an organization without an `active` enrollment sees a waiting screen and its tenant API calls fail closed. Local development and automated tests keep enforcement off unless they are explicitly testing rollout access.

Operator writes require a second safety switch for each command:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- <command>
```

The operator CLI accepts internal organization/issue IDs and controlled enums only. Never put a client name, phone, email, free-form support note or database credential in CLI arguments, terminal history, product events or issue codes.

## Rollout waves

1. `demo` — one internal organization;
2. `design_partner` — one reviewed design partner;
3. `first_paid` — the first three paying organizations;
4. `extended` — remaining participants, up to ten paid organizations for Gate 6.

The CLI refuses to activate the next wave until the previous wave has the required `profit_review` evidence and no open Severity 1–2 issue. Opening `extended` additionally requires three reviewed, paid `first_paid` organizations.

Create or update an enrollment:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- enroll \
  --organization <uuid> \
  --wave demo \
  --status active \
  --operator founder \
  --paid-at 2026-11-09T09:00:00Z \
  --monthly-price-minor 60000 \
  --currency MDL
```

Use `--status paused` to stop workspace/API access when enforcement is enabled. Pausing does not delete or rewrite tenant data. Resume only after the issue is resolved and the wave review is repeated.

## Evidence collection

The application automatically records versioned, deduplicated and PII-free:

- `onboarding_started` after workspace creation;
- `service_cost_completed` when a service first has trustworthy price, duration, recipe, material cost and commission;
- `visit_completed` with only a boolean complete-margin marker;
- `onboarding_completed` after the first financial snapshot;
- `import_started` and `import_completed` with counts only.

Record active operator time, never elapsed calendar time:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- interaction \
  --organization <uuid> --kind onboarding --minutes 75 --operator founder

ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- interaction \
  --organization <uuid> --kind interview --minutes 30 --operator founder

ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- interaction \
  --organization <uuid> --kind support --minutes 15 --operator founder

ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- interaction \
  --organization <uuid> --kind decision --decision-type price --operator founder

ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- interaction \
  --organization <uuid> --kind profit_review --minutes 30 --operator founder
```

Allowed decision types are `price`, `service_composition` and `material_consumption`. One organization counts once toward the Gate decision criterion even if it records several decisions.

After the second month, record both yes and no outcomes; missing outcomes never count as non-renewal or success:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- renewal \
  --organization <uuid> --renewed true --operator founder
```

## Issues and financial discrepancies

The issue register stores only an uppercase tracker code, category and severity:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- issue \
  --organization <uuid> --issue-code FIN-2026-001 \
  --category financial --severity 2 --operator founder

ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- resolve-issue \
  --issue <issue-uuid> --operator founder
```

Any open Severity 1–2 issue blocks the next rollout wave. Any open Severity 1–2 financial issue blocks Gate 6. Detailed investigation stays in the incident system under `issue-code`, following the incident runbook.

## Operating cadence

First week, every business day:

1. check health, 5xx, latency, rate limits and backup age;
2. run the Gate report and inspect coverage gaps;
3. classify new incidents before onboarding another organization;
4. review incomplete financial snapshots and import failures;
5. record support minutes immediately after the interaction.

Per organization:

1. start a timer for active onboarding work;
2. record manual corrections without copying their values into telemetry;
3. hold a 30-minute interview after the first calculation;
4. record only controlled decision categories;
5. complete a weekly `profit_review` before the next rollout wave.

## Gate 6 report

```bash
npm run pilot:ops -- report
```

The report returns `PASS` only when every roadmap criterion is both measured and satisfied. Missing onboarding time, renewal decisions or support capacity produces `NOT_READY`. The report includes no organization names or client contacts.

Exact implemented definitions:

- activation: `onboarding_completed` no later than seven days after `onboarding_started`;
- five calculated services: five distinct `service_cost_completed` events;
- WAU paid: a paid organization with at least one product event in the last seven days;
- onboarding time: sum of recorded `onboarding` minutes per paid organization, then average with complete coverage;
- support load: recorded `support` minutes in the last 30 days versus configured founder capacity;
- renewal: at least ten organizations due after two calendar months, every outcome recorded, at least six renewed and rate at least 60%;
- financial consistency: zero open Severity 1–2 financial issues.

Gate 6 cannot be passed by code or seeded/demo data. Store the dated JSON report and links to payment/renewal evidence outside the repository, without PII.

## Rollback and pause

- pause the affected enrollment rather than deleting its organization;
- do not roll back or delete product events, interactions or financial snapshots;
- resolve a bad calculation with a new snapshot version;
- for tenant isolation or financial integrity, stop the rollout and use the incident runbook;
- resume a wave only after tests pass, issues are resolved and a new `profit_review` is recorded.
