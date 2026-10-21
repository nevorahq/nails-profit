import { AppShell } from "@/components/app-shell";
import { LexiconProvider } from "@/components/lexicon-provider";
import { PushWorker } from "@/components/push-worker";
import { organizationLogoUrl } from "@/domain/avatar-image";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { registerOf } from "@/i18n/lexicon";
import { getActiveMembership } from "@/lib/membership";
import { loadOrganizationLogoVersion } from "@/lib/organization-logo";
import { readPreviewCookie } from "@/lib/preview-request";
import { organizationAllows } from "@/lib/plan";

/**
 * The shell for every signed-in screen.
 *
 * It draws nothing of its own when there is no workspace to draw it around. A
 * visitor with no session is about to be redirected to /login by the page
 * below; someone with a session and no organization gets the setup card; and a
 * pilot account that is not enrolled yet gets the access notice. All three are
 * full-page states that a sidebar of eleven sections they cannot use would only
 * be in the way of — so the layout passes `children` straight through and lets
 * those pages own the whole viewport, exactly as they did before.
 *
 * Reading the membership here costs nothing extra: `getActiveMembership` is
 * memoized for the request, so the page underneath reuses this very result.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const caller = await getActiveMembership();

  if (!caller.session || !caller.membership) return <>{children}</>;

  /*
   * The organization came with the membership: the type decides which heading
   * «Мастера» sits under, and nothing else on this screen — see `groupOf` in
   * `components/nav-items.ts`.
   *
   * The studio's own mark for the topbar is read separately — it lives in its
   * own table behind the tenant policy — and so is whether the tier opens
   * expenses. Neither needs the other, and each runs in a transaction of its
   * own on its own connection, so they are asked together rather than one after
   * the other: that is the difference between one wait and two. The logo is
   * memoized per request, so the settings page's own preview costs no second
   * query.
   */
  const organization = caller.organization;
  const [logoVersion, expensesAllowed] = await Promise.all([
    loadOrganizationLogoVersion(caller.membership.organizationId),
    organizationAllows(caller.membership.organizationId, "expenses"),
  ]);

  const { preview } = caller.membership;
  // A selection the membership check refused: the colleague left the team, or
  // the cookie outlived the account that set it. The shell renders owner mode
  // and asks the banner to clear the dead cookie — see its `stale` prop.
  const stalePreview = preview === null && (await readPreviewCookie()) !== null;

  /*
   * Who every screen under the shell is talking to — the format and the
   * detailed-analytics switch, read once here. Client components take it from
   * the provider; the shell and the server pages pass it to `getTranslator`.
   */
  const register = registerOf({
    businessType: (organization?.type ?? "solo") as BusinessType,
    detailedAnalytics: organization?.detailedAnalytics ?? false,
  });

  return (
    <LexiconProvider register={register}>
      <AppShell
        register={register}
        locale={(organization?.locale ?? "ru") as AppLocale}
        role={caller.membership.role}
        businessType={(organization?.type ?? "solo") as BusinessType}
        organizationName={organization?.name ?? ""}
        organizationLogo={organizationLogoUrl(logoVersion)}
        userEmail={caller.membership.userEmail}
        preview={
          preview && {
            targetName: preview.targetName,
            targetEmail: preview.targetEmail,
            targetRole: preview.targetRole,
            actorEmail: preview.actorEmail,
          }
        }
        stalePreview={stalePreview}
        bookingOff={organization?.bookingAccess === "off"}
        expensesOff={!expensesAllowed}
      >
        {children}
      </AppShell>
      <PushWorker />
    </LexiconProvider>
  );
}
