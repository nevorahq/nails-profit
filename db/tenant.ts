import { sql } from "drizzle-orm";

import { db } from "@/db";
import { recordTransaction } from "@/db/query-meter";
import { isPreviewRequested } from "@/lib/preview-request";

export type TenantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * All tenant-owned reads and writes must run through this boundary. PostgreSQL
 * RLS policies read the transaction-local setting and deny rows from other orgs.
 *
 * While an owner is previewing a colleague's interface the transaction is also
 * marked read-only, which is what makes "read-only" a property of the mode
 * rather than a promise each of the forty-eight endpoints has to keep. The
 * request boundary in `proxy.ts` refuses those writes first and with a usable
 * error; this is the layer underneath it, and it holds for callers that never
 * pass through the proxy at all — a server component, a future server action,
 * an endpoint added next year by someone who has not read any of this.
 *
 * Ordering matters: PostgreSQL accepts `SET TRANSACTION` alongside the
 * `set_config` above but not after real work has begun, so it is issued here
 * and not left to the caller.
 *
 * The timeout guards against a request whose client goes away mid-transaction
 * (Next.js logs it as "the destination stream closed early") — `work` then
 * never sends its next statement, or COMMIT, and the connection sits "idle in
 * transaction" with nothing to end it. `max: 2` in development means two such
 * orphans are enough to exhaust the whole pool: every later request that needs
 * a connection queues behind them and hangs, indistinguishable from the page
 * itself being slow, until the process restarts. Set here rather than as a
 * connection-startup parameter in `db/index.ts` because Supabase's pooler
 * silently drops that form — `set_config(..., true)` is a normal statement
 * inside the transaction it protects, so nothing about the pooler affects it.
 */
export async function withTenant<T>(organizationId: string, work: (tx: TenantTransaction) => Promise<T>) {
  const readOnly = await isPreviewRequested();

  recordTransaction();

  return db.transaction(async (tx) => {
    await tx.execute(settingsFor(organizationId));
    if (readOnly) await tx.execute(sql`set transaction read only`);
    return work(tx);
  });
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two transaction-local settings, in one statement.
 *
 * Every tenant transaction pays for these before it does any work, and the
 * database is in another region, so what matters is how many times it has to be
 * asked — not what it is asked. They used to be two statements, and the second
 * carried the organization as a parameter. A statement with a parameter costs
 * two round trips, because the driver has to ask the server what type the
 * parameter is before it can send it; one without costs one. Together that was
 * three trips for setting up a transaction, and now it is one.
 *
 * The organization id is written into the text rather than passed, which is
 * safe only because it is checked first: a UUID is hex digits and hyphens and
 * cannot close the quote it sits in. Anything else — no caller passes one, but
 * this is the boundary that keeps tenants apart, so it does not assume — takes
 * the parameterised path, which is slower and cannot be injected into.
 */
function settingsFor(organizationId: string) {
  if (!UUID_SHAPE.test(organizationId)) {
    return sql`select set_config('idle_in_transaction_session_timeout', '30000', true), set_config('app.current_organization_id', ${organizationId}, true)`;
  }
  return sql.raw(
    `select set_config('idle_in_transaction_session_timeout', '30000', true), set_config('app.current_organization_id', '${organizationId}', true)`,
  );
}

type Read<T> = (tx: TenantTransaction) => Promise<T>;

/** What a read answers, or `null` where the read was `null` — distributes over a conditional `Read | null`. */
type ReadResult<Candidate> = Candidate extends Read<infer Result> ? Result : null;

/**
 * Independent tenant reads, run at once.
 *
 * A page that needs six unrelated things used to ask for them one after the
 * other, each in a transaction of its own, and every transaction is a round
 * trip to open, one to close and one to set up — a database in another region
 * turns the sum into seconds. `Promise.all` inside a single transaction does not
 * help: its statements share one connection and go down it in turn. Separate
 * transactions are separate connections, so they overlap, and the page waits
 * for the slowest read instead of for all of them.
 *
 * Use it for reads that do not depend on each other and do not need to agree
 * to the row: each sees the database as it was when its own transaction began.
 * Figures that must add up to one another belong in one transaction.
 *
 * A read that is `null` is skipped and comes back `null`, which is how a page
 * says «only for whoever may see this» without a ternary around every key.
 * Each read takes a pool connection while it runs, so keep the list to what a
 * page really shows.
 */
export async function readTogether<const Reads extends Record<string, Read<unknown> | null>>(
  organizationId: string,
  reads: Reads,
): Promise<{ [Key in keyof Reads]: ReadResult<Reads[Key]> }> {
  const entries = await Promise.all(
    Object.entries(reads).map(async ([key, read]) => [key, read ? await withTenant(organizationId, read) : null] as const),
  );
  return Object.fromEntries(entries) as never;
}
