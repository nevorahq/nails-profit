import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, errorCodeOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";
import { PREVIEW_COOKIE } from "@/lib/preview";

/**
 * «Посмотреть как» — the owner's view of a colleague's interface.
 *
 * The problem it answers is not a bug in this application: Better Auth holds
 * one session per browser origin, so an owner who signs in as their master to
 * check what the master sees loses their own session to the one cookie slot
 * both accounts share. The session survives on the server and is simply
 * unreachable from that browser — which looks exactly like being logged out.
 *
 * So the fix is not a second session. It is this: the owner stays the
 * authenticated actor throughout, and only the rendering context moves. These
 * tests hold that line — the identity never changes, the scoping does, and
 * nothing may be written while it is moved.
 */
type Fixture = Readonly<{
  studio: Studio;
  master: Actor;
  manager: Actor;
  outsider: Readonly<{ owner: Actor; masterUserId: string }>;
}>;

let fixture: Fixture;

/**
 * The browser's cookie jar mid-preview: one session cookie and one selection,
 * exactly as the owner's browser would send them together.
 */
function previewing(actor: Actor, targetUserId: string) {
  return { cookie: `${actor.cookie}; ${PREVIEW_COOKIE}=${actor.userId}:${targetUserId}` };
}

/**
 * Every message in a rejection's `cause` chain. The driver wraps PostgreSQL's
 * refusal in its own "Failed query" error, so the reason a write did not land
 * is one level below the message the assertion would otherwise see.
 */
async function causeChain(work: Promise<unknown>): Promise<string> {
  const messages: string[] = [];
  try {
    await work;
  } catch (thrown) {
    let error: unknown = thrown;
    while (error instanceof Error) {
      messages.push(error.message);
      error = error.cause;
    }
  }
  return messages.join(" | ");
}

beforeAll(async () => {
  await resetDatabase();

  const studio = await createCanonicalStudio("preview-owner@studio.example");
  const master = await inviteMember(studio.owner, "preview-master@studio.example", "master");
  const manager = await inviteMember(studio.owner, "preview-manager@studio.example", "manager");

  const outsiderStudio = await createCanonicalStudio("other-owner@studio.example", "Other Studio");
  const outsiderMaster = await inviteMember(outsiderStudio.owner, "other-master@studio.example", "master");

  fixture = {
    studio,
    master,
    manager,
    outsider: { owner: outsiderStudio.owner, masterUserId: outsiderMaster.userId },
  };
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("entering", () => {
  test("an owner may open a colleague's view", async () => {
    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: fixture.master.userId,
    });

    expect(response.status).toBe(200);
    const body = dataOf<{ member_user_id: string; role: string; email: string }>(response);
    expect(body.member_user_id).toBe(fixture.master.userId);
    expect(body.role).toBe("master");
    expect(body.email).toBe("preview-master@studio.example");
  });

  test("the selection comes back as a cookie the browser will send, and nothing else", async () => {
    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: fixture.master.userId,
    });

    const [cookie] = response.headers
      .getSetCookie()
      .filter((line) => line.startsWith(`${PREVIEW_COOKIE}=`));

    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    // The actor is baked in, so a cookie outliving its account is inert rather
    // than merely stale — the next person to use this browser inherits nothing.
    expect(cookie).toContain(`${fixture.studio.owner.userId}%3A${fixture.master.userId}`);
    // The session is not among the cookies this endpoint writes. That is the
    // whole distinction from signing in as the master.
    expect(response.headers.getSetCookie().some((line) => line.includes("session_token"))).toBe(false);
  });

  test("a master may not preview anyone", async () => {
    const response = await fixture.master.post("/api/v1/preview", {
      member_user_id: fixture.manager.userId,
    });

    expect(response.status).toBe(403);
    expect(errorCodeOf(response)).toBe("FORBIDDEN");
  });

  test("a member of another organization cannot be named", async () => {
    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: fixture.outsider.masterUserId,
    });

    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("PREVIEW_TARGET_INVALID");
  });

  test("an account with no membership at all cannot be named", async () => {
    const stranger = await signUp("stranger@studio.example");
    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: stranger.userId,
    });

    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("PREVIEW_TARGET_INVALID");
  });

  test("another owner cannot be previewed, so preview can only ever narrow", async () => {
    const second = await signUp("second-owner@studio.example");
    const { token } = dataOf<{ token: string }>(
      await fixture.studio.owner.post("/api/v1/invitations", {
        email: "second-owner@studio.example",
        role: "owner",
      }),
    );
    await second.post("/api/v1/invitations/accept", { token });

    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: second.userId,
    });

    expect(response.status).toBe(403);
    expect(errorCodeOf(response)).toBe("PREVIEW_TARGET_INVALID");
  });

  test("an owner cannot preview themselves", async () => {
    const response = await fixture.studio.owner.post("/api/v1/preview", {
      member_user_id: fixture.studio.owner.userId,
    });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("PREVIEW_TARGET_INVALID");
  });
});

describe("while previewing", () => {
  test("the session is untouched and the permissions shown are the colleague's", async () => {
    const { auth } = await import("@/lib/auth");
    const jar = previewing(fixture.studio.owner, fixture.master.userId);

    // The session itself, read the way every request reads it. Preview never
    // reaches this far down: no new session, no new subject, no new token.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.cookie }) });
    expect(session?.user.id).toBe(fixture.studio.owner.userId);
    expect(session?.user.email).toBe("preview-owner@studio.example");

    // What the application renders, though, is the master's.
    const permissions = dataOf<{ role: string }>(
      await fixture.studio.owner.get("/api/v1/me/permissions", jar),
    );
    expect(permissions.role).toBe("master");
  });

  test("the interface is scoped to the colleague, not to the owner", async () => {
    const own = dataOf<unknown[]>(await fixture.studio.owner.get("/api/v1/clients"));
    const asMaster = dataOf<unknown[]>(
      await fixture.studio.owner.get(
        "/api/v1/clients",
        previewing(fixture.studio.owner, fixture.master.userId),
      ),
    );

    // Section 6.1 gives a master "только назначенные клиенты/визиты", and this
    // master has served nobody. The owner sees the studio's list; through the
    // master's eyes the same request answers with the master's empty one.
    expect(own.length).toBeGreaterThanOrEqual(0);
    expect(asMaster).toEqual([]);
  });

  test("a capability the colleague does not hold is refused to the owner too", async () => {
    const response = await fixture.studio.owner.get(
      "/api/v1/expenses",
      previewing(fixture.studio.owner, fixture.master.userId),
    );

    // Затраты are the owner's alone. Previewing a master means being refused
    // them, which is the point: the owner is looking at what the master sees.
    expect(response.status).toBe(403);
  });

  test("writes are refused at the database, however the request arrives", async () => {
    // `proxy.ts` refuses this first in the running application, with a 403 and
    // a usable code — see `proxy.test.ts`. E2E calls handlers directly and so
    // reaches the layer underneath: the tenant transaction is read-only for the
    // duration of the mode, so a mutation cannot land even with the proxy out
    // of the way.
    const attempt = fixture.studio.owner.post(
      "/api/v1/clients",
      { name: "Written while previewing" },
      previewing(fixture.studio.owner, fixture.master.userId),
    );

    // PostgreSQL's own refusal, reached through the driver's wrapper, so the
    // assertion is about why it failed and not merely that it did.
    await expect(attempt).rejects.toThrow();
    expect(await causeChain(attempt)).toMatch(/read-only transaction/i);

    const after = dataOf<{ name: string }[]>(await fixture.studio.owner.get("/api/v1/clients"));
    expect(after.some((client) => client.name === "Written while previewing")).toBe(false);
  });

  test("a selection naming a colleague of another studio is ignored, not obeyed", async () => {
    const response = await fixture.studio.owner.get(
      "/api/v1/expenses",
      previewing(fixture.studio.owner, fixture.outsider.masterUserId),
    );

    // The cookie is checked against the membership table on every request, so a
    // hand-edited one falls back to the owner's own view rather than reaching
    // another studio. Затраты answering 200 is that fallback.
    expect(response.status).toBe(200);
  });

  test("a selection belonging to a different account is ignored", async () => {
    const borrowed = {
      cookie: `${fixture.studio.owner.cookie}; ${PREVIEW_COOKIE}=${fixture.manager.userId}:${fixture.master.userId}`,
    };

    const response = await fixture.studio.owner.get("/api/v1/expenses", borrowed);
    expect(response.status).toBe(200);
  });

  test("a master carrying a preview cookie gains nothing by it", async () => {
    const response = await fixture.master.get(
      "/api/v1/expenses",
      previewing(fixture.master, fixture.studio.owner.userId),
    );

    // Only an owner may look, so this stays the master's own refusal. Privilege
    // escalation would be this answering 200.
    expect(response.status).toBe(403);
  });
});

describe("leaving", () => {
  test("the exit clears the selection and keeps the session", async () => {
    const response = await fixture.studio.owner.delete(
      "/api/v1/preview",
      undefined,
      previewing(fixture.studio.owner, fixture.master.userId),
    );

    expect(response.status).toBe(200);
    const [cookie] = response.headers
      .getSetCookie()
      .filter((line) => line.startsWith(`${PREVIEW_COOKIE}=`));
    expect(cookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(response.headers.getSetCookie().some((line) => line.includes("session_token"))).toBe(false);
  });

  test("the owner's own view is back, writes included", async () => {
    const created = await fixture.studio.owner.post("/api/v1/clients", { name: "After preview" });
    expect(created.status).toBe(201);
  });

  test("a master may still leave a mode they could never enter", async () => {
    // Never refused: the states most needing an exit are the ones where
    // something else has already gone wrong.
    expect((await fixture.master.delete("/api/v1/preview")).status).toBe(200);
  });
});
