import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, signUp } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * A service is written in its studio's currency unless it says otherwise.
 *
 * The catalogue form sends no currency, and the API used to fill in MDL — so a
 * studio on RUB or EUR got every service it added in lei, and a booking page
 * offers only the services in its studio's currency. They vanished from it with
 * no message at either end.
 */
describe("a service's currency", () => {
  let owner: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    await resetDatabase();
    owner = await signUp("currency-owner@studio.example");
    await owner.post("/api/v1/organizations", {
      name: "Rouble Studio",
      type: "studio",
      currency: "RUB",
      locale: "ru",
    });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  /** The create answer is the id and name only, so the currency is read back from the catalogue. */
  async function currencyOfNew(body: Record<string, unknown>) {
    const { id } = dataOf<{ id: string }>(
      await owner.post("/api/v1/services", { name: { ru: "Покрытие" }, price_minor: 20_000, duration_minutes: 90, ...body }),
    );
    const catalogue = dataOf<{ id: string; currency: string }[]>(await owner.get("/api/v1/services"));
    return catalogue.find((service) => service.id === id)?.currency;
  }

  test("takes the studio's currency when none is given", async () => {
    expect(await currencyOfNew({})).toBe("RUB");
  });

  test("keeps a currency that is given", async () => {
    expect(await currencyOfNew({ currency: "MDL" })).toBe("MDL");
  });
});
