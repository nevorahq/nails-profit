import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { dataOf, signUp } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * The address a studio's public booking page lives at, which it is given rather
 * than asked for.
 *
 * It used to be a field on `/app/booking` — a screen a studio has no reason to
 * open in its first week — and until somebody typed one, a booking page could
 * be published and still exist at no address at all. The name typed on the way
 * in is the answer, and these are the four things that has to survive: a
 * Russian name, a second studio called the same, a name that transliterates to
 * nothing, and a name that collides with a path the application serves.
 */
async function register(email: string, name: string) {
  const owner = await signUp(email);
  const created = dataOf<{ id: string }>(
    await owner.post("/api/v1/organizations", {
      name,
      type: "solo",
      currency: "MDL",
      locale: "ru",
    }),
  );

  const [row] = await adminDb
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, created.id));

  return row.slug;
}

beforeAll(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a studio's public address", () => {
  test("is the transliteration of the name it registered under", async () => {
    // Diacritics rather than Cyrillic: a studio name must now be Latin — see
    // `domain/organization-name.ts` — and «Frumusețe» is exactly the name a
    // Moldovan studio registers under, with the letters a URL cannot carry.
    expect(await register("address-first@studio.example", "Frumusețe Irina")).toBe(
      "frumusete-irina",
    );
  });

  test("numbers the second studio of the same name instead of refusing it", async () => {
    // Two studios called «Nails» is an ordinary Tuesday, and the second one
    // registers — it does not see an error about a name it cannot see.
    expect(await register("address-nails@studio.example", "Nails")).toBe("nails");
    expect(await register("address-nails2@studio.example", "Nails")).toBe("nails-2");
  });

  test("gives a dictatable address to a name that transliterates to nothing", async () => {
    // Punctuation passes the name rule and leaves the slug empty, which is the
    // same hole the emoji case used to cover before emoji were refused outright.
    expect(await register("address-symbols@studio.example", "&&")).toBe("studio");
  });

  test("never hands out a path the application serves itself", async () => {
    // `/book` and `/booking` are ours; «Booking» is a plausible studio name.
    expect(await register("address-booking@studio.example", "Booking")).toBe("booking-2");
  });
});
