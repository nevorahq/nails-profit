import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf, type ApiResponse } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Renaming the studio and moving its booking link — two answers the screens
 * now ask for, through an endpoint they did not use before.
 *
 * Sign-up derives the link from the name, and for a while nothing after
 * sign-up could change either: a studio named «Some One» in a hurry kept
 * `/book/some-one`, and the «Название» on its address card renamed only the
 * address. `/app/booking` and `/app/settings` now send `slug` and `name` to
 * `PATCH /api/v1/organizations/settings`, and every message they show is keyed
 * on a code asserted here.
 */
let studio: Studio;
let neighbour: Studio;
const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

beforeAll(async () => {
  process.env.PUBLIC_BOOKING_ENABLED = "true";
  await resetDatabase();
  studio = await createCanonicalStudio("rename-owner@studio.example", "Some One");
  neighbour = await createCanonicalStudio("neighbour-owner@studio.example", "Neighbour Nails");
  await neighbour.owner.patch("/api/v1/organizations/settings", { slug: "neighbour-nails" });

  await studio.owner.patch("/api/v1/organizations/settings", { slug: "some-one" });
  await adminDb
    .update(organizations)
    .set({ bookingAccess: "public" })
    .where(eq(organizations.id, studio.organizationId));
  const locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", {
      name: "Some One",
      slug: "centru",
      timezone: "Europe/Chisinau",
    }),
  ).id;
  await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    public_status: "published",
  });
}, 60_000);

afterAll(async () => {
  if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
  else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
  await closeTestConnections();
});

function publicPage(slug: string): Promise<ApiResponse<unknown>> {
  return anonymous.get(`/api/v1/public/booking/${slug}`);
}

describe("the booking link", () => {
  test("moves the public page, and the old link stops answering", async () => {
    expect((await publicPage("some-one")).status).toBe(200);

    const moved = await studio.owner.patch("/api/v1/organizations/settings", { slug: "studio-belle" });
    expect(moved.status).toBe(200);
    expect(dataOf<{ slug: string }>(moved).slug).toBe("studio-belle");

    expect((await publicPage("studio-belle")).status).toBe(200);
    expect((await publicPage("some-one")).status).toBe(404);
  });

  test("is refused when another studio already has it", async () => {
    const taken = await studio.owner.patch("/api/v1/organizations/settings", {
      slug: "neighbour-nails",
    });
    expect(taken.status).toBe(409);
    expect(errorCodeOf(taken)).toBe("SLUG_TAKEN");
  });

  test.each([
    ["admin", "reserved"],
    ["-belle", "invalid_characters"],
    ["studio_belle", "invalid_characters"],
  ])("refuses %s and says which rule it broke", async (slug, problem) => {
    const refused = await studio.owner.patch("/api/v1/organizations/settings", { slug });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("INVALID_SLUG");
    // The screen picks its sentence from this code, not from the message.
    expect(
      (refused.body as { error: { field_errors: { code: string }[] } }).error.field_errors[0].code,
    ).toBe(problem);
  });

  test("cannot be moved by a manager", async () => {
    const manager = await inviteMember(studio.owner, "rename-manager@studio.example", "manager");
    const refused = await manager.patch("/api/v1/organizations/settings", { slug: "manager-link" });
    expect(refused.status).toBe(403);
  });
});

describe("the studio's name", () => {
  test("is renamed without moving the link", async () => {
    const [{ slug: before }] = await adminDb
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, studio.organizationId));

    const renamed = await studio.owner.patch("/api/v1/organizations/settings", {
      name: "Studio Belle",
    });
    expect(renamed.status).toBe(200);
    expect(dataOf<{ name: string; slug: string }>(renamed)).toMatchObject({
      name: "Studio Belle",
      slug: before,
    });

    const page = dataOf<{ name: string }>(await publicPage(before!));
    expect(page.name).toBe("Studio Belle");
  });

  test("is refused in Cyrillic, as at sign-up", async () => {
    const refused = await studio.owner.patch("/api/v1/organizations/settings", {
      name: "Студия Белль",
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
  });
});
