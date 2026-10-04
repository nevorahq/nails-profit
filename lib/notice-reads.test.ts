import { describe, expect, it } from "vitest";

import { settledReads, withLocalReads } from "@/lib/notice-reads";

const clicked = "2026-10-04T10:00:00.000Z";

function line(bookingId: string, unread: boolean, happenedAt = clicked) {
  return { booking_id: bookingId, happened_at: happenedAt, unread };
}

function answer(...feed: ReturnType<typeof line>[]) {
  return { feed, unread: feed.filter((row) => row.unread).length, pending: [] as string[] };
}

describe("the reads made on this screen, over the bell's answer", () => {
  it("keeps a line read when an answer sent before the write says otherwise", () => {
    const stale = answer(line("a", true), line("b", true));
    const shown = withLocalReads(stale, new Map([["a", clicked]]));

    expect(shown.feed.map((row) => row.unread)).toEqual([false, true]);
    expect(shown.unread).toBe(1);
    // Everything else in the answer rides through untouched.
    expect(shown.pending).toBe(stale.pending);
  });

  it("lets a newer event on the same appointment come back unread", () => {
    const later = answer(line("a", true, "2026-10-04T10:05:00.000Z"));
    const shown = withLocalReads(later, new Map([["a", clicked]]));

    expect(shown.feed[0].unread).toBe(true);
    expect(shown.unread).toBe(1);
    expect(settledReads(later, new Map([["a", clicked]]))).toEqual(["a"]);
  });

  it("hands the answer back as it came when nothing was read here", () => {
    const fresh = answer(line("a", true));
    expect(withLocalReads(fresh, new Map())).toBe(fresh);
  });

  it("drops a mark once the server says read too, and only then", () => {
    const readHere = new Map([["a", clicked], ["b", clicked]]);
    const stillStale = answer(line("a", true), line("b", false));

    expect(settledReads(stillStale, readHere)).toEqual(["b"]);
    // Pure: the map is the caller's to change.
    expect(readHere.size).toBe(2);
  });

  it("keeps a mark whose line the answer does not carry", () => {
    expect(settledReads(answer(line("b", true)), new Map([["a", clicked]]))).toEqual([]);
  });
});
