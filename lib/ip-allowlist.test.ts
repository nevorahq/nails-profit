import { describe, expect, it } from "vitest";

import { clientIpFromHeaders, ipInAllowlist, matchesCidr, normalizeIpv4 } from "@/lib/ip-allowlist";

describe("clientIpFromHeaders", () => {
  it("prefers the Netlify client-connection header", () => {
    const headers = new Headers({
      "x-nf-client-connection-ip": "34.194.127.46",
      "x-forwarded-for": "10.0.0.1",
    });
    expect(clientIpFromHeaders(headers)).toBe("34.194.127.46");
  });

  it("falls back to the first x-forwarded-for hop", () => {
    const headers = new Headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1 " });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.7");
  });

  it("is null when no address header is present", () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});

describe("normalizeIpv4", () => {
  it("passes a plain IPv4 address through, trimmed", () => {
    expect(normalizeIpv4(" 192.0.2.10 ")).toBe("192.0.2.10");
  });

  it("unwraps an IPv4-mapped IPv6 address", () => {
    expect(normalizeIpv4("::ffff:192.0.2.10")).toBe("192.0.2.10");
  });

  it("drops a zone id", () => {
    expect(normalizeIpv4("192.0.2.10%eth0")).toBe("192.0.2.10");
  });

  it("is null for a real IPv6 address", () => {
    expect(normalizeIpv4("2001:db8::1")).toBeNull();
  });

  it("is null for an out-of-range octet or the wrong octet count", () => {
    expect(normalizeIpv4("192.0.2.256")).toBeNull();
    expect(normalizeIpv4("192.0.2")).toBeNull();
    expect(normalizeIpv4("192.0.2.1.1")).toBeNull();
    expect(normalizeIpv4("nonsense")).toBeNull();
  });
});

describe("matchesCidr", () => {
  it("matches an exact /32", () => {
    expect(matchesCidr("34.194.127.46", "34.194.127.46/32")).toBe(true);
    expect(matchesCidr("34.194.127.47", "34.194.127.46/32")).toBe(false);
  });

  it("treats a bare address as /32", () => {
    expect(matchesCidr("34.194.127.46", "34.194.127.46")).toBe(true);
  });

  it("matches inside a wider prefix and rejects just outside it", () => {
    expect(matchesCidr("198.51.100.9", "198.51.100.0/24")).toBe(true);
    expect(matchesCidr("198.51.100.255", "198.51.100.0/24")).toBe(true);
    expect(matchesCidr("198.51.101.0", "198.51.100.0/24")).toBe(false);
  });

  it("is false for a malformed CIDR, a bad prefix length, or a non-IPv4 address", () => {
    expect(matchesCidr("198.51.100.9", "198.51.100.0/33")).toBe(false);
    expect(matchesCidr("198.51.100.9", "garbage/24")).toBe(false);
    expect(matchesCidr("2001:db8::1", "198.51.100.0/24")).toBe(false);
  });
});

describe("ipInAllowlist", () => {
  const allowlist = ["34.194.127.46/32", "52.29.196.34/32"];

  it("is true when any entry matches", () => {
    expect(ipInAllowlist("52.29.196.34", allowlist)).toBe(true);
  });

  it("is false when none match and for an empty list", () => {
    expect(ipInAllowlist("203.0.113.7", allowlist)).toBe(false);
    expect(ipInAllowlist("34.194.127.46", [])).toBe(false);
  });
});
