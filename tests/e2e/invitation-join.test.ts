import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { db } from "@/db";
import { invitations, memberships, users } from "@/db/schema";
import { invitationTokenFromNext } from "@/domain/invitation-link";
import { previewInvitation } from "@/lib/invitation-preview";
import { setNotificationProvider } from "@/lib/notification-provider";
import { dataOf, errorCodeOf, signIn, signUp } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * What the invitation screen is allowed to know before anyone presses anything.
 *
 * `/join` used to find out what state a link was in by trying to claim it and
 * reading the error, which meant the only screen a guest could ever reach was
 * "принять и войти" — a button that, with no account yet, could only fail with
 * 401, bounce to sign-up and leave the invitation pending. Everything the
 * screen decides now comes from `previewInvitation`, so these tests are what
 * stands between a person and being told the wrong thing about their link.
 */
let studio: Studio;

async function invite(email: string, role: "master" | "manager" = "master") {
  return dataOf<{ id: string; token: string }>(
    await studio.owner.post("/api/v1/invitations", { email, role }),
  );
}

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("join-owner@studio.example", "Sage Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("what a link says about itself", () => {
  test("a live invitation names the studio, the role and the address it was issued for", async () => {
    const { token } = await invite("live@studio.example", "manager");

    const preview = await previewInvitation(token);

    expect(preview).toMatchObject({
      status: "pending",
      email: "live@studio.example",
      role: "manager",
      organizationId: studio.organizationId,
      organizationName: "Sage Studio",
      locale: "ru",
    });
  });

  test("the address is normalized, so the sign-up form is filled with the one that will match", async () => {
    const { token } = await invite("Mixed.Case@Studio.Example");

    // The accept path compares against the normalized address; a preview that
    // showed the typed one would prefill a field that then fails the check.
    expect((await previewInvitation(token))?.email).toBe("mixed.case@studio.example");
  });

  test("a malformed or unknown token resolves to nothing at all", async () => {
    const { token } = await invite("known@studio.example");
    const [organizationId, secret] = token.split(".");

    expect(await previewInvitation("")).toBeNull();
    expect(await previewInvitation("not-a-token")).toBeNull();
    // Well-formed, same organization, wrong secret: the shape of a guess.
    expect(await previewInvitation(`${organizationId}.${secret.slice(0, -4)}xxxx`)).toBeNull();
  });

  test("an accepted invitation reads as accepted rather than as a broken link", async () => {
    const { token } = await invite("accepts@studio.example");
    const invitee = await signUp("accepts@studio.example");

    expect((await invitee.post("/api/v1/invitations/accept", { token })).status).toBe(201);

    expect((await previewInvitation(token))?.status).toBe("accepted");
  });

  test("a revoked invitation reads as revoked", async () => {
    const { id, token } = await invite("revoked@studio.example");

    expect((await studio.owner.delete(`/api/v1/invitations/${id}`)).status).toBe(200);

    expect((await previewInvitation(token))?.status).toBe("revoked");
  });

  test("expiry is derived from the row, not from a job having rewritten it", async () => {
    const { id, token } = await invite("stale@studio.example");

    await adminDb
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, id));

    expect((await previewInvitation(token))?.status).toBe("expired");
  });
});

describe("sending the invitation email", () => {
  /**
   * The pilot's failure, in one test.
   *
   * A development server pointed at the production database sent real mail to
   * a real address with `http://localhost:3000/join?token=…` inside. Resend
   * delivered it, the owner's screen said the invitation was sent, and the
   * invitee had a link nobody but the sender could open — while the row stayed
   * "ожидает" and looked like the email had gone missing.
   *
   * The test environment's own `NEXT_PUBLIC_APP_URL` is that localhost, which
   * is what makes this checkable without stubbing anything.
   */
  test("is refused while the app URL is one only the sender can open", async () => {
    const { token } = await invite("localhost-guard@studio.example");

    const response = await studio.owner.post("/api/v1/invitations/send", { token });

    expect(response.status).toBe(500);
    expect(errorCodeOf(response)).toBe("APP_URL_NOT_PUBLIC");
  });

  test("accepts a public address", async () => {
    const { token } = await invite("public-url@studio.example");
    const original = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://nailsprofit.example";

    /*
     * The provider is stubbed because this suite reads the real `.env`, where
     * `NOTIFICATION_PROVIDER` is `resend` and the key is the production one.
     * Without this the test posts a genuine invitation to an address that does
     * not exist, and two of those bounces are already on the sending domain's
     * record — which is a cost paid in the deliverability of real mail.
     */
    const delivered: string[] = [];
    setNotificationProvider({
      name: "test",
      async send(message) {
        delivered.push(message.destination);
        return { ok: true, providerMessageId: `test:${delivered.length}` };
      },
    });

    try {
      const response = await studio.owner.post("/api/v1/invitations/send", { token });
      expect(response.status).toBe(200);
      expect(dataOf<{ sent: boolean }>(response).sent).toBe(true);
      expect(delivered).toEqual(["public-url@studio.example"]);
    } finally {
      setNotificationProvider(null);
      process.env.NEXT_PUBLIC_APP_URL = original;
    }
  });
});

describe("a colleague who was removed", () => {
  test("can be invited again, and the old link stays spent", async () => {
    const email = "returns@studio.example";
    const first = await invite(email);
    const person = await signUp(email);
    expect((await person.post("/api/v1/invitations/accept", { token: first.token })).status).toBe(201);

    const [membership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(users.email, email))
      .limit(1);
    expect((await studio.owner.delete(`/api/v1/memberships/${membership.id}`)).status).toBe(200);

    /*
     * The accepted row stays exactly as it is — it is the record of how they
     * got in the first time, and the audit event points at it. What must not
     * happen is for it to block the second invitation: only pending rows are
     * covered by the partial unique index on the address.
     */
    const second = await invite(email, "manager");
    expect((await previewInvitation(first.token))?.status).toBe("accepted");
    expect(await previewInvitation(second.token)).toMatchObject({ status: "pending", role: "manager" });

    // Their account survived the removal, so the same person accepts again.
    const returning = await signIn(email);
    expect((await returning.post("/api/v1/invitations/accept", { token: second.token })).status).toBe(201);
  });
});

describe("the token carried by a sign-in redirect", () => {
  test("is read back from a join link", () => {
    expect(invitationTokenFromNext("/join?token=abc.def")).toBe("abc.def");
    expect(invitationTokenFromNext("/join?token=a%2Bb")).toBe("a+b");
  });

  test("is absent from anything that is not one", () => {
    expect(invitationTokenFromNext(undefined)).toBeNull();
    expect(invitationTokenFromNext("/app")).toBeNull();
    expect(invitationTokenFromNext("/join")).toBeNull();
    expect(invitationTokenFromNext("/joinery?token=abc")).toBeNull();
  });

  test("is not taken from a path that resolves onto another host", () => {
    // `//evil.example/join?token=x` passes a naive "starts with a slash" check
    // and is a protocol-relative URL to a browser.
    expect(invitationTokenFromNext("//evil.example/join?token=abc")).toBeNull();
    expect(invitationTokenFromNext("https://evil.example/join?token=abc")).toBeNull();
  });
});
