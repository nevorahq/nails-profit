import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIFFICULTY_BITS,
  digestOf,
  hasLeadingZeroBits,
  isSolved,
  solveChallenge,
} from "@/domain/proof-of-work";

describe("leading zero bits", () => {
  it("counts bits, not bytes", () => {
    expect(hasLeadingZeroBits(Uint8Array.from([0x00, 0x0f]), 8)).toBe(true);
    expect(hasLeadingZeroBits(Uint8Array.from([0x00, 0x0f]), 12)).toBe(true);
    // 0x0f is 00001111: the thirteenth bit is set.
    expect(hasLeadingZeroBits(Uint8Array.from([0x00, 0x0f]), 13)).toBe(false);
    expect(hasLeadingZeroBits(Uint8Array.from([0x01]), 8)).toBe(false);
  });

  it("asks nothing of a zero-bit difficulty", () => {
    expect(hasLeadingZeroBits(Uint8Array.from([0xff]), 0)).toBe(true);
  });
});

describe("solving", () => {
  it("finds a solution the verifier accepts", () => {
    // Eight bits keeps the unit suite fast; the wiring is the same at sixteen.
    const nonce = "1893456000000.abcdef";
    const solution = solveChallenge(nonce, 8);

    expect(solution).not.toBeNull();
    expect(isSolved(nonce, solution!, 8)).toBe(true);
    expect(digestOf(nonce, solution!)[0]).toBe(0);
  });

  it("binds the work to its own nonce", () => {
    const solution = solveChallenge("first-nonce", 8)!;
    // The whole point: work done once cannot be reused for the next request.
    expect(isSolved("second-nonce", solution, 8)).toBe(false);
  });

  it("gives up rather than looping forever", () => {
    expect(solveChallenge("nonce", 32, 50)).toBeNull();
  });

  it("keeps a difficulty a phone can afford", () => {
    // Sixteen bits is ~65k hashes. If this ever grows, it grows deliberately.
    expect(DEFAULT_DIFFICULTY_BITS).toBe(16);
  });
});
