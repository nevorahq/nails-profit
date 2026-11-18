import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { galleryPhotos, organizations, specialists } from "@/db/schema";
import { memoryPhotoStorage, setPhotoStorage } from "@/lib/photo-storage";
import { loadPublicGallery, PUBLIC_GALLERY_LIMIT } from "@/lib/public-gallery";
import { anonymous, dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { PNG_PIXEL } from "../helpers/images";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The studio's finished work on its public booking page: who may publish a
 * photo, that it needs the client's consent, and that a photo is public exactly
 * as long as a gallery row says so — taken down, its master archived, the photo
 * deleted or the client erased, the address stops serving it.
 */
const slug = "gallery-photos";
const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

let studio: Studio;
let master: Actor;
let analyst: Actor;
let colleagueId: string;
let clientId: string;
let storage: ReturnType<typeof memoryPhotoStorage>;

type Photo = { id: string; url: string };

function upload() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(PNG_PIXEL)], "work.png", { type: "image/png" }));
  form.set("width", "1");
  form.set("height", "1");
  return form;
}

async function photo(specialistId = studio.specialistId, client: string | null = clientId): Promise<Photo> {
  const visitId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: specialistId,
      ...(client ? { client_id: client } : {}),
    }),
  ).id;
  return dataOf<Photo>(await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload()));
}

const publish = (actor: Actor, shown: Photo, body: Parameters<Actor["post"]>[1] = { client_consent: true }) =>
  actor.post(`${shown.url}/gallery`, body);

async function galleryId(shown: Photo) {
  const photoId = shown.url.split("/").pop() as string;
  const [row] = await adminDb.select().from(galleryPhotos).where(eq(galleryPhotos.visitPhotoId, photoId));
  return row?.id ?? null;
}

const served = (id: string) => anonymous.get(`/api/v1/public/booking/${slug}/gallery/${id}`);

beforeAll(async () => {
  process.env.PUBLIC_BOOKING_ENABLED = "true";
  await resetDatabase();
  studio = await createCanonicalStudio("gallery-owner@studio.example", "Gallery Studio");
  await studio.owner.patch("/api/v1/organizations/settings", { slug });
  await adminDb
    .update(organizations)
    .set({ bookingAccess: "public" })
    .where(eq(organizations.id, studio.organizationId));
  const locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", { name: "Centru", slug: "centru", timezone: "Europe/Chisinau" }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, { location_ids: [locationId] });
  await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    public_status: "published",
    confirmation_mode: "instant",
    min_lead_minutes: 0,
    max_advance_days: 90,
  });

  master = await inviteMember(studio.owner, "gallery-master@studio.example", "master");
  analyst = await inviteMember(studio.owner, "gallery-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });
  colleagueId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/specialists", {
      name: "Коллега",
      default_rule: { type: "percentage", basis_points: 4_000 },
    }),
  ).id;
  clientId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/clients", { name: "Мария", phone: "+37369555111" }),
  ).id;
}, 60_000);

afterEach(() => {
  setPhotoStorage(undefined);
});

afterAll(async () => {
  setPhotoStorage(undefined);
  if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
  else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
  await closeTestConnections();
});

function useMemory() {
  storage = memoryPhotoStorage();
  setPhotoStorage(storage);
}

describe("publishing a photo", () => {
  test("needs the client's consent, stated", async () => {
    useMemory();
    const shown = await photo();
    for (const body of [{}, { client_consent: false }, { client_consent: "yes" }]) {
      const response = await publish(studio.owner, shown, body);
      expect(response.status).toBe(422);
    }
    expect(await galleryId(shown)).toBeNull();
  });

  test("an owner publishes it; the page lists it and the public address serves its bytes", async () => {
    useMemory();
    const shown = await photo();
    expect((await publish(studio.owner, shown)).status).toBe(200);
    const id = await galleryId(shown);
    expect(id).not.toBeNull();

    const listed = await loadPublicGallery(slug);
    expect(listed.map((item) => item.id)).toContain(id);
    expect(listed.find((item) => item.id === id)).toMatchObject({
      url: `/api/v1/public/booking/${slug}/gallery/${id}`,
      specialistId: studio.specialistId,
    });

    const response = await served(id as string);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("publishing twice is one publication", async () => {
    useMemory();
    const shown = await photo();
    await publish(studio.owner, shown);
    const first = await galleryId(shown);
    expect((await publish(studio.owner, shown)).status).toBe(200);
    expect(await galleryId(shown)).toBe(first);
  });

  test("taking it down closes the public address", async () => {
    useMemory();
    const shown = await photo();
    await publish(studio.owner, shown);
    const id = (await galleryId(shown)) as string;

    expect((await studio.owner.delete(`${shown.url}/gallery`)).status).toBe(200);
    expect((await served(id)).status).toBe(404);
    expect((await loadPublicGallery(slug)).map((item) => item.id)).not.toContain(id);
  });

  test("a photo that was never published is not served, and nor is an unknown id", async () => {
    useMemory();
    const shown = await photo();
    // The photo's own id is not a publication's id.
    expect((await served(shown.id)).status).toBe(404);
    expect((await served("not-a-uuid")).status).toBe(404);
    expect((await served(crypto.randomUUID())).status).toBe(404);
  });
});

describe("who may publish", () => {
  test("a master publishes the photos of their own visits only", async () => {
    useMemory();
    const own = await photo(studio.specialistId);
    const colleagues = await photo(colleagueId);

    expect((await publish(master, own)).status).toBe(200);
    const response = await publish(master, colleagues);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("PHOTO_NOT_FOUND");
    expect(await galleryId(colleagues)).toBeNull();
  });

  test("an analyst may not, and a stranger's studio cannot see the photo", async () => {
    useMemory();
    const shown = await photo();
    expect((await publish(analyst, shown)).status).toBe(403);

    const other = await createCanonicalStudio("gallery-other@studio.example", "Other Studio");
    expect((await publish(other.owner, shown)).status).toBe(404);
    expect((await other.owner.delete(`${shown.url}/gallery`)).status).toBe(404);
    expect(await galleryId(shown)).toBeNull();
  });

  test("nobody signed in may", async () => {
    useMemory();
    const shown = await photo();
    expect((await publish(anonymous, shown)).status).toBe(401);
  });
});

describe("what keeps a photo public", () => {
  test("a photo of an archived master leaves the page with them", async () => {
    useMemory();
    const shown = await photo(colleagueId);
    await publish(studio.owner, shown);
    const id = (await galleryId(shown)) as string;
    expect((await served(id)).status).toBe(200);

    await adminDb.update(specialists).set({ archivedAt: new Date() }).where(eq(specialists.id, colleagueId));
    try {
      expect((await served(id)).status).toBe(404);
      expect((await loadPublicGallery(slug)).map((item) => item.id)).not.toContain(id);
    } finally {
      await adminDb.update(specialists).set({ archivedAt: null }).where(eq(specialists.id, colleagueId));
    }
  });

  test("deleting the photo takes its publication with it", async () => {
    useMemory();
    const shown = await photo();
    await publish(studio.owner, shown);
    const id = (await galleryId(shown)) as string;

    expect((await studio.owner.delete(shown.url)).status).toBe(200);
    expect(await galleryId(shown)).toBeNull();
    expect((await served(id)).status).toBe(404);
  });

  test("erasing the client takes the photos of their visits off the page", async () => {
    useMemory();
    const erased = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", { name: "Ирина", phone: "+37369555222" }),
    ).id;
    const shown = await photo(studio.specialistId, erased);
    await publish(studio.owner, shown);
    const id = (await galleryId(shown)) as string;

    expect((await studio.owner.delete(`/api/v1/clients/${erased}`)).status).toBe(200);
    expect(await galleryId(shown)).toBeNull();
    expect((await served(id)).status).toBe(404);
  });

  test("the page carries the newest photos, and no more than its limit", async () => {
    useMemory();
    const ids: string[] = [];
    for (let count = 0; count < PUBLIC_GALLERY_LIMIT + 1; count += 1) {
      const shown = await photo();
      await publish(studio.owner, shown);
      ids.push((await galleryId(shown)) as string);
    }

    const listed = (await loadPublicGallery(slug)).map((item) => item.id);
    expect(listed).toHaveLength(PUBLIC_GALLERY_LIMIT);
    // The last one published is first; the first one published fell off the end.
    expect(listed[0]).toBe(ids[ids.length - 1]);
    expect(listed).not.toContain(ids[0]);
  });
});
