import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { storageDeletions, visitPhotos, visits } from "@/db/schema";
import { memoryPhotoStorage, PhotoStorageError, setPhotoStorage, type PhotoStorage } from "@/lib/photo-storage";
import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { PNG_PIXEL } from "../helpers/images";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Photos of work at a visit, roadmap phase 8: who may add and see them, the
 * limits, and that every way a photo's row goes takes the object in the bucket
 * with it — now, or from the queue when Storage could not be reached.
 *
 * The bucket is the in-memory driver; the Supabase driver's requests are
 * covered in `lib/photo-storage.test.ts`.
 */
type Photo = { id: string; url: string; width: number; height: number };
type PhotoList = { enabled: boolean; max_per_visit: number; photos: Photo[] };

let studio: Studio;
let master: Actor;
let stranger: Actor;
let analyst: Actor;
let colleagueCard: string;
let clientId: string;
let storage: ReturnType<typeof memoryPhotoStorage>;

function upload(bytes: Buffer = PNG_PIXEL, size: { width?: string; height?: string } = { width: "1", height: "1" }) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "work.png", { type: "image/png" }));
  if (size.width !== undefined) form.set("width", size.width);
  if (size.height !== undefined) form.set("height", size.height);
  return form;
}

async function visit(specialistId = studio.specialistId, client: string | null = clientId) {
  return dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: specialistId,
      ...(client ? { client_id: client } : {}),
    }),
  ).id;
}

async function addPhoto(visitId: string, actor: Actor = studio.owner) {
  return dataOf<Photo>(await actor.post(`/api/v1/visits/${visitId}/photos`, upload()));
}

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("photos-owner@studio.example", "Photos Studio");
  master = await inviteMember(studio.owner, "photos-master@studio.example", "master");
  stranger = await inviteMember(studio.owner, "photos-stranger@studio.example", "master");
  analyst = await inviteMember(studio.owner, "photos-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });
  colleagueCard = dataOf<{ id: string }>(
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
  await closeTestConnections();
});

function useMemory() {
  storage = memoryPhotoStorage();
  setPhotoStorage(storage);
  return storage;
}

describe("adding and seeing photos", () => {
  test("an owner adds a photo; the object lands under the studio's prefix", async () => {
    useMemory();
    const visitId = await visit();
    const response = await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload());
    expect(response.status).toBe(201);
    const photo = dataOf<Photo>(response);

    const [row] = await adminDb.select().from(visitPhotos).where(eq(visitPhotos.id, photo.id));
    expect(row.storagePath).toBe(`${studio.organizationId}/${visitId}/${photo.id}.png`);
    // What the bytes are, not what the upload called them.
    expect(row.mimeType).toBe("image/png");
    expect(storage.objects.has(row.storagePath)).toBe(true);

    const list = dataOf<PhotoList>(await studio.owner.get(`/api/v1/visits/${visitId}/photos`));
    expect(list).toMatchObject({ enabled: true, max_per_visit: 4 });
    expect(list.photos.map((item) => item.id)).toEqual([photo.id]);
    expect(list.photos[0].url).toBe(`/api/v1/visits/${visitId}/photos/${photo.id}`);
  });

  test("the photo is served privately through the application", async () => {
    useMemory();
    const visitId = await visit();
    const photo = await addPhoto(visitId);

    const served = await studio.owner.get(photo.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("private");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("with a bucket that signs, the browser is sent to a link that expires", async () => {
    const memory = useMemory();
    const signing: PhotoStorage = {
      ...memory,
      name: "supabase",
      signedUrl: async (storagePath, seconds) => `https://bucket.example/${storagePath}?expires=${seconds}`,
    };
    setPhotoStorage(signing);
    const visitId = await visit();
    const photo = await addPhoto(visitId);

    const served = await studio.owner.get(photo.url);
    expect(served.status).toBe(302);
    expect(served.headers.get("location")).toMatch(/^https:\/\/bucket\.example\/.+\?expires=3600$/);
    expect(served.headers.get("cache-control")).toContain("private");
  });

  test("a master adds to and sees their own visits only", async () => {
    useMemory();
    const own = await visit();
    const colleagues = await visit(colleagueCard);

    expect((await master.post(`/api/v1/visits/${own}/photos`, upload())).status).toBe(201);
    expect((await master.get(`/api/v1/visits/${own}/photos`)).status).toBe(200);

    const theirs = await addPhoto(colleagues);
    expect((await master.post(`/api/v1/visits/${colleagues}/photos`, upload())).status).toBe(404);
    expect((await master.get(`/api/v1/visits/${colleagues}/photos`)).status).toBe(404);
    expect((await master.get(theirs.url)).status).toBe(404);
    expect((await master.delete(theirs.url)).status).toBe(404);
    // A master with no card of their own owns no visit at all.
    expect((await stranger.get(`/api/v1/visits/${own}/photos`)).status).toBe(404);
  });

  test("an analyst sees no photo and adds none: a picture of hands is the client's", async () => {
    useMemory();
    const visitId = await visit();
    const photo = await addPhoto(visitId);

    expect((await analyst.get(`/api/v1/visits/${visitId}/photos`)).status).toBe(403);
    expect((await analyst.get(photo.url)).status).toBe(403);
    expect((await analyst.post(`/api/v1/visits/${visitId}/photos`, upload())).status).toBe(403);
  });
});

describe("what is refused", () => {
  test("a fifth photo on one visit", async () => {
    useMemory();
    const visitId = await visit();
    for (let index = 0; index < 4; index += 1) await addPhoto(visitId);

    const fifth = await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload());
    expect(fifth.status).toBe(409);
    expect(errorCodeOf(fifth)).toBe("VISIT_PHOTOS_FULL");
  });

  test("something that is not an image, something too large, and a photo without its size", async () => {
    useMemory();
    const visitId = await visit();

    const script = await studio.owner.post(
      `/api/v1/visits/${visitId}/photos`,
      upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    );
    expect(script.status).toBe(422);

    const oversized = Buffer.concat([PNG_PIXEL, Buffer.alloc(512 * 1024)]);
    expect((await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload(oversized))).status).toBe(413);

    const sizeless = await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload(PNG_PIXEL, {}));
    expect(sizeless.status).toBe(422);
    expect(storage.objects.size).toBe(0);
  });

  test("with no bucket set up, photos are off and say so", async () => {
    setPhotoStorage(null);
    const visitId = await visit();

    const refused = await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload());
    expect(refused.status).toBe(503);
    expect(errorCodeOf(refused)).toBe("PHOTOS_NOT_CONFIGURED");
    expect(dataOf<PhotoList>(await studio.owner.get(`/api/v1/visits/${visitId}/photos`)).enabled).toBe(false);
  });

  test("a bucket that refuses the upload leaves no row behind", async () => {
    const memory = useMemory();
    setPhotoStorage({
      ...memory,
      put: async () => {
        throw new PhotoStorageError("upload", 500);
      },
    });
    const visitId = await visit();

    const failed = await studio.owner.post(`/api/v1/visits/${visitId}/photos`, upload());
    expect(failed.status).toBe(502);
    expect(errorCodeOf(failed)).toBe("PHOTO_STORAGE_FAILED");
    expect(await adminDb.select().from(visitPhotos).where(eq(visitPhotos.visitId, visitId))).toEqual([]);
  });
});

describe("every way a photo goes takes its object with it", () => {
  async function pathsOf(visitId: string) {
    return (await adminDb.select().from(visitPhotos).where(eq(visitPhotos.visitId, visitId))).map(
      (row) => row.storagePath,
    );
  }

  test("removing one photo", async () => {
    useMemory();
    const visitId = await visit();
    const photo = await addPhoto(visitId);
    const [path] = await pathsOf(visitId);

    expect((await studio.owner.delete(photo.url)).status).toBe(200);
    expect(await pathsOf(visitId)).toEqual([]);
    expect(storage.objects.has(path)).toBe(false);
    expect(await adminDb.select().from(storageDeletions)).toEqual([]);
  });

  test("a bucket out of reach keeps the debt in the queue, and the next sweep pays it", async () => {
    const memory = useMemory();
    const visitId = await visit();
    const photo = await addPhoto(visitId);
    const [path] = await pathsOf(visitId);

    setPhotoStorage({
      ...memory,
      remove: async () => {
        throw new PhotoStorageError("delete", 503);
      },
    });
    expect((await studio.owner.delete(photo.url)).status).toBe(200);
    const [owed] = await adminDb.select().from(storageDeletions).where(eq(storageDeletions.storagePath, path));
    expect(owed.attempts).toBe(1);
    expect(memory.objects.has(path)).toBe(true);

    setPhotoStorage(memory);
    const { sweepStorageDeletions } = await import("@/lib/visit-photos");
    expect((await sweepStorageDeletions()).removed).toBeGreaterThanOrEqual(1);
    expect(memory.objects.has(path)).toBe(false);
    expect(await adminDb.select().from(storageDeletions).where(eq(storageDeletions.storagePath, path))).toEqual([]);
  });

  test("deleting the visit", async () => {
    useMemory();
    const visitId = await visit();
    await addPhoto(visitId);
    const [path] = await pathsOf(visitId);

    expect((await studio.owner.delete(`/api/v1/visits/${visitId}`)).status).toBe(200);
    expect(storage.objects.has(path)).toBe(false);
  });

  test("erasing the client: the visits stay, the pictures of their hands do not", async () => {
    useMemory();
    const erased = dataOf<{ id: string }>(await studio.owner.post("/api/v1/clients", { name: "Стереть" })).id;
    const visitId = await visit(studio.specialistId, erased);
    await addPhoto(visitId);
    const [path] = await pathsOf(visitId);

    expect((await studio.owner.delete(`/api/v1/clients/${erased}`)).status).toBe(200);
    expect(await adminDb.select().from(visits).where(eq(visits.id, visitId))).toHaveLength(1);
    expect(await pathsOf(visitId)).toEqual([]);
    expect(storage.objects.has(path)).toBe(false);
  });

  test("the export lists every photo with a link to it", async () => {
    useMemory();
    const visitId = await visit();
    const photo = await addPhoto(visitId);

    const exported = dataOf<{ format_version: number; visit_photos: { id: string; url: string; storagePath?: string }[] }>(
      await studio.owner.get("/api/v1/organizations/export"),
    );
    expect(exported.format_version).toBe(6);
    const listed = exported.visit_photos.find((item) => item.id === photo.id);
    // A driver that does not sign links to the application's own address.
    expect(listed?.url).toBe(photo.url);
    // The bucket's layout is not part of what leaves the server.
    expect(listed).not.toHaveProperty("storagePath");
  });

  test("deleting the studio", async () => {
    useMemory();
    const other = await createCanonicalStudio("photos-other@studio.example", "Gone Studio");
    const visitId = dataOf<{ id: string }>(
      await other.owner.post("/api/v1/visits", { service_id: other.serviceId, specialist_id: other.specialistId }),
    ).id;
    await addPhoto(visitId, other.owner);
    const [path] = await pathsOf(visitId);

    expect(
      (await other.owner.post("/api/v1/organizations/delete", { confirmation_name: "Gone Studio" })).status,
    ).toBe(200);
    expect(storage.objects.has(path)).toBe(false);
  });
});
