import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Агрегаты», which the matrix promised and nothing delivered.
 *
 * Section 6.1 gives an Analyst `commissions` at «Агрегаты» and the dashboard at
 * «Все агрегаты», encoded as the `aggregates_only` constraint. The constraint
 * was declared in `domain/rbac.ts` and read by no code at all, so the role sold
 * as "reads the numbers" opened «Мастера» to every master's rate beside the
 * address of the account behind it. Of the four constraints in that file only
 * `exclude_pii` was ever wired up, and the matrix test proves the cells, not
 * what they mean.
 *
 * Which is why this checks the shape of the answer rather than its status code:
 * a 200 was always the right status, and the leak was inside it.
 */
type Card = {
  id: string;
  name: string;
  user_id: string | null;
  default_rule: unknown | null;
  service_exceptions: unknown[];
};

let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("aggregate-owner@studio.example", "Aggregate Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("an analyst reads aggregates", () => {
  test("is told who works here and not what any one of them is paid", async () => {
    const analyst = await inviteMember(studio.owner, "analyst@studio.example", "analyst");

    const cards = dataOf<Card[]>(await analyst.get("/api/v1/specialists"));
    expect(cards).toHaveLength(1);

    // The name stays: an analyst meets it in the calendar anyway, and a
    // ranking nobody can read the names of is not an aggregate, it is a riddle.
    expect(cards[0].name).toBe("Мастер");

    // These three are the leak, and they are three because the screen showed
    // all three: the rate, the exceptions to it, and the account behind the card.
    expect(cards[0].default_rule).toBeNull();
    expect(cards[0].service_exceptions).toEqual([]);
    expect(cards[0].user_id).toBeNull();
  });

  test("still answers the owner in full", async () => {
    // The redaction is a property of the reader, not of the row — the same
    // request from the person the rate belongs to has to keep working.
    const cards = dataOf<Card[]>(await studio.owner.get("/api/v1/specialists"));
    expect(cards[0].default_rule).not.toBeNull();
  });

  test("lets a master read their own rate", async () => {
    /*
     * A master holds `commissions` at scope "own" and no constraint: their own
     * pay is theirs to read. The scope narrows the rows; nothing should narrow
     * the row they get.
     */
    const master = await inviteMember(studio.owner, "own-rate@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, {
      user_id: master.userId,
    });

    const own = dataOf<Card[]>(await master.get("/api/v1/specialists"));
    expect(own).toHaveLength(1);
    expect(own[0].default_rule).not.toBeNull();
  });
});
