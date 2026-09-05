import { describe, expect, it } from "vitest";

import { PROVIDER_CONFIRMATION_WINDOW_HOURS } from "@/scripts/booking-metrics-core.mjs";
import { POLL_WINDOW_HOURS } from "@/lib/smsmd-delivery-status";

/**
 * Two numbers in two languages that have to mean the same day.
 *
 * The poller stops asking after `POLL_WINDOW_HOURS`; the metrics report counts
 * exactly the rows it gave up on. Move one without the other and the report
 * either invents unconfirmed messages the poller is still working on, or misses
 * the ones it has already abandoned — and both read as a number that is simply
 * wrong rather than as a bug anyone would notice.
 *
 * They are duplicated rather than shared because one is TypeScript the
 * application bundles and the other a script run by hand at a checkout. This
 * test is what a shared constant would have bought.
 */
describe("the window the poller gives up on", () => {
  it("is the same window the metrics report counts against", () => {
    expect(PROVIDER_CONFIRMATION_WINDOW_HOURS).toBe(POLL_WINDOW_HOURS);
  });
});
