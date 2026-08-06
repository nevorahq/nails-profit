import { describe, expect, it } from "vitest";

import { checkRequestOrigin } from "@/lib/csrf";

const APP = "https://app.nailprofit.example";

function headersOf(entries: Record<string, string>) {
  return new Headers(entries);
}

describe("cross-site requests", () => {
  it("refuses what the browser labels cross-site", () => {
    expect(checkRequestOrigin(headersOf({ "sec-fetch-site": "cross-site" }), APP)).toBe("refuse");
  });

  it("allows the application's own pages", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(checkRequestOrigin(headersOf({ "sec-fetch-site": site }), APP)).toBe("allow");
    }
  });

  it("trusts Sec-Fetch-Site over a matching Origin", () => {
    // Page JavaScript can set neither, but a proxy can rewrite Origin. The
    // header the browser controls is the one to believe.
    expect(
      checkRequestOrigin(headersOf({ "sec-fetch-site": "cross-site", origin: APP }), APP),
    ).toBe("refuse");
  });

  it("falls back to Origin for clients that send no Sec-Fetch-Site", () => {
    expect(checkRequestOrigin(headersOf({ origin: APP }), APP)).toBe("allow");
    expect(checkRequestOrigin(headersOf({ origin: `${APP}:8443` }), APP)).toBe("refuse");
    expect(checkRequestOrigin(headersOf({ origin: "https://evil.example" }), APP)).toBe("refuse");
  });

  it("refuses an Origin that is not a URL", () => {
    expect(checkRequestOrigin(headersOf({ origin: "not a url" }), APP)).toBe("refuse");
  });

  it("allows a request with neither header", () => {
    // curl, a cron job, a server-to-server call: no ambient cookie to forge.
    expect(checkRequestOrigin(headersOf({}), APP)).toBe("allow");
  });

  it("refuses the opaque origin", () => {
    // A sandboxed iframe on an old browser is the one caller that reaches here
    // with an ambient cookie and no Sec-Fetch-Site.
    expect(checkRequestOrigin(headersOf({ origin: "null" }), APP)).toBe("refuse");
  });
});
