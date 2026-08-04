import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/env";
import * as schema from "@/db/schema";

const globalForDb = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
};

const sqlClient =
  globalForDb.sqlClient ??
  postgres(getServerEnv().DATABASE_URL, {
    max: process.env.NODE_ENV === "production" ? 10 : 2,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlClient = sqlClient;
}

export const db = drizzle(sqlClient, { schema });
export { sqlClient };
