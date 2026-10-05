import { and, eq, inArray } from "drizzle-orm";

import { pushSubscriptions } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { isPushConfigured } from "@/env";
import { logEvent } from "@/lib/logger";

/**
 * The devices of the studio's people, phase 7. Who may hold one and when it is
 * forgotten is decided by the callers; this is only how it is written down.
 */

export type DeviceKeys = Readonly<{
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}>;

export type SaveOutcome = "saved" | "taken";

/**
 * This device, for this person, in this studio.
 *
 * Found first and updated rather than upserted, because the conflict that
 * matters is the one the tenant policy hides: an endpoint already registered by
 * a different studio. `on conflict do update` cannot see that row, and
 * PostgreSQL answers with an error rather than skipping it — so the insert runs
 * in a savepoint, and its unique violation becomes `taken` instead of rolling
 * back the caller's whole transaction.
 *
 * In the same studio the device simply changes hands: a shared tablet at the
 * front desk is whoever signed in on it last, and the keys are whatever the
 * browser handed over this time.
 */
export async function saveDevice(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string; device: DeviceKeys }>,
): Promise<SaveOutcome> {
  const [existing] = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, input.device.endpoint))
    .limit(1);

  if (existing) {
    await tx
      .update(pushSubscriptions)
      .set({
        userId: input.userId,
        p256dh: input.device.p256dh,
        auth: input.device.auth,
        userAgent: input.device.userAgent,
      })
      .where(eq(pushSubscriptions.id, existing.id));
    return "saved";
  }

  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.insert(pushSubscriptions).values({
        organizationId: input.organizationId,
        userId: input.userId,
        endpoint: input.device.endpoint,
        p256dh: input.device.p256dh,
        auth: input.device.auth,
        userAgent: input.device.userAgent,
      });
    });
    return "saved";
  } catch (error) {
    if (isUniqueViolation(error)) return "taken";
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps the driver's error; the code is on `cause`.
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** One device of one person — what «Выключить» and signing out both mean. */
export async function forgetDevice(
  tx: TenantTransaction,
  input: Readonly<{ userId: string; endpoint: string }>,
): Promise<number> {
  const removed = await tx
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, input.userId), eq(pushSubscriptions.endpoint, input.endpoint)),
    )
    .returning({ id: pushSubscriptions.id });
  return removed.length;
}

/** Every device of a person who has left the team. */
export async function forgetPersonDevices(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string }>,
): Promise<number> {
  const removed = await tx
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.organizationId, input.organizationId),
        eq(pushSubscriptions.userId, input.userId),
      ),
    )
    .returning({ id: pushSubscriptions.id });
  return removed.length;
}

/** Every device in a studio that is being deleted. */
export async function forgetStudioDevices(
  tx: TenantTransaction,
  organizationId: string,
): Promise<number> {
  const removed = await tx
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.organizationId, organizationId))
    .returning({ id: pushSubscriptions.id });
  return removed.length;
}

/** A device the push service says no longer exists (404/410). */
export async function forgetDeviceById(tx: TenantTransaction, id: string): Promise<void> {
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

export async function devicesOf(tx: TenantTransaction, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  return tx
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, [...userIds]));
}

export async function deviceCountOf(tx: TenantTransaction, userId: string): Promise<number> {
  const rows = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return rows.length;
}

/** The last time a push reached this device, so a dead one can be told from a quiet one. */
export async function touchDevice(tx: TenantTransaction, id: string, at: Date): Promise<void> {
  await tx.update(pushSubscriptions).set({ lastSuccessAt: at }).where(eq(pushSubscriptions.id, id));
}

/**
 * Whether push is configured, without letting a broken configuration fail the
 * request it is asked inside — a booking, the bell. Half a key pair is a
 * deployment mistake to shout about in the log, not a reason a client's
 * request is refused.
 */
export function isPushOn(): boolean {
  try {
    return isPushConfigured();
  } catch (error) {
    logEvent("error", "push.misconfigured", {}, { reason: error instanceof Error ? error.message : "unknown" });
    return false;
  }
}
