import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { paymentMethods, taxRules } from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * «Как вы платите налоги?» and «Как платят клиенты?» through their endpoints.
 *
 * What is checked here is the contract a screen relies on: a rate is never
 * assumed, the answer is the guide's step, and a second answer is a 409 rather
 * than a quiet overwrite. Who may call them is `rbac-matrix.test.ts`.
 */
let studio: Studio;

type Month = { done: number; total: number; steps: { key: string; done: boolean }[] };

async function stepDone(key: string) {
  const month = dataOf<Month>(await studio.owner.get("/api/v1/onboarding/month"));
  return month.steps.find((step) => step.key === key)?.done;
}

beforeEach(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("money-answers-owner@studio.example");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("POST /api/v1/onboarding/taxes", () => {
  test("«не плачу с визита» finishes the step and writes no rule", async () => {
    expect(await stepDone("taxes")).toBe(false);

    const response = await studio.owner.post("/api/v1/onboarding/taxes", { answer: "none" });

    expect(response.status).toBe(201);
    expect(await stepDone("taxes")).toBe(true);
    expect(await adminDb.select().from(taxRules).where(eq(taxRules.organizationId, studio.organizationId))).toEqual([]);
  });

  test("a turnover tax is written as the rate the owner typed", async () => {
    const response = await studio.owner.post("/api/v1/onboarding/taxes", { answer: "turnover", basis_points: 400 });

    expect(response.status).toBe(201);
    const rules = dataOf<{ kind: string; basis_points: number; active_to: string | null }[]>(
      await studio.owner.get("/api/v1/tax-rules"),
    );
    expect(rules).toEqual([expect.objectContaining({ kind: "turnover", basis_points: 400, active_to: null })]);
  });

  test("VAT without a rate is refused, not given one", async () => {
    const response = await studio.owner.post("/api/v1/onboarding/taxes", { answer: "vat" });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    expect(await stepDone("taxes")).toBe(false);
  });

  test("an answer that is not one of the three is refused", async () => {
    const response = await studio.owner.post("/api/v1/onboarding/taxes", { answer: "payroll", basis_points: 2_400 });

    expect(response.status).toBe(422);
  });

  test("a second answer is a 409, and a rule entered in «Налоги с визита» counts as the first", async () => {
    await studio.owner.post("/api/v1/tax-rules", { kind: "vat", basis_points: 2_000 });
    expect(await stepDone("taxes")).toBe(true);

    const response = await studio.owner.post("/api/v1/onboarding/taxes", { answer: "none" });

    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("ALREADY_ANSWERED");
  });
});

describe("POST /api/v1/onboarding/payments", () => {
  test("«только наличные» finishes the step with one cash method as the default", async () => {
    expect(await stepDone("payments")).toBe(false);

    const response = await studio.owner.post("/api/v1/onboarding/payments", { methods: ["cash"] });

    expect(response.status).toBe(201);
    expect(await stepDone("payments")).toBe(true);
    const methods = dataOf<{ kind: string; is_default: boolean; commission_basis_points: number }[]>(
      await studio.owner.get("/api/v1/payment-methods"),
    );
    expect(methods).toEqual([expect.objectContaining({ kind: "cash", is_default: true, commission_basis_points: 0 })]);
  });

  test("card carries the bank's rate, and the usual method is the default", async () => {
    const response = await studio.owner.post("/api/v1/onboarding/payments", {
      methods: ["cash", "card"],
      card_commission_basis_points: 180,
      default: "card",
    });

    expect(response.status).toBe(201);
    const methods = await adminDb
      .select({ kind: paymentMethods.kind, rate: paymentMethods.commissionBasisPoints, isDefault: paymentMethods.isDefault })
      .from(paymentMethods)
      .where(eq(paymentMethods.organizationId, studio.organizationId));
    expect(methods.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "card", rate: 180, isDefault: true },
      { kind: "cash", rate: 0, isDefault: false },
    ]);
  });

  test.each([
    ["card without the bank's rate", { methods: ["card"] }],
    ["a rate without card", { methods: ["cash"], card_commission_basis_points: 100 }],
    ["two methods and no usual one", { methods: ["cash", "transfer"] }],
    ["a usual method that was not chosen", { methods: ["cash", "transfer"], default: "card" }],
    ["no method at all", { methods: [] }],
    ["the same method twice", { methods: ["cash", "cash"] }],
  ])("refuses %s", async (_, body) => {
    const response = await studio.owner.post("/api/v1/onboarding/payments", body);

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    expect(await stepDone("payments")).toBe(false);
  });

  test("a second answer is a 409 and writes nothing more", async () => {
    await studio.owner.post("/api/v1/onboarding/payments", { methods: ["cash"] });

    const response = await studio.owner.post("/api/v1/onboarding/payments", { methods: ["transfer"] });

    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("ALREADY_ANSWERED");
    const methods = await adminDb.select().from(paymentMethods).where(eq(paymentMethods.organizationId, studio.organizationId));
    expect(methods).toHaveLength(1);
  });
});
