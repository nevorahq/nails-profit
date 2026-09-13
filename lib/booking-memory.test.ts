import { afterEach, describe, expect, test, vi } from "vitest";

import {
  forgetBooking,
  isActiveStatus,
  isBookingStatus,
  isWorthShowing,
  needsFreshDetails,
  noRememberedBooking,
  parseRemembered,
  rememberBooking,
  rememberedSnapshot,
  storageKey,
  subscribeRemembered,
  withStatus,
  type RememberedBooking,
} from "./booking-memory";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const visit = Date.parse("2026-09-14T10:00:00.000Z");

function entry(over: Partial<RememberedBooking> = {}): RememberedBooking {
  return {
    token: "tok_abc",
    startsAt: new Date(visit).toISOString(),
    timezone: "Europe/Chisinau",
    status: "pending_confirmation",
    version: 1,
    statusSeenAt: new Date(visit - DAY).toISOString(),
    ...over,
  };
}

/** A `localStorage` that can be made to behave like a browser refusing site data. */
function fakeStorage(options: { throws?: boolean } = {}) {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      if (options.throws) throw new Error("blocked");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.throws) throw new Error("blocked");
      values.set(key, value);
    },
    removeItem(key: string) {
      if (options.throws) throw new Error("blocked");
      values.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWorthShowing", () => {
  test("an awaited request shows before the visit", () => {
    expect(isWorthShowing(entry(), new Date(visit - DAY))).toBe(true);
  });

  test("a confirmed visit still shows on the evening of the same day", () => {
    const confirmed = entry({ status: "confirmed" });
    expect(isWorthShowing(confirmed, new Date(visit + 11 * HOUR))).toBe(true);
  });

  test("and is gone the next morning", () => {
    const confirmed = entry({ status: "confirmed" });
    expect(isWorthShowing(confirmed, new Date(visit + 13 * HOUR))).toBe(false);
  });

  test("a finished visit follows the same clock as an active one", () => {
    const completed = entry({ status: "completed", statusSeenAt: new Date(visit).toISOString() });
    expect(isWorthShowing(completed, new Date(visit + 11 * HOUR))).toBe(true);
    expect(isWorthShowing(completed, new Date(visit + 13 * HOUR))).toBe(false);
  });

  test("a cancellation stays for two days after this browser first saw it", () => {
    const seenAt = visit - 3 * DAY;
    const cancelled = entry({
      status: "cancelled",
      statusSeenAt: new Date(seenAt).toISOString(),
    });
    expect(isWorthShowing(cancelled, new Date(seenAt + 47 * HOUR))).toBe(true);
    expect(isWorthShowing(cancelled, new Date(seenAt + 49 * HOUR))).toBe(false);
  });

  test("but never more than a week after the appointment it was about", () => {
    const seenAt = visit + 8 * DAY;
    const cancelled = entry({
      status: "cancelled",
      statusSeenAt: new Date(seenAt).toISOString(),
    });
    expect(isWorthShowing(cancelled, new Date(seenAt + HOUR))).toBe(false);
  });

  test("an absence is news the same way a cancellation is", () => {
    const seenAt = visit + HOUR;
    const noShow = entry({ status: "no_show", statusSeenAt: new Date(seenAt).toISOString() });
    expect(isWorthShowing(noShow, new Date(seenAt + HOUR))).toBe(true);
    expect(isWorthShowing(noShow, new Date(seenAt + 49 * HOUR))).toBe(false);
  });
});

describe("withStatus", () => {
  const now = new Date(visit - HOUR);

  test("an unchanged answer leaves the record alone", () => {
    const stored = entry();
    expect(withStatus(stored, { status: "pending_confirmation", version: 1 }, now)).toBe(stored);
  });

  test("a new status dates itself", () => {
    const next = withStatus(entry(), { status: "confirmed", version: 2 }, now);
    expect(next.status).toBe("confirmed");
    expect(next.statusSeenAt).toBe(now.toISOString());
  });

  test("a reschedule moves the version and keeps the date of the status", () => {
    const stored = entry();
    const next = withStatus(stored, { status: "pending_confirmation", version: 4 }, now);
    expect(next.version).toBe(4);
    expect(next.statusSeenAt).toBe(stored.statusSeenAt);
  });
});

describe("needsFreshDetails", () => {
  test("asks for nothing while the version stands still", () => {
    expect(needsFreshDetails(entry(), { status: "pending_confirmation", version: 1 })).toBe(false);
  });

  test("takes one bump with a new status for the studio's answer, and asks for nothing", () => {
    expect(needsFreshDetails(entry(), { status: "confirmed", version: 2 })).toBe(false);
  });

  test("asks again when the version moved under an unchanged status", () => {
    expect(needsFreshDetails(entry(), { status: "pending_confirmation", version: 2 })).toBe(true);
  });

  test("asks again when more happened than one answer could explain", () => {
    expect(needsFreshDetails(entry(), { status: "confirmed", version: 3 })).toBe(true);
  });
});

describe("parseRemembered", () => {
  test("round-trips what rememberBooking would have written", () => {
    const stored = entry();
    expect(parseRemembered(JSON.stringify(stored))).toEqual(stored);
  });

  test("rejects nothing stored", () => {
    expect(parseRemembered(null)).toBeNull();
    expect(parseRemembered("")).toBeNull();
  });

  test("rejects text that is not JSON, and JSON that is not a record", () => {
    expect(parseRemembered("not-json")).toBeNull();
    expect(parseRemembered("42")).toBeNull();
    expect(parseRemembered("null")).toBeNull();
  });

  test("rejects a missing or empty token", () => {
    expect(parseRemembered(JSON.stringify({ ...entry(), token: "" }))).toBeNull();
    expect(parseRemembered(JSON.stringify({ ...entry(), token: 7 }))).toBeNull();
  });

  test("rejects a status the domain does not have", () => {
    expect(parseRemembered(JSON.stringify({ ...entry(), status: "waiting" }))).toBeNull();
  });

  test("rejects unusable dates", () => {
    expect(parseRemembered(JSON.stringify({ ...entry(), startsAt: "soon" }))).toBeNull();
    expect(parseRemembered(JSON.stringify({ ...entry(), statusSeenAt: "soon" }))).toBeNull();
  });

  test("rejects a version that is not a number", () => {
    expect(parseRemembered(JSON.stringify({ ...entry(), version: "1" }))).toBeNull();
    expect(parseRemembered(JSON.stringify({ ...entry(), version: Number.NaN }))).toBeNull();
  });

  test("rejects a record with no zone to print the hour in", () => {
    expect(parseRemembered(JSON.stringify({ ...entry(), timezone: "" }))).toBeNull();
    const without: Record<string, unknown> = { ...entry() };
    delete without.timezone;
    expect(parseRemembered(JSON.stringify(without))).toBeNull();
  });
});

describe("isActiveStatus", () => {
  test("names the two statuses that still hold the slot", () => {
    expect(isActiveStatus("pending_confirmation")).toBe(true);
    expect(isActiveStatus("confirmed")).toBe(true);
    expect(isActiveStatus("cancelled")).toBe(false);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("no_show")).toBe(false);
  });
});

describe("isBookingStatus", () => {
  test("accepts the domain's five and nothing else", () => {
    expect(isBookingStatus("no_show")).toBe(true);
    expect(isBookingStatus("waiting")).toBe(false);
    expect(isBookingStatus(undefined)).toBe(false);
    expect(isBookingStatus(2)).toBe(false);
  });
});

describe("the store", () => {
  test("reads back what was remembered, under the slug's own key", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });

    rememberBooking("studio-one", entry());
    expect(storage.values.has(storageKey("studio-one"))).toBe(true);
    expect(rememberedSnapshot("studio-one")).toEqual(entry());

    forgetBooking("studio-one");
    expect(rememberedSnapshot("studio-one")).toBeNull();
  });

  test("keeps one studio's booking out of another's", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });

    rememberBooking("studio-one", entry());
    expect(rememberedSnapshot("studio-two")).toBeNull();
  });

  /**
   * The contract `useSyncExternalStore` is unforgiving about: a snapshot that
   * builds a new object per call re-renders the page for as long as it is open.
   */
  test("hands back the same record until the stored text changes", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    rememberBooking("studio-one", entry());

    const first = rememberedSnapshot("studio-one");
    expect(rememberedSnapshot("studio-one")).toBe(first);

    rememberBooking("studio-one", entry({ status: "confirmed", version: 2 }));
    const second = rememberedSnapshot("studio-one");
    expect(second).not.toBe(first);
    expect(second?.status).toBe("confirmed");
  });

  test("tells subscribers about a write and a forget, and stops when they leave", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    let told = 0;
    const unsubscribe = subscribeRemembered(() => {
      told += 1;
    });

    rememberBooking("studio-one", entry());
    forgetBooking("studio-one");
    expect(told).toBe(2);

    unsubscribe();
    rememberBooking("studio-one", entry());
    expect(told).toBe(2);
  });

  test("says nothing is remembered when the browser refuses site data", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage({ throws: true }) });

    expect(() => rememberBooking("studio-one", entry())).not.toThrow();
    expect(rememberedSnapshot("studio-one")).toBeNull();
    expect(() => forgetBooking("studio-one")).not.toThrow();
  });

  test("does nothing at all on the server, where there is no browser to ask", () => {
    expect(rememberedSnapshot("studio-one")).toBeNull();
    expect(noRememberedBooking()).toBeNull();
    expect(() => rememberBooking("studio-one", entry())).not.toThrow();
    expect(() => forgetBooking("studio-one")).not.toThrow();
  });
});
