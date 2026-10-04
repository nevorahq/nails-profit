import { describe, expect, it } from "vitest";

import { databaseNameOf, describeTarget, isLocalTarget, parseOptions, refusalsFor } from "./db-migrate-core.mjs";

const PRODUCTION = "postgres://postgres.ref:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres";
const LOCAL = "postgres://nail_profit:x@localhost:55432/nail_profit";

const CLEAN = { available: true, dirty: [], unmerged: [], mainRef: true };
const NONE = parseOptions([]);

describe("the target", () => {
  it("is described without its credentials", () => {
    expect(describeTarget(PRODUCTION)).toBe("aws-1-eu-west-1.pooler.supabase.com:5432/postgres");
    expect(databaseNameOf(PRODUCTION)).toBe("postgres");
  });

  it("is local only on this machine's own addresses", () => {
    expect(isLocalTarget(LOCAL)).toBe(true);
    expect(isLocalTarget("postgres://u:p@127.0.0.1:5432/x")).toBe(true);
    expect(isLocalTarget("postgres://u:p@[::1]:5432/x")).toBe(true);
    expect(isLocalTarget(PRODUCTION)).toBe(false);
  });
});

describe("a run against a remote database", () => {
  it("goes ahead from a clean checkout of main", () => {
    expect(refusalsFor({ url: PRODUCTION, git: CLEAN, verdict: "pending", options: NONE })).toEqual([]);
  });

  it("refuses a migration file nobody has committed", () => {
    // The draft of 0057 that reached production was exactly this.
    const [refusal] = refusalsFor({
      url: PRODUCTION,
      git: { ...CLEAN, dirty: ["?? drizzle/0060_draft.sql", " M drizzle/meta/_journal.json"] },
      verdict: "pending",
      options: NONE,
    });
    expect(refusal).toContain("uncommitted changes");
    expect(refusal).toContain("drizzle/0060_draft.sql");
  });

  it("refuses migrations committed on a branch but not on main", () => {
    const [refusal] = refusalsFor({
      url: PRODUCTION,
      git: { ...CLEAN, unmerged: ["A\tdrizzle/0060_draft.sql"] },
      verdict: "pending",
      options: NONE,
    });
    expect(refusal).toContain("differs from origin/main");
  });

  it("refuses when there is no main to compare with, or no git at all", () => {
    expect(
      refusalsFor({ url: PRODUCTION, git: { ...CLEAN, mainRef: false }, verdict: "pending", options: NONE })[0],
    ).toContain("no origin/main");
    expect(
      refusalsFor({ url: PRODUCTION, git: { available: false, dirty: [], unmerged: [], mainRef: false }, verdict: "pending", options: NONE })[0],
    ).toContain("Not a git checkout");
  });

  it("waives the checkout checks only for the database named", () => {
    const git = { ...CLEAN, dirty: ["?? drizzle/0060_draft.sql"] };
    expect(
      refusalsFor({ url: PRODUCTION, git, verdict: "pending", options: parseOptions(["--allow-unmerged", "--confirm-database=postgres"]) }),
    ).toEqual([]);

    const wrong = refusalsFor({
      url: PRODUCTION,
      git,
      verdict: "pending",
      options: parseOptions(["--allow-unmerged", "--confirm-database=nail_profit"]),
    });
    expect(wrong[0]).toContain("--confirm-database=postgres");
    expect(wrong).toHaveLength(2);
  });
});

describe("a database db:status calls broken", () => {
  it("is refused anywhere, waiver or not", () => {
    for (const url of [PRODUCTION, LOCAL]) {
      const refusals = refusalsFor({
        url,
        git: CLEAN,
        verdict: "broken",
        options: parseOptions(["--allow-unmerged", `--confirm-database=${databaseNameOf(url)}`]),
      });
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("inconsistent");
    }
  });
});

describe("a local database", () => {
  it("keeps the generate-and-try loop", () => {
    const git = { ...CLEAN, dirty: ["?? drizzle/0060_draft.sql"], unmerged: ["A\tdrizzle/0060_draft.sql"] };
    expect(refusalsFor({ url: LOCAL, git, verdict: "pending", options: NONE })).toEqual([]);
  });
});
