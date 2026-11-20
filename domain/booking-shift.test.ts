import { describe, expect, it } from "vitest";

import { planShift, shiftWriteOrder, type ShiftBooking } from "@/domain/booking-shift";

const at = (time: string) => new Date(`2026-11-20T${time}:00.000Z`);
const booking = (id: string, start: string, end: string): ShiftBooking => ({
  id,
  start: at(start),
  end: at(end),
});

const day = [{ start: at("09:00"), end: at("18:00") }];
const NEVER = new Date(0);

describe("planShift earlier", () => {
  it("pulls back-to-back bookings forward by the same amount", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00"), booking("b", "12:00", "13:00")],
      deltaMinutes: -30,
      anchorStart: at("06:00"), anchorEnd: at("10:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.moves.map((m) => [m.id, m.to.start, m.to.end])).toEqual([
      ["a", at("10:30"), at("11:30")],
      ["b", at("11:30"), at("12:30")],
    ]);
  });

  it("stops the chain at the first gap, and leaves everything after it alone", () => {
    const plan = planShift({
      following: [
        booking("a", "11:00", "12:00"),
        booking("b", "12:00", "13:00"),
        booking("lunch-after", "14:00", "15:00"),
      ],
      deltaMinutes: -30,
      anchorStart: at("06:00"), anchorEnd: at("10:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan.ok && plan.moves.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("moves only the first booking when a gap follows it", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00"), booking("b", "12:15", "13:00")],
      deltaMinutes: -30,
      anchorStart: at("06:00"), anchorEnd: at("10:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan.ok && plan.moves.map((m) => m.id)).toEqual(["a"]);
  });

  it("refuses to free more time than the visit before it was booked for", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00")],
      deltaMinutes: -45,
      anchorStart: at("10:00"), anchorEnd: at("09:45"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan).toEqual({ ok: false, reason: "too_early", bookingId: "a" });
  });

  it("refuses to move into the past", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00")],
      deltaMinutes: -30,
      anchorStart: at("06:00"), anchorEnd: at("10:00"),
      notBefore: at("10:45"),
      working: day,
    });

    expect(plan).toEqual({ ok: false, reason: "too_early", bookingId: "a" });
  });

  it("allows landing exactly on the limit", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00")],
      deltaMinutes: -30,
      anchorStart: at("06:00"), anchorEnd: at("10:30"),
      notBefore: at("10:30"),
      working: day,
    });

    expect(plan.ok).toBe(true);
  });

  it("refuses a move that begins before the shift does", () => {
    const plan = planShift({
      following: [booking("a", "09:30", "10:30")],
      deltaMinutes: -45,
      anchorStart: at("06:00"), anchorEnd: at("08:00"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan).toEqual({ ok: false, reason: "outside_working_hours", bookingId: "a" });
  });
});

describe("planShift later", () => {
  it("pushes what the delay runs into, keeping each booking's length", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00"), booking("b", "12:00", "12:45")],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("11:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan.ok && plan.moves.map((m) => [m.id, m.to.start, m.to.end])).toEqual([
      ["a", at("11:30"), at("12:30")],
      ["b", at("12:30"), at("13:15")],
    ]);
  });

  it("lets a gap absorb the delay and stops there", () => {
    const plan = planShift({
      following: [
        booking("a", "11:00", "12:00"),
        booking("b", "12:30", "13:30"),
        booking("c", "13:30", "14:30"),
      ],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("11:30"),
      notBefore: NEVER,
      working: day,
    });

    // a ends 12:30 exactly where b starts, so b is not touched, nor is c.
    expect(plan.ok && plan.moves.map((m) => m.id)).toEqual(["a"]);
  });

  it("shifts a later booking by less than the delay when a gap absorbs part of it", () => {
    const plan = planShift({
      following: [booking("a", "11:00", "12:00"), booking("b", "12:10", "13:00")],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("11:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan.ok && plan.moves.map((m) => [m.id, m.to.start])).toEqual([
      ["a", at("11:30")],
      ["b", at("12:30")],
    ]);
  });

  it("does not move a booking the delay never reaches", () => {
    const plan = planShift({
      following: [booking("a", "12:00", "13:00")],
      deltaMinutes: 15,
      anchorStart: at("06:00"), anchorEnd: at("11:15"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan).toEqual({ ok: false, reason: "nothing_to_move" });
  });

  it("refuses a push that runs past the end of the shift", () => {
    const plan = planShift({
      following: [booking("a", "17:00", "18:00")],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("17:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan).toEqual({ ok: false, reason: "outside_working_hours", bookingId: "a" });
  });

  it("refuses a push across a break between two stretches of work", () => {
    const plan = planShift({
      following: [booking("a", "12:00", "13:00")],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("12:30"),
      notBefore: NEVER,
      working: [
        { start: at("09:00"), end: at("13:00") },
        { start: at("14:00"), end: at("18:00") },
      ],
    });

    expect(plan).toEqual({ ok: false, reason: "outside_working_hours", bookingId: "a" });
  });

  it("does not refuse a booking the studio had already placed outside the rota", () => {
    const plan = planShift({
      following: [booking("late", "19:00", "20:00")],
      deltaMinutes: 30,
      anchorStart: at("06:00"), anchorEnd: at("19:30"),
      notBefore: NEVER,
      working: day,
    });

    expect(plan.ok).toBe(true);
  });
});

describe("planShift with nothing to do", () => {
  it("refuses an empty day", () => {
    expect(
      planShift({ following: [], deltaMinutes: 15, anchorStart: at("06:00"), anchorEnd: at("10:00"), notBefore: NEVER, working: day }),
    ).toEqual({ ok: false, reason: "nothing_to_move" });
  });

  it("refuses a zero delta", () => {
    expect(
      planShift({
        following: [booking("a", "11:00", "12:00")],
        deltaMinutes: 0,
        anchorStart: at("06:00"), anchorEnd: at("10:00"),
        notBefore: NEVER,
        working: day,
      }),
    ).toEqual({ ok: false, reason: "nothing_to_move" });
  });
});

describe("shiftWriteOrder", () => {
  const moves = [
    { id: "a", from: { start: at("11:00"), end: at("12:00") }, to: { start: at("10:30"), end: at("11:30") } },
    { id: "b", from: { start: at("12:00"), end: at("13:00") }, to: { start: at("11:30"), end: at("12:30") } },
  ];

  it("writes the nearest first going earlier", () => {
    expect(shiftWriteOrder(moves, -30).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("writes the furthest first going later", () => {
    expect(shiftWriteOrder(moves, 30).map((m) => m.id)).toEqual(["b", "a"]);
  });
});
