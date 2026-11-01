import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations, specialists } from "@/db/schema";
import { anonymous, dataOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { PNG_PIXEL } from "../helpers/images";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The faces on the booking page: the catalogue says which masters have one, and
 * a route with no session serves it — to a master the page offers, and to no one
 * the page does not.
 */
describe("public booking: master photos", () => {
  let studio: Studio;
  let locationId: string;
  let colleagueId: string;
  let hiddenId: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;
  const base = "/api/v1/public/booking/booking-photo";

  function upload(bytes: Buffer) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "face.png", { type: "image/png" }));
    return form;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("booking-photo@studio.example", "Booking Photo Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "booking-photo" });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Centru", slug: "centru", timezone: "Europe/Chisinau" }),
    ).id;
    colleagueId = dataOf<{ id: string }>(await studio.owner.post("/api/v1/specialists", { name: "Ana" })).id;
    hiddenId = dataOf<{ id: string }>(await studio.owner.post("/api/v1/specialists", { name: "Elena" })).id;
    for (const id of [studio.specialistId, colleagueId]) {
      await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [locationId] });
    }
    // Elena is on file but on no address, so the page does not offer her.
    await studio.owner.put(`/api/v1/specialists/${hiddenId}/locations`, { location_ids: [] });
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
      max_advance_days: 90,
    });
    await studio.owner.post(`/api/v1/specialists/${colleagueId}/avatar`, upload(PNG_PIXEL));
    await studio.owner.post(`/api/v1/specialists/${hiddenId}/avatar`, upload(PNG_PIXEL));
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  test("the catalogue carries the photo version for a master who has one, null for one who has not", async () => {
    const catalogue = dataOf<{
      services: { specialists: { id: string; photo_version: number | null }[] }[];
    }>(await anonymous.get(`${base}/catalog?location_id=${locationId}`));
    const people = catalogue.services[0].specialists;

    expect(people.find((person) => person.id === colleagueId)?.photo_version).toBe(1);
    expect(people.find((person) => person.id === studio.specialistId)?.photo_version).toBeNull();
  });

  test("anyone can fetch the photo of a master the page offers", async () => {
    const response = await anonymous.get(`${base}/specialists/${colleagueId}/avatar?v=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("public");
  });

  test("a repeat request with the etag is answered without the bytes", async () => {
    const first = await anonymous.get(`${base}/specialists/${colleagueId}/avatar`);
    const etag = first.headers.get("etag") as string;
    const again = await anonymous.get(`${base}/specialists/${colleagueId}/avatar`, { "if-none-match": etag });

    expect(again.status).toBe(304);
  });

  test("a master the page does not offer has no public photo", async () => {
    const response = await anonymous.get(`${base}/specialists/${hiddenId}/avatar`);
    expect(response.status).toBe(404);
  });

  test("a master with no photo, an unknown id and an archived card are all 404", async () => {
    expect((await anonymous.get(`${base}/specialists/${studio.specialistId}/avatar`)).status).toBe(404);
    expect((await anonymous.get(`${base}/specialists/not-an-id/avatar`)).status).toBe(404);

    await adminDb.update(specialists).set({ archivedAt: new Date() }).where(eq(specialists.id, colleagueId));
    expect((await anonymous.get(`${base}/specialists/${colleagueId}/avatar`)).status).toBe(404);
  });

  test("a studio that is not public serves no photo", async () => {
    const response = await anonymous.get(`/api/v1/public/booking/no-such-studio/specialists/${colleagueId}/avatar`);
    expect(response.status).toBe(404);
  });
});
