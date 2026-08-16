import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { db } from "@/db";
import { memberships, sessions, specialists, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { dataOf, errorCodeOf, signIn, signUp } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Removing a colleague from the studio.
 *
 * The distinction these tests exist to hold is the one the interface makes in a
 * single word: «удалить» ends the person's part in the studio, not the person.
 * Their account survives, their work does not lose its attribution, and the
 * studio's money is untouched. Everything below is one of those three.
 */
type Fixture = Readonly<{
  studio: Studio;
  otherStudio: Studio;
}>;

let fixture: Fixture;

async function membershipIdOf(email: string) {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);
  return row?.id ?? null;
}

beforeAll(async () => {
  await resetDatabase();
  fixture = {
    studio: await createCanonicalStudio("removal-owner@studio.example"),
    otherStudio: await createCanonicalStudio("other-owner@studio.example", "Other Studio"),
  };
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("who may remove whom", () => {
  test("a master cannot remove anybody", async () => {
    const master = await inviteMember(fixture.studio.owner, "m1@studio.example", "master");
    const target = await inviteMember(fixture.studio.owner, "m2@studio.example", "master");

    const response = await master.delete(`/api/v1/memberships/${await membershipIdOf(target.email)}`);
    expect(response.status).toBe(403);
    expect(errorCodeOf(response)).toBe("FORBIDDEN");
  });

  test("a manager may remove a master but not an owner", async () => {
    const manager = await inviteMember(fixture.studio.owner, "mgr@studio.example", "manager");
    const master = await inviteMember(fixture.studio.owner, "m3@studio.example", "master");

    const allowed = await manager.delete(`/api/v1/memberships/${await membershipIdOf(master.email)}`);
    expect(allowed.status).toBe(200);

    // Section 6.1: a Manager administers users "кроме Owner".
    const refused = await manager.delete(
      `/api/v1/memberships/${await membershipIdOf(fixture.studio.owner.email)}`,
    );
    expect(refused.status).toBe(403);
    expect(errorCodeOf(refused)).toBe("ROLE_NOT_MANAGEABLE");
  });

  test("nobody removes themselves", async () => {
    const response = await fixture.studio.owner.delete(
      `/api/v1/memberships/${await membershipIdOf(fixture.studio.owner.email)}`,
    );
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("SELF_REMOVAL_FORBIDDEN");
  });

  test("a membership from another studio is not found, let alone removed", async () => {
    const outsider = await inviteMember(fixture.otherStudio.owner, "out@studio.example", "master");
    const outsiderMembership = await membershipIdOf(outsider.email);

    const response = await fixture.studio.owner.delete(`/api/v1/memberships/${outsiderMembership}`);
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("MEMBER_NOT_FOUND");

    // `membership` sits outside the org-scoped RLS policies on purpose, so the
    // organization filter in the handler is the whole tenant boundary here.
    const [survivor] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.id, outsiderMembership!));
    expect(survivor).toBeDefined();
  });
});

describe("what removal does", () => {
  test("the membership goes and the account stays", async () => {
    const master = await inviteMember(fixture.studio.owner, "leaving@studio.example", "master");

    const response = await fixture.studio.owner.delete(
      `/api/v1/memberships/${await membershipIdOf(master.email)}`,
    );
    expect(response.status).toBe(200);
    expect(dataOf<{ email: string }>(response).email).toBe("leaving@studio.example");

    expect(await membershipIdOf(master.email)).toBeNull();

    // The row in `user` belongs to the person, not to the studio that invited
    // them — and they can still sign in.
    const [account] = await db.select().from(users).where(eq(users.id, master.userId));
    expect(account).toBeDefined();
    await expect(signIn(master.email)).resolves.toMatchObject({ userId: master.userId });
  });

  test("the sessions they had open are revoked", async () => {
    const master = await inviteMember(fixture.studio.owner, "session@studio.example", "master");
    const before = await db.select().from(sessions).where(eq(sessions.userId, master.userId));
    expect(before.length).toBeGreaterThan(0);

    await fixture.studio.owner.delete(`/api/v1/memberships/${await membershipIdOf(master.email)}`);

    // Deleting the rows is the revocation: Better Auth resolves every cookie
    // through this table, and the session cookie cache is off.
    const after = await db.select().from(sessions).where(eq(sessions.userId, master.userId));
    expect(after).toEqual([]);

    // And the cookie they still hold is now worth nothing.
    const stale = await master.get("/api/v1/me/permissions");
    expect(stale.status).toBe(401);
  });

  test("a linked specialist is unlinked and archived, never deleted", async () => {
    const master = await inviteMember(fixture.studio.owner, "linked@studio.example", "master");
    await fixture.studio.owner.patch(`/api/v1/specialists/${fixture.studio.specialistId}`, {
      user_id: master.userId,
    });

    await fixture.studio.owner.delete(`/api/v1/memberships/${await membershipIdOf(master.email)}`);

    // Read inside a tenant transaction: `specialist` is org-scoped by RLS, and
    // a plain connection sees no rows at all rather than the wrong ones.
    const [specialist] = await withTenant(fixture.studio.organizationId, (tx) =>
      tx.select().from(specialists).where(eq(specialists.id, fixture.studio.specialistId)),
    );

    // The studio's record of a person survives, because their visits and the
    // commissions inside every financial snapshot point at this row.
    expect(specialist).toBeDefined();
    expect(specialist.userId).toBeNull();
    expect(specialist.archivedAt).not.toBeNull();
  });

  test("an owner leaves only when another owner remains", async () => {
    const second = await signUp("co-owner@studio.example");
    const { token } = dataOf<{ token: string }>(
      await fixture.studio.owner.post("/api/v1/invitations", {
        email: "co-owner@studio.example",
        role: "owner",
      }),
    );
    await second.post("/api/v1/invitations/accept", { token });

    const response = await fixture.studio.owner.delete(
      `/api/v1/memberships/${await membershipIdOf(second.email)}`,
    );
    expect(response.status).toBe(200);

    const owners = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, fixture.studio.organizationId),
          eq(memberships.role, "owner"),
        ),
      );
    expect(owners).toHaveLength(1);
  });
});

describe("after removal", () => {
  test("the same person can be invited back", async () => {
    const master = await inviteMember(fixture.studio.owner, "returning@studio.example", "master");
    await fixture.studio.owner.delete(`/api/v1/memberships/${await membershipIdOf(master.email)}`);

    const { token } = dataOf<{ token: string }>(
      await fixture.studio.owner.post("/api/v1/invitations", {
        email: "returning@studio.example",
        role: "master",
      }),
    );

    // Their session was revoked with the membership, so they arrive the way
    // anyone arrives: by signing in again.
    const returning = await signIn("returning@studio.example");
    const accepted = await returning.post("/api/v1/invitations/accept", { token });

    expect(accepted.status).toBe(201);
    expect(await membershipIdOf("returning@studio.example")).not.toBeNull();
  });
});
