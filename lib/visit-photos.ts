import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { organizations, storageDeletions, visitPhotos, visits } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import { can, hasConstraint, type MemberRole } from "@/domain/rbac";
import { logEvent } from "@/lib/logger";
import { getPhotoStorage, PhotoStorageError, type PhotoStorage } from "@/lib/photo-storage";

/** Where the application serves one photo; the route checks access and signs. */
export function photoUrl(visitId: string, photoId: string) {
  return `/api/v1/visits/${visitId}/photos/${photoId}`;
}

/**
 * Who may see or add photos of work: whoever may read (or change) visits,
 * except an Analyst — a photo of somebody's hands is the client's, like their
 * number, and is withheld under the same `exclude_pii`. A Master's own visits
 * only; the routes narrow that with `mayActOnSpecialist`.
 */
export function mayHandlePhotos(role: MemberRole, action: "read" | "write") {
  return can(role, "bookings", action) && !hasConstraint(role, "clients", "exclude_pii");
}

/**
 * Removing photos of work: the rows in this transaction, the objects after it.
 *
 * Postgres and Storage cannot commit together, so the rows go here and their
 * paths are written to `storage_deletion` in the same transaction. The caller
 * then calls `flushStorageDeletions` once it has committed, and the
 * maintenance job sweeps whatever that could not reach. A photo of a client who
 * asked to be erased survives a network error as a row in a queue, never as an
 * object nobody remembers.
 */
async function queueDeletionOf(tx: TenantTransaction, organizationId: string, where: SQL | undefined) {
  const doomed = await tx
    .delete(visitPhotos)
    .where(and(eq(visitPhotos.organizationId, organizationId), where))
    .returning({ storagePath: visitPhotos.storagePath });
  if (doomed.length > 0) {
    await tx
      .insert(storageDeletions)
      .values(doomed.map((row) => ({ organizationId, storagePath: row.storagePath })));
  }
  return doomed.length;
}

/** Photos of these visits — before the visits themselves are deleted. */
export function queueVisitPhotoDeletions(tx: TenantTransaction, organizationId: string, visitIds: readonly string[]) {
  if (visitIds.length === 0) return Promise.resolve(0);
  return queueDeletionOf(tx, organizationId, inArray(visitPhotos.visitId, [...visitIds]));
}

/** Photos of every visit of one client: erasure keeps the visits and not the pictures. */
export function queueClientPhotoDeletions(tx: TenantTransaction, organizationId: string, clientId: string) {
  return queueDeletionOf(
    tx,
    organizationId,
    inArray(
      visitPhotos.visitId,
      tx.select({ id: visits.id }).from(visits).where(eq(visits.clientId, clientId)),
    ),
  );
}

/** Every photo of the studio, when the studio itself is deleted. */
export function queueStudioPhotoDeletions(tx: TenantTransaction, organizationId: string) {
  return queueDeletionOf(tx, organizationId, undefined);
}

/** One photo, removed from its visit card. */
export function queuePhotoDeletion(tx: TenantTransaction, organizationId: string, photoId: string) {
  return queueDeletionOf(tx, organizationId, eq(visitPhotos.id, photoId));
}

const BATCH = 100;

/**
 * Removes what the queue owes for one studio. Called right after the deleting
 * transaction commits, and by the sweep. Never throws: a failure stays queued
 * with its attempt counted, which is the whole point of the queue.
 */
export async function flushStorageDeletions(
  organizationId: string,
  storage: PhotoStorage | null = getPhotoStorage(),
): Promise<{ removed: number; failed: number }> {
  // Not set up here: the queue waits for a deployment that can reach the bucket.
  if (!storage) return { removed: 0, failed: 0 };

  try {
    return await withTenant(organizationId, async (tx) => {
      const owed = await tx
        .select({ id: storageDeletions.id, storagePath: storageDeletions.storagePath })
        .from(storageDeletions)
        .orderBy(asc(storageDeletions.createdAt))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      if (owed.length === 0) return { removed: 0, failed: 0 };

      try {
        await storage.remove(owed.map((row) => row.storagePath));
      } catch (error) {
        await tx
          .update(storageDeletions)
          .set({
            attempts: sql`${storageDeletions.attempts} + 1`,
            lastError: error instanceof PhotoStorageError ? error.message : "unreachable",
          })
          .where(inArray(storageDeletions.id, owed.map((row) => row.id)));
        logEvent("error", "photo.storage_delete_failed", { organizationId }, {
          paths: owed.length,
          reason: error instanceof PhotoStorageError ? error.status : "unreachable",
        });
        return { removed: 0, failed: owed.length };
      }

      await tx.delete(storageDeletions).where(inArray(storageDeletions.id, owed.map((row) => row.id)));
      return { removed: owed.length, failed: 0 };
    });
  } catch (error) {
    logEvent("error", "photo.storage_delete_failed", { organizationId }, {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { removed: 0, failed: 0 };
  }
}

/**
 * The maintenance job's half: every studio, deleted ones included — a studio
 * that was deleted is exactly the one whose photos are owed a removal.
 */
export async function sweepStorageDeletions(): Promise<{ removed: number; failed: number }> {
  const storage = getPhotoStorage();
  if (!storage) return { removed: 0, failed: 0 };

  const tenants = await db.select({ id: organizations.id }).from(organizations);
  let removed = 0;
  let failed = 0;
  for (const tenant of tenants) {
    const outcome = await flushStorageDeletions(tenant.id, storage);
    removed += outcome.removed;
    failed += outcome.failed;
  }
  return { removed, failed };
}
