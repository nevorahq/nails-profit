import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, organizationLogos } from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { PNG_PIXEL } from "../helpers/images";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The studio's own mark: storing it, serving it, and who may change it.
 *
 * The topbar draws `BrandMark`'s flower beside the studio's name, and it is the
 * product's mark rather than the studio's — the same one in every salon here. A
 * logo replaces it and removing one brings it back, which is why there is no
 * test for "the studio has no mark at all": that state does not exist in the
 * interface, only in this table.
 */
describe("a studio's logo", () => {
  let studio: Studio;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("owner@logo.example", "Logo Studio");
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  function upload(bytes: Buffer, name = "logo.png", type = "image/png") {
    const form = new FormData();
    // `Uint8Array` rather than the Buffer itself: a Buffer is not a `BlobPart`
    // under this TypeScript lib, and the view costs nothing.
    form.set("file", new File([new Uint8Array(bytes)], name, { type }));
    return form;
  }

  test("a studio with no logo is not an error anywhere but here", async () => {
    const response = await studio.owner.get("/api/v1/organizations/logo");

    // 404 is what tells the interface to draw the flower; the topbar never asks
    // at all, because the page reads the version and finds none.
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("NOT_FOUND");
  });

  test("an owner sets the mark, and it lands in their own organization", async () => {
    const response = await studio.owner.post("/api/v1/organizations/logo", upload(PNG_PIXEL));

    expect(response.status).toBe(201);
    const stored = dataOf<{ mime_type: string; byte_size: number; version: number }>(response);
    expect(stored.mime_type).toBe("image/png");
    expect(stored.byte_size).toBe(PNG_PIXEL.length);

    const [row] = await adminDb
      .select()
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, studio.organizationId));
    expect(Buffer.from(row.bytes).equals(PNG_PIXEL)).toBe(true);
  });

  test("serves the bytes back, and answers a repeat request without them", async () => {
    const first = await studio.owner.get("/api/v1/organizations/logo");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("content-length")).toBe(String(PNG_PIXEL.length));
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    // Private: the mark sits behind a session and must not land in a shared cache.
    expect(first.headers.get("cache-control")).toContain("private");

    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    // The topbar asks for this picture on every page of every session, so the
    // request that costs nothing is the one that matters most here.
    const second = await studio.owner.get("/api/v1/organizations/logo", {
      "if-none-match": etag as string,
    });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
  });

  test("everyone in the studio may see the mark that is drawn for them", async () => {
    const master = await inviteMember(studio.owner, "master@logo.example", "master");

    const seen = await master.get("/api/v1/organizations/logo");
    expect(seen.status).toBe(200);

    // Seeing it is not setting it: the mark is the studio's, and the studio is
    // the owner's to describe.
    const refused = await master.post("/api/v1/organizations/logo", upload(PNG_PIXEL));
    expect(refused.status).toBe(403);
    expect(await master.delete("/api/v1/organizations/logo").then((r) => r.status)).toBe(403);
  });

  test("the stored type is read from the bytes, not from what the upload claims", async () => {
    const response = await studio.owner.post(
      "/api/v1/organizations/logo",
      upload(PNG_PIXEL, "liar.jpg", "image/jpeg"),
    );

    expect(response.status).toBe(201);
    expect(dataOf<{ mime_type: string }>(response).mime_type).toBe("image/png");
  });

  test("replacing the mark moves the version, so a cached logo is not the old one", async () => {
    const before = await studio.owner.get("/api/v1/organizations/logo");
    const replaced = await studio.owner.post("/api/v1/organizations/logo", upload(PNG_PIXEL));
    const after = await studio.owner.get("/api/v1/organizations/logo");

    expect(replaced.status).toBe(201);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));

    const rows = await adminDb
      .select()
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, studio.organizationId));
    // Replaced, not appended to: one mark per studio, and no history of
    // half-megabyte rows behind it.
    expect(rows).toHaveLength(1);
  });

  test("refuses an SVG, whatever the upload calls it", async () => {
    // The file a designer is most likely to hand over, and the one format that
    // would run markup in the topbar of every signed-in page.
    const response = await studio.owner.post(
      "/api/v1/organizations/logo",
      upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), "logo.png", "image/png"),
    );

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
  });

  test("refuses a file over the size limit before reading it", async () => {
    const oversized = Buffer.concat([PNG_PIXEL, Buffer.alloc(512 * 1024)]);
    const response = await studio.owner.post("/api/v1/organizations/logo", upload(oversized));

    expect(response.status).toBe(413);
    expect(errorCodeOf(response)).toBe("FILE_TOO_LARGE");
  });

  test("another studio's owner sees their own absence of a mark, not ours", async () => {
    const other = await createCanonicalStudio("owner@other-logo.example", "Other Studio");

    // Not a 403: the route never names an organization, so a caller can only
    // ever reach their own row — and theirs is empty.
    expect(await other.owner.get("/api/v1/organizations/logo").then((r) => r.status)).toBe(404);

    await other.owner.post("/api/v1/organizations/logo", upload(PNG_PIXEL));
    const rows = await adminDb.select().from(organizationLogos);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.organizationId))).toEqual(
      new Set([studio.organizationId, other.organizationId]),
    );
  });

  test("removing the mark brings the flower back, and says so in the audit log", async () => {
    const removed = await studio.owner.delete("/api/v1/organizations/logo");
    expect(removed.status).toBe(200);

    // What the topbar reads to decide between a picture and the flower.
    expect(await studio.owner.get("/api/v1/organizations/logo").then((r) => r.status)).toBe(404);
    expect(await studio.owner.delete("/api/v1/organizations/logo").then((r) => r.status)).toBe(404);

    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, studio.organizationId));
    const types = events.map((event) => event.eventType);
    expect(types).toContain("organization.logo_set");
    expect(types).toContain("organization.logo_replaced");
    expect(types).toContain("organization.logo_removed");
    // The log describes the picture and never carries it.
    expect(JSON.stringify(events)).not.toContain(PNG_PIXEL.toString("base64").slice(0, 24));
  });

  test("deleting the studio erases its mark with the rest of its pictures", async () => {
    const erased = await createCanonicalStudio("owner@erased-logo.example", "Erased Studio");
    await erased.owner.post("/api/v1/organizations/logo", upload(PNG_PIXEL));

    // `organization_logo.organization_id` is ON DELETE restrict, so this only
    // succeeds because the delete route erases the mark on its way through.
    const response = await erased.owner.post("/api/v1/organizations/delete", {
      confirmation_name: "Erased Studio",
    });
    expect(response.status).toBe(200);
    expect(dataOf<{ logo_erased: boolean }>(response).logo_erased).toBe(true);

    expect(
      await adminDb
        .select()
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, erased.organizationId)),
    ).toHaveLength(0);
  });
});
