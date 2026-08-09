export type ProfitTrendChartPoint = Readonly<{
  label: string;
  valueMinor: number;
}>;

const WIDTH = 640;
const HEIGHT = 200;
const PAD_X = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;

/**
 * A line-and-area chart, drawn by hand: the project has no charting library
 * and the redesign brief rules out adding one. Server-rendered, since nothing
 * here needs a client — the labels are already chosen by the caller
 * (`buildProfitTrend` in `domain/dashboard-metrics.ts` only picks the bucket
 * size; turning a bucket into a locale label is the page's job).
 *
 * `role="img"` plus `aria-label` stand in for the visual: this is real
 * information, not decoration, so it does not get `aria-hidden` the way the
 * hand-drawn nav glyphs do.
 */
export function ProfitTrendChart({
  points,
  formatMoney,
  emptyLabel,
  title,
}: {
  points: readonly ProfitTrendChartPoint[];
  formatMoney: (minor: number) => string;
  emptyLabel: string;
  title: string;
}) {
  if (points.length < 2) {
    return <p className="muted">{emptyLabel}</p>;
  }

  const values = points.map((point) => point.valueMinor);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const plotWidth = WIDTH - PAD_X * 2;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const coords = points.map((point, index) => ({
    x: PAD_X + (index / (points.length - 1)) * plotWidth,
    y: PAD_TOP + plotHeight - ((point.valueMinor - min) / range) * plotHeight,
    label: point.label,
  }));

  const line = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const area = `${PAD_X},${PAD_TOP + plotHeight} ${line} ${PAD_X + plotWidth},${PAD_TOP + plotHeight}`;
  // Caps labels at roughly eight, however many points there are — a month of
  // daily buckets would otherwise print thirty overlapping dates.
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const last = points.at(-1)!;

  return (
    <svg
      className="profit-trend-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${title}: ${points[0].label} — ${last.label}, ${formatMoney(last.valueMinor)}`}
    >
      <polygon points={area} className="profit-trend-area" />
      <polyline points={line} className="profit-trend-line" />
      {coords.map((c, index) => (
        <circle key={index} cx={c.x} cy={c.y} r="3" className="profit-trend-dot" />
      ))}
      {coords.map((c, index) =>
        index % labelStep === 0 || index === coords.length - 1 ? (
          <text key={index} x={c.x} y={HEIGHT - 8} textAnchor="middle" className="profit-trend-axis">
            {c.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}
