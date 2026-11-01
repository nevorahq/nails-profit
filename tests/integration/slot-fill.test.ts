import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { bookingHolds, bookingLines, bookings, clients, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { BOOKING_LINK_TOKEN } from "@/domain/client-return";
import { loadSlotFill, type SlotFillOrganization } from "@/lib/slot-fill";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";
import { daysAgoInStudio } from "../helpers/calendar";

/**
 * The query half of the offer made after a cancellation: which appointments are
 * an hour worth offering, and whom. The ranking is unit-tested in
 * `domain/slot-fill.test.ts` and the pool in `client-return.test.ts`; this holds
 * the reads together against PostgreSQL — the refusals, the services a client
 * has had done, the studio's language and a Master's narrowing.
 */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const daysAgo = daysAgoInStudio;

describe("the hour a cancellation gave back", () => {
  let organizationId: string;
  let ownerId: string;
  let locationId: string;
  let irina: string;
  let olga: string;
  let manicure: string;
  let pedicure: string;

  const organization: SlotFillOrganization = { name: "Belle", locale: "ru", bookingSlug: "belle" };
  const startsAt = new Date(Date.now() + 3 * DAY);

  /** Three visits twenty days apart, the last thirty days ago: due by ten days. */
  async function regular(
    name: string,
    options: { lastWith?: string; service?: string; phone?: string | null; locale?: string } = {},
  ) {
    const phone = options.phone === undefined ? `+3736${Math.floor(1000000 + Math.random() * 8999999)}` : options.phone;
    const client = await createClient(organizationId, { name, normalizedPhone: phone });
    if (options.locale) {
      await adminDb.update(clients).set({ locale: options.locale as "ro" }).where(eq(clients.id, client.id));
    }
    const serviceId = options.service ?? null;
    await createVisit(organizationId, { specialistId: irina, clientId: client.id, completedAt: daysAgo(70), serviceId });
    await createVisit(organizationId, { specialistId: irina, clientId: client.id, completedAt: daysAgo(50), serviceId });
    await createVisit(organizationId, {
      specialistId: options.lastWith ?? irina,
      clientId: client.id,
      completedAt: daysAgo(30),
      serviceId,
    });
    return client.id;
  }

  async function appointment(
    overrides: Partial<typeof bookings.$inferInsert> = {},
    options: { service?: string } = {},
  ) {
    const [booking] = await adminDb
      .insert(bookings)
      .values({
        organizationId,
        locationId,
        specialistId: irina,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        status: "cancelled",
        source: "staff",
        cancelledAt: new Date(),
        cancelledBy: "client",
        ...overrides,
      })
      .returning();
    await adminDb.insert(bookingLines).values({
      organizationId,
      bookingId: booking.id,
      kind: "service",
      serviceId: options.service ?? manicure,
      nameSnapshot: { ru: "Маникюр", ro: "Manichiură", en: "Manicure" },
      priceMinor: 60_000,
      durationMinutes: 60,
    });
    return booking;
  }

  function offer(bookingId: string, role: "owner" | "master" = "owner", userId = ownerId, org = organization) {
    return withTenant(organizationId, (tx) =>
      loadSlotFill(tx, { userId, role }, { bookingId, organization: org, now: new Date() }),
    );
  }

  async function offered(bookingId: string) {
    const outcome = await offer(bookingId);
    if (!outcome.ok) throw new Error(`expected an offer, got ${outcome.failure}`);
    return outcome.offer;
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    ownerId = user.id;
    organizationId = (await createOrganization({ ownerId })).id;
    locationId = (await createLocation(organizationId)).id;
    irina = (await createSpecialist(organizationId, { name: "Ирина" })).id;
    olga = (await createSpecialist(organizationId, { name: "Ольга" })).id;
    manicure = (await createService(organizationId, { name: "Маникюр" })).id;
    pedicure = (await createService(organizationId, { name: "Педикюр" })).id;
  });

  describe("when there is an hour to offer", () => {
    it("offers a cancelled appointment still to come to the clients past their rhythm", async () => {
      const anna = await regular("Анна");
      const booking = await appointment();

      const result = await offered(booking.id);

      expect(result.rows.map((row) => row.clientId)).toEqual([anna]);
      expect(result.rows[0]).toMatchObject({ name: "Анна", intervalDays: 20, daysSinceLastVisit: 30 });
      expect(result.specialistName).toBe("Ирина");
      expect(result.startsAt).toEqual(booking.startsAt);
    });

    it("is an empty list, not a refusal, when nobody is due", async () => {
      const booking = await appointment();
      const outcome = await offer(booking.id);
      expect(outcome).toMatchObject({ ok: true, offer: { rows: [] } });
    });

    it("does not offer the hour back to the client who cancelled it", async () => {
      const cancelled = await regular("Отменила");
      const other = await regular("Другая");
      const booking = await appointment({ clientId: cancelled });

      expect((await offered(booking.id)).rows.map((row) => row.clientId)).toEqual([other]);
    });

    it("leaves out a client without a phone number", async () => {
      await regular("Без номера", { phone: null });
      const anna = await regular("Анна");
      const booking = await appointment();

      expect((await offered(booking.id)).rows.map((row) => row.clientId)).toEqual([anna]);
    });

    it("offers a master's own clients first, then those who have had the service", async () => {
      const strangerPlain = await regular("Чужая без услуги", { lastWith: olga, service: pedicure });
      const strangerService = await regular("Чужая с услугой", { lastWith: olga, service: manicure });
      const mineOther = await regular("Моя, другая услуга", { service: pedicure });
      const mineService = await regular("Моя, та же услуга", { service: manicure });
      const booking = await appointment();

      expect((await offered(booking.id)).rows.map((row) => row.clientId)).toEqual([
        mineService,
        mineOther,
        strangerService,
        strangerPlain,
      ]);
    });

    it("counts the services a visit kept on its lines, not only the first", async () => {
      const onLines = await regular("Две услуги", { lastWith: olga, service: pedicure });
      const plain = await regular("Одна услуга", { lastWith: olga, service: pedicure });
      const [visit] = await adminDb.select().from(visits).where(eq(visits.clientId, onLines)).limit(1);
      await adminDb.insert(visitLines).values({
        organizationId,
        visitId: visit.id,
        kind: "service",
        serviceId: manicure,
        nameSnapshot: { ru: "Маникюр" },
        priceMinor: 60_000,
      });
      const booking = await appointment();

      const ids = (await offered(booking.id)).rows.map((row) => row.clientId);
      expect(ids).toEqual([onLines, plain]);
    });

    it("offers at most five clients", async () => {
      for (let index = 0; index < 7; index += 1) await regular(`Клиент ${index}`);
      const booking = await appointment();

      expect((await offered(booking.id)).rows).toHaveLength(5);
    });

    it("leaves out a client who is already booked", async () => {
      const booked = await regular("Записана");
      const free = await regular("Свободна");
      const later = new Date(startsAt.getTime() + 5 * DAY);
      await adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId: olga,
        clientId: booked,
        startsAt: later,
        endsAt: new Date(later.getTime() + HOUR),
        status: "confirmed",
        source: "staff",
      });
      const booking = await appointment();

      expect((await offered(booking.id)).rows.map((row) => row.clientId)).toEqual([free]);
    });
  });

  describe("the message", () => {
    it("carries the hour, the master and the service, with the link where the page answers", async () => {
      await regular("Анна");
      const booking = await appointment();

      const [row] = (await offered(booking.id)).rows;

      expect(row.message).toContain("Анна");
      expect(row.message).toContain("Belle");
      expect(row.message).toContain("Ирина");
      expect(row.message).toContain("Маникюр");
      expect(row.message).toContain(BOOKING_LINK_TOKEN);
    });

    it("reads the hour on the location's clock", async () => {
      await regular("Анна");
      const noon = new Date(Date.now() + 3 * DAY);
      noon.setUTCHours(12, 0, 0, 0);
      const booking = await appointment({ startsAt: noon, endsAt: new Date(noon.getTime() + HOUR) });

      const [row] = (await offered(booking.id)).rows;

      const hour = new Intl.DateTimeFormat("ru-MD", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Europe/Chisinau",
      }).format(noon);
      expect(row.message).toContain(hour);
      expect(row.message).not.toContain("12:00");
    });

    it("asks to write back when the booking page does not answer", async () => {
      await regular("Анна");
      const booking = await appointment();

      const outcome = await offer(booking.id, "owner", ownerId, { ...organization, bookingSlug: null });

      expect(outcome.ok && outcome.offer.rows[0].message).not.toContain(BOOKING_LINK_TOKEN);
      expect(outcome.ok && outcome.offer.rows[0].message).toContain("Ответьте");
    });

    it("is written in the client's language, and in the studio's when the card has none", async () => {
      await regular("Румынка", { locale: "ro" });
      await regular("Без языка");
      const booking = await appointment();

      const rows = (await offered(booking.id)).rows;

      expect(rows.find((row) => row.name === "Румынка")!.message).toContain("Manichiură");
      expect(rows.find((row) => row.name === "Румынка")!.message).toContain("Bună ziua");
      expect(rows.find((row) => row.name === "Без языка")!.message).toContain("Здравствуйте");
    });
  });

  describe("when there is no hour to offer", () => {
    it("refuses an appointment that does not exist", async () => {
      const outcome = await offer("00000000-0000-4000-8000-000000000000");
      expect(outcome).toEqual({ ok: false, failure: "not_found" });
    });

    it.each(["pending_confirmation", "confirmed", "completed", "no_show"] as const)(
      "refuses an appointment that is %s: it still holds its hour",
      async (status) => {
        const booking = await appointment({ status, cancelledAt: null, cancelledBy: null });
        expect(await offer(booking.id)).toEqual({ ok: false, failure: "not_cancelled" });
      },
    );

    it("refuses a cancelled appointment whose time has already come", async () => {
      const past = new Date(Date.now() - HOUR);
      const booking = await appointment({ startsAt: past, endsAt: new Date(past.getTime() + HOUR) });
      expect(await offer(booking.id)).toEqual({ ok: false, failure: "in_past" });
    });

    it("refuses an hour that somebody has booked since", async () => {
      const booking = await appointment();
      await adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId: irina,
        startsAt: new Date(startsAt.getTime() + 15 * 60_000),
        endsAt: new Date(startsAt.getTime() + HOUR + 15 * 60_000),
        status: "confirmed",
        source: "public_booking",
      });
      expect(await offer(booking.id)).toEqual({ ok: false, failure: "slot_taken" });
    });

    it("offers an hour next to a booking, not on top of it", async () => {
      const booking = await appointment();
      await adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId: irina,
        startsAt: booking.endsAt,
        endsAt: new Date(booking.endsAt.getTime() + HOUR),
        status: "confirmed",
        source: "staff",
      });
      expect((await offer(booking.id)).ok).toBe(true);
    });

    it("offers an hour that only a colleague's booking overlaps", async () => {
      const booking = await appointment();
      await adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId: olga,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        status: "confirmed",
        source: "staff",
      });
      expect((await offer(booking.id)).ok).toBe(true);
    });

    it("ignores a lapsed hold but refuses a live one", async () => {
      const booking = await appointment();
      const hold = {
        organizationId,
        locationId,
        specialistId: irina,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
      };

      await adminDb.insert(bookingHolds).values({
        ...hold,
        tokenHash: "lapsed",
        status: "expired",
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect((await offer(booking.id)).ok).toBe(true);

      await adminDb.insert(bookingHolds).values({
        ...hold,
        tokenHash: "live",
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      expect(await offer(booking.id)).toEqual({ ok: false, failure: "slot_taken" });
    });
  });

  describe("for a master", () => {
    it("offers only the clients whose latest visit was theirs", async () => {
      const masterUser = await createUser();
      const mine = await createSpecialist(organizationId, { name: "Мария", userId: masterUser.id });
      const colleagues = await regular("Клиентка коллеги", { lastWith: olga });
      const clientOfMine = await createClient(organizationId, { name: "Моя", normalizedPhone: "+37369111222" });
      for (const days of [70, 50, 30]) {
        await createVisit(organizationId, {
          specialistId: mine.id,
          clientId: clientOfMine.id,
          completedAt: daysAgo(days),
        });
      }
      const booking = await appointment({ specialistId: mine.id });

      const outcome = await offer(booking.id, "master", masterUser.id);

      expect(outcome.ok && outcome.offer.rows.map((row) => row.clientId)).toEqual([clientOfMine.id]);
      expect(outcome.ok && outcome.offer.rows.map((row) => row.clientId)).not.toContain(colleagues);
    });

    it("is told there is no such appointment for a colleague's hour", async () => {
      const masterUser = await createUser();
      await createSpecialist(organizationId, { name: "Мария", userId: masterUser.id });
      await regular("Анна");
      const colleagues = await appointment({ specialistId: olga });

      expect(await offer(colleagues.id, "master", masterUser.id)).toEqual({ ok: false, failure: "not_found" });
      expect((await offer(colleagues.id, "owner")).ok).toBe(true);
    });

    it("is told there is no such appointment by a master with no card of their own", async () => {
      const orphan = await createUser();
      const booking = await appointment();

      expect(await offer(booking.id, "master", orphan.id)).toEqual({ ok: false, failure: "not_found" });
    });
  });
});
