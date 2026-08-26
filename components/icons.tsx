import type { IconName } from "@/components/nav-items";

/**
 * The navigation icons, drawn here rather than installed.
 *
 * The project has no icon library and the redesign brief rules out adding one,
 * so these are small inline paths on a shared 24-unit grid: one stroke weight, round
 * joins, and `currentColor` throughout, which is what lets the active state
 * tint the icon with the same rule that tints the label.
 *
 * They are decorative. Every one of them sits next to its own text label, so
 * `aria-hidden` is correct — a screen reader that announced both would read the
 * section name twice.
 */
const PATHS: Readonly<Record<IconName, React.ReactNode>> = {
  // Отчёт — bars under a rising line.
  report: (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 15l4-5 3 3 5-6" />
    </>
  ),
  // Отчёт за месяц — a sheet with its bottom line ruled off, the way the P&L
  // draws one under the figure it totals.
  monthReport: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h5" />
      <path d="M8 17h8" />
    </>
  ),
  // Календарь — a month with its days marked.
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
    </>
  ),
  // Онлайн-запись — a slot taken, confirmed.
  booking: (
    <>
      <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M8 3v4M16 3v4M3 11h18" />
      <path d="M16 19l2 2 4-4" />
    </>
  ),
  // Визиты — the closed-out sheet.
  visits: (
    <>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 14l2 2 4-4" />
    </>
  ),
  // Клиенты — two people.
  clients: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  // Услуги — a checked list.
  services: (
    <>
      <path d="M3 5l2 2 3-3" />
      <path d="M3 13l2 2 3-3" />
      <path d="M3 20.5l2 2 3-3" />
      <path d="M12 6h9M12 14h9M12 21h9" />
    </>
  ),
  // Опции — sliders.
  addOns: (
    <>
      <path d="M3 7h5M13 7h8M3 17h9M17 17h4" />
      <circle cx="10.5" cy="7" r="2.5" />
      <circle cx="14.5" cy="17" r="2.5" />
    </>
  ),
  // Затраты — a wallet with its clasp pocket.
  expenses: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M17 11h4v4h-4a2 2 0 0 1 0-4z" />
    </>
  ),
  // Мастера — a person with a setting.
  specialists: (
    <>
      <circle cx="10" cy="7" r="4" />
      <path d="M3 21v-2a4 4 0 0 1 4-4h5" />
      <circle cx="18" cy="17" r="3" />
      <path d="M18 13.5v1M18 19.5v1M21 17h-1M16 17h-1" />
    </>
  ),
  // Импорт — upload.
  import: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v13" />
    </>
  ),
  // Настройки — a gear.
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  // Ещё — the overflow dots.
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
};

export function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * The glyphs the calendar toolbar needs. Same grid and weight as the
 * navigation set, and decorative for the same reason — each sits beside its own
 * label, so announcing them would read the control's name twice.
 *
 * `minus` renders alongside `plus` inside the mobile round button
 * (`.header-action`) rather than replacing it: which one shows is a CSS
 * `:has()` swap keyed on the compose `<details>`'s open state, so the icon
 * tracks the panel whether it was opened from that button, the toolbar's own
 * button, or the summary itself — no JS needed just to pick the glyph.
 */
export function ToolIcon({ name }: { name: "filter" | "plus" | "minus" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
  };
  return (
    <svg
      className={`tool-icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

/** The period-card glyphs on the reports page, one per figure. */
export function MetricIcon({ name }: { name: "revenue" | "expenses" | "profit" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    revenue: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M3 10.5h18" />
        <path d="M15 15h3" />
      </>
    ),
    // Затраты — a receipt.
    expenses: (
      <>
        <path d="M6 3h12v17l-3-1.6-3 1.6-3-1.6L6 20V3z" />
        <path d="M9 8h6M9 12h4" />
      </>
    ),
    profit: (
      <>
        <path d="M4 16l6-6 4 4 6-7" />
        <path d="M15 6h5v5" />
      </>
    ),
  };
  return (
    <svg
      className={`metric-card-icon-glyph icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

/**
 * The account menu's glyphs, kept separate from `NavIcon` because neither
 * names a navigation section.
 */
export function ChromeIcon({ name }: { name: "chevron" | "signOut" | "bell" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    chevron: <path d="M6 9l6 6 6-6" />,
    // Выйти — a door with an arrow leaving through it.
    signOut: (
      <>
        <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
        <path d="M10 8l-4 4 4 4" />
        <path d="M6 12h9" />
      </>
    ),
    bell: (
      <>
        <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5z" />
        <path d="M9.5 18.5a2.5 2.5 0 0 0 5 0" />
      </>
    ),
  };
  return (
    <svg
      className={`chrome-icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

/** The mark next to the product name in the sidebar. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2.5c1.7 0 3 1.5 3 3.3 0 .6-.1 1.1-.4 1.6 1.5-.9 3.4-.5 4.3 1 .8 1.5.3 3.4-1.2 4.3-.5.3-1 .4-1.6.5.5.2 1 .5 1.4.9 1.2 1.2 1.2 3.2 0 4.5-1.2 1.2-3.2 1.2-4.4 0-.4-.4-.7-.9-.9-1.4-.2.5-.5 1-.9 1.4-1.2 1.2-3.2 1.2-4.4 0-1.2-1.3-1.2-3.3 0-4.5.4-.4.9-.7 1.4-.9-.6-.1-1.1-.2-1.6-.5-1.5-.9-2-2.8-1.2-4.3.9-1.5 2.8-1.9 4.3-1-.3-.5-.4-1-.4-1.6 0-1.8 1.3-3.3 3-3.3z"
      />
      <circle cx="12" cy="12" r="2.4" fill="var(--surface)" />
    </svg>
  );
}
