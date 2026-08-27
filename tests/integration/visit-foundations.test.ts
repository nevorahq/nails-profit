import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { financialSnapshots, specialists, visits } from "@/db/schema";
import type { Currency } from "@/domain/money";
import { withTenant } from "@/db/tenant";
import { CURRENT_FORMULA_VERSION } from "@/domain/costing";
import {
  adoptPrincipalHistory,
  recalculateVisitProfit,
  recordCompletedVisit,
  writeFinancialSnapshot,
} from "@/lib/visit-service";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * The two things a visit has to carry that it did not before: the currency it
 * was charged in, and whether the person who did the work takes the profit
 * rather than a fee.
 *
 * Both are snapshots, and both are here rather than in a domain test because
 * the bugs they close were bugs of the write path — a literal in a service, a
 * flag read from a live row — which no pure function could have caught.
 */
describe("visit foundations", () => {
  let userId: string;

  async function studio(options: { currency?: Currency; isPrincipal?: boolean } = {}) {
    const organizationId = (await createOrganization({ ownerId: userId, currency: options.currency })).id;
    const specialistId = (await createSpecialist(organizationId, { isPrincipal: options.isPrincipal })).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });

    const service = await createService(organizationId, {
      priceMinor: 60_000,
      durationMinutes: 90,
      currency: options.currency,
    });

    return { organizationId, specialistId, serviceId: service.id };
  }

  async function close(scene: Awaited<ReturnType<typeof studio>>) {
    return withTenant(scene.organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId: scene.organizationId,
        actor: { userId, role: "owner" },
        serviceId: scene.serviceId,
        specialistId: scene.specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: new Date(),
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
  });

  describe("currency", () => {
    it("closes a visit in the organization's own currency", async () => {
      const scene = await studio({ currency: "EUR" });
      const { visit, snapshot } = await close(scene);

      expect(visit.currency).toBe("EUR");
      expect(snapshot.currency).toBe("EUR");
    });

    /*
     * The defect this closes: re-costing stamped a literal "MDL", so a EUR
     * organization got its first snapshot in EUR and every correction
     * afterwards in MDL. Nothing on screen showed it — the page formats by the
     * organization's currency either way — so only the stored row can tell.
     */
    it("keeps the currency through a correction", async () => {
      const scene = await studio({ currency: "EUR" });
      const { visit } = await close(scene);

      const corrected = await withTenant(scene.organizationId, async (tx) => {
        const after = (await recalculateVisitProfit(tx, visit.id))!;
        return writeFinancialSnapshot(tx, {
          organizationId: scene.organizationId,
          visitId: visit.id,
          profit: after.profit,
          actorUserId: userId,
        });
      });

      expect(corrected.snapshotVersion).toBe(2);
      expect(corrected.currency).toBe("EUR");
    });

    it("leaves an MDL organization exactly where it was", async () => {
      const scene = await studio();
      const { visit, snapshot } = await close(scene);

      expect(visit.currency).toBe("MDL");
      expect(snapshot.currency).toBe("MDL");
      // The canonical scenario: 600 − 240 commission.
      expect(snapshot.contributionMarginMinor).toBe(36_000);
    });

    /*
     * The third currency, which is the one a database can refuse.
     *
     * `currency` is a `pgEnum`, so a value the application accepts and the type
     * has never heard of is a runtime error at the moment a visit closes —
     * after the studio has been set up and priced. This is the test that says
     * migration 0042 was applied wherever these run.
     */
    it("closes a visit for a studio keeping its books in roubles", async () => {
      const scene = await studio({ currency: "RUB" });
      const { visit, snapshot } = await close(scene);

      expect(visit.currency).toBe("RUB");
      expect(snapshot.currency).toBe("RUB");
      // The same arithmetic as every other currency: nothing here converts.
      expect(snapshot.contributionMarginMinor).toBe(36_000);
    });
  });

  describe("the principal mark", () => {
    it("copies the mark into the visit when it closes", async () => {
      const scene = await studio({ isPrincipal: true });
      const { visit } = await close(scene);

      expect(visit.masterIsPrincipal).toBe(true);
    });

    it("records a plain master as not a principal", async () => {
      const scene = await studio();
      const { visit } = await close(scene);

      expect(visit.masterIsPrincipal).toBe(false);
    });

    /*
     * The reason the flag is snapshotted at all. A studio that stops treating
     * someone as its principal must not have last year's months recomputed
     * underneath it: those visits were done by the owner, whatever is true now.
     */
    it("does not rewrite a closed visit when the mark is removed later", async () => {
      const scene = await studio({ isPrincipal: true });
      const { visit } = await close(scene);

      await adminDb
        .update(specialists)
        .set({ isPrincipal: false })
        .where(eq(specialists.id, scene.specialistId));

      const [stored] = await adminDb
        .select({ masterIsPrincipal: visits.masterIsPrincipal })
        .from(visits)
        .where(eq(visits.id, visit.id));

      expect(stored.masterIsPrincipal).toBe(true);
    });

    /*
     * Visits closed before migration 0025 hold null: not "no", but "nobody was
     * asked". Marking someone a principal answers it for them once.
     */
    it("fills in only the visits that never had an answer", async () => {
      const scene = await studio();
      const unanswered = await createVisit(scene.organizationId, { specialistId: scene.specialistId });
      const answered = await close(scene);

      expect(
        (
          await adminDb
            .select({ value: visits.masterIsPrincipal })
            .from(visits)
            .where(eq(visits.id, unanswered.id))
        )[0].value,
      ).toBeNull();

      const filled = await withTenant(scene.organizationId, (tx) =>
        adoptPrincipalHistory(tx, scene.specialistId),
      );

      expect(filled).toBe(1);

      const rows = await adminDb
        .select({ id: visits.id, value: visits.masterIsPrincipal })
        .from(visits)
        .where(eq(visits.specialistId, scene.specialistId));

      const byId = new Map(rows.map((row) => [row.id, row.value]));
      expect(byId.get(unanswered.id)).toBe(true);
      // Closed with the mark off, and it stays off: a recorded answer stands.
      expect(byId.get(answered.visit.id)).toBe(false);
    });

    it("is idempotent — a second run has nothing left to fill", async () => {
      const scene = await studio();
      await createVisit(scene.organizationId, { specialistId: scene.specialistId });

      await withTenant(scene.organizationId, (tx) => adoptPrincipalHistory(tx, scene.specialistId));
      const again = await withTenant(scene.organizationId, (tx) =>
        adoptPrincipalHistory(tx, scene.specialistId),
      );

      expect(again).toBe(0);
    });

    it("leaves another specialist's visits alone", async () => {
      const scene = await studio();
      const other = (await createSpecialist(scene.organizationId, { name: "Другой" })).id;
      const theirs = await createVisit(scene.organizationId, { specialistId: other });

      await withTenant(scene.organizationId, (tx) => adoptPrincipalHistory(tx, scene.specialistId));

      const [stored] = await adminDb
        .select({ value: visits.masterIsPrincipal })
        .from(visits)
        .where(eq(visits.id, theirs.id));

      expect(stored.value).toBeNull();
    });
  });

  describe("the formula version", () => {
    it("stamps every snapshot with the constant, complete or not", async () => {
      const complete = await studio();
      await close(complete);

      // A visit that took nothing in has no margin to state, and the snapshot
      // is still written — with a version, and with the reason on it.
      const free = await studio();
      const gratis = await createService(free.organizationId, {
        priceMinor: 0,
        durationMinutes: 90,
      });
      await withTenant(free.organizationId, async (tx) => {
        const result = await recordCompletedVisit(tx, {
          organizationId: free.organizationId,
          actor: { userId, role: "owner" },
          serviceId: gratis.id,
          specialistId: free.specialistId,
          clientId: null,
          addOnIds: [],
          completedAt: new Date(),
          actualDurationMinutes: 90,
          requestId: "test",
        });
        if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      });

      const rows = await adminDb
        .select({
          formulaVersion: financialSnapshots.formulaVersion,
          incompleteReasons: financialSnapshots.incompleteReasons,
        })
        .from(financialSnapshots);

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.formulaVersion === CURRENT_FORMULA_VERSION)).toBe(true);
      expect(rows.some((row) => (row.incompleteReasons ?? []).length > 0)).toBe(true);
    });
  });

  describe("completion idempotency", () => {
    it("replays the same key without creating a second visit or snapshot", async () => {
      const scene = await studio();
      const completedAt = new Date();
      const input = {
        organizationId: scene.organizationId,
        actor: { userId, role: "owner" as const },
        serviceId: scene.serviceId,
        specialistId: scene.specialistId,
        clientId: null,
        addOnIds: [],
        completedAt,
        actualDurationMinutes: 90,
        requestId: "idempotent-close",
        completionKey: "visit-foundations-key",
        completionFingerprint: "same-request",
      } as const;

      const first = await withTenant(scene.organizationId, (tx) => recordCompletedVisit(tx, input));
      const replay = await withTenant(scene.organizationId, (tx) => recordCompletedVisit(tx, input));

      expect(first.ok).toBe(true);
      expect(replay.ok).toBe(true);
      if (!first.ok || !replay.ok) throw new Error("expected idempotent completion");
      expect(replay.replayed).toBe(true);
      expect(replay.visit.id).toBe(first.visit.id);

      const storedVisits = await adminDb
        .select({ id: visits.id })
        .from(visits)
        .where(eq(visits.organizationId, scene.organizationId));
      const storedSnapshots = await adminDb
        .select({ id: financialSnapshots.id })
        .from(financialSnapshots)
        .where(eq(financialSnapshots.organizationId, scene.organizationId));
      expect(storedVisits).toHaveLength(1);
      expect(storedSnapshots).toHaveLength(1);
    });

    it("rejects reuse of a key for a different payload", async () => {
      const scene = await studio();
      const base = {
        organizationId: scene.organizationId,
        actor: { userId, role: "owner" as const },
        serviceId: scene.serviceId,
        specialistId: scene.specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: new Date(),
        actualDurationMinutes: 90,
        requestId: "idempotency-conflict",
        completionKey: "conflicting-visit-key",
      } as const;

      const first = await withTenant(scene.organizationId, (tx) =>
        recordCompletedVisit(tx, { ...base, completionFingerprint: "first" }),
      );
      const conflict = await withTenant(scene.organizationId, (tx) =>
        recordCompletedVisit(tx, { ...base, completionFingerprint: "different" }),
      );

      expect(first.ok).toBe(true);
      expect(conflict).toEqual({ ok: false, failure: "idempotency_conflict" });
    });
  });
});
