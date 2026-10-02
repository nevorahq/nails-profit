import { allocateProportionally } from "@/domain/money";
import { commissionOfLines, type CommissionTerms } from "@/domain/visit-commission";

/**
 * One visit's figures, split between the services it was made of.
 *
 * The ranking of services used to count a visit whole against its service,
 * which was right while a visit held one. A manicure and a pedicure closed
 * together would otherwise credit the pedicure's money and time to the
 * manicure, and make the pedicure look like nothing anybody books.
 *
 * What a line says is taken exactly: each service's revenue is what its own
 * lines charged, and its commission is what its own rule paid on them. What a
 * line does not say is shared out: VAT, turnover tax and the acquirer's fee in
 * proportion to revenue, payroll tax in proportion to commission, the minutes
 * in proportion to each service's planned time. Every share is a
 * largest-remainder split of the snapshot's own figure, so the parts add up to
 * the visit to the unit and the ranking's total is the dashboard's.
 */

export type SplitLine = Readonly<{
  /** Null on an add-on written before add-ons named their service. */
  serviceId: string | null;
  priceMinor: number;
  discountMinor: number;
  refundMinor: number;
  commissionable: boolean;
  commissionTerms: CommissionTerms | null;
  durationMinutes: number;
}>;

/** The snapshot's figures, as the dashboard reads them; null terms count as zero. */
export type SplitFigures = Readonly<{
  revenueMinor: number;
  commissionMinor: number;
  vatMinor: number;
  turnoverTaxMinor: number;
  payrollTaxMinor: number;
  paymentCommissionMinor: number;
  durationMinutes: number;
}>;

export type ServicePart = Readonly<{
  serviceId: string;
  revenueMinor: number;
  commissionMinor: number;
  contributionMarginMinor: number;
  durationMinutes: number;
}>;

function sumBy<T>(items: readonly T[], pick: (item: T) => number) {
  return items.reduce((total, item) => total + pick(item), 0);
}

/**
 * Null when the visit is a single service: the caller counts it whole, exactly
 * as it always has, and no allocation can move a unit of it.
 */
export function splitVisitByService(
  figures: SplitFigures,
  lines: readonly SplitLine[],
  fallback: CommissionTerms,
): ServicePart[] | null {
  const serviceIds = [...new Set(lines.flatMap((line) => (line.serviceId ? [line.serviceId] : [])))];
  if (serviceIds.length < 2) return null;

  // Anything that names no service belongs to the first, as it did when the
  // first was the only one.
  const ownerOf = (line: SplitLine) => line.serviceId ?? serviceIds[0];
  const indexOf = new Map(serviceIds.map((serviceId, index) => [serviceId, index]));

  const revenueWeights = serviceIds.map((serviceId) =>
    sumBy(
      lines.filter((line) => ownerOf(line) === serviceId),
      (line) => line.priceMinor - line.discountMinor - line.refundMinor,
    ),
  );

  // Each rule's commission goes to the services of its own lines, by what each
  // contributed to its base — so a flat amount on the pedicure is the
  // pedicure's, and a percentage shared by two services splits as it accrued.
  const commission = commissionOfLines(
    lines.map((line) => ({ ...line, terms: line.commissionTerms })),
    fallback,
  );
  const commissionWeights = serviceIds.map(() => 0);
  for (const group of commission.groups) {
    const members = [...new Set(group.lineIndexes.map((index) => ownerOf(lines[index])))];
    const shares = allocateProportionally(
      group.commissionMinor,
      members.map((serviceId) =>
        sumBy(
          group.lineIndexes.filter((index) => ownerOf(lines[index]) === serviceId),
          (index) => commission.lineBaseMinor[index],
        ),
      ),
    );
    members.forEach((serviceId, position) => {
      commissionWeights[indexOf.get(serviceId)!] += shares[position];
    });
  }

  const durationWeights = serviceIds.map((serviceId) =>
    sumBy(
      lines.filter((line) => ownerOf(line) === serviceId),
      (line) => Math.max(0, line.durationMinutes),
    ),
  );

  const revenue = allocateProportionally(figures.revenueMinor, revenueWeights);
  const commissionParts = allocateProportionally(figures.commissionMinor, commissionWeights);
  const vat = allocateProportionally(figures.vatMinor, revenue);
  const turnover = allocateProportionally(figures.turnoverTaxMinor, revenue);
  const payment = allocateProportionally(figures.paymentCommissionMinor, revenue);
  const payroll = allocateProportionally(figures.payrollTaxMinor, commissionParts);
  const minutes = allocateProportionally(figures.durationMinutes, durationWeights);

  return serviceIds.map((serviceId, index) => ({
    serviceId,
    revenueMinor: revenue[index],
    commissionMinor: commissionParts[index],
    contributionMarginMinor:
      revenue[index] - vat[index] - commissionParts[index] - payroll[index] - payment[index] - turnover[index],
    durationMinutes: minutes[index],
  }));
}
