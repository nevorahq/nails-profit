#!/usr/bin/env node

import { buildPilotGateReport, parsePilotArgs } from "./pilot-core.mjs";
import { openOperatorConnection } from "./ops-connection.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAVES = new Set(["demo", "design_partner", "first_paid", "extended"]);
const STATUSES = new Set(["pending", "active", "paused", "completed", "withdrawn"]);
const INTERACTIONS = new Set(["onboarding", "interview", "profit_review", "support", "decision"]);
const BOOKING_ACCESS_LEVELS = new Set(["off", "calendar", "public"]);
const DECISIONS = new Set(["price", "service_composition", "material_consumption"]);
const ISSUE_CATEGORIES = new Set(["financial", "technical", "privacy", "support"]);

function fail(message) {
  throw new Error(message);
}

function required(values, key) {
  const value = values[key];
  if (!value) fail(`--${key.replaceAll("_", "-")} is required`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.has(value)) fail(`${label} must be one of: ${[...allowed].join(", ")}`);
  return value;
}

function uuid(value, label) {
  if (!UUID_PATTERN.test(value)) fail(`${label} must be a UUID`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function instant(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`${label} must be an ISO date/time`);
  return parsed;
}

function requireWriteApproval() {
  if (process.env.ALLOW_PILOT_OPERATOR_WRITE !== "1") {
    fail("Refusing an operator write. Set ALLOW_PILOT_OPERATOR_WRITE=1 after verifying the database target.");
  }
}

async function requireOrganization(sql, organizationId) {
  const [organization] = await sql`
    select id from organization where id = ${organizationId} and deleted_at is null limit 1
  `;
  if (!organization) fail("Organization does not exist or is deleted");
}

async function requirePreviousWaveReview(sql, wave, status) {
  if (status !== "active" || wave === "demo") return;
  const previousWave =
    wave === "design_partner"
      ? "demo"
      : wave === "first_paid"
        ? "design_partner"
        : "first_paid";
  const requiredOrganizations = wave === "extended" ? 3 : 1;

  const [{ eligible, reviewed, blockers }] = await sql`
    select
      count(distinct p.organization_id)::int as eligible,
      count(distinct case when r.organization_id is not null then p.organization_id end)::int as reviewed,
      count(distinct case when i.id is not null then p.organization_id end)::int as blockers
    from pilot_enrollment p
    left join pilot_interaction r
      on r.organization_id = p.organization_id and r.kind = 'profit_review'
    left join pilot_issue i
      on i.organization_id = p.organization_id and i.status = 'open' and i.severity <= 2
    where p.wave = ${previousWave}
      and p.status in ('active', 'completed')
      and (${wave} <> 'extended' or p.paid_at is not null)
  `;

  if (blockers > 0) {
    fail(`Cannot activate ${wave}: the previous wave has open Severity 1-2 issues`);
  }
  if (eligible < requiredOrganizations || reviewed < requiredOrganizations) {
    fail(
      `Cannot activate ${wave}: the previous wave needs ${requiredOrganizations} organization(s) with a recorded profit_review`,
    );
  }
}

async function enroll(sql, values) {
  requireWriteApproval();
  const organizationId = uuid(required(values, "organization"), "organization");
  const operator = required(values, "operator");
  await requireOrganization(sql, organizationId);

  const [existing] = await sql`
    select * from pilot_enrollment where organization_id = ${organizationId} limit 1
  `;
  const wave = values.wave
    ? oneOf(values.wave, WAVES, "wave")
    : existing?.wave ?? fail("--wave is required for a new enrollment");
  const status = values.status
    ? oneOf(values.status, STATUSES, "status")
    : existing?.status ?? "pending";
  const paidAt = values.paid_at
    ? values.paid_at === "none"
      ? null
      : instant(values.paid_at, "paid-at")
    : existing?.paid_at ?? null;
  const monthlyPriceMinor = values.monthly_price_minor
    ? nonNegativeInteger(values.monthly_price_minor, "monthly-price-minor")
    : existing?.monthly_price_minor ?? null;
  const billingCurrency = values.currency ?? existing?.billing_currency ?? null;

  if (billingCurrency !== null && billingCurrency !== "MDL" && billingCurrency !== "EUR") {
    fail("currency must be MDL or EUR");
  }
  if ((monthlyPriceMinor === null) !== (billingCurrency === null)) {
    fail("monthly-price-minor and currency must be supplied together");
  }
  if (monthlyPriceMinor !== null && paidAt === null) fail("paid-at is required when a price is recorded");
  await requirePreviousWaveReview(sql, wave, status);

  const [row] = await sql`
    insert into pilot_enrollment (
      organization_id, wave, status, paid_at, monthly_price_minor,
      billing_currency, operator_ref, updated_at
    ) values (
      ${organizationId}, ${wave}, ${status}, ${paidAt}, ${monthlyPriceMinor},
      ${billingCurrency}, ${operator}, now()
    )
    on conflict (organization_id) do update set
      wave = excluded.wave,
      status = excluded.status,
      paid_at = excluded.paid_at,
      monthly_price_minor = excluded.monthly_price_minor,
      billing_currency = excluded.billing_currency,
      operator_ref = excluded.operator_ref,
      updated_at = now()
    returning *
  `;
  return row;
}

async function recordInteraction(sql, values) {
  requireWriteApproval();
  const organizationId = uuid(required(values, "organization"), "organization");
  const operator = required(values, "operator");
  const kind = oneOf(required(values, "kind"), INTERACTIONS, "kind");
  const duration = values.minutes ? positiveInteger(values.minutes, "minutes") : null;
  const decisionType = values.decision_type
    ? oneOf(values.decision_type, DECISIONS, "decision-type")
    : null;
  const occurredAt = values.occurred_at ? instant(values.occurred_at, "occurred-at") : new Date();
  if (kind === "decision" && decisionType === null) fail("--decision-type is required for a decision");
  if (kind !== "decision" && decisionType !== null) fail("--decision-type is valid only for a decision");
  if (kind !== "decision" && duration === null) fail("--minutes is required for timed interactions");
  await requireOrganization(sql, organizationId);

  const [row] = await sql`
    insert into pilot_interaction (
      organization_id, kind, duration_minutes, decision_type, recorded_by, occurred_at
    ) values (
      ${organizationId}, ${kind}, ${duration}, ${decisionType}, ${operator}, ${occurredAt}
    ) returning *
  `;
  return row;
}

async function recordRenewal(sql, values) {
  requireWriteApproval();
  const organizationId = uuid(required(values, "organization"), "organization");
  const operator = required(values, "operator");
  const renewedText = required(values, "renewed");
  if (renewedText !== "true" && renewedText !== "false") fail("renewed must be true or false");

  const [row] = await sql`
    update pilot_enrollment
       set renewed_second_month = ${renewedText === "true"},
           renewal_recorded_at = now(),
           operator_ref = ${operator},
           updated_at = now()
     where organization_id = ${organizationId}
     returning *
  `;
  if (!row) fail("Organization is not enrolled in the pilot");
  return row;
}

async function recordIssue(sql, values) {
  requireWriteApproval();
  const organizationId = uuid(required(values, "organization"), "organization");
  const operator = required(values, "operator");
  const issueCode = required(values, "issue_code");
  const category = oneOf(required(values, "category"), ISSUE_CATEGORIES, "category");
  const severity = positiveInteger(required(values, "severity"), "severity");
  if (severity > 3) fail("severity must be 1, 2 or 3");
  if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(issueCode)) {
    fail("issue-code must be a 3-64 character uppercase identifier without PII");
  }
  await requireOrganization(sql, organizationId);

  const [row] = await sql`
    insert into pilot_issue (
      organization_id, issue_code, category, severity, recorded_by
    ) values (
      ${organizationId}, ${issueCode}, ${category}, ${severity}, ${operator}
    ) returning *
  `;
  return row;
}

async function resolveIssue(sql, values) {
  requireWriteApproval();
  const issueId = uuid(required(values, "issue"), "issue");
  const operator = required(values, "operator");
  const [row] = await sql`
    update pilot_issue
       set status = 'resolved', resolved_by = ${operator}, resolved_at = now(), updated_at = now()
     where id = ${issueId} and status = 'open'
     returning *
  `;
  if (!row) fail("Open issue not found");
  return row;
}

/**
 * The rollout switch of roadmap section 7.11, moved by the operator.
 *
 * Stepping up to `public` is deliberately not something a studio can do from
 * its own settings screen: it is the moment a page becomes reachable by
 * strangers, and section 7.11 puts it after the security and concurrency gates
 * rather than after an owner's click. Stepping down is available in both
 * places — a rollback nobody can perform at 2am is not a rollback.
 */
async function setBookingAccess(sql, values) {
  requireWriteApproval();
  const organizationId = uuid(required(values, "organization"), "organization");
  const level = oneOf(required(values, "level"), BOOKING_ACCESS_LEVELS, "level");
  const operator = required(values, "operator");
  await requireOrganization(sql, organizationId);

  const [row] = await sql`
    update organization
       set booking_access = ${level}::booking_access_level, updated_at = now()
     where id = ${organizationId} and deleted_at is null
    returning id, booking_access
  `;
  if (!row) fail("Organization not found");

  // The audit trail is the tenant's, so the change is visible to the studio
  // whose product just changed, not only in an operator's shell history.
  await sql`
    insert into audit_event
           (organization_id, actor_user_id, event_type, entity_type, entity_id, after, request_id)
    values (${organizationId}, null, 'organization.booking_access_changed', 'organization',
            ${organizationId}, ${sql.json({ booking_access: level, operator })},
            ${`operator:${crypto.randomUUID()}`})
  `;

  return row;
}

async function report(sql, values) {
  const [enrollments, events, interactions, issues] = await Promise.all([
    sql`select organization_id, paid_at, monthly_price_minor, renewed_second_month, enrolled_at
          from pilot_enrollment where status <> 'withdrawn'`,
    sql`select e.organization_id, e.event_name, e.entity_id, e.occurred_at
          from pilot_product_event e
          inner join pilot_enrollment p on p.organization_id = e.organization_id
         where p.status <> 'withdrawn'`,
    sql`select i.organization_id, i.kind, i.duration_minutes, i.decision_type, i.occurred_at
          from pilot_interaction i
          inner join pilot_enrollment p on p.organization_id = i.organization_id
         where p.status <> 'withdrawn'`,
    sql`select i.organization_id, i.category, i.severity, i.status
          from pilot_issue i
          inner join pilot_enrollment p on p.organization_id = i.organization_id
         where p.status <> 'withdrawn'`,
  ]);
  const rawCapacity = values.support_capacity_minutes ?? process.env.PILOT_MONTHLY_SUPPORT_CAPACITY_MINUTES;
  const supportCapacityMinutes = rawCapacity
    ? positiveInteger(rawCapacity, "support-capacity-minutes")
    : null;
  return buildPilotGateReport({
    enrollments,
    events,
    interactions,
    issues,
    supportCapacityMinutes,
    now: values.at ? instant(values.at, "at") : new Date(),
  });
}

function usage() {
  return `Pilot operator CLI (never put client PII in arguments)

  pilot:ops -- report [--support-capacity-minutes N] [--at ISO]
  pilot:ops -- enroll --organization UUID --wave WAVE --status STATUS --operator REF
                         [--paid-at ISO] [--monthly-price-minor N --currency MDL|EUR]
  pilot:ops -- interaction --organization UUID --kind KIND --operator REF
                              [--minutes N] [--decision-type TYPE] [--occurred-at ISO]
  pilot:ops -- renewal --organization UUID --renewed true|false --operator REF
  pilot:ops -- issue --organization UUID --issue-code CODE --category CATEGORY
                        --severity 1|2|3 --operator REF
  pilot:ops -- resolve-issue --issue UUID --operator REF
  pilot:ops -- booking-access --organization UUID --level off|calendar|public --operator REF

Write commands require ALLOW_PILOT_OPERATOR_WRITE=1.`;
}

const { command, values } = parsePilotArgs(process.argv.slice(2));
if (!command || command === "help") {
  console.log(usage());
  process.exit(0);
}

// Naming the variable is not enough on its own: pointed at the application's
// role, every one of these commands would read an empty database and write
// nothing that a policy lets through.
const sql = await openOperatorConnection(process.env, [
  "PILOT_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
]);

try {
  const result =
    command === "report"
      ? await report(sql, values)
      : command === "enroll"
        ? await enroll(sql, values)
        : command === "interaction"
          ? await recordInteraction(sql, values)
          : command === "renewal"
            ? await recordRenewal(sql, values)
            : command === "issue"
              ? await recordIssue(sql, values)
              : command === "resolve-issue"
                ? await resolveIssue(sql, values)
                : command === "booking-access"
                  ? await setBookingAccess(sql, values)
                  : fail(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
