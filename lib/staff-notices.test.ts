import { describe, expect, it } from "vitest";

import { groupNotices, type NoticeRow, type StaffNoticeKind } from "@/lib/staff-notices";

const visit = new Date("2026-09-14T08:00:00.000Z");

function row(over: Partial<NoticeRow> & { createdAt: Date; kind?: StaffNoticeKind }): NoticeRow {
  return {
    id: `n-${over.bookingId ?? "booking-1"}-${over.createdAt.toISOString()}`,
    bookingId: "booking-1",
    // The kind is what most of these tests are about and beside the point in
    // the rest: the ones about order and about who has opened what care only
    // when each event landed.
    kind: "client_cancelled",
    previousStartsAt: null,
    clientName: "Ольга",
    specialistId: "spec-1",
    specialistName: "Анна",
    startsAt: visit,
    timezone: "Europe/Chisinau",
    ...over,
  };
}

/** The feed arrives newest first, which is the order the grouping relies on. */
function feed(...rows: NoticeRow[]) {
  return [...rows].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

/** Somebody who has opened none of them, which is where every reader starts. */
const NONE: ReadonlyMap<string, Date> = new Map();

/** The one appointment these fixtures use, opened at a given moment. */
function readThrough(at: Date): ReadonlyMap<string, Date> {
  return new Map([["booking-1", at]]);
}

describe("grouping the bell by appointment", () => {
  const moved = new Date("2026-09-12T09:00:00.000Z");
  const movedAgain = new Date("2026-09-12T10:00:00.000Z");
  const cancelled = new Date("2026-09-12T11:00:00.000Z");

  it("collapses one appointment's story into one line", () => {
    const groups = groupNotices(
      feed(
        row({ createdAt: moved, kind: "client_rescheduled", previousStartsAt: visit.toISOString() }),
        row({ createdAt: cancelled, kind: "client_cancelled" }),
      ),
      NONE,
    );

    expect(groups).toHaveLength(1);
    // The line says what happened last, and carries what came before it.
    expect(groups[0].kind).toBe("client_cancelled");
    expect(groups[0].earlier).toEqual(["client_rescheduled"]);
    expect(groups[0].at).toEqual(cancelled);
  });

  it("reads the trail oldest first, however many events it took", () => {
    const groups = groupNotices(
      feed(
        row({ createdAt: moved, kind: "client_rescheduled" }),
        row({ createdAt: movedAgain, kind: "staff_rescheduled" }),
        row({ createdAt: cancelled, kind: "client_cancelled" }),
      ),
      NONE,
    );

    expect(groups[0].kind).toBe("client_cancelled");
    expect(groups[0].earlier).toEqual(["client_rescheduled", "staff_rescheduled"]);
  });

  /**
   * Two visits of the same client on two days are two holes in the calendar.
   * Grouping by the person would hide one of them, which is the reason the
   * grouping is by booking.
   */
  it("keeps two appointments apart, newest first", () => {
    const groups = groupNotices(
      feed(
        row({ bookingId: "booking-1", createdAt: moved, kind: "client_cancelled" }),
        row({ bookingId: "booking-2", createdAt: cancelled, kind: "client_cancelled" }),
      ),
      NONE,
    );

    expect(groups.map((group) => group.bookingId)).toEqual(["booking-2", "booking-1"]);
  });

  it("remembers the hour the appointment started from, not the last one it left", () => {
    const first = new Date("2026-09-14T08:00:00.000Z");
    const second = new Date("2026-09-15T08:00:00.000Z");

    const groups = groupNotices(
      feed(
        row({ createdAt: moved, kind: "client_rescheduled", previousStartsAt: first.toISOString() }),
        row({
          createdAt: movedAgain,
          kind: "client_rescheduled",
          previousStartsAt: second.toISOString(),
        }),
      ),
      NONE,
    );

    expect(groups[0].previousStartsAt).toBe(first.toISOString());
  });
});

describe("what counts as unread", () => {
  const seen = new Date("2026-09-12T10:00:00.000Z");

  it("is everything for somebody who has opened none of them", () => {
    const groups = groupNotices(feed(row({ createdAt: seen, kind: "client_cancelled" })), NONE);
    expect(groups[0].unread).toBe(true);
  });

  it("is nothing that happened before they opened that appointment", () => {
    const groups = groupNotices(
      feed(row({ createdAt: new Date(seen.getTime() - 60_000), kind: "client_cancelled" })),
      readThrough(seen),
    );
    expect(groups[0].unread).toBe(false);
  });

  /**
   * A group is unread when any of its events is, not when its newest one is: a
   * cancellation seen yesterday and a move this morning collapse into one line,
   * and the line is new.
   */
  it("marks a whole group when one event in it is new", () => {
    const groups = groupNotices(
      feed(
        row({ createdAt: new Date(seen.getTime() - 60_000), kind: "client_rescheduled" }),
        row({ createdAt: new Date(seen.getTime() + 60_000), kind: "client_cancelled" }),
      ),
      readThrough(seen),
    );

    expect(groups[0].unread).toBe(true);
  });

  /**
   * The mark is per appointment, which is the whole reason it stopped being one
   * moment on the reader.
   *
   * Opening one line must leave the others exactly where they were — a single
   * timestamp cannot express that, however it is read, because everything older
   * than the moment it records goes with it.
   */
  it("leaves the appointments they have not opened alone", () => {
    const groups = groupNotices(
      feed(
        row({ bookingId: "b1", createdAt: new Date(seen.getTime() - 60_000) }),
        row({ bookingId: "b2", createdAt: new Date(seen.getTime() - 120_000) }),
      ),
      new Map([["b1", seen]]),
    );

    expect(groups.find((group) => group.bookingId === "b1")?.unread).toBe(false);
    expect(groups.find((group) => group.bookingId === "b2")?.unread).toBe(true);
  });
});

/**
 * The order a queue wants, which is not the order a record wants.
 *
 * The feed used to be one run of time — right for «что произошло», wrong the
 * moment the list became «что мне ещё разгрести»: the line opened a minute ago
 * sat above the three untouched ones purely because it had moved most recently.
 */
describe("the order lines are read in", () => {
  const seen = new Date("2026-09-12T10:00:00.000Z");

  it("puts what is still waiting above what has been dealt with", () => {
    const groups = groupNotices(
      feed(
        // The newest event of the three, and already opened.
        row({ bookingId: "opened", createdAt: new Date(seen.getTime() + 600_000) }),
        row({ bookingId: "waiting-older", createdAt: new Date(seen.getTime() - 600_000) }),
        row({ bookingId: "waiting-newer", createdAt: new Date(seen.getTime() - 60_000) }),
      ),
      new Map([["opened", new Date(seen.getTime() + 900_000)]]),
    );

    expect(groups.map((group) => group.bookingId)).toEqual([
      "waiting-newer",
      "waiting-older",
      "opened",
    ]);
  });

  it("keeps newest first inside each half", () => {
    const groups = groupNotices(
      feed(
        row({ bookingId: "read-new", createdAt: new Date(seen.getTime() - 60_000) }),
        row({ bookingId: "read-old", createdAt: new Date(seen.getTime() - 600_000) }),
      ),
      new Map([
        ["read-new", seen],
        ["read-old", seen],
      ]),
    );

    expect(groups.map((group) => group.bookingId)).toEqual(["read-new", "read-old"]);
  });

  /**
   * And the rule that makes sinking safe rather than silencing: anything that
   * happens on an appointment after it was opened is newer than the mark, so
   * the line comes back up with its own stripe instead of staying quietly at
   * the bottom.
   */
  it("lifts a line back when something else happens on it", () => {
    const groups = groupNotices(
      feed(
        row({ bookingId: "moved-again", createdAt: new Date(seen.getTime() + 60_000) }),
        row({ bookingId: "untouched", createdAt: new Date(seen.getTime() - 60_000) }),
      ),
      new Map([
        ["moved-again", seen],
        ["untouched", new Date(seen.getTime() + 600_000)],
      ]),
    );

    expect(groups[0].bookingId).toBe("moved-again");
    expect(groups[0].unread).toBe(true);
  });
});
