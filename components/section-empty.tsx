import Link from "next/link";

import type { BusinessType } from "@/i18n/business-labels";
import type { MessageKey } from "@/i18n/dictionary";

/**
 * What an empty section says: why it exists, and the one thing to do first.
 * Written once for the five lists — clients, visits, services, masters,
 * expenses — so they open the same way and a sixth does not grow its own.
 *
 * It takes the translator rather than a locale so a Server Component's
 * `getTranslator` and a client list's `useTranslator` both fit; a solo reader
 * and a studio get their own sentence (`business-labels.ts` explains why).
 */
export type EmptySection = "clients" | "visits" | "services" | "specialists" | "expenses";

export const emptyKeys: Record<
  EmptySection,
  { lead: Record<BusinessType, MessageKey>; action: MessageKey }
> = {
  clients: {
    lead: { solo: "empty.clients.solo", studio: "empty.clients.studio" },
    action: "empty.clients.action",
  },
  visits: {
    lead: { solo: "empty.visits.solo", studio: "empty.visits.studio" },
    action: "empty.visits.action",
  },
  services: {
    lead: { solo: "empty.services.solo", studio: "empty.services.studio" },
    action: "empty.services.action",
  },
  specialists: {
    lead: { solo: "empty.specialists.solo", studio: "empty.specialists.studio" },
    action: "empty.specialists.action",
  },
  expenses: {
    lead: { solo: "empty.expenses.solo", studio: "empty.expenses.studio" },
    action: "empty.expenses.action",
  },
};

export function SectionEmpty({
  section,
  businessType,
  t,
  action,
}: {
  section: EmptySection;
  businessType: BusinessType;
  t: (key: MessageKey) => string;
  /**
   * Where the first step is. Absent for a role that cannot take it — a button
   * the server would answer with a refusal is no offer. `#add-…` anchors open
   * the folded add panel the page's own header button opens.
   */
  action?: { href: string };
}) {
  const keys = emptyKeys[section];
  const classes = "primary-button";
  return (
    <div className="section-empty">
      <p className="muted">{t(keys.lead[businessType])}</p>
      {action &&
        (action.href.startsWith("#") ? (
          <a className={classes} href={action.href}>
            {t(keys.action)}
          </a>
        ) : (
          <Link className={classes} href={action.href}>
            {t(keys.action)}
          </Link>
        ))}
    </div>
  );
}
