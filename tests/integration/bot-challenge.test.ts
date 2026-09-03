import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_DIFFICULTY_BITS, solveChallenge } from "@/domain/proof-of-work";
import {
  challengeRequired,
  issueChallenge,
  recordSuspiciousActivity,
  resetBotChallenges,
  verifyChallenge,
} from "@/lib/bot-challenge";
import { closeTestConnections } from "../helpers/database";

const caller = "ip:198.51.100.9";

/** A nonce for `caller`, and the work that answers it. */
function solved(key = caller) {
  const challenge = issueChallenge(key);
  const solution = solveChallenge(challenge.nonce, DEFAULT_DIFFICULTY_BITS);
  if (!solution) throw new Error("the challenge went unsolved, which 16 bits should never do");
  return { nonce: challenge.nonce, header: `${challenge.nonce}:${solution}` };
}

/**
 * The state behind roadmap section 7.9, and the half of it that used to live in
 * the process. Both properties asserted here are invisible in a single-instance
 * test — which is exactly how they survived so long on a deployment that runs
 * several.
 */
describe("bot challenge state", () => {
  beforeEach(async () => {
    await resetBotChallenges();
  });

  afterAll(async () => {
    await resetBotChallenges();
    await closeTestConnections();
  });

  test("nothing is challenged before the threshold", async () => {
    for (let index = 0; index < 9; index += 1) await recordSuspiciousActivity(caller);
    expect(await challengeRequired(caller)).toBe(false);

    await recordSuspiciousActivity(caller);
    expect(await challengeRequired(caller)).toBe(true);
  });

  test("suspicion belongs to the caller, not to the caller and the endpoint", async () => {
    for (let index = 0; index < 10; index += 1) await recordSuspiciousActivity(caller);

    expect(await challengeRequired(caller)).toBe(true);
    expect(await challengeRequired("ip:203.0.113.4")).toBe(false);
  });

  /**
   * Ten refusals used to mean ten *per lambda*, so a caller spreading itself
   * over instances was never challenged at all while an unlucky client could be.
   * Reloading the module is the nearest thing in one process to a second
   * instance: new module state, same database.
   */
  test("a second instance sees the suspicion the first one recorded", async () => {
    for (let index = 0; index < 10; index += 1) await recordSuspiciousActivity(caller);

    vi.resetModules();
    const fresh = await import("@/lib/bot-challenge");

    expect(await fresh.challengeRequired(caller)).toBe(true);
  });

  test("a solved proof of work is accepted once and only once", async () => {
    const { header } = solved();

    expect(await verifyChallenge(caller, header)).toBe("ok");
    expect(await verifyChallenge(caller, header)).toBe("spent");
  });

  /** The replay the per-process set allowed: once more on every other instance. */
  test("a spent proof stays spent for a second instance", async () => {
    const { header } = solved();
    expect(await verifyChallenge(caller, header)).toBe("ok");

    vi.resetModules();
    const fresh = await import("@/lib/bot-challenge");

    expect(await fresh.verifyChallenge(caller, header)).toBe("spent");
  });

  /** Two copies arriving together: a read-then-write claim would pass both. */
  test("simultaneous replays of one proof produce a single acceptance", async () => {
    const { header } = solved();

    const verdicts = await Promise.all(
      Array.from({ length: 4 }, () => verifyChallenge(caller, header)),
    );

    expect(verdicts.filter((verdict) => verdict === "ok")).toHaveLength(1);
    expect(verdicts.filter((verdict) => verdict === "spent")).toHaveLength(3);
  });

  test("a wrong answer costs the work, not the nonce", async () => {
    const { nonce, header } = solved();

    // The proof is checked before the nonce is claimed, so a client that
    // miscounts can still submit the right answer for the same challenge.
    expect(await verifyChallenge(caller, `${nonce}:not-the-answer`)).toBe("unsolved");
    expect(await verifyChallenge(caller, header)).toBe("ok");
  });

  test("a proof is bound to the caller it was issued to", async () => {
    const { header } = solved();

    expect(await verifyChallenge("ip:203.0.113.4", header)).toBe("invalid");
    // And the nonce is still unspent for the caller it belongs to.
    expect(await verifyChallenge(caller, header)).toBe("ok");
  });
});
