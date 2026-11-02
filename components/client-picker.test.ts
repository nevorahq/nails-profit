import { describe, expect, it } from "vitest";

import { looksLikePhone, matchClients, type PickableClient } from "@/components/client-picker";

const base: readonly PickableClient[] = [
  { id: "1", name: "Ирина Петрова", phone: "+37369123456" },
  { id: "2", name: "Marina Popa", phone: "+37378555000" },
  { id: "3", name: "Анна", phone: null },
  { id: "4", name: "Anya" },
];

describe("looksLikePhone", () => {
  it.each(["069 123", "+373 (69) 123-456", "37369"])("takes %s for a number", (query) => {
    expect(looksLikePhone(query)).toBe(true);
  });

  it.each(["Ирина", "anna 2", "12", "", "  "])("takes %j for a name", (query) => {
    expect(looksLikePhone(query)).toBe(false);
  });
});

describe("matchClients", () => {
  it("finds a name anywhere in it, whatever the case", () => {
    expect(matchClients(base, "РИН").map((client) => client.id)).toEqual(["1"]);
    expect(matchClients(base, "rina").map((client) => client.id)).toEqual(["2"]);
  });

  it("finds a number by its digits, whatever it was written with", () => {
    expect(matchClients(base, "69 123").map((client) => client.id)).toEqual(["1"]);
    expect(matchClients(base, "(78) 555").map((client) => client.id)).toEqual(["2"]);
  });

  it("does not match a number against a client who has none", () => {
    expect(matchClients(base, "000")).toEqual([base[1]]);
    expect(matchClients([base[2], base[3]], "123")).toEqual([]);
  });

  it("matches nothing for an empty or blank query", () => {
    expect(matchClients(base, "")).toEqual([]);
    expect(matchClients(base, "   ")).toEqual([]);
  });

  it("matches nothing against the digits of a name when the query has letters", () => {
    // «anna 2» is a name being typed; it must not be read as the digits 2.
    expect(matchClients(base, "anna 2")).toEqual([]);
  });

  it("offers five at most, in the base's order", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `Anna ${index}` }));
    expect(matchClients(many, "anna").map((client) => client.id)).toEqual(["0", "1", "2", "3", "4"]);
  });
});
