import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { dataOf, signUp, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * How a studio of one stops being one, now that nobody is asked.
 *
 * «Формат работы» used to be a dropdown in «Настройки». It is gone, and these
 * are the two events that replaced it — a second master catalogued, or a master
 * accepting an invitation. Both run through `lib/solo-mode.ts`.
 *
 * The stake is not a word on a screen. `organization.type` decides the first
 * screen after registration, the heading «Мастера» sits under, the wording of
 * four staff notifications and the sentence on every service card
 * (`i18n/business-labels.ts`). An owner who hires and stays `solo` is addressed
 * by the product as though she still worked alone, and after the dropdown was
 * removed she would have had no way at all to say otherwise.
 */
let index = 0;

/** A workspace the way somebody working alone opens one. */
async function soloStudio(): Promise<{ owner: Actor; organizationId: string }> {
  const owner = await signUp(`solo-${(index += 1)}@studio.example`);
  const organizationId = dataOf<{ id: string }>(
    await owner.post("/api/v1/organizations", {
      name: `Solo ${index}`,
      type: "solo",
      currency: "MDL",
      locale: "ru",
    }),
  ).id;
  return { owner, organizationId };
}

async function typeOf(organizationId: string): Promise<string> {
  const [row] = await adminDb
    .select({ type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row.type;
}

async function versionOf(organizationId: string): Promise<number> {
  const [row] = await adminDb
    .select({ version: organizations.version })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row.version;
}

beforeAll(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a second master in the catalogue", () => {
  test("a fresh solo workspace is solo, and its own owner's card does not change that", async () => {
    // `POST /organizations` writes the owner her own card. It is one specialist,
    // and one specialist is what working alone looks like — if this ever flipped
    // here, every solo account would be a studio before its first visit.
    const { organizationId } = await soloStudio();

    expect(await typeOf(organizationId)).toBe("solo");
  });

  test("cataloguing somebody else makes it a studio", async () => {
    const { owner, organizationId } = await soloStudio();

    await owner.post("/api/v1/specialists", {
      name: "Ирина",
      default_rule: { type: "percentage", basis_points: 4_000 },
    });

    expect(await typeOf(organizationId)).toBe("studio");
  });

  test("a third master changes nothing, and costs the organization no version", async () => {
    const { owner, organizationId } = await soloStudio();
    await owner.post("/api/v1/specialists", { name: "Ирина" });
    const settled = await versionOf(organizationId);

    await owner.post("/api/v1/specialists", { name: "Оля" });

    expect(await typeOf(organizationId)).toBe("studio");
    // The guard is in the `where`, so the second call updates no row at all.
    expect(await versionOf(organizationId)).toBe(settled);
  });

  test("archiving the second master does not send the studio back", async () => {
    // Deliberate, and the reason is in `lib/solo-mode.ts`: a studio whose
    // second master left in March is still a studio in the March report, and
    // rewriting the wording of a month already read is worse than a label that
    // is a size too big.
    const { owner, organizationId } = await soloStudio();
    const hired = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", { name: "Ирина" }),
    ).id;

    expect((await owner.delete(`/api/v1/specialists/${hired}`)).status).toBe(200);

    expect(await typeOf(organizationId)).toBe("studio");
  });
});

describe("somebody accepting an invitation", () => {
  async function join(owner: Actor, email: string, role: "master" | "manager" | "analyst") {
    const { token } = dataOf<{ token: string }>(
      await owner.post("/api/v1/invitations", { email, role }),
    );
    const invitee = await signUp(email);
    expect((await invitee.post("/api/v1/invitations/accept", { token })).status).toBe(201);
  }

  test("a master signing in makes it a studio", async () => {
    const { owner, organizationId } = await soloStudio();

    await join(owner, `hired-${index}@studio.example`, "master");

    expect(await typeOf(organizationId)).toBe("studio");
  });

  test("an administrator does not: she shares the books, not the table", async () => {
    // «Оплата труда мастеров» is still the wrong sentence for the only person
    // holding a brush, however many people can read the reports.
    const { owner, organizationId } = await soloStudio();

    await join(owner, `admin-${index}@studio.example`, "manager");

    expect(await typeOf(organizationId)).toBe("solo");
  });

  test("nor does an analyst", async () => {
    const { owner, organizationId } = await soloStudio();

    await join(owner, `analyst-${index}@studio.example`, "analyst");

    expect(await typeOf(organizationId)).toBe("solo");
  });
});
