import { beforeEach, describe, expect, it } from "vitest";

import { withTenant } from "@/db/tenant";
import { loadStartScreen } from "@/lib/first-numbers";
import { resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * What `/app` answers with before a studio has sold anything.
 *
 * Three states and they are easy to confuse, because two of them belong to a
 * studio with no revenue: one that is still missing a rate or a price, and one
 * that is set up and simply has not had a client yet. The second used to be
 * shown a wall of zeroes; it is now shown what its own catalogue is worth, and
 * that is the whole of what these tests hold to.
 */
describe("the first screen of a studio with no visits", () => {
  let organizationId: string;
  let specialistId: string;

  async function start() {
    return withTenant(organizationId, (tx) => loadStartScreen(tx, "ru"));
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });
  });

  it("points at the one thing missing while the checklist is unfinished", async () => {
    const screen = await start();

    expect(screen?.kind).toBe("goal");
    expect(screen?.kind === "goal" && screen.progress.next?.key).toBe("service");
  });

  it("answers with what the work is worth once the catalogue can be costed", async () => {
    // 600.00 for ninety minutes at a rate of 40%.
    await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });

    const screen = await start();

    expect(screen?.kind).toBe("numbers");
    if (screen?.kind !== "numbers") return;
    expect(screen.rows).toHaveLength(1);
    expect(screen.rows[0]).toMatchObject({
      name: "Услуга",
      priceMinor: 60_000,
      commissionMinor: 24_000,
      contributionMarginMinor: 36_000,
      marginBasisPoints: 6_000,
      // The figure the product exists for, and it arrives before any client
      // does: 360.00 of margin over an hour and a half.
      profitPerHourMinor: 24_000,
    });
  });

  it("leaves out a service it cannot cost rather than showing it as dashes", async () => {
    await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    // Priced but timeless: there is no profit per hour to report, and the gap
    // is named on the services screen rather than half-said here.
    await createService(organizationId, { name: "Без длительности", durationMinutes: null });

    const screen = await start();

    expect(screen?.kind).toBe("numbers");
    expect(screen?.kind === "numbers" && screen.rows.map((row) => row.name)).toEqual(["Услуга"]);
  });

  it("stands aside the moment the studio has actually sold something", async () => {
    const service = await createService(organizationId);
    await createVisit(organizationId, { specialistId, serviceId: service.id });

    // Null means the dashboard proper: from here on the figures are sums over
    // work that happened, and nothing on this screen has anything to add.
    expect(await start()).toBeNull();
  });
});
