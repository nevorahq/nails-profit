import { describe, expect, it } from "vitest";

import { crossTenantRefusal, openOperatorConnection, operatorUrlFrom } from "./ops-connection.mjs";

/**
 * A fake connection that answers the role probe and remembers being closed.
 *
 * The whole point of the guard is what happens with a connection nobody should
 * be using, and standing one up for real would mean creating a second database
 * role in the test harness. Injecting the connection tests the decision, which
 * is the part that was missing.
 */
function fakeConnection(role) {
  let closed = false;
  const sql = async () => [role];
  sql.end = async () => {
    closed = true;
  };
  return { sql, wasClosed: () => closed };
}

const OPERATOR = { name: "nail_profit", superuser: true, bypassrls: true };
const APPLICATION = { name: "nail_profit_app", superuser: false, bypassrls: false };

describe("choosing the connection", () => {
  it("takes the first variable that is set", () => {
    expect(
      operatorUrlFrom({ DATABASE_URL: "postgres://app" }, ["MIGRATION_DATABASE_URL", "DATABASE_URL"]),
    ).toEqual({ url: "postgres://app", variable: "DATABASE_URL" });

    expect(
      operatorUrlFrom({ MIGRATION_DATABASE_URL: "postgres://owner", DATABASE_URL: "postgres://app" }, [
        "MIGRATION_DATABASE_URL",
        "DATABASE_URL",
      ]),
    ).toEqual({ url: "postgres://owner", variable: "MIGRATION_DATABASE_URL" });
  });

  it("treats an empty value as unset", () => {
    // A variable exported as "" in a unit file is how this happens in the field,
    // and connecting to the empty string fails somewhere much less obvious.
    const chosen = operatorUrlFrom({ MIGRATION_DATABASE_URL: "  " }, ["MIGRATION_DATABASE_URL"]);
    expect(chosen.url).toBeUndefined();
    expect(chosen.error).toContain("MIGRATION_DATABASE_URL");
  });

  it("names every variable it would have accepted", () => {
    const { error } = operatorUrlFrom({}, ["PILOT_DATABASE_URL", "MIGRATION_DATABASE_URL"]);
    expect(error).toContain("PILOT_DATABASE_URL or MIGRATION_DATABASE_URL");
  });
});

describe("judging the role", () => {
  it("accepts a role the tenant policies do not apply to", () => {
    expect(crossTenantRefusal(OPERATOR, "MIGRATION_DATABASE_URL")).toBeNull();
    // Either attribute is enough; deployments grant one or the other.
    expect(crossTenantRefusal({ ...APPLICATION, bypassrls: true }, "DATABASE_URL")).toBeNull();
    expect(crossTenantRefusal({ ...APPLICATION, superuser: true }, "DATABASE_URL")).toBeNull();
  });

  it("refuses the application's own role, and says what would have happened", () => {
    const refusal = crossTenantRefusal(APPLICATION, "DATABASE_URL");
    expect(refusal).toContain("DATABASE_URL");
    expect(refusal).toContain("nail_profit_app");
    // The message has to explain the silence, because the symptom an operator
    // sees is a report full of zeroes rather than an error.
    expect(refusal).toContain("no rows");
  });
});

describe("opening the connection", () => {
  it("hands back a connection the job can use", async () => {
    const { sql, wasClosed } = fakeConnection(OPERATOR);
    const opened = await openOperatorConnection({ MIGRATION_DATABASE_URL: "postgres://owner" }, undefined, () => sql);

    expect(opened).toBe(sql);
    expect(wasClosed()).toBe(false);
  });

  it("refuses a tenant-scoped connection and closes it", async () => {
    const { sql, wasClosed } = fakeConnection(APPLICATION);

    await expect(
      openOperatorConnection({ DATABASE_URL: "postgres://app" }, undefined, () => sql),
    ).rejects.toThrow(/tenant policies apply to/);
    // Refusing while leaving a connection open would hold a slot in the pool of
    // a database the job is not allowed to read anyway.
    expect(wasClosed()).toBe(true);
  });

  it("does not connect at all when nothing is configured", async () => {
    let connected = false;
    await expect(
      openOperatorConnection({}, undefined, () => {
        connected = true;
        return fakeConnection(OPERATOR).sql;
      }),
    ).rejects.toThrow(/MIGRATION_DATABASE_URL or DATABASE_URL/);
    expect(connected).toBe(false);
  });

  it("closes the connection when the probe itself fails", async () => {
    let closed = false;
    const sql = async () => {
      throw new Error("password authentication failed");
    };
    sql.end = async () => {
      closed = true;
    };

    await expect(
      openOperatorConnection({ DATABASE_URL: "postgres://app" }, undefined, () => sql),
    ).rejects.toThrow(/password authentication failed/);
    expect(closed).toBe(true);
  });
});
