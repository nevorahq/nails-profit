import { createHash } from "node:crypto";

/**
 * Whether a database is on the schema this checkout's code reads, epic E3.1.
 *
 * Drizzle's own journal is not enough to say so. `drizzle-kit migrate` asks
 * `drizzle.__drizzle_migrations` for one thing only — the newest `created_at` —
 * and applies every file whose journal `when` is later, all in one
 * transaction. Two ways a real database stops matching that record:
 *
 *   - a migration run by hand in an SQL editor, and never recorded: the next
 *     `db:migrate` replays it, fails on `ADD COLUMN` of a column that exists,
 *     and rolls back everything before it in the same run;
 *   - a row recorded for a newer file while an older one was never run: the
 *     older one is now behind the newest `created_at`, and no `db:migrate` will
 *     ever apply it. The code then fails on the first query that reads its
 *     column — a `Failed query` on the dashboard, nowhere near the cause.
 *
 * So the journal is read against the catalogue as well: what each file creates
 * (tables, their columns, enum types and values), with what later files drop or
 * rename taken off, has to exist for a file marked as applied, and existing for
 * a file that is not is how one run by hand shows itself.
 *
 * Everything here is pure; `db-status.mjs` brings the files and the database.
 */

/** Drizzle's hash of a migration: the sha256 of the file exactly as read. */
export function migrationHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

/** Statements as `drizzle-kit` splits them, with `--` comment lines removed. */
export function statementsOf(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

const NAME = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_]*)`;
const QUALIFIED = String.raw`(?:${NAME}\.)?(${NAME})`;
const unquote = (name) => (name.startsWith('"') ? name.slice(1, -1) : name);

/**
 * What one statement does to the objects this checks, in order.
 *
 * Only the shapes `drizzle-kit generate` writes, and the hand-written ones the
 * folder actually holds; a statement it does not recognise — a policy, an
 * index, a `DO` block — changes nothing here, which makes the check weaker for
 * that file, never wrong about it.
 */
export function effectsOf(statement) {
  const effects = [];
  let match;

  if ((match = statement.match(new RegExp(String.raw`^CREATE TABLE (?:IF NOT EXISTS )?${QUALIFIED}\s*\(`, "i")))) {
    const table = unquote(match[1]);
    effects.push({ op: "add", key: `table:${table}` });
    const body = statement.slice(statement.indexOf("(") + 1, statement.lastIndexOf(")"));
    for (const line of body.split("\n")) {
      const column = line.trim().match(/^"([^"]+)"\s/);
      if (column) effects.push({ op: "add", key: `column:${table}.${column[1]}` });
    }
    return effects;
  }

  if ((match = statement.match(new RegExp(String.raw`^DROP TABLE (?:IF EXISTS )?${QUALIFIED}`, "i")))) {
    return [{ op: "dropTable", table: unquote(match[1]) }];
  }

  if ((match = statement.match(new RegExp(String.raw`^CREATE TYPE ${QUALIFIED} AS ENUM\s*\(([^)]*)\)`, "i")))) {
    const type = unquote(match[1]);
    effects.push({ op: "add", key: `type:${type}` });
    for (const value of match[2].matchAll(/'((?:[^']|'')*)'/g)) {
      effects.push({ op: "add", key: `enum:${type}.${value[1].replaceAll("''", "'")}` });
    }
    return effects;
  }

  if ((match = statement.match(new RegExp(String.raw`^DROP TYPE (?:IF EXISTS )?${QUALIFIED}`, "i")))) {
    return [{ op: "dropType", type: unquote(match[1]) }];
  }

  if ((match = statement.match(new RegExp(String.raw`^ALTER TYPE ${QUALIFIED} ADD VALUE (?:IF NOT EXISTS )?'((?:[^']|'')*)'`, "i")))) {
    return [{ op: "add", key: `enum:${unquote(match[1])}.${match[2].replaceAll("''", "'")}` }];
  }

  if ((match = statement.match(new RegExp(String.raw`^ALTER TABLE (?:ONLY )?${QUALIFIED}\s+(.*)$`, "is")))) {
    const table = unquote(match[1]);
    const action = match[2];
    let column;
    if ((column = action.match(new RegExp(String.raw`^ADD COLUMN (?:IF NOT EXISTS )?(${NAME})`, "i")))) {
      effects.push({ op: "add", key: `column:${table}.${unquote(column[1])}` });
    } else if ((column = action.match(new RegExp(String.raw`^DROP COLUMN (?:IF EXISTS )?(${NAME})`, "i")))) {
      effects.push({ op: "drop", key: `column:${table}.${unquote(column[1])}` });
    } else if ((column = action.match(new RegExp(String.raw`^RENAME COLUMN (${NAME}) TO (${NAME})`, "i")))) {
      effects.push({ op: "drop", key: `column:${table}.${unquote(column[1])}` });
      effects.push({ op: "add", key: `column:${table}.${unquote(column[2])}` });
    }
  }

  return effects;
}

/**
 * The objects each migration is answerable for once the whole folder has run:
 * what it created and no later file dropped. An object recreated later belongs
 * to the later file, so each is checked against exactly one migration.
 *
 * `migrations` are `{ tag, statements }`, in journal order.
 */
export function expectedObjects(migrations) {
  const owner = new Map();
  for (const { tag, statements } of migrations) {
    for (const statement of statements) {
      for (const effect of effectsOf(statement)) {
        if (effect.op === "add") owner.set(effect.key, tag);
        else if (effect.op === "drop") owner.delete(effect.key);
        else if (effect.op === "dropTable") {
          for (const key of [...owner.keys()]) {
            if (key === `table:${effect.table}` || key.startsWith(`column:${effect.table}.`)) owner.delete(key);
          }
        } else if (effect.op === "dropType") {
          for (const key of [...owner.keys()]) {
            if (key === `type:${effect.type}` || key.startsWith(`enum:${effect.type}.`)) owner.delete(key);
          }
        }
      }
    }
  }

  const byTag = new Map(migrations.map(({ tag }) => [tag, []]));
  for (const [key, tag] of owner) byTag.get(tag).push(key);
  return byTag;
}

/**
 * The verdict on every file and every recorded row.
 *
 * `entries` are journal entries with the file's hash and expected objects
 * (`{ idx, tag, when, hash, objects }`); `applied` the migrations table's rows
 * (`{ id, hash, created_at }`); `present` the keys the catalogue holds.
 *
 * Statuses, and what each means for `db:migrate`:
 *   applied       recorded, and what it created is there;
 *   edited        recorded, but the file has changed since — applied
 *                 migrations are not to be edited;
 *   missing       recorded, but objects it created are gone;
 *   pending       not recorded and newer than the newest row: `db:migrate`
 *                 applies it;
 *   hand-applied  pending by the record, yet everything it creates exists:
 *                 `db:migrate` would fail on it and roll back its whole run;
 *   partial       pending by the record, and some of what it creates exists;
 *   skipped       not recorded and older than the newest row: `db:migrate`
 *                 will never apply it.
 */
export function assess(entries, applied, present) {
  const newest = applied.reduce((max, row) => Math.max(max, Number(row.created_at)), -Infinity);
  const byCreatedAt = new Map(applied.map((row) => [Number(row.created_at), row]));

  const migrations = entries.map((entry) => {
    const row = byCreatedAt.get(entry.when);
    const missing = entry.objects.filter((key) => !present.has(key));
    const found = entry.objects.length - missing.length;
    const base = { idx: entry.idx, tag: entry.tag, when: entry.when, hash: entry.hash, objects: entry.objects.length, missing };

    if (row) {
      if (missing.length > 0) return { ...base, status: "missing" };
      if (row.hash !== entry.hash) return { ...base, status: "edited" };
      return { ...base, status: "applied" };
    }
    if (entry.when <= newest) return { ...base, status: "skipped" };
    if (entry.objects.length > 0 && missing.length === 0) return { ...base, status: "hand-applied" };
    if (found > 0) return { ...base, status: "partial" };
    return { ...base, status: "pending" };
  });

  const known = new Set(entries.map((entry) => entry.when));
  const unknown = applied.filter((row) => !known.has(Number(row.created_at)));

  return { migrations, unknown, verdict: verdictOf(migrations, unknown) };
}

/**
 * `ok`: nothing to do. `pending`: `db:migrate` brings the database up to date
 * on its own. `broken`: it would not, or it already disagrees with the record,
 * and a person has to look before anything runs.
 */
function verdictOf(migrations, unknown) {
  if (unknown.length > 0 || migrations.some((migration) => !["applied", "pending"].includes(migration.status))) {
    return "broken";
  }
  return migrations.some((migration) => migration.status === "pending") ? "pending" : "ok";
}

export const EXIT_CODES = { ok: 0, broken: 1, pending: 2 };

const ADVICE = {
  edited:
    "the file changed after it was applied (line endings count). Restore it from git; a change goes in a new migration.",
  missing: "recorded as applied, but what it created is not there. Do not run db:migrate until this is understood.",
  "hand-applied":
    "everything it creates already exists, but it is not recorded. db:migrate would fail here and roll back its whole run. " +
    "If the whole file was run, record it:",
  partial: "part of it exists, none of it is recorded: it was run in part by hand. Finish or undo it by hand first.",
  skipped:
    "not recorded, and older than the newest recorded migration: db:migrate will never apply it.",
};

const recordStatement = (migration) =>
  `insert into drizzle.__drizzle_migrations (hash, created_at) values ('${migration.hash}', ${migration.when});`;

/** The report a person reads; lines, so the caller decides where they go. */
export function formatReport({ migrations, unknown, verdict }) {
  const lines = [];
  const counts = new Map();
  for (const migration of migrations) counts.set(migration.status, (counts.get(migration.status) ?? 0) + 1);

  for (const migration of migrations) {
    if (migration.status === "applied") continue;
    lines.push(`${migration.status.padEnd(12)} ${migration.tag}`);
    if (migration.missing.length > 0 && migration.status !== "pending") {
      lines.push(`             absent: ${migration.missing.join(", ")}`);
    }
    if (ADVICE[migration.status]) lines.push(`             ${ADVICE[migration.status]}`);
    if (migration.status === "hand-applied") lines.push(`             ${recordStatement(migration)}`);
    if (migration.status === "skipped") {
      lines.push(
        migration.objects > 0 && migration.missing.length === 0
          ? `             Its objects exist; if the whole file was run, record it: ${recordStatement(migration)}`
          : `             Run drizzle/${migration.tag}.sql by hand, then record it: ${recordStatement(migration)}`,
      );
    }
  }

  for (const row of unknown) {
    lines.push(
      `unknown      row ${row.id} (created_at ${row.created_at}) is in the database but not in this checkout's journal: ` +
        "the database is ahead of this code.",
    );
  }

  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
  lines.push("", `${migrations.length} migrations: ${summary}.`);

  const hasPendingBeforeHandApplied = migrations.some(
    (migration, index) =>
      migration.status === "hand-applied" && migrations.slice(0, index).some((earlier) => earlier.status === "pending"),
  );
  if (verdict === "ok") lines.push("Up to date: the database has the schema this checkout reads.");
  if (verdict === "pending") lines.push("Behind: npm run db:migrate applies the pending migrations, in order.");
  if (verdict === "broken") {
    lines.push("Not consistent: db:migrate cannot fix this on its own. Nothing was changed.");
    if (hasPendingBeforeHandApplied) {
      lines.push(
        "A pending migration comes before one applied by hand: run the pending files by hand in order, then record every one of them — " +
          "a row for the hand-applied file alone would turn the earlier ones into skipped.",
      );
    }
  }
  return lines;
}
