import { asc, eq, isNull } from "drizzle-orm";

import { BillingSettings, type CheckoutConfig, type SubscriptionStatusRow } from "@/components/billing-settings";
import { DataManagement } from "@/components/data-management";
import { LaborCostManager, type LaborCostRow } from "@/components/labor-cost-manager";
import { OrganizationSettings } from "@/components/organization-settings";
import { type TeamMember, TeamManager } from "@/components/team-manager";
import { PaymentMethodManager, type PaymentMethodRow } from "@/components/payment-method-manager";
import { TaxRuleManager, type TaxRuleRowView } from "@/components/tax-rule-manager";
import {
  laborCostRules,
  memberships,
  organizations,
  organizationSubscriptions,
  paymentMethods,
  specialists,
  taxRules,
  users,
} from "@/db/schema";
import { db } from "@/db";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { getLemonSqueezyCheckoutUrl, getPaddleCheckoutConfig } from "@/env";
import { loadDashboard } from "@/lib/dashboard";
import { monthBounds, monthOf } from "@/lib/period";
import { requireWorkspace } from "@/lib/workspace";

/**
 * Temporarily keep advanced labour, acquiring and visit-tax controls off the
 * settings page without deleting their data, APIs or effect on snapshots.
 * Flip this single switch when the product is ready to expose them again.
 */
const SHOW_ADVANCED_FINANCIAL_SETTINGS = false;

export default async function SettingsPage() {
  const {
    membership,
    organizationName,
    locale,
    currency,
    businessType,
    practicalCapacityBasisPoints,
  } = await requireWorkspace();

  const canReadTeam = can(membership.role, "user_management", "read");
  const canReadOrg = can(membership.role, "organization_settings", "read");
  const canReadData = can(membership.role, "data_export", "read");
  const canReadFinancialSettings = can(membership.role, "expenses", "read");
  const canReadLabour =
    SHOW_ADVANCED_FINANCIAL_SETTINGS && canReadFinancialSettings;

  /*
   * The labour rules, whom they are for, and what the owner has already booked
   * themselves this month.
   *
   * The last of those goes into the form as its starting value: it is the
   * market rate the owner charged their own visits at, and it is the figure
   * that makes the add-back and the imputed wage cancel exactly. Read through
   * `loadDashboard` rather than a query of its own, so it is the same
   * aggregate the monthly report shows.
   */
  const labour = canReadLabour
    ? await withTenant(membership.organizationId, async (tx) => {
        const rules: LaborCostRow[] = (
          await tx
            .select({
              id: laborCostRules.id,
              recipient: laborCostRules.recipient,
              specialist_id: laborCostRules.specialistId,
              label: laborCostRules.label,
              basis: laborCostRules.basis,
              amount_minor: laborCostRules.amountMinor,
              basis_points: laborCostRules.basisPoints,
              payroll_tax_basis_points: laborCostRules.payrollTaxBasisPoints,
              active_from: laborCostRules.activeFrom,
              active_to: laborCostRules.activeTo,
            })
            .from(laborCostRules)
            .orderBy(asc(laborCostRules.activeFrom))
        ).map((rule) => ({
          ...rule,
          active_from: rule.active_from.toISOString(),
          active_to: rule.active_to?.toISOString() ?? null,
        }));

        const people = await tx
          .select({ id: specialists.id, name: specialists.name })
          .from(specialists)
          .where(isNull(specialists.archivedAt))
          .orderBy(asc(specialists.name));

        const [organization] = await tx
          .select({ reserveMinor: organizations.withdrawalReserveMinor })
          .from(organizations)
          .where(eq(organizations.id, membership.organizationId))
          .limit(1);

        const { from, to } = monthBounds(monthOf(new Date()));
        const dashboard = await loadDashboard(tx, { from, to }, locale);

        return {
          rules,
          people,
          reserveMinor: organization?.reserveMinor ?? 0,
          suggestedOwnerWageMinor: dashboard.metrics.principalLabourMinor,
        };
      })
    : null;

  /*
   * The acquirer's terms and the tax rates.
   *
   * Read under different capabilities and shown to different people: a manager
   * closes visits and needs to see which methods exist, while a tax rate is the
   * owner's business in the same way rent is.
   */
  const methods: PaymentMethodRow[] =
    SHOW_ADVANCED_FINANCIAL_SETTINGS && can(membership.role, "bookings", "read")
    ? await withTenant(membership.organizationId, (tx) =>
        tx
          .select({
            id: paymentMethods.id,
            name: paymentMethods.name,
            kind: paymentMethods.kind,
            commission_basis_points: paymentMethods.commissionBasisPoints,
            fixed_fee_minor: paymentMethods.fixedFeeMinor,
            is_default: paymentMethods.isDefault,
          })
          .from(paymentMethods)
          .where(isNull(paymentMethods.archivedAt))
          .orderBy(asc(paymentMethods.createdAt)),
      )
    : [];

  const taxes: TaxRuleRowView[] | null =
    SHOW_ADVANCED_FINANCIAL_SETTINGS && canReadFinancialSettings
    ? (
        await withTenant(membership.organizationId, (tx) =>
          tx
            .select({
              id: taxRules.id,
              kind: taxRules.kind,
              basis_points: taxRules.basisPoints,
              remittable: taxRules.remittable,
              active_from: taxRules.activeFrom,
              active_to: taxRules.activeTo,
            })
            .from(taxRules)
            .orderBy(asc(taxRules.activeFrom)),
        )
      ).map((rule) => ({
        ...rule,
        active_from: rule.active_from.toISOString(),
        active_to: rule.active_to?.toISOString() ?? null,
      }))
    : null;

  const subscription: SubscriptionStatusRow | null = canReadOrg
    ? (
        await withTenant(membership.organizationId, (tx) =>
          tx
            .select({
              provider: organizationSubscriptions.provider,
              status: organizationSubscriptions.status,
              current_period_end: organizationSubscriptions.currentPeriodEnd,
              manage_url: organizationSubscriptions.manageUrl,
            })
            .from(organizationSubscriptions)
            .limit(1),
        )
      )[0] ?? null
    : null;

  const checkout: CheckoutConfig = {
    paddle: getPaddleCheckoutConfig(),
    lemonSqueezyUrl: getLemonSqueezyCheckoutUrl(),
  };

  const memberRows = canReadTeam
    ? await db
        .select({
          id: memberships.id,
          user_id: memberships.userId,
          email: users.email,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, membership.organizationId))
        .orderBy(asc(memberships.createdAt))
    : [];

  /*
   * Which accounts the catalogue knows as a specialist. A master's calendar,
   * visits and commission all resolve through `specialist.user_id`, so a master
   * without that link signs in to an empty product and cannot be booked — a
   * state the team screen is where somebody would notice. Read separately
   * because `specialist` is tenant-scoped and `membership` is not.
   */
  const linkedAccounts = canReadTeam
    ? new Set(
        (
          await withTenant(membership.organizationId, (tx) =>
            tx
              .select({ userId: specialists.userId })
              .from(specialists)
              .where(isNull(specialists.archivedAt)),
          )
        )
          .map((row) => row.userId)
          .filter((userId): userId is string => userId !== null),
      )
    : new Set<string>();

  const members: TeamMember[] = memberRows.map((row) => ({
    ...row,
    has_specialist_card: linkedAccounts.has(row.user_id),
  }));

  return (
    <main className="app-shell">
      {canReadOrg && (
        <OrganizationSettings
          locale={locale}
          currency={currency}
          practicalCapacityBasisPoints={practicalCapacityBasisPoints}
          canEdit={can(membership.role, "organization_settings", "write")}
        />
      )}
      {canReadOrg && (
        <BillingSettings
          subscription={subscription}
          checkout={checkout}
          organizationId={membership.organizationId}
          locale={locale}
        />
      )}
      {labour && (
        <LaborCostManager
          rules={labour.rules}
          specialists={labour.people}
          currency={currency}
          locale={locale}
          businessType={businessType}
          reserveMinor={labour.reserveMinor}
          canEdit={can(membership.role, "expenses", "write")}
          suggestedOwnerWageMinor={labour.suggestedOwnerWageMinor}
        />
      )}
      {SHOW_ADVANCED_FINANCIAL_SETTINGS && can(membership.role, "bookings", "read") && (
        <PaymentMethodManager
          methods={methods}
          currency={currency}
          locale={locale}
          canEdit={can(membership.role, "organization_settings", "write")}
        />
      )}
      {taxes && (
        <TaxRuleManager
          rules={taxes}
          locale={locale}
          canEdit={can(membership.role, "expenses", "write")}
        />
      )}
      {canReadTeam && (
        <TeamManager
          members={members}
          canManage={can(membership.role, "user_management", "write")}
          locale={locale}
          /*
           * Owner only, and never from inside a preview — an owner two levels
           * deep would be choosing a colleague to watch while wearing another
           * colleague's face. `POST /api/v1/preview` refuses both cases on the
           * server; this only keeps the control from being offered.
           */
          canPreview={membership.role === "owner" && membership.preview === null}
          /*
           * Who is asking, so the row for the person themselves offers no
           * removal and a manager is not offered an owner. Both are refused by
           * the endpoint as well — this decides what the screen shows, not what
           * the server allows.
           */
          currentUserId={membership.userId}
          currentRole={membership.role}
        />
      )}
      {canReadData && (
        <DataManagement
          locale={locale}
          organizationName={organizationName}
          canExport={can(membership.role, "data_export", "read")}
          canDelete={can(membership.role, "data_export", "write")}
        />
      )}
    </main>
  );
}
