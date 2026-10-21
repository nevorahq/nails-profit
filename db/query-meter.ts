import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "drizzle-orm/logger";

/**
 * How many statements a piece of work sends to the database.
 *
 * Why this is worth a module: on this application the cost of a page is not
 * the work the database does but the number of times it is asked. Production
 * runs its functions in one region and the database in another, so every
 * statement is a round trip across an ocean — and a statement carrying a
 * parameter is two of them, because the driver has to ask the server what type
 * the parameter is before it can send the value. A page that sends sixty
 * statements is therefore slow for a reason no profiler pointed at the
 * database will ever show, and a loop that sends one more per row passes every
 * test written against ten rows.
 *
 * Counting is the cheapest honest guard against that. It is not timing: a count
 * is the same on a laptop and in production, so it can be asserted in a test.
 *
 * Two ways in, both off unless asked for:
 *
 *  - `measureStatements(work)` wraps one call and reports what it sent. It is
 *    what the integration tests use.
 *  - `DB_QUERY_LOG=<file>` appends one JSON line per statement from a running
 *    server. It is what `scripts/perf/page-queries.mjs` uses to attribute
 *    statements to a page. Never set it on a deployment: it writes
 *    synchronously.
 *
 * `begin` and `commit` are not statements as far as Drizzle's logger is
 * concerned — the driver sends them itself — so `withTenant` reports each
 * transaction through `recordTransaction`, and a caller reading the total adds
 * two round trips for each.
 */
type Meter = { statements: string[]; transactions: number };

const meters = new AsyncLocalStorage<Meter>();

const logFile = process.env.DB_QUERY_LOG;

function append(kind: "q" | "tx", text: string) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), kind, q: text.replace(/\s+/g, " ").slice(0, 160) })}\n`);
}

/** Passed to Drizzle as its `logger`. Does nothing unless a meter is listening. */
export const queryMeterLogger: Logger = {
  logQuery(query) {
    meters.getStore()?.statements.push(query);
    append("q", query);
  },
};

/** Called by `withTenant`: one transaction is a `begin` and a `commit` the logger never sees. */
export function recordTransaction() {
  const meter = meters.getStore();
  if (meter) meter.transactions += 1;
  append("tx", "begin … commit");
}

export type Measured<T> = Readonly<{
  result: T;
  statements: readonly string[];
  transactions: number;
  /** What the work cost in round trips if no statement carried a parameter: the floor. */
  minimumRoundTrips: number;
}>;

/** Runs `work` and reports every statement it sent, including those it started and did not await. */
export async function measureStatements<T>(work: () => Promise<T>): Promise<Measured<T>> {
  const meter: Meter = { statements: [], transactions: 0 };
  const result = await meters.run(meter, work);
  return {
    result,
    statements: meter.statements,
    transactions: meter.transactions,
    minimumRoundTrips: meter.statements.length + meter.transactions * 2,
  };
}
