import { eq } from "drizzle-orm";

import { specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { headlineKindFor, ownerHeadline, visitsHeadline, type Headline } from "@/domain/headline";
import type { MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { loadDashboard } from "@/lib/dashboard";
import { loadPeriodPL, monthBounds } from "@/lib/period";

/**
 * The figure the report opens with, read the way «Месяц подробно» reads it.
 *
 * For the owner this *is* `loadPeriodPL` — the card takes its bottom line, so
 * the two screens cannot drift apart without one of them stopping being this
 * call. `tests/integration/headline.test.ts` holds them equal on real rows.
 *
 * `ownSpecialistId` is the caller's own card when the role is limited to its
 * own rows, and is ignored otherwise: the card is the studio's month even when
 * the report below it has been narrowed to one master, because rent is not
 * split per master and the card's figure is a month's, not a filter's.
 */
export async function loadHeadline(
  tx: TenantTransaction,
  options: Readonly<{
    role: MemberRole;
    month: string;
    currency: string;
    organizationId: string;
    ownSpecialistId: string | null;
  }>,
  locale: AppLocale,
): Promise<Headline> {
  const kind = headlineKindFor(options.role);

  if (kind === "operating") {
    const report = await loadPeriodPL(
      tx,
      { month: options.month, currency: options.currency, organizationId: options.organizationId },
      locale,
    );
    return ownerHeadline(report.pl, report.capacity);
  }

  const { from, to } = monthBounds(options.month);
  const { metrics } = await loadDashboard(
    tx,
    {
      from,
      to,
      // A role limited to its own rows with no card of its own has earned
      // nothing here; an absent id would widen the read to everybody's.
      specialistId:
        kind === "earnings" ? (options.ownSpecialistId ?? "00000000-0000-0000-0000-000000000000") : null,
    },
    locale,
  );
  // Only asked when the month has no visits to say it: the snapshots answer
  // for every month that has.
  const rentsChair =
    kind === "earnings" && metrics.visits === 0 && options.ownSpecialistId
      ? (
          await tx
            .select({ cooperationType: specialists.cooperationType })
            .from(specialists)
            .where(eq(specialists.id, options.ownSpecialistId))
            .limit(1)
        )[0]?.cooperationType === "rent"
      : false;
  return visitsHeadline(kind, metrics, { rentsChair });
}
