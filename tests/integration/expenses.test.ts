import { beforeEach, describe, expect, it } from "vitest";

import { expenses } from "@/db/schema";
import type { ExpenseCategory } from "@/domain/expense-categories";
import { loadExpenses, sumExpensesMinor } from "@/lib/expenses";
import { withTenant } from "@/db/tenant";
import { adminDb, resetDatabase } from "../helpers/database";
import { createOrganization, createUser } from "../helpers/factories";

/**
 * The ledger's filter, against real rows.
 *
 * The dates are the part worth checking: the period has to answer for the day
 * the money was spent rather than the day the row was written, the closing day
 * has to be included whole, and a query string anyone can edit by hand must not
 * reach the driver as a date that does not exist. None of it shows up in a type
 * check.
 */
describe("expense ledger", () => {
  let organizationId: string;
  let otherOrganizationId: string;

  async function record(options: {
    name: string;
    category: ExpenseCategory;
    amountMinor: number;
    /** The day of the purchase, `YYYY-MM-DD`. */
    spentOn: string;
    /** When the row was written, which is deliberately a different day. */
    createdAt?: Date;
    organization?: string;
    archived?: boolean;
  }) {
    const [row] = await adminDb
      .insert(expenses)
      .values({
        organizationId: options.organization ?? organizationId,
        name: options.name,
        category: options.category,
        spentOn: options.spentOn,
        amountMinor: options.amountMinor,
        currency: "MDL",
        createdAt: options.createdAt ?? new Date("2026-09-01T00:00:00Z"),
        archivedAt: options.archived ? new Date() : null,
      })
      .returning();
    return row;
  }

  beforeEach(async () => {
    await resetDatabase();
    const owner = await createUser();
    organizationId = (await createOrganization({ ownerId: owner.id })).id;
    otherOrganizationId = (await createOrganization({ name: "Other" })).id;

    /*
     * Every row is written on the same September day, and every one is spent on
     * a different one. A filter that reads `created_at` passes none of the
     * tests below.
     */
    await record({ name: "Аренда июль", category: "rent", amountMinor: 500_00, spentOn: "2026-07-15" });
    // The closing day of the period asked for further down.
    await record({ name: "Аренда август", category: "rent", amountMinor: 600_00, spentOn: "2026-08-03" });
    await record({ name: "Лампа", category: "tools", amountMinor: 120_00, spentOn: "2026-08-10" });
    await record({
      name: "Удалённая",
      category: "tools",
      amountMinor: 999_00,
      spentOn: "2026-08-10",
      archived: true,
    });
    await record({
      name: "Чужая аренда",
      category: "rent",
      amountMinor: 100_00,
      spentOn: "2026-08-01",
      organization: otherOrganizationId,
    });
  });

  it("returns the organization's own live rows, oldest purchase first", async () => {
    const rows = await loadExpenses(organizationId);
    expect(rows.map((row) => row.name)).toEqual(["Аренда июль", "Аренда август", "Лампа"]);
    expect(rows.map((row) => row.spent_on)).toEqual(["2026-07-15", "2026-08-03", "2026-08-10"]);
  });

  it("filters by the day of the purchase, not the day it was entered", async () => {
    // Everything was written on 1 September; only one was spent in July.
    const rows = await loadExpenses(organizationId, { from: "2026-07-01", to: "2026-07-31" });
    expect(rows.map((row) => row.name)).toEqual(["Аренда июль"]);
  });

  it("takes the closing day whole", async () => {
    const rows = await loadExpenses(organizationId, { from: "2026-08-01", to: "2026-08-03" });
    expect(rows.map((row) => row.name)).toEqual(["Аренда август"]);
  });

  it("filters by category", async () => {
    const rows = await loadExpenses(organizationId, { category: "rent" });
    expect(rows.map((row) => row.name)).toEqual(["Аренда июль", "Аренда август"]);
  });

  it("combines the period with the category", async () => {
    const rows = await loadExpenses(organizationId, {
      from: "2026-08-01",
      category: "tools",
    });
    expect(rows.map((row) => row.name)).toEqual(["Лампа"]);
  });

  it("ignores a date that is not one instead of failing the query", async () => {
    // `2026-02-31` has the shape of a date and is not a day; `Date` would roll
    // it forward to March rather than refuse it.
    for (const from of ["вчера", "", "2026-02-31", "31-08-2026"]) {
      expect(await loadExpenses(organizationId, { from })).toHaveLength(3);
    }
  });

  it("sums to what the table's totals row shows", async () => {
    const rows = await loadExpenses(organizationId, { category: "rent" });
    expect(rows.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(110_000);
  });

  /*
   * The report's «Затраты» card and the ledger's own totals row are two
   * different queries over the same rows — one sums in the database, the other
   * in the browser. They have to agree, or the page contradicts itself.
   */
  it("adds up in the database to what the page adds up in the browser", async () => {
    for (const filters of [
      {},
      { from: "2026-08-01", to: "2026-08-31" },
      { category: "tools" as const },
      { from: "2026-01-01", to: "2026-01-31" },
    ]) {
      const rows = await loadExpenses(organizationId, filters);
      const summed = await withTenant(organizationId, (tx) => sumExpensesMinor(tx, filters, "MDL"));
      expect(summed.minor).toBe(rows.reduce((total, row) => total + row.amount_minor, 0));
      expect(summed.excludedRows).toBe(0);
    }
  });

  it("answers zero for a period with nothing in it, not null", async () => {
    const total = await withTenant(organizationId, (tx) =>
      sumExpensesMinor(tx, { from: "2020-01-01", to: "2020-12-31" }, "MDL"),
    );
    expect(total.minor).toBe(0);
    expect(total.excludedRows).toBe(0);
  });

  /*
   * An owner may change the organization's currency, and nothing already
   * recorded is converted. Adding lei to euros would be a number that is not
   * money, so the other currency is counted out instead of summed in.
   */
  it("leaves another currency out of the total and says how many rows that was", async () => {
    await adminDb.insert(expenses).values({
      organizationId,
      name: "Аренда в евро",
      category: "rent",
      spentOn: "2026-08-05",
      amountMinor: 300_00,
      currency: "EUR",
    });

    const total = await withTenant(organizationId, (tx) =>
      sumExpensesMinor(tx, { from: "2026-08-01", to: "2026-08-31" }, "MDL"),
    );

    // 600 rent + 120 lamp, and not a cent of the 300 euros.
    expect(total.minor).toBe(72_000);
    expect(total.excludedRows).toBe(1);
  });

  it("totals the currency it was asked for, whichever that is", async () => {
    await adminDb.insert(expenses).values({
      organizationId,
      name: "Аренда в евро",
      category: "rent",
      spentOn: "2026-08-05",
      amountMinor: 300_00,
      currency: "EUR",
    });

    const total = await withTenant(organizationId, (tx) => sumExpensesMinor(tx, {}, "EUR"));

    expect(total.minor).toBe(30_000);
    // The three live MDL rows.
    expect(total.excludedRows).toBe(3);
  });
});
