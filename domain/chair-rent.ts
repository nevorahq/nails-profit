/**
 * What masters renting a chair owe the studio in a month.
 *
 * The studio's income from a rented chair is the rent and nothing else — the
 * renter's visits are theirs, and `lib/dashboard.ts` keeps them out of the
 * studio's revenue. This is the other half: the amount that takes their place.
 *
 * Read by month exactly as a salary is (`domain/labor-cost.ts`): a rent agreed
 * on the 15th is owed for that month, one ended on the 10th was owed for the
 * month it ended in, and when two versions touch one month the newer wins.
 * Anything finer would need a proration nobody agreed.
 *
 * Pure: no database, no locale.
 */

export type ChairRentRow = Readonly<{
  id: string;
  specialistId: string;
  amountMinor: number;
  activeFrom: Date;
  activeTo: Date | null;
}>;

/** `YYYY-MM` of an instant, in UTC — the key the rest of the month report uses. */
function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The rent in force in `month`, one per master. */
export function selectChairRents(rows: readonly ChairRentRow[], month: string): readonly ChairRentRow[] {
  const newest = new Map<string, ChairRentRow>();
  for (const row of rows) {
    // Ended at its own start: a rent scheduled and called off before it began.
    // It was never owed, though by months alone it would look like one.
    if (row.activeTo !== null && row.activeTo.getTime() <= row.activeFrom.getTime()) continue;
    if (monthOf(row.activeFrom) > month) continue;
    if (row.activeTo !== null && monthOf(row.activeTo) < month) continue;
    const held = newest.get(row.specialistId);
    if (!held || row.activeFrom.getTime() >= held.activeFrom.getTime()) newest.set(row.specialistId, row);
  }
  return [...newest.values()];
}

export function chairRentTotalMinor(rows: readonly ChairRentRow[]): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}
