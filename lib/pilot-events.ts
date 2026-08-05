import { asc, isNull } from "drizzle-orm";

import { pilotProductEvents, services, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { MemberRole } from "@/domain/rbac";
import { loadServiceCosting } from "@/lib/service-costing";

export type PilotEventName =
  | "onboarding_started"
  | "onboarding_completed"
  | "service_cost_completed"
  | "visit_completed"
  | "import_started"
  | "import_completed"
  | "import_failed"
  /**
   * The booking funnel, roadmap section 7.10. Deduplicated by booking id like
   * every other event here, so each answers whether something happened to an
   * appointment rather than how many times: an appointment moved twice counts
   * once as `booking_rescheduled`. How often is a question for the audit trail,
   * which records every move; the funnel is about how many bookings reach each
   * stage.
   */
  | "booking_started"
  | "booking_confirmed"
  | "booking_rescheduled"
  | "booking_cancelled"
  | "booking_no_show"
  | "booking_completed";

type ProductEventInput = Readonly<{
  organizationId: string;
  eventName: PilotEventName;
  actorUserId: string | null;
  actorRole: MemberRole | null;
  source: "api" | "import" | "system";
  entityType: string;
  entityId: string;
  /** Numbers and booleans only: product analytics is not a PII side channel. */
  metadata?: Readonly<Record<string, number | boolean | null>>;
  occurredAt?: Date;
}>;

/**
 * Idempotent product telemetry. Replaying an API request or an import cannot
 * inflate activation: the database key is organization + event + entity.
 */
export async function recordPilotProductEvent(tx: TenantTransaction, event: ProductEventInput) {
  await tx
    .insert(pilotProductEvents)
    .values({
      organizationId: event.organizationId,
      eventName: event.eventName,
      eventVersion: 1,
      actorUserId: event.actorUserId,
      actorRole: event.actorRole,
      source: event.source,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata ?? {},
      occurredAt: event.occurredAt ?? new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Costing inputs can become complete from several directions: a recipe, a
 * purchase price, service details or a commission rule. After any of those
 * writes, re-evaluate the small pilot catalogue and record each service's first
 * trustworthy calculation. The event is deduplicated forever by service id.
 */
export async function recordCompletedServiceCostEvents(
  tx: TenantTransaction,
  actor: Readonly<{ organizationId: string; userId: string; role: MemberRole }>,
) {
  const [defaultSpecialist] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(isNull(specialists.archivedAt))
    .orderBy(asc(specialists.createdAt), asc(specialists.id))
    .limit(1);

  if (!defaultSpecialist) return;

  const activeServices = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt), asc(services.id));

  for (const service of activeServices) {
    const costing = await loadServiceCosting(tx, service, { specialistId: defaultSpecialist.id });
    if (costing.status !== "complete") continue;

    await recordPilotProductEvent(tx, {
      organizationId: actor.organizationId,
      eventName: "service_cost_completed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      source: "api",
      entityType: "service",
      entityId: service.id,
      metadata: { material_lines: costing.lines.length },
    });
  }
}
