import { describe, expect, it } from "vitest";

import { groupNotices, type NoticeRow, type StaffNoticeKind } from "@/lib/staff-notices";

const visit = new Date("2026-09-14T08:00:00.000Z");

function row(over: Partial<NoticeRow> & { createdAt: Date; kind: StaffNoticeKind }): NoticeRow {
  return {
    id: `n-${over.createdAt.toISOString()}`,
    bookingId: "booking-1",
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
      null,
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
      null,
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
      null,
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
      null,
    );

    expect(groups[0].previousStartsAt).toBe(first.toISOString());
  });
});

describe("what counts as unread", () => {
  const seen = new Date("2026-09-12T10:00:00.000Z");

  it("is everything for somebody who has never opened the bell", () => {
    const groups = groupNotices(feed(row({ createdAt: seen, kind: "client_cancelled" })), null);
    expect(groups[0].unread).toBe(true);
  });

  it("is nothing that happened before they looked", () => {
    const groups = groupNotices(
      feed(row({ createdAt: new Date(seen.getTime() - 60_000), kind: "client_cancelled" })),
      seen,
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
      seen,
    );

    expect(groups[0].unread).toBe(true);
  });
});
