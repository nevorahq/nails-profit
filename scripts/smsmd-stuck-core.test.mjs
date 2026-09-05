import { describe, expect, it } from "vitest";

import { buildStuckReport, findStuckMessages } from "./smsmd-stuck-core.mjs";

const NOW = new Date("2026-09-05T09:00:00.000Z");

function message(overrides = {}) {
  const created = overrides.dateCreated ?? "2026-09-05T08:00:00.000Z";
  return {
    id: "id-1",
    senderName: "NEVORA",
    receiverNumber: "37360111222",
    smsCount: 1,
    carrier: { id: 1, name: "Orange" },
    status: { id: 1, name: "Queued" },
    dateCreated: created,
    // Matching `dateCreated` is the untouched case, which is what the incident
    // looked like; a test that wants movement says so.
    dateUpdated: created,
    dateSent: null,
    ...overrides,
  };
}

describe("what counts as stuck", () => {
  it("keeps a message nobody has settled and drops the ones that are done", () => {
    const stuck = findStuckMessages(
      [
        message({ id: "queued", status: { id: 1, name: "Queued" } }),
        message({ id: "at-carrier", status: { id: 2, name: "Sent" } }),
        message({ id: "resending", status: { id: 4, name: "Повторная отправка" } }),
        message({ id: "at-operator", status: { id: 5, name: "У оператора" } }),
        message({ id: "delivered", status: { id: 3, name: "Delivered" } }),
        message({ id: "undelivered", status: { id: 9, name: "Undelivered" } }),
        message({ id: "failed", status: { id: 10, name: "Failed" } }),
        // The platform saying it never found out. Asking again cannot improve
        // on that, so the wait is over even though nothing was delivered.
        message({ id: "unknown", status: { id: 8, name: "Unknown" } }),
      ],
      { now: NOW },
    );

    expect(stuck.map((row) => row.id)).toEqual(["queued", "at-carrier", "resending", "at-operator"]);
  });

  it("waits out the threshold before calling anything stuck", () => {
    const messages = [
      message({ id: "old", dateCreated: "2026-09-05T08:40:00.000Z" }), // 20 минут
      message({ id: "fresh", dateCreated: "2026-09-05T08:55:00.000Z" }), // 5 минут
    ];

    expect(findStuckMessages(messages, { now: NOW }).map((row) => row.id)).toEqual(["old"]);
    // The same two rows, judged against an hour: neither has waited that long.
    expect(findStuckMessages(messages, { now: NOW, minutes: 60 })).toEqual([]);
  });

  it("ignores a timestamp it cannot read rather than reporting a clock as an outage", () => {
    const stuck = findStuckMessages(
      [
        message({ id: "unreadable", dateCreated: "не дата" }),
        message({ id: "future", dateCreated: "2026-09-06T00:00:00.000Z" }),
      ],
      { now: NOW },
    );

    expect(stuck).toEqual([]);
  });

  it("shows the oldest first, because that is the one to quote", () => {
    const stuck = findStuckMessages(
      [
        message({ id: "hour", dateCreated: "2026-09-05T08:00:00.000Z" }),
        message({ id: "half", dateCreated: "2026-09-05T08:30:00.000Z" }),
        message({ id: "night", dateCreated: "2026-09-04T21:00:00.000Z" }),
      ],
      { now: NOW },
    );

    expect(stuck.map((row) => row.id)).toEqual(["night", "hour", "half"]);
    expect(stuck[0].age_minutes).toBe(720);
  });

  it("marks a message nothing has happened to", () => {
    const [untouched, moved] = findStuckMessages(
      [
        message({ id: "untouched" }),
        message({ id: "moved", dateUpdated: "2026-09-05T08:30:00.000Z" }),
      ],
      { now: NOW },
    );

    expect(untouched.untouched).toBe(true);
    expect(moved.untouched).toBe(false);
  });
});

describe("the report", () => {
  /**
   * The night this script exists for: five messages accepted and charged for on
   * one route, three delivered in a second on another. Naming the single route
   * is the whole finding — it is a closed direction, not a slow platform.
   */
  it("names the one route that stopped when the others are working", () => {
    const report = buildStuckReport(
      [
        message({ id: "a", carrier: { name: "International" }, smsCount: 4 }),
        message({ id: "b", carrier: { name: "International" }, smsCount: 4 }),
        message({ id: "c", carrier: { name: "International" }, smsCount: 2 }),
        message({ id: "d", carrier: { name: "Orange" }, status: { id: 3, name: "Delivered" } }),
      ],
      { now: NOW },
    );

    expect(report).toMatchObject({
      verdict: "STUCK",
      messages_examined: 4,
      stuck_messages: 3,
      stuck_segments: 10,
      oldest_age_minutes: 60,
      single_carrier_affected: "International",
    });
    expect(report.stuck_by_carrier).toEqual({ International: 3 });
  });

  it("does not blame one route when several are stuck", () => {
    // Everything waiting is the platform having a bad afternoon, and it needs a
    // different conversation than a shut direction.
    const report = buildStuckReport(
      [
        message({ id: "a", carrier: { name: "International" } }),
        message({ id: "b", carrier: { name: "Orange" } }),
      ],
      { now: NOW },
    );

    expect(report.single_carrier_affected).toBeNull();
    expect(report.stuck_by_carrier).toEqual({ International: 1, Orange: 1 });
  });

  it("does not blame a route that is the only one there is", () => {
    // One carrier stuck out of one carrier seen says nothing about routing:
    // there is no working route to contrast it with.
    const report = buildStuckReport([message({ carrier: { name: "Orange" } })], { now: NOW });

    expect(report.single_carrier_affected).toBeNull();
    expect(report.verdict).toBe("STUCK");
  });

  it("passes on an account with nothing waiting", () => {
    const report = buildStuckReport(
      [message({ status: { id: 3, name: "Delivered" } })],
      { now: NOW },
    );

    expect(report).toMatchObject({ verdict: "PASS", stuck_messages: 0, oldest_age_minutes: null });
  });

  it("passes on an account with no messages at all", () => {
    expect(buildStuckReport([], { now: NOW })).toMatchObject({
      verdict: "PASS",
      messages_examined: 0,
      single_carrier_affected: null,
    });
  });
});
