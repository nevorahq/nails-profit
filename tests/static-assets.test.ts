import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every root-relative asset a component asks for exists, and is committed.
 *
 * Written after the landing page shipped with `<Image src="/images/…">` while
 * `public/` existed on one laptop and in no commit. Locally the file was on
 * disk and the page looked finished; production builds from the repository, so
 * it served nothing, and the failure was invisible to everyone who had the file
 * — which is to say, to the person who added it.
 *
 * Two assertions rather than one, because the bug needs both to be caught. On
 * disk is what a developer checks by looking at the page. Tracked by git is
 * what a deploy actually gets, and it is the half that was missing.
 *
 * Source text rather than a render: these are string literals in JSX, and the
 * property under test is of the source, exactly as in `accessibility.test.ts`.
 */
const SOURCE_ROOTS = ["components", "app"];

/** `src="/images/hero.png"`, `poster="/video/still.jpg"` — root-relative only. */
const ASSET_REFERENCE = /\b(?:src|poster)=["'](\/[^"'{}]+\.[a-z0-9]{2,5})["']/gi;

/**
 * Paths Next.js answers itself rather than reading out of `public/`: its own
 * build output, and the endpoints this application serves as routes.
 */
const SERVED_BY_THE_APP = [/^\/_next\//, /^\/api\//];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) found.push(full);
  }
  return found;
}

type Reference = Readonly<{ file: string; path: string }>;

const references: Reference[] = SOURCE_ROOTS.flatMap((root) => sourceFiles(root)).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(ASSET_REFERENCE)]
    .map((match) => ({ file, path: match[1] }))
    .filter((reference) => !SERVED_BY_THE_APP.some((pattern) => pattern.test(reference.path)));
});

/** What `git ls-files` knows about — the only thing a deploy will have. */
const tracked = new Set(
  execFileSync("git", ["ls-files", "public"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);

describe("static assets referenced by the interface", () => {
  it("finds at least one to check, so a broken matcher cannot pass silently", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it("all exist under public/", () => {
    const missing = references
      .filter((reference) => !existsSync(join("public", reference.path)))
      .map((reference) => `${reference.path} (${reference.file})`);

    expect(missing).toEqual([]);
  });

  it("are all tracked by git, or the deploy gets a page without them", () => {
    const untracked = references
      .filter((reference) => !tracked.has(`public${reference.path}`))
      .map((reference) => `${reference.path} (${reference.file})`);

    expect(untracked).toEqual([]);
  });
});
