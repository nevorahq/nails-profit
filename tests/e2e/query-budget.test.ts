import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";

import { measureStatements } from "@/db/query-meter";
import { withTenant } from "@/db/tenant";
import { resolveLocale } from "@/lib/locale";
import { getActiveMembership } from "@/lib/membership";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { setSessionHeaders } from "../helpers/session";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * How many times a request asks the database who is calling.
 *
 * Production runs its functions in one region and the database in another, so
 * the cost of a page is the number of statements it sends, not what the
 * database does with them — and a statement with a parameter costs two round
 * trips. These are the lookups every signed-in page starts with. They are
 * asserted as exact counts rather than as limits because a count that drops is
 * as worth noticing as one that rises: it means a check moved somewhere.
 *
 * Only what is measured here is guaranteed. Pages add their own reads on top,
 * and `scripts/perf/page-queries.mjs` is how those are counted.
 */
let studio: Studio;

function asVisitor(cookie: string | null) {
  setSessionHeaders(new Headers(cookie ? { cookie } : {}));
}

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("budget-owner@example.com", "Budget Studio");
});

afterAll(async () => {
  await closeTestConnections();
});

describe("identifying the caller", () => {
  test("a visitor with no session cookie costs no statement at all", async () => {
    asVisitor(null);

    const { result, statements } = await measureStatements(() => getActiveMembership());

    expect(result.session).toBe(false);
    expect(statements).toHaveLength(0);
  });

  test("a signed-in owner is found in two statements: the session with its user, then the membership with its organization", async () => {
    asVisitor(studio.owner.cookie);

    const { result, statements } = await measureStatements(() => getActiveMembership());

    expect(result.session).toBe(true);
    if (!result.session) return;
    expect(result.membership?.organizationId).toBe(studio.organizationId);
    expect(result.membership?.role).toBe("owner");
    // The organization rides on the membership query, so the shell, the
    // workspace and the language never read it again.
    expect(result.organization).toMatchObject({ id: studio.organizationId, name: "Budget Studio", locale: "ru" });
    expect(statements).toHaveLength(2);
  });

  test("the language of a signed-in page is read from that same lookup, not by a fresh one", async () => {
    asVisitor(studio.owner.cookie);

    const { result, statements } = await measureStatements(() => resolveLocale());

    expect(result).toBe("ru");
    // Unmemoized here, because `cache` only remembers inside a render; the two
    // statements are one lookup. In a page the layout, the metadata and the
    // page share it.
    expect(statements).toHaveLength(2);
  });

  test("the language of an anonymous page comes from the browser and costs no statement", async () => {
    setSessionHeaders(new Headers({ "accept-language": "ro-RO,ro;q=0.9" }));

    const { result, statements } = await measureStatements(() => resolveLocale());

    expect(result).toBe("ro");
    expect(statements).toHaveLength(0);
  });
});

describe("a tenant transaction", () => {
  test("sets itself up in one statement, so a read costs the setup plus itself", async () => {
    const { result, statements, transactions } = await measureStatements(() =>
      withTenant(studio.organizationId, async (tx) => {
        const rows = await tx.execute(sql`select current_setting('app.current_organization_id', true) as organization`);
        return rows[0]?.organization;
      }),
    );

    expect(result).toBe(studio.organizationId);
    expect(statements).toHaveLength(2);
    expect(transactions).toBe(1);
  });

  test("carries the idle-in-transaction timeout with it", async () => {
    const timeout = await withTenant(studio.organizationId, async (tx) => {
      const rows = await tx.execute(sql`select current_setting('idle_in_transaction_session_timeout') as timeout`);
      return rows[0]?.timeout;
    });

    expect(timeout).toBe("30s");
  });

  test("an id that is not a UUID is passed as a parameter, never written into the statement", async () => {
    // The fast path writes the id into the text, which is safe only because a
    // UUID cannot close the quote around it. Anything else must take the other
    // path and come back byte for byte as the value it was given.
    const hostile = "x'); select pg_sleep(30); --";

    const value = await withTenant(hostile, async (tx) => {
      const rows = await tx.execute(sql`select current_setting('app.current_organization_id', true) as organization`);
      return rows[0]?.organization;
    });

    expect(value).toBe(hostile);
  });
});
