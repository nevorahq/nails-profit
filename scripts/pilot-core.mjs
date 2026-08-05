const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function secondMonthDue(paidAt, now) {
  const due = asDate(paidAt);
  due.setUTCMonth(due.getUTCMonth() + 2);
  return due <= now;
}

function criterion(key, label, actual, target, passed, coverage = null) {
  return { key, label, actual, target, passed, coverage };
}

/**
 * Pure Gate 6 calculation. Inputs are PII-free rows returned by the operator
 * query, which keeps the report testable without a database or a production
 * analytics vendor.
 */
export function buildPilotGateReport({
  enrollments,
  events,
  interactions,
  issues,
  now = new Date(),
  supportCapacityMinutes = null,
}) {
  const reportTime = asDate(now);
  const paid = enrollments.filter((row) => row.paid_at !== null);
  const paidIds = new Set(paid.map((row) => row.organization_id));
  const eventsByOrganization = new Map();
  const interactionsByOrganization = new Map();

  for (const event of events) {
    const rows = eventsByOrganization.get(event.organization_id) ?? [];
    rows.push(event);
    eventsByOrganization.set(event.organization_id, rows);
  }
  for (const interaction of interactions) {
    const rows = interactionsByOrganization.get(interaction.organization_id) ?? [];
    rows.push(interaction);
    interactionsByOrganization.set(interaction.organization_id, rows);
  }

  let activated = 0;
  let withFiveServices = 0;
  let activeThisWeek = 0;
  let decisionOrganizations = 0;
  const onboardingMinutes = [];

  const weeklyThreshold = new Date(reportTime.getTime() - 7 * DAY_MS);
  for (const enrollment of paid) {
    const organizationEvents = eventsByOrganization.get(enrollment.organization_id) ?? [];
    const organizationInteractions = interactionsByOrganization.get(enrollment.organization_id) ?? [];
    const started = organizationEvents
      .filter((event) => event.event_name === "onboarding_started")
      .map((event) => asDate(event.occurred_at))
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? asDate(enrollment.enrolled_at);
    const completed = organizationEvents
      .filter((event) => event.event_name === "onboarding_completed")
      .map((event) => asDate(event.occurred_at))
      .sort((left, right) => left.getTime() - right.getTime())[0];

    if (completed && completed >= started && completed.getTime() - started.getTime() <= 7 * DAY_MS) {
      activated += 1;
    }

    const calculatedServices = new Set(
      organizationEvents
        .filter((event) => event.event_name === "service_cost_completed")
        .map((event) => event.entity_id),
    );
    if (calculatedServices.size >= 5) withFiveServices += 1;

    if (organizationEvents.some((event) => asDate(event.occurred_at) >= weeklyThreshold)) {
      activeThisWeek += 1;
    }

    if (organizationInteractions.some((row) => row.kind === "decision")) {
      decisionOrganizations += 1;
    }

    const measuredOnboarding = organizationInteractions
      .filter((row) => row.kind === "onboarding")
      .reduce((sum, row) => sum + (row.duration_minutes ?? 0), 0);
    if (measuredOnboarding > 0) onboardingMinutes.push(measuredOnboarding);
  }

  const renewalEligible = paid.filter((row) => secondMonthDue(row.paid_at, reportTime));
  const renewalRecorded = renewalEligible.filter((row) => row.renewed_second_month !== null);
  const renewed = renewalEligible.filter((row) => row.renewed_second_month === true);
  const openCriticalFinancialIssues = issues.filter(
    (row) =>
      paidIds.has(row.organization_id) &&
      row.category === "financial" &&
      row.status === "open" &&
      row.severity <= 2,
  );

  const supportThreshold = new Date(reportTime.getTime() - 30 * DAY_MS);
  const supportMinutes = interactions
    .filter(
      (row) =>
        paidIds.has(row.organization_id) &&
        row.kind === "support" &&
        asDate(row.occurred_at) >= supportThreshold,
    )
    .reduce((sum, row) => sum + (row.duration_minutes ?? 0), 0);

  const onboardingAverage = average(onboardingMinutes);
  const activationRate = ratio(activated, paid.length);
  const weeklyActiveRate = ratio(activeThisWeek, paid.length);
  const renewalRate = ratio(renewed.length, renewalEligible.length);
  const mrrMinor = paid.reduce((sum, row) => sum + Number(row.monthly_price_minor ?? 0), 0);

  const criteria = [
    criterion("paid", "Paying organizations", paid.length, ">= 10", paid.length >= 10),
    criterion(
      "activation",
      "Activated within seven days",
      activationRate,
      ">= 70%",
      paid.length >= 10 && activationRate >= 0.7,
      `${activated}/${paid.length}`,
    ),
    criterion(
      "five_services",
      "Organizations with five calculated services",
      withFiveServices,
      ">= 7",
      withFiveServices >= 7,
    ),
    criterion(
      "decisions",
      "Organizations with a recorded management decision",
      decisionOrganizations,
      ">= 6",
      decisionOrganizations >= 6,
    ),
    criterion(
      "renewal",
      "Second-month renewal",
      renewalRate,
      ">= 60% and >= 10 eligible decisions recorded",
      renewalEligible.length >= 10 &&
        renewalRecorded.length === renewalEligible.length &&
        renewed.length >= 6 &&
        renewalRate >= 0.6,
      `${renewalRecorded.length}/${renewalEligible.length} decisions`,
    ),
    criterion(
      "weekly_active",
      "Weekly active among paid",
      weeklyActiveRate,
      ">= 60%",
      paid.length >= 10 && weeklyActiveRate >= 0.6,
      `${activeThisWeek}/${paid.length}`,
    ),
    criterion(
      "onboarding",
      "Average measured onboarding time",
      onboardingAverage,
      "< 120 minutes with complete measurement",
      paid.length >= 10 && onboardingMinutes.length === paid.length && onboardingAverage !== null && onboardingAverage < 120,
      `${onboardingMinutes.length}/${paid.length} measured`,
    ),
    criterion(
      "financial_consistency",
      "Open critical financial discrepancies",
      openCriticalFinancialIssues.length,
      "0",
      openCriticalFinancialIssues.length === 0,
    ),
    criterion(
      "support_capacity",
      "Support within founder capacity (last 30 days)",
      supportMinutes,
      supportCapacityMinutes === null ? "capacity input required" : `<= ${supportCapacityMinutes} minutes`,
      supportCapacityMinutes !== null && supportMinutes <= supportCapacityMinutes,
      supportCapacityMinutes === null ? null : `${supportMinutes}/${supportCapacityMinutes} minutes`,
    ),
  ];

  return {
    generated_at: reportTime.toISOString(),
    verdict: criteria.every((row) => row.passed) ? "PASS" : "NOT_READY",
    metrics: {
      enrolled_organizations: enrollments.length,
      paid_organizations: paid.length,
      mrr_minor: mrrMinor,
      arpa_minor: paid.length === 0 ? 0 : Math.round(mrrMinor / paid.length),
      activation_rate: activationRate,
      five_service_organizations: withFiveServices,
      decision_organizations: decisionOrganizations,
      renewal_rate: renewalRate,
      weekly_active_rate: weeklyActiveRate,
      onboarding_average_minutes: onboardingAverage,
      support_minutes_last_30_days: supportMinutes,
      support_minutes_per_paid:
        paid.length === 0 ? 0 : Math.round((supportMinutes / paid.length) * 10) / 10,
      open_critical_financial_issues: openCriticalFinancialIssues.length,
    },
    criteria,
  };
}

export function parsePilotArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}
