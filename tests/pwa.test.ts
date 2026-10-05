import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import nextConfig from "@/next.config";
import { config as proxyConfig } from "@/proxy";

/**
 * The installable shell the push channel depends on.
 *
 * A phone that cannot install the site cannot receive its pushes on iOS at all,
 * and a worker that is cached, blocked or caching is a notification that opens
 * yesterday's calendar. Each of those is a property of a file rather than of a
 * running server, so they are checked as files.
 */
describe("the web app manifest", () => {
  const value = manifest();

  it("opens the signed-in screens as a standalone application", () => {
    expect(value.start_url).toBe("/app");
    expect(value.display).toBe("standalone");
  });

  it("points at icons that are in public/", () => {
    for (const icon of value.icons ?? []) {
      expect(() => readFileSync(`public${icon.src}`)).not.toThrow();
    }
    expect(value.icons?.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
  });
});

describe("the push worker", () => {
  const source = readFileSync("public/sw.js", "utf8");

  it("handles a push and a click on it", () => {
    expect(source).toContain('addEventListener("push"');
    expect(source).toContain('addEventListener("notificationclick"');
  });

  it("caches nothing and is never in the path of a page load", () => {
    // No offline mode, decided for phase 7: a cached calendar is a wrong answer
    // that looks right.
    expect(source).not.toContain('addEventListener("fetch"');
    expect(source).not.toMatch(/caches\./);
  });

  it("is always fetched fresh", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const worker = rules.find((rule) => rule.source === "/sw.js");
    expect(worker?.headers).toContainEqual({
      key: "Cache-Control",
      value: "no-cache, no-store, must-revalidate",
    });
  });
});

describe("nothing stands in front of the worker or the manifest", () => {
  it("leaves both outside the proxy, which only guards /api/v1", () => {
    // The proxy's one job is the read-only preview; a refusal on these paths
    // would break installing and receiving for an owner who happens to preview.
    expect(proxyConfig.matcher).toBe("/api/v1/:path*");
  });

  it("sends no Content-Security-Policy that could refuse the worker script", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const keys = rules.flatMap((rule) => rule.headers.map((header) => header.key.toLowerCase()));
    // If a CSP is added later it needs `worker-src 'self'`; this test is the
    // reminder, not a ban.
    expect(keys).not.toContain("content-security-policy");
  });
});
