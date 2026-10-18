import { describe, expect, it } from "vitest";

import { forEachConcurrently } from "@/lib/tenant-sweep";

/** A unit of work that finishes when the test says so, and records its overlap. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const finished: number[] = [];

  async function work(item: number) {
    started.push(item);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Uneven, so the items do not finish in the order they started.
    await new Promise((resolve) => setTimeout(resolve, (item % 3) * 2));
    inFlight -= 1;
    finished.push(item);
  }

  return { work, started, finished, peak: () => peak };
}

const ITEMS = Array.from({ length: 12 }, (_, index) => index);

describe("forEachConcurrently", () => {
  it("works on every item exactly once", async () => {
    const run = tracker();
    await forEachConcurrently(ITEMS, 5, run.work);

    expect([...run.finished].sort((a, b) => a - b)).toEqual(ITEMS);
    expect(run.started).toHaveLength(ITEMS.length);
  });

  it("never has more items in flight than it was given", async () => {
    const run = tracker();
    await forEachConcurrently(ITEMS, 5, run.work);
    expect(run.peak()).toBe(5);
  });

  it("starts no more workers than there are items", async () => {
    const run = tracker();
    await forEachConcurrently([0, 1], 5, run.work);
    expect(run.peak()).toBe(2);
    expect(run.finished.sort()).toEqual([0, 1]);
  });

  it("does nothing for an empty list", async () => {
    const run = tracker();
    await forEachConcurrently([], 5, run.work);
    expect(run.started).toEqual([]);
  });

  it("treats a concurrency below one as one at a time", async () => {
    const run = tracker();
    await forEachConcurrently(ITEMS, 0, run.work);
    expect(run.peak()).toBe(1);
    expect(run.finished).toEqual(ITEMS);
  });

  it("stops starting work after a failure, lets the rest finish, then throws it", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const failure = new Error("studio 2 failed");

    const outcome = forEachConcurrently(ITEMS, 3, async (item) => {
      started.push(item);
      if (item === 2) throw failure;
      // Still running when item 2 fails; must not be abandoned mid-way.
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished.push(item);
    });

    await expect(outcome).rejects.toBe(failure);
    expect(started).toEqual([0, 1, 2]);
    expect(finished.sort()).toEqual([0, 1]);
  });

  it("throws the first failure when several items fail", async () => {
    const outcome = forEachConcurrently([0, 1, 2], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item * 2));
      throw new Error(`item ${item}`);
    });
    await expect(outcome).rejects.toThrow("item 0");
  });
});
