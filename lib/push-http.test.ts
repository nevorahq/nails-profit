import { describe, expect, it } from "vitest";

import { endpointSchema, isPushServiceHost } from "@/lib/push-http";

/**
 * The server POSTs to whatever endpoint it stores, so only the browsers' own
 * push services are accepted.
 */
describe("a push endpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", (endpoint) => {
    expect(endpointSchema.safeParse(endpoint).success).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/api/v1/ops/notifications",
    "https://fcm.googleapis.com.attacker.example/send/abc",
    "https://evilpush.apple.com.example/x",
    "/api/v1/ops/notifications",
    "not a url",
  ])("refuses %s", (endpoint) => {
    expect(endpointSchema.safeParse(endpoint).success).toBe(false);
  });

  it("matches a host by whole labels, not by a trailing string", () => {
    expect(isPushServiceHost("notpush.apple.com")).toBe(false);
    expect(isPushServiceHost("web.push.apple.com")).toBe(true);
  });
});
