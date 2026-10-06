import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { storageDeletions, visitPhotos } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { memoryPhotoStorage } from "@/lib/photo-storage";
import { flushStorageDeletions, queueStudioPhotoDeletions } from "@/lib/visit-photos";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createOrganization, createSpecialist, createUser, createVisit } from "../helpers/factories";

/**
 * Through `@/db`, the application role, so the tenant policy is in force: the
 * rows say where a studio's pictures of its clients' hands are, and the queue
 * says which of them are owed an erasure. Neither belongs to the studio next
 * door.
 */
afterAll(async () => {
  await closeTestConnections();
});

describe("photo rows and the deletion queue", () => {
  let orgA: string;
  let orgB: string;
  let visitA: string;
  let visitB: string;

  async function photo(organizationId: string, visitId: string, name: string) {
    await adminDb.insert(visitPhotos).values({
      organizationId,
      visitId,
      storagePath: `${organizationId}/${visitId}/${name}.webp`,
      mimeType: "image/webp",
      sizeBytes: 100,
      width: 10,
      height: 10,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    orgA = (await createOrganization({ name: "A", ownerId: (await createUser()).id })).id;
    orgB = (await createOrganization({ name: "B", ownerId: (await createUser()).id })).id;
    visitA = (await createVisit(orgA, { specialistId: (await createSpecialist(orgA)).id })).id;
    visitB = (await createVisit(orgB, { specialistId: (await createSpecialist(orgB)).id })).id;
    await photo(orgA, visitA, "a");
    await photo(orgB, visitB, "b");
  });

  it("shows a studio only its own photos, and none without a tenant", async () => {
    const seenByA = await withTenant(orgA, (tx) => tx.select().from(visitPhotos));
    expect(seenByA.map((row) => row.visitId)).toEqual([visitA]);
    expect(await db.select().from(visitPhotos)).toEqual([]);
  });

  it("refuses to file a photo or a deletion under another studio", async () => {
    await expect(
      withTenant(orgA, (tx) =>
        tx.insert(visitPhotos).values({
          organizationId: orgB,
          visitId: visitB,
          storagePath: "x.webp",
          mimeType: "image/webp",
          sizeBytes: 1,
          width: 1,
          height: 1,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(orgA, (tx) => tx.insert(storageDeletions).values({ organizationId: orgB, storagePath: "x.webp" })),
    ).rejects.toThrow();
  });

  it("deleting a studio's photos queues its own paths and nobody else's, and a flush pays only its own", async () => {
    const queued = await withTenant(orgA, (tx) => queueStudioPhotoDeletions(tx, orgA));
    expect(queued).toBe(1);

    const owed = await adminDb.select().from(storageDeletions);
    expect(owed.map((row) => row.storagePath)).toEqual([`${orgA}/${visitA}/a.webp`]);
    expect(await adminDb.select().from(visitPhotos)).toHaveLength(1);

    await adminDb.insert(storageDeletions).values({ organizationId: orgB, storagePath: `${orgB}/${visitB}/b.webp` });
    const storage = memoryPhotoStorage();
    const removed: string[] = [];
    const outcome = await flushStorageDeletions(orgA, {
      ...storage,
      remove: async (paths) => {
        removed.push(...paths);
      },
    });
    expect(outcome).toEqual({ removed: 1, failed: 0 });
    expect(removed).toEqual([`${orgA}/${visitA}/a.webp`]);
    expect((await adminDb.select().from(storageDeletions)).map((row) => row.organizationId)).toEqual([orgB]);
  });
});
