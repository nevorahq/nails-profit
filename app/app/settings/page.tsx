import { asc, eq, isNull } from "drizzle-orm";

import { BillingSettings, type CheckoutConfig, type SubscriptionStatusRow } from "@/components/billing-settings";
import { DangerZone } from "@/components/danger-zone";
import { DataManagement } from "@/components/data-management";
import { StudioDeletion } from "@/components/studio-deletion";
import { OrganizationLogo } from "@/components/organization-logo";
import { OrganizationSettings } from "@/components/organization-settings";
import { type TeamMember, TeamManager } from "@/components/team-manager";
import { MaterialsModeSetting } from "@/components/materials-mode-setting";
import { PushDeviceSwitch } from "@/components/push-device-switch";
import { memberships, organizationSubscriptions, specialists, users } from "@/db/schema";
import { db } from "@/db";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { getLemonSqueezyCheckoutUrl, getPaddleCheckoutConfig, isPublicAppUrlReachable } from "@/env";
import { loadMaterialsModes, materialsModeAt, monthIn } from "@/lib/materials-mode";
import { loadOrganizationLogoVersion } from "@/lib/organization-logo";
import { loadUpcomingByUser } from "@/lib/team-workload";
import { fetchPaddlePlan, fetchPaddleSubscriptionManageUrl } from "@/lib/paddle-api";
import { AccountDeletion } from "@/components/account-deletion";
import { requireWorkspace } from "@/lib/workspace";
import { registerOf } from "@/i18n/lexicon";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  // `?edit=name` is how «Изменить название студии» on «Онлайн-запись» asks for
  // the studio's panel to arrive unfolded at its name.
  const { edit } = await searchParams;
  const workspace = await requireWorkspace();
  const {
    membership,
    organizationName,
    organizationSlug,
    locale,
    currency,
    businessType,
    staffNotices,
    detailedAnalytics,
  } = workspace;
  const register = registerOf(workspace);

  const canReadTeam = can(membership.role, "user_management", "read");
  const canReadOrg = can(membership.role, "organization_settings", "read");
  const canReadData = can(membership.role, "data_export", "read");
  const canReadFinancialSettings = can(membership.role, "expenses", "read");

  /*
   * The studio's own mark, which stands where `BrandMark`'s flower does until
   * a logo exists. Only the version is read: it decides whether the preview
   * draws the flower or an `<img>`, and it is the cache key in that image's
   * URL. Memoized per request, so the topbar above this page and the block
   * below share one query.
   */
  const logoVersion = canReadOrg ? await loadOrganizationLogoVersion(membership.organizationId) : null;

  /*
   * How the studio counts materials, for whoever sees its costs. It stays
   * here rather than moving to «Деньги» with the taxes, the payment methods
   * and the labour rules: it is a way of counting, chosen from a month on, not
   * money that comes or goes.
   */
  const materials = canReadFinancialSettings
    ? await withTenant(membership.organizationId, async (tx) => {
        const modes = await loadMaterialsModes(tx, membership.organizationId);
        const currentMonth = monthIn(new Date(), modes.timezone);
        return {
          current: materialsModeAt(modes),
          currentMonth,
          scheduled: modes.periods
            .filter((period) => period.effectiveFrom.slice(0, 7) > currentMonth)
            .map((period) => ({ mode: period.mode, month: period.effectiveFrom.slice(0, 7) })),
        };
      })
    : null;

  const subscriptionRow = canReadOrg
    ? (
        await withTenant(membership.organizationId, (tx) =>
          tx
            .select({
              provider: organizationSubscriptions.provider,
              status: organizationSubscriptions.status,
              current_period_end: organizationSubscriptions.currentPeriodEnd,
              manage_url: organizationSubscriptions.manageUrl,
              provider_subscription_id: organizationSubscriptions.providerSubscriptionId,
            })
            .from(organizationSubscriptions)
            .limit(1),
        )
      )[0] ?? null
    : null;

  const subscription: SubscriptionStatusRow | null = subscriptionRow
    ? {
        provider: subscriptionRow.provider,
        status: subscriptionRow.status,
        current_period_end: subscriptionRow.current_period_end,
        // Paddle's webhooks omit `management_urls`, so a stored link is the
        // exception; read it from the API when we have none.
        manage_url:
          subscriptionRow.manage_url ??
          (subscriptionRow.provider === "paddle"
            ? await fetchPaddleSubscriptionManageUrl(subscriptionRow.provider_subscription_id)
            : null),
      }
    : null;

  const checkout: CheckoutConfig = {
    paddle: getPaddleCheckoutConfig(),
    lemonSqueezyUrl: getLemonSqueezyCheckoutUrl(),
  };
  // Only worth a round trip to Paddle while there is a button to put it on.
  const plan = !subscription && checkout.paddle ? await fetchPaddlePlan(checkout.paddle.priceId) : null;

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

  /*
   * What removing somebody would leave behind — see `loadUpcomingByUser` for
   * why the number belongs in the confirmation rather than in the response
   * that reports what was already done.
   */
  const upcomingByUser = canReadTeam
    ? await withTenant(membership.organizationId, (tx) => loadUpcomingByUser(tx))
    : new Map<string, number>();

  const members: TeamMember[] = memberRows.map((row) => ({
    ...row,
    has_specialist_card: linkedAccounts.has(row.user_id),
    upcoming_bookings: upcomingByUser.get(row.user_id) ?? 0,
  }));

  return (
    <main className="app-shell">
      {canReadOrg && (
        <OrganizationSettings
          name={organizationName}
          slug={organizationSlug}
          startOpen={edit === "name"}
          locale={locale}
          currency={currency}
          staffNotices={staffNotices}
          detailedAnalytics={detailedAnalytics}
          canEdit={can(membership.role, "organization_settings", "write")}
        />
      )}
      {canReadOrg && (
        <OrganizationLogo
          version={logoVersion}
          canEdit={can(membership.role, "organization_settings", "write")}
          locale={locale}
        />
      )}
      {canReadOrg && (
        <BillingSettings
          plan={plan}
          register={register}
          subscription={subscription}
          checkout={checkout}
          organizationId={membership.organizationId}
          locale={locale}
        />
      )}
      {materials && (
        <MaterialsModeSetting
          current={materials.current}
          scheduled={materials.scheduled}
          currentMonth={materials.currentMonth}
          canEdit={can(membership.role, "organization_settings", "write")}
          locale={locale}
        />
      )}
      {canReadTeam && (
        <TeamManager
          members={members}
          canManage={can(membership.role, "user_management", "write")}
          locale={locale}
          businessType={businessType}
          /*
           * Owner only, and never from inside a preview — an owner two levels
           * deep would be choosing a colleague to watch while wearing another
           * colleague's face. `POST /api/v1/preview` refuses both cases on the
           * server; this only keeps the control from being offered.
           */
          canPreview={membership.role === "owner" && membership.preview === null}
          /*
           * Read on the server because the answer belongs to the deployment,
           * not the browser: `window.location.origin` would call a tunnel or a
           * proxied host public while the address the email is built on —
           * `NEXT_PUBLIC_APP_URL` — is still localhost. The send endpoint
           * decides again with the same function.
           */
          canSendEmail={isPublicAppUrlReachable()}
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
      {/*
        This device, for whoever is holding it — every role that has a bell has
        something a push could tell them. Not the studio's setting: each person
        turns it on for each phone of their own.
      */}
      {can(membership.role, "bookings", "read") && <PushDeviceSwitch locale={locale} />}
      {canReadData && (
        <DataManagement locale={locale} canExport={can(membership.role, "data_export", "read")} />
      )}

      {/*
        Leaving, which is a different act from deleting the studio and belongs
        to everybody rather than to the owner. An owner is refused by the
        endpoint until the studio itself is gone, and the order of the two is
        the part nobody could work out from here — so it is said before the
        action rather than by the refusal afterwards.

        A membership on this screen is a membership in a live organization:
        erasing a studio removes every one of them, which is how an owner ends
        up with no settings screen at all. So the role alone answers the same
        question the endpoint asks of the database.
      */}
      <DangerZone locale={locale}>
        {canReadData && can(membership.role, "data_export", "write") && (
          <StudioDeletion locale={locale} organizationName={organizationName} />
        )}
        <AccountDeletion
          locale={locale}
          email={membership.userEmail}
          blockedByStudio={membership.role === "owner"}
        />
      </DangerZone>
    </main>
  );
}
