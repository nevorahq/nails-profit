import { describe, expect, it } from "vitest";

import { fingerprintRow, normalizeKeyPart, rowIdentity } from "@/domain/import-identity";

describe("normalizeKeyPart", () => {
  it("folds the differences a spreadsheet introduces", () => {
    expect(normalizeKeyPart("  Гель-лак  ")).toBe("гель-лак");
    expect(normalizeKeyPart("Гель  лак")).toBe("гель лак");
  });

  it("unifies the dashes Word substitutes", () => {
    // Word turns a typed hyphen into an en dash; the owner sees no difference
    // and would not accept "you now have two services" as an explanation.
    expect(normalizeKeyPart("Гель–лак")).toBe(normalizeKeyPart("Гель-лак"));
    expect(normalizeKeyPart("Гель—лак")).toBe(normalizeKeyPart("Гель-лак"));
    expect(normalizeKeyPart("Гель−лак")).toBe(normalizeKeyPart("Гель-лак"));
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeKeyPart("База")).not.toBe(normalizeKeyPart("Топ"));
  });
});

describe("fingerprintRow", () => {
  it("is stable across a re-import of the same row", () => {
    expect(fingerprintRow("service", ["Гель-лак", "ml"])).toBe(
      fingerprintRow("service", [" гель-лак ", "ML"]),
    );
  });

  it("does not collide across entity types", () => {
    // "Френч" is a plausible name for both a service and a client's nickname.
    expect(fingerprintRow("service", ["Френч"])).not.toBe(fingerprintRow("client", ["Френч"]));
  });

  it("keeps an empty part in position", () => {
    expect(fingerprintRow("service", ["Гель", ""])).not.toBe(fingerprintRow("service", ["", "Гель"]));
  });
});

describe("rowIdentity", () => {
  it("trusts an external id when the file has one", () => {
    expect(rowIdentity("client", "crm-42", ["Ирина"])).toEqual({
      kind: "external",
      externalId: "crm-42",
    });
  });

  it("falls back to a fingerprint when the id cell is blank", () => {
    // A blank cell is an absent id, not an id shared by every blank row —
    // treating it as a value would merge every such row into one.
    const first = rowIdentity("client", "  ", ["Ирина", "+37360000001"]);
    const second = rowIdentity("client", "", ["Ольга", "+37360000002"]);

    expect(first.kind).toBe("fingerprint");
    expect(first.externalId).not.toBe(second.externalId);
  });

  it("gives the same identity to the same row in a second file", () => {
    expect(rowIdentity("service", null, ["Гель-лак"])).toEqual(
      rowIdentity("service", undefined, ["ГЕЛЬ-ЛАК"]),
    );
  });
});
