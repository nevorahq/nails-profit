import { describe, expect, test } from "vitest";

import {
  contains,
  durationMinutes,
  intersectIntervals,
  isEmpty,
  mergeIntervals,
  overlaps,
  padInterval,
  subtractIntervals,
  type Interval,
} from "@/domain/interval";

function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, 5, hour, minute));
}

function interval(startHour: number, endHour: number): Interval {
  return { start: at(startHour), end: at(endHour) };
}

const hours = (list: readonly Interval[]) =>
  list.map((piece) => [piece.start.getUTCHours(), piece.end.getUTCHours()]);

describe("half-open semantics", () => {
  test("back-to-back appointments do not overlap", () => {
    // The whole reason for [start, end): 10:00–11:00 and 11:00–12:00 are two
    // clients in a row, not a double booking.
    expect(overlaps(interval(10, 11), interval(11, 12))).toBe(false);
    expect(overlaps(interval(10, 12), interval(11, 12))).toBe(true);
    expect(overlaps(interval(11, 12), interval(10, 12))).toBe(true);
  });

  test("an interval contains one that ends exactly at its end", () => {
    expect(contains(interval(9, 18), interval(17, 18))).toBe(true);
    expect(contains(interval(9, 18), interval(17, 19))).toBe(false);
  });

  test("a reversed or zero-length interval is empty", () => {
    expect(isEmpty(interval(10, 10))).toBe(true);
    expect(isEmpty(interval(12, 10))).toBe(true);
    expect(isEmpty(interval(10, 11))).toBe(false);
  });
});

describe("mergeIntervals", () => {
  test("sorts, joins overlaps and drops empties", () => {
    expect(hours(mergeIntervals([interval(14, 16), interval(9, 12), interval(11, 13), interval(5, 5)]))).toEqual([
      [9, 13],
      [14, 16],
    ]);
  });

  test("abutting intervals become one working day", () => {
    expect(hours(mergeIntervals([interval(9, 13), interval(13, 18)]))).toEqual([[9, 18]]);
  });

  test("a contained interval does not shorten the one around it", () => {
    expect(hours(mergeIntervals([interval(9, 18), interval(11, 12)]))).toEqual([[9, 18]]);
  });
});

describe("subtractIntervals", () => {
  test("a cut through the middle leaves two pieces", () => {
    expect(hours(subtractIntervals([interval(9, 18)], [interval(13, 14)]))).toEqual([
      [9, 13],
      [14, 18],
    ]);
  });

  test("a cut at an edge shortens rather than splits", () => {
    expect(hours(subtractIntervals([interval(9, 18)], [interval(9, 11)]))).toEqual([[11, 18]]);
    expect(hours(subtractIntervals([interval(9, 18)], [interval(16, 18)]))).toEqual([[9, 16]]);
  });

  test("a cut covering everything leaves nothing", () => {
    expect(subtractIntervals([interval(9, 18)], [interval(8, 20)])).toEqual([]);
  });

  test("a cut that touches but does not overlap changes nothing", () => {
    expect(hours(subtractIntervals([interval(9, 18)], [interval(18, 20)]))).toEqual([[9, 18]]);
  });

  test("several cuts apply to several bases", () => {
    expect(
      hours(subtractIntervals([interval(9, 13), interval(14, 18)], [interval(10, 11), interval(15, 20)])),
    ).toEqual([
      [9, 10],
      [11, 13],
      [14, 15],
    ]);
  });
});

describe("intersectIntervals", () => {
  test("keeps only what both sides cover", () => {
    expect(hours(intersectIntervals([interval(9, 18)], [interval(12, 20)]))).toEqual([[12, 18]]);
    expect(intersectIntervals([interval(9, 12)], [interval(12, 18)])).toEqual([]);
  });

  test("intersecting many with many merges the result", () => {
    expect(
      hours(intersectIntervals([interval(9, 13), interval(14, 18)], [interval(10, 15), interval(15, 17)])),
    ).toEqual([
      [10, 13],
      [14, 17],
    ]);
  });
});

describe("padding and duration", () => {
  test("padding widens both ends by the buffers", () => {
    const padded = padInterval(interval(10, 11), 5, 15);
    expect(padded.start.toISOString()).toBe(at(9, 55).toISOString());
    expect(padded.end.toISOString()).toBe(at(11, 15).toISOString());
  });

  test("duration is in minutes", () => {
    expect(durationMinutes(interval(9, 18))).toBe(540);
  });
});
