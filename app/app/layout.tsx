import { eq } from "drizzle-orm";

import { AppShell } from "@/components/app-shell";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import type { AppLocale } from "@/i18n/messages";
import { getActiveMembership } from "@/lib/membership";
import { readPreviewCookie } from "@/lib/preview-request";

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

  const [organization] = await db
    .select({ name: organizations.name, locale: organizations.locale })
    .from(organizations)
    .where(eq(organizations.id, caller.membership.organizationId))
    .limit(1);

  const { preview } = caller.membership;
  // A selection the membership check refused: the colleague left the team, or
  // the cookie outlived the account that set it. The shell renders owner mode
  // and asks the banner to clear the dead cookie — see its `stale` prop.
  const stalePreview = preview === null && (await readPreviewCookie()) !== null;

  return (
    <AppShell
      locale={(organization?.locale ?? "ru") as AppLocale}
      role={caller.membership.role}
      organizationName={organization?.name ?? ""}
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
    >
      {children}
    </AppShell>
  );
}
