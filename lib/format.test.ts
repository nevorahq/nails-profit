import { describe, expect, it } from "vitest";

import { formatPercentDelta } from "@/lib/format";

describe("formatPercentDelta", () => {
  it("reports a rise against the prior period", () => {
    const delta = formatPercentDelta(28_540_00, 25_390_00, "ru-MD");
    expect(delta?.direction).toBe("up");
    expect(delta?.text).toContain("12");
  });

  it("reports a fall against the prior period", () => {
    const delta = formatPercentDelta(9_430_00, 12_000_00, "ru-MD");
    expect(delta?.direction).toBe("down");
  });

  it("has no delta when there was nothing to compare against", () => {
    // A prior period with zero profit is not a 100% drop from nothing; it is
    // not a comparison at all.
    expect(formatPercentDelta(5_000, 0, "ru-MD")).toBeNull();
  });

  it("reads a loss-to-loss change by the size of the loss, not its sign", () => {
    // From a 10 000 loss to a 5 000 loss is an improvement, read the same way
    // a revenue rise would be: `direction: "up"`.
    const delta = formatPercentDelta(-5_000, -10_000, "ru-MD");
    expect(delta?.direction).toBe("up");
  });
});
