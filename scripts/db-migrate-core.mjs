/**
 * When `npm run db:migrate` refuses to run, epic E3.1.
 *
 * `.env` on a working checkout points at production, so a plain `db:migrate`
 * there is a production migration — including one run straight after
 * `db:generate`, from a file nobody has reviewed. That is how a draft of 0057
 * reached production: applied from a branch, regenerated afterwards under a
 * new timestamp, and left behind as a journal row no checkout knows, with half
 * its columns. `db:migrate` could not undo it and failed on every run after.
 *
 * So, against any database that is not on this machine, a run needs:
 *
 *   - no uncommitted change under `drizzle/` — a file being written is not a
 *     migration yet;
 *   - `drizzle/` exactly as on `origin/main` — reviewed, merged, and the same
 *     bytes every other checkout will hash;
 *   - a database `db:status` does not call broken, because drizzle cannot fix
 *     that state and would only fail half way or, worse, skip a file.
 *
 * A local database keeps the old loop of generate-and-try. The first two can be
 * waived for one named database — an emergency fix that cannot wait for a
 * merge — the third cannot.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `host/database` of a URL, for messages, without its credentials. */
export function describeTarget(url) {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
}

export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

export function isLocalTarget(url) {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/** `--allow-unmerged --confirm-database=<name>`, the waiver for one database. */
export function parseOptions(argv) {
  const confirm = argv.find((arg) => arg.startsWith("--confirm-database="));
  return {
    allowUnmerged: argv.includes("--allow-unmerged"),
    confirmDatabase: confirm ? confirm.slice("--confirm-database=".length) : null,
  };
}

/**
 * The refusals for one run, empty when it may go ahead.
 *
 * `git` is what the CLI found: `{ available, dirty, unmerged, mainRef }` —
 * the `git status --porcelain` lines and `git diff --name-status` lines under
 * `drizzle/`, and whether `origin/main` exists at all. `verdict` is
 * `db:status`'s.
 */
export function refusalsFor({ url, git, verdict, options }) {
  const refusals = [];
  const name = databaseNameOf(url);

  if (verdict === "broken") {
    refusals.push(
      "db:status calls this database inconsistent with drizzle/: db:migrate would fail on it or skip a file. " +
        "Run npm run db:status and repair what it lists first.",
    );
  }

  if (isLocalTarget(url)) return refusals;

  const waived = options.allowUnmerged && options.confirmDatabase === name;
  if (options.allowUnmerged && !waived) {
    refusals.push(`--allow-unmerged needs --confirm-database=${name}: retype the name of the database it waives the checks for.`);
  }
  if (waived) return refusals;

  if (!git.available) {
    refusals.push("Not a git checkout, so nothing proves drizzle/ is the merged one. Migrate from a checkout of main.");
    return refusals;
  }
  if (git.dirty.length > 0) {
    refusals.push(
      ["drizzle/ has uncommitted changes — not a migration anyone has reviewed yet:", ...git.dirty.map((line) => `  ${line}`)].join("\n"),
    );
  }
  if (!git.mainRef) {
    refusals.push("There is no origin/main to compare drizzle/ with: git fetch origin main.");
  } else if (git.unmerged.length > 0) {
    refusals.push(
      [
        "drizzle/ differs from origin/main — a migration not merged yet, or a checkout behind main:",
        ...git.unmerged.map((line) => `  ${line}`),
        "Merge it, or git pull, and migrate from main.",
      ].join("\n"),
    );
  }
  return refusals;
}
