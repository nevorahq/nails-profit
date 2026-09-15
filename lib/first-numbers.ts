import { and, asc, count, eq, isNull } from "drizzle-orm";

import { bookingSettings, locations, services, specialists, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";
import { loadOnboarding, type OnboardingProgress } from "@/lib/onboarding";
import { loadServiceCosting } from "@/lib/service-costing";

/**
 * What `/app` shows a studio that has not closed a visit yet — and why that is
 * no longer a wall of zeroes.
 *
 * The dashboard answers from visits: revenue, margin, profit per hour, all of
 * them sums over work that happened. A studio on its first day has none, so the
 * page it used to get was a row of zeroes under a filter, and the product's
 * whole claim — «покажу, сколько вы зарабатываете» — went unmade until the
 * owner had done a week's work and closed the visits by hand.
 *
 * It does not have to wait. A price, a duration and a rate are enough for
 * `lib/service-costing.ts` to answer per service, which is the same question
 * asked one step earlier: not «сколько я заработала», but «сколько мне
 * приносит каждая работа». The setup screen now collects exactly those three
 * things, so the answer exists the minute the workspace does.
 *
 * Three states, decided in one place because two of them look like the third
 * from the outside:
 *   - `goal`    — setup is genuinely unfinished; the guided panel points at it.
 *   - `numbers` — set up, nothing sold yet: the catalogue's own figures.
 *   - `null`    — the studio is trading; the dashboard answers as it always has.
 */

export type FirstNumberRow = Readonly<{
  id: string;
  name: string;
  priceMinor: number;
  durationMinutes: number;
  commissionMinor: number;
  contributionMarginMinor: number;
  marginBasisPoints: number | null;
  profitPerHourMinor: number | null;
}>;

export type StartScreen =
  | Readonly<{ kind: "goal"; progress: OnboardingProgress }>
  | Readonly<{
      kind: "numbers";
      rows: readonly FirstNumberRow[];
      /** Whether an address of this studio is actually published to clients. */
      bookingPublished: boolean;
    }>
  | null;

export async function loadStartScreen(
  tx: TenantTransaction,
  locale: AppLocale,
): Promise<StartScreen> {
  /*
   * One count, paid by every studio that opens the dashboard, and the only
   * thing a trading studio pays here. A closed visit is a fact of history —
   * `visit_status` is `completed | adjusted` and there is no delete — so this
   * answer never comes back off.
   */
  const [closed] = await tx.select({ value: count() }).from(visits);
  if (closed.value > 0) return null;

  const progress = await loadOnboarding(tx);
  if (!progress.complete) return { kind: "goal", progress };

  /*
   * Costed against the first specialist, which is the same choice
   * `GET /api/v1/services` makes: the commission rule belongs to a person, and
   * on a screen about what the work is worth rather than about who did it, the
   * studio's first card is the one to ask. A solo workspace has exactly one.
   */
  const [specialist] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(isNull(specialists.archivedAt))
    .orderBy(asc(specialists.createdAt), asc(specialists.id))
    .limit(1);

  const catalogue = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt));

  const rows: FirstNumberRow[] = [];
  for (const service of catalogue) {
    const costed = await loadServiceCosting(tx, service, { specialistId: specialist?.id ?? null });
    /*
     * An incomplete service is left out rather than shown with dashes. The
     * checklist above is what reports a gap in the catalogue, in the one place
     * that can also say which gap it is; a row of «—» here would be a second,
     * vaguer version of the same news.
     */
    if (costed.status !== "complete") continue;
    rows.push({
      id: service.id,
      name: resolveLocalizedText(service.name, locale, locale) ?? "",
      priceMinor: service.priceMinor ?? 0,
      durationMinutes: service.durationMinutes ?? 0,
      commissionMinor: costed.costing.commissionMinor,
      contributionMarginMinor: costed.costing.contributionMarginMinor,
      marginBasisPoints: costed.costing.marginBasisPoints,
      profitPerHourMinor: costed.costing.profitPerHourMinor,
    });
  }

  /*
   * Whether the page clients book on is live, which is what decides if the
   * screen can hand out its address. Read from the address's own settings
   * rather than from `organization.booking_access` alone: both have to say yes,
   * and the caller knows the third condition — the deployment's own flag.
   */
  const [published] = await tx
    .select({ id: locations.id })
    .from(locations)
    .innerJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
    .where(and(eq(locations.status, "active"), eq(bookingSettings.publicStatus, "published")))
    .limit(1);

  return { kind: "numbers", rows, bookingPublished: published !== undefined };
}
