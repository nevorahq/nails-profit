export type ProfitBarEntry = Readonly<{
  key: string;
  label: string;
  valueMinor: number;
}>;

/**
 * Horizontal bars, longest first. Width is relative to the largest entry, not
 * to the sum of all of them — a single dominant service should read as
 * dominant, not be squeezed down to look like a fifth of the row.
 */
export function ProfitBars({
  entries,
  formatMoney,
}: {
  entries: readonly ProfitBarEntry[];
  formatMoney: (minor: number) => string;
}) {
  const max = Math.max(1, ...entries.map((entry) => Math.max(0, entry.valueMinor)));

  return (
    <ul className="profit-bars">
      {entries.map((entry) => (
        <li key={entry.key} className="profit-bar-row">
          <span className="profit-bar-label">{entry.label}</span>
          <span className="profit-bar-track">
            <span
              className="profit-bar-fill"
              style={{ width: `${Math.max(0, Math.min(100, (entry.valueMinor / max) * 100))}%` }}
            />
          </span>
          <span className="profit-bar-value">{formatMoney(entry.valueMinor)}</span>
        </li>
      ))}
    </ul>
  );
}
