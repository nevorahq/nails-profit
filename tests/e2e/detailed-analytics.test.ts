import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, organizations } from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Подробная финансовая аналитика»: a column on the organization, written
 * through the settings endpoint like the language and the currency, and the
 * owner's to change for the same reason — section 6.1 gives organization
 * settings to the owner alone. Hiding the checkbox from a manager is not the
 * control; the endpoint asking `can()` is.
 */
let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("analytics-owner@studio.example");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

async function flag() {
  const [row] = await adminDb
    .select({ detailedAnalytics: organizations.detailedAnalytics })
    .from(organizations)
    .where(eq(organizations.id, studio.organizationId));
  return row.detailedAnalytics;
}

describe("detailed financial analytics", () => {
  test("is off for a workspace registered now", async () => {
    expect(await flag()).toBe(false);
  });

  test("is turned on and off by the owner, and the change is in the trail", async () => {
    const on = await studio.owner.patch("/api/v1/organizations/settings", { detailed_analytics: true });
    expect(on.status).toBe(200);
    expect(dataOf<{ detailed_analytics: boolean }>(on).detailed_analytics).toBe(true);
    expect(await flag()).toBe(true);

    const events = await adminDb
      .select({ before: auditEvents.before, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, studio.organizationId));
    expect(events).toContainEqual(
      expect.objectContaining({
        before: expect.objectContaining({ detailed_analytics: false }),
        after: expect.objectContaining({ detailed_analytics: true }),
      }),
    );

    const off = await studio.owner.patch("/api/v1/organizations/settings", { detailed_analytics: false });
    expect(off.status).toBe(200);
    expect(await flag()).toBe(false);
  });

  test("is refused to a manager and to a master", async () => {
    const manager = await inviteMember(studio.owner, "analytics-manager@studio.example", "manager");
    const master = await inviteMember(studio.owner, "analytics-master@studio.example", "master");

    for (const member of [manager, master]) {
      const refused = await member.patch("/api/v1/organizations/settings", { detailed_analytics: true });
      expect(refused.status).toBe(403);
      expect(errorCodeOf(refused)).toBe("FORBIDDEN");
    }
    expect(await flag()).toBe(false);
  });

  test("takes a boolean and nothing else", async () => {
    const refused = await studio.owner.patch("/api/v1/organizations/settings", { detailed_analytics: "yes" });
    expect(refused.status).toBe(422);
  });
});
