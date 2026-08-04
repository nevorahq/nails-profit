import { describe, expect, it } from "vitest";

import {
  createInvitationToken,
  effectiveInvitationStatus,
  hashInvitationToken,
  invitationExpiry,
  normalizeInvitationEmail,
  parseInvitationToken,
  tokenHashEquals,
} from "@/domain/invitation";

const ORG = "65bf3d3a-3d81-43c2-af45-ff986a4e0432";

describe("invitation tokens", () => {
  it("round-trips the organization and hash", () => {
    const { token, tokenHash } = createInvitationToken(ORG);
    const parsed = parseInvitationToken(token);

    expect(parsed).not.toBeNull();
    expect(parsed?.organizationId).toBe(ORG);
    expect(parsed?.tokenHash).toBe(tokenHash);
  });

  it("never stores the token itself", () => {
    const { token, tokenHash } = createInvitationToken(ORG);
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues a different token every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createInvitationToken(ORG).token));
    expect(seen.size).toBe(50);
  });

  it("changes the hash when a single character of the secret changes", () => {
    const { token, tokenHash } = createInvitationToken(ORG);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(hashInvitationToken(tampered)).not.toBe(tokenHash);
  });

  it("rejects malformed tokens without hashing them", () => {
    for (const bad of [
      "",
      "   ",
      "not-a-token",
      `${ORG}`,
      `${ORG}.`,
      `${ORG}.short`,
      `not-a-uuid.${"a".repeat(43)}`,
      `${ORG}.${"a".repeat(43)}.extra`,
      `${ORG}.has spaces here padding`,
    ]) {
      expect(parseInvitationToken(bad)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace from a pasted link", () => {
    const { token, tokenHash } = createInvitationToken(ORG);
    expect(parseInvitationToken(`  ${token}\n`)?.tokenHash).toBe(tokenHash);
  });

  it("compares hashes without leaking length mismatches", () => {
    const a = hashInvitationToken("one");
    const b = hashInvitationToken("two");
    expect(tokenHashEquals(a, a)).toBe(true);
    expect(tokenHashEquals(a, b)).toBe(false);
    expect(tokenHashEquals(a, "short")).toBe(false);
  });
});

describe("invitation lifecycle", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("expires seven days out by default", () => {
    expect(invitationExpiry(now).toISOString()).toBe("2026-08-12T12:00:00.000Z");
  });

  it("derives expiry from the timestamp instead of a stored status", () => {
    const past = new Date("2026-08-04T12:00:00Z");
    const future = new Date("2026-08-06T12:00:00Z");

    expect(effectiveInvitationStatus("pending", past, now)).toBe("expired");
    expect(effectiveInvitationStatus("pending", future, now)).toBe("pending");
  });

  it("treats the exact expiry instant as expired", () => {
    expect(effectiveInvitationStatus("pending", now, now)).toBe("expired");
  });

  it("never resurrects an accepted or revoked invitation", () => {
    const past = new Date("2026-08-04T12:00:00Z");
    expect(effectiveInvitationStatus("accepted", past, now)).toBe("accepted");
    expect(effectiveInvitationStatus("revoked", past, now)).toBe("revoked");
  });
});

describe("normalizeInvitationEmail", () => {
  it("folds case and trims so one address cannot be invited twice", () => {
    expect(normalizeInvitationEmail("  Master@Example.COM ")).toBe("master@example.com");
  });
});
