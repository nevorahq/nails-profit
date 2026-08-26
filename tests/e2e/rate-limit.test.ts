import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { IMPORT_UPLOAD_RULE, INVITATION_ACCEPT_RULE } from "@/lib/rate-limit";
import { dataOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * Spec section 15.3 asks for rate limits on auth, public links and imports.
 * Better Auth carries the auth routes; these are ours, and this checks the
 * limits exist where the endpoint lives rather than only in the limiter's own
 * unit tests.
 */
function tinyImport() {
  const form = new FormData();
  form.set("entity", "service");
  form.set("file", new File(["Наименование;Цена;Длительность\r\nТоп-услуга;600;90"], "one.csv"));
  return form;
}

describe("rate limits", () => {
  let owner: Actor;

  beforeAll(async () => {
    await resetDatabase();
    owner = await signUp("limits@studio.example");
    await owner.post("/api/v1/organizations", { name: "Limits Studio", type: "solo" });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("import upload refuses past the limit and says when to return", async () => {
    for (let attempt = 0; attempt < IMPORT_UPLOAD_RULE.limit; attempt += 1) {
      const allowed = await owner.post("/api/v1/imports", tinyImport());
      expect(allowed.status).toBe(201);
    }

    const refused = await owner.post("/api/v1/imports", tinyImport());
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // Retry-After is the difference between a refusal and an instruction.
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(IMPORT_UPLOAD_RULE.windowSeconds);
  });

  test("the limit follows the account, not the endpoint", async () => {
    for (let attempt = 0; attempt < IMPORT_UPLOAD_RULE.limit; attempt += 1) {
      await owner.post("/api/v1/imports", tinyImport());
    }
    expect((await owner.post("/api/v1/imports", tinyImport())).status).toBe(429);

    // A second studio is unaffected: one tenant must not be able to lock out
    // another by burning a shared counter.
    const other = await signUp("limits-other@studio.example");
    dataOf<{ id: string }>(await other.post("/api/v1/organizations", { name: "Other", type: "solo" }));
    expect((await other.post("/api/v1/imports", tinyImport())).status).toBe(201);
  });

  test("invitation accept is limited too", async () => {
    for (let attempt = 0; attempt < INVITATION_ACCEPT_RULE.limit; attempt += 1) {
      const guess = await owner.post("/api/v1/invitations/accept", { token: `guess-${attempt}` });
      expect(guess.status).toBe(404);
    }

    const refused = await owner.post("/api/v1/invitations/accept", { token: "guess-again" });
    expect(refused.status).toBe(429);
  });
});
