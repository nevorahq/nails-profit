/**
 * The decisions behind `purge-organizations.mjs`, kept apart from the database
 * so they can be tested without one.
 *
 * The application deletes an organization by anonymizing it: section 15.3 keeps
 * the financial record while erasing who it was about, and the forty-one tables
 * that reference `organization` with ON DELETE RESTRICT exist to make that the
 * only possible outcome. That is right for a studio that leaves, and wrong for
 * a database being re-tested from registration, where the leftover row still
 * holds the slug and the owner's address is still taken. This is the other
 * door — physical deletion — and it is deliberately not reachable from the
 * product.
 */

/** A database name that ends in `_test`, which is the only one this targets by default. */
export function isTestDatabase(url) {
  try {
    return new URL(url).pathname.endsWith("_test");
  } catch {
    return false;
  }
}

export function databaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the flags mean, and the two that are missing on purpose.
 *
 * Nothing is written without `--apply`: the default run does the whole delete
 * inside a transaction and rolls it back, so the counts it prints are the real
 * ones rather than an estimate that could still meet a constraint on the day it
 * matters.
 *
 * `--prod` does not merely pick a different URL, it also demands the database's
 * own name back through `--confirm-database`. `.env` on this checkout points at
 * production and `drizzle-kit` loads it after the shell, which is the trap
 * `drizzle.test.config.ts` was written about: "I exported the test URL first"
 * has already proven not to be a guarantee here.
 */
export function parseOptions(argv) {
  const options = {
    scope: "deleted",
    organizationIds: [],
    apply: false,
    production: false,
    users: false,
    orphanUsers: false,
    confirmDatabase: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--prod") options.production = true;
    else if (argument === "--users") options.users = true;
    else if (argument === "--orphan-users") options.orphanUsers = true;
    else if (argument === "--deleted") options.scope = "deleted";
    else if (argument === "--all") options.scope = "all";
    else if (argument === "--org") {
      const value = argv[index + 1];
      if (!value || !UUID.test(value)) return { error: `--org needs an organization uuid, got ${value ?? "nothing"}` };
      options.organizationIds.push(value);
      options.scope = "ids";
      index += 1;
    } else if (argument.startsWith("--org=")) {
      const value = argument.slice("--org=".length);
      if (!UUID.test(value)) return { error: `--org needs an organization uuid, got ${value}` };
      options.organizationIds.push(value);
      options.scope = "ids";
    } else if (argument.startsWith("--confirm-database=")) {
      options.confirmDatabase = argument.slice("--confirm-database=".length);
    } else {
      return { error: `Unknown argument: ${argument}` };
    }
  }

  return { options };
}

/**
 * Which URL to read and whether this is allowed to run against it at all.
 *
 * A separate variable per target rather than one that the caller redirects,
 * for the reason `scripts/migrate-down.mjs` gives: on a checkout whose `.env`
 * is production, an override in the shell is not proof of anything.
 */
export function resolveTarget(env, options) {
  if (options.production) {
    const url = env.MIGRATION_DATABASE_URL;
    if (!url) return { error: "Set MIGRATION_DATABASE_URL: --prod deletes rows across every organization." };

    const name = databaseName(url);
    if (options.confirmDatabase !== name) {
      return {
        error:
          `--prod deletes financial history that the application refuses to delete. ` +
          `Retype the database name to confirm: --confirm-database=${name}`,
      };
    }
    return { url, variable: "MIGRATION_DATABASE_URL" };
  }

  const url = env.TEST_MIGRATION_DATABASE_URL;
  if (!url) {
    return {
      error:
        "Set TEST_MIGRATION_DATABASE_URL. This script targets the destructive test database; " +
        "pass --prod (and --confirm-database) if production is really what you mean.",
    };
  }
  if (!isTestDatabase(url)) {
    return { error: `Refusing to purge ${databaseName(url)}: without --prod the database name must end in _test.` };
  }
  return { url, variable: "TEST_MIGRATION_DATABASE_URL" };
}

/**
 * The order the deletes have to go in, computed from the live catalogue rather
 * than written down.
 *
 * `tests/helpers/database.ts` keeps a hand-ordered list and a test that fails
 * when the schema drifts past it. A second copy here would be a second thing to
 * forget: a migration that adds a tenant table would leave this script deleting
 * in an order that no longer works, and the failure would arrive as a foreign
 * key error nobody could read. So the graph is read from `pg_constraint` at run
 * time — a table is ready once everything that references it has already gone.
 *
 * Self-references are dropped from the graph: a row pointing at its own table
 * cannot be ordered around, and the single delete statement settles it.
 */
export function deleteOrder(tables, foreignKeys) {
  const known = new Set(tables);
  const dependents = new Map(tables.map((table) => [table, new Set()]));

  for (const { child, parent } of foreignKeys) {
    if (child === parent) continue;
    if (!known.has(child) || !known.has(parent)) continue;
    dependents.get(parent).add(child);
  }

  const order = [];
  const remaining = new Set(tables);

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) => [...dependents.get(table)].every((child) => !remaining.has(child)))
      .sort();

    // A cycle of non-nullable references cannot be deleted in any order. It
    // does not exist in this schema today; if a migration introduces one, this
    // says which tables rather than letting Postgres refuse one row at a time.
    if (ready.length === 0) return { order, cycle: [...remaining].sort() };

    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }

  return { order, cycle: [] };
}

/** The report, with the tables nothing was deleted from left out of it. */
export function formatCounts(counts) {
  const touched = Object.entries(counts).filter(([, rows]) => rows > 0);
  if (touched.length === 0) return "  (nothing)";

  const width = Math.max(...touched.map(([table]) => table.length));
  return touched
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([table, rows]) => `  ${table.padEnd(width)}  ${String(rows).padStart(6)}`)
    .join("\n");
}

/** «1 account», «2 accounts» — the report is read by somebody deciding whether to run it again. */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export const USAGE = `Physically deletes organizations the application can only anonymize.

  node scripts/purge-organizations.mjs [--deleted | --all | --org <uuid>]
                                       [--users] [--orphan-users] [--apply]

  --deleted     organizations already marked deleted_at (default)
  --all         every organization in the database
  --org <uuid>  one organization; repeat the flag for several
  --users       also delete the people this purge leaves with no membership,
                which is what frees the address for registering again
  --orphan-users
                delete every account with no membership at all, including ones
                this purge never touched — a registration that never reached
                the first studio looks exactly like an owner who has left
  --apply       actually delete; without it the whole run is rolled back
  --prod        target MIGRATION_DATABASE_URL instead of the _test database,
                which also requires --confirm-database=<name>
`;
