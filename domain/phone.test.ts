import { describe, expect, it } from "vitest";

import { normalizePhone, samePhone } from "@/domain/phone";

describe("normalizePhone", () => {
  it("accepts the shapes a Moldovan client actually writes", () => {
    // All of these are the same subscriber.
    for (const input of [
      "060123456",
      "60123456",
      "+373 60 123 456",
      "373-60-123-456",
      "(0) 60 123 456",
      "  +37360123456  ",
    ]) {
      expect(normalizePhone(input)).toBe("+37360123456");
    }
  });

  it("handles a non-breaking space pasted from a web page", () => {
    expect(normalizePhone("+373 60 123 456")).toBe("+37360123456");
  });

  it("normalizes Romanian numbers when that region is selected", () => {
    expect(normalizePhone("0721234567", "RO")).toBe("+40721234567");
    expect(normalizePhone("+40721234567", "RO")).toBe("+40721234567");
  });

  it("recognizes an international number even when the wrong region is selected", () => {
    // A Moldovan salon with a Romanian client: the country code is explicit, so
    // the region default must not corrupt it.
    expect(normalizePhone("+40721234567", "MD")).toBe("+40721234567");
  });

  it("returns null for input that is not a number", () => {
    for (const input of ["", "   ", "не телефон", "+", "abc123", "+373-60-12а-456"]) {
      expect(normalizePhone(input)).toBeNull();
    }
  });

  it("returns null when the length is wrong for the region", () => {
    expect(normalizePhone("6012345")).toBeNull();
    expect(normalizePhone("601234567")).toBeNull();
    expect(normalizePhone("+3736012345")).toBeNull();
  });

  it("does not silently accept a Romanian-length number as Moldovan", () => {
    expect(normalizePhone("0721234567", "MD")).toBeNull();
  });
});

describe("samePhone", () => {
  it("matches the same subscriber written differently", () => {
    expect(samePhone("060123456", "+373 60 123 456")).toBe(true);
  });

  it("does not match different subscribers", () => {
    expect(samePhone("060123456", "060123457")).toBe(false);
  });

  it("never matches two unparseable values", () => {
    // Otherwise every malformed entry would deduplicate against every other.
    expect(samePhone("nonsense", "nonsense")).toBe(false);
  });
});
