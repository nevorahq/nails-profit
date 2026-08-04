import { sql } from "drizzle-orm";

import { db } from "@/db";

export type TenantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * All tenant-owned reads and writes must run through this boundary. PostgreSQL
 * RLS policies read the transaction-local setting and deny rows from other orgs.
 */
export async function withTenant<T>(organizationId: string, work: (tx: TenantTransaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_organization_id', ${organizationId}, true)`);
    return work(tx);
  });
}
