import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The gap between "приглашён" and "работает": accepting an invitation creates a
 * membership and nothing else.
 *
 * Every scope a master has — their calendar, their visits, their commission —
 * resolves through `specialist.user_id`, so until a card exists and is linked
 * they sign in to a product that shows them nothing and no client can be booked
 * to them. On the pilot that surfaced as an appointment "уходящей к владельцу":
 * the only card a client could pick belonged to the owner's account, so the
 * owner's calendar was the correct place for it, and the master had no calendar
 * of their own to receive anything.
 *
 * The two steps below are creation and linking done separately, on purpose.
 */
let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("card-owner@studio.example", "Card Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a master with an account but no card", () => {
  test("sees no specialist of their own until one is linked", async () => {
    const master = await inviteMember(studio.owner, "cardless@studio.example", "master");

    // Not an error — an empty product, which is exactly what makes the state
    // hard to notice from the master's side.
    expect(dataOf<unknown[]>(await master.get("/api/v1/specialists"))).toEqual([]);

    const created = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Cardless Master",
        cooperation_type: "commission",
      }),
    );
    // Creating the card is catalogue work; the link is a separate decision, and
    // a separate request.
    expect(dataOf<unknown[]>(await master.get("/api/v1/specialists"))).toEqual([]);

    expect(
      (await studio.owner.patch(`/api/v1/specialists/${created.id}`, { user_id: master.userId }))
        .status,
    ).toBe(200);

    const own = dataOf<{ id: string; name: string }[]>(await master.get("/api/v1/specialists"));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: created.id, name: "Cardless Master" });
  });

  test("keeps their card when a second master is invited", async () => {
    const second = await inviteMember(studio.owner, "second-card@studio.example", "master");
    const created = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Second Master",
        cooperation_type: "commission",
      }),
    );
    await studio.owner.patch(`/api/v1/specialists/${created.id}`, { user_id: second.userId });

    // Scope "own" means one card each, not the catalogue: a master must not
    // gain sight of a colleague's rows by the studio growing.
    const own = dataOf<{ id: string }[]>(await second.get("/api/v1/specialists"));
    expect(own.map((row) => row.id)).toEqual([created.id]);
  });
});
