import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, specialistAvatars } from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { PNG_PIXEL } from "../helpers/images";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * A master's photo: storing it, serving it, and refusing what is not one.
 *
 * The picture the calendar and the visits list draw used to come from
 * `user.image`, which nothing ever wrote — so a face was unreachable for
 * everyone, and permanently unreachable for the masters a studio records
 * without an account. It comes from the card now, which is what these tests are
 * about: who may set it, what counts as an image, and what a second request for
 * the same photo costs.
 */
describe("a specialist's photo", () => {
  let studio: Studio;
  let cardWithoutAccount: string;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("owner@avatar.example", "Avatar Studio");
    cardWithoutAccount = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Без логина" }),
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  function upload(bytes: Buffer, name = "face.png", type = "image/png") {
    const form = new FormData();
    // `Uint8Array` rather than the Buffer itself: a Buffer is not a `BlobPart`
    // under this TypeScript lib, and the view costs nothing.
    form.set("file", new File([new Uint8Array(bytes)], name, { type }));
    return form;
  }

  test("an owner sets a photo on a card that has no account behind it", async () => {
    const response = await studio.owner.post<{ data: { mime_type: string; byte_size: number; version: number } }>(
      `/api/v1/specialists/${cardWithoutAccount}/avatar`,
      upload(PNG_PIXEL),
    );

    expect(response.status).toBe(201);
    const stored = dataOf<{ mime_type: string; byte_size: number; version: number }>(response);
    expect(stored.mime_type).toBe("image/png");
    expect(stored.byte_size).toBe(PNG_PIXEL.length);

    const [row] = await adminDb
      .select()
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, cardWithoutAccount));
    expect(Buffer.from(row.bytes).equals(PNG_PIXEL)).toBe(true);
    expect(row.organizationId).toBe(studio.organizationId);
  });

  test("serves the bytes back, and answers a repeat request without them", async () => {
    const first = await studio.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`);

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("content-length")).toBe(String(PNG_PIXEL.length));
    // Sniffing is what would let a file stored as an image be run as something
    // else, whatever the bytes turned out to be.
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    // Private: a face sits behind a session and must not land in a shared cache.
    expect(first.headers.get("cache-control")).toContain("private");

    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await studio.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`, {
      "if-none-match": etag as string,
    });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
  });

  test("the stored type is read from the bytes, not from what the upload claims", async () => {
    // A PNG announced as a JPEG. The header is written by the caller; the
    // signature is written by whatever produced the file.
    const response = await studio.owner.post(
      `/api/v1/specialists/${cardWithoutAccount}/avatar`,
      upload(PNG_PIXEL, "liar.jpg", "image/jpeg"),
    );

    expect(response.status).toBe(201);
    expect(dataOf<{ mime_type: string }>(response).mime_type).toBe("image/png");
  });

  test("replacing a photo moves the version, so a cached face is not the old one", async () => {
    const before = await studio.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`);
    const replaced = await studio.owner.post(
      `/api/v1/specialists/${cardWithoutAccount}/avatar`,
      upload(PNG_PIXEL),
    );
    const after = await studio.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`);

    expect(replaced.status).toBe(201);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));

    const rows = await adminDb
      .select()
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, cardWithoutAccount));
    // Replaced, not appended to: one row, and no history of half-megabyte rows.
    expect(rows).toHaveLength(1);
  });

  test("refuses a file that is not an image, whatever it is called", async () => {
    const response = await studio.owner.post(
      `/api/v1/specialists/${studio.specialistId}/avatar`,
      upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), "face.png", "image/png"),
    );

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    expect(
      await adminDb.select().from(specialistAvatars).where(eq(specialistAvatars.specialistId, studio.specialistId)),
    ).toHaveLength(0);
  });

  test("refuses a file over the size limit before reading it", async () => {
    const oversized = Buffer.concat([PNG_PIXEL, Buffer.alloc(512 * 1024)]);
    const response = await studio.owner.post(
      `/api/v1/specialists/${studio.specialistId}/avatar`,
      upload(oversized),
    );

    expect(response.status).toBe(413);
    expect(errorCodeOf(response)).toBe("FILE_TOO_LARGE");
  });

  test("a master may not set a photo, and a card from another studio is not found", async () => {
    const master = await inviteMember(studio.owner, "master@avatar.example", "master");
    const refused = await master.post(
      `/api/v1/specialists/${cardWithoutAccount}/avatar`,
      upload(PNG_PIXEL),
    );
    expect(refused.status).toBe(403);

    const other = await createCanonicalStudio("owner@other-avatar.example", "Other Studio");
    const across = await other.owner.post(
      `/api/v1/specialists/${cardWithoutAccount}/avatar`,
      upload(PNG_PIXEL),
    );
    // Not 403: the tenant policy makes the row invisible rather than forbidden,
    // which is the answer that does not confirm the card exists.
    expect(across.status).toBe(404);

    const stillOurs = await other.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`);
    expect(stillOurs.status).toBe(404);
  });

  test("removing the photo leaves the card, and says so in the audit log", async () => {
    const removed = await studio.owner.delete(`/api/v1/specialists/${cardWithoutAccount}/avatar`);
    expect(removed.status).toBe(200);

    const gone = await studio.owner.get(`/api/v1/specialists/${cardWithoutAccount}/avatar`);
    expect(gone.status).toBe(404);

    const again = await studio.owner.delete(`/api/v1/specialists/${cardWithoutAccount}/avatar`);
    expect(again.status).toBe(404);

    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, cardWithoutAccount));
    const types = events.map((event) => event.eventType);
    expect(types).toContain("specialist.avatar_set");
    expect(types).toContain("specialist.avatar_replaced");
    expect(types).toContain("specialist.avatar_removed");
    // The log describes the photo and never carries it.
    expect(JSON.stringify(events)).not.toContain(PNG_PIXEL.toString("base64").slice(0, 24));
  });

  test("deleting the master takes the photo with them", async () => {
    const card = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Ошибка ввода" }),
    ).id;
    await studio.owner.post(`/api/v1/specialists/${card}/avatar`, upload(PNG_PIXEL));

    // `specialist_avatar.specialist_id` is ON DELETE restrict, so this only
    // succeeds because the route removes the photo before the card.
    const response = await studio.owner.delete(`/api/v1/specialists/${card}`);
    expect(response.status).toBe(200);

    expect(
      await adminDb.select().from(specialistAvatars).where(eq(specialistAvatars.specialistId, card)),
    ).toHaveLength(0);
  });
});
