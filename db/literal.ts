import { sql, type SQL } from "drizzle-orm";

/**
 * Values written into a statement's text instead of sent beside it, for the
 * few shapes that cannot carry anything but themselves.
 *
 * Why: the driver runs with `prepare: false`, because the pooler in front of
 * the production database does not keep prepared statements, and in that mode
 * a statement with even one parameter costs two round trips — the driver asks
 * the server what type each parameter is, waits, then sends the value. Worse,
 * it stops pipelining while it waits, so the statements queued behind it wait
 * too. A statement with no parameters is one round trip, and several of them
 * started together inside one transaction go down the wire as one flight. The
 * database is in another region from the functions, so on a page that reads
 * twenty things this is the difference between seconds and a fraction of one.
 *
 * Why it is safe: every function here accepts one exact shape, checked with an
 * anchored pattern whose alphabet has no quote, backslash or whitespace, and
 * throws on anything else. Nothing that passes can close the quote it sits in.
 * `withTenant` has written the organization id into its `set_config` this way
 * since October; this module is the same rule, given a name so it is not
 * re-derived in each query that wants it.
 *
 * What it is not for: anything a person typed. Names, notes, phone numbers,
 * search text — those stay parameters, whatever they cost.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** An enum label or other constant from the code: lower-case words and underscores. */
const CONSTANT = /^[a-z][a-z0-9_]*$/;
/** A Better Auth id: letters, digits, `-` and `_`. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function checked(value: string, shape: RegExp, what: string): string {
  if (!shape.test(value)) throw new Error(`Refusing to inline ${what}: it does not have the expected shape`);
  return value;
}

/** Whether a value from outside — a path segment, a query string — is shaped like a row id. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A row id. */
export function uuidLiteral(id: string): SQL {
  return sql.raw(`'${checked(id, UUID, "a uuid")}'`);
}

/** An id that is not a uuid but has a fixed alphabet, such as a Better Auth user id. */
export function opaqueIdLiteral(id: string): SQL {
  return sql.raw(`'${checked(id, OPAQUE_ID, "an id")}'`);
}

/** A calendar day, `YYYY-MM-DD`, for a `date` column. */
export function dayLiteral(day: string): SQL {
  return sql.raw(`'${checked(day, DAY, "a day")}'`);
}

/** A moment, for a `timestamp with time zone` column. */
export function instantLiteral(at: Date): SQL {
  if (Number.isNaN(at.getTime())) throw new Error("Refusing to inline an invalid date");
  return sql.raw(`'${checked(at.toISOString(), INSTANT, "a moment")}'`);
}

/** A constant the code itself names: an enum label, a kind. */
export function constantLiteral(value: string): SQL {
  return sql.raw(`'${checked(value, CONSTANT, "a constant")}'`);
}

/**
 * Several row ids, for `inArray(column, uuidListLiteral(ids))`: renders as
 * `('…', '…')`. An empty list would be a syntax error, so it is refused — the
 * callers already skip the query when there is nothing to ask about.
 */
export function uuidListLiteral(ids: readonly string[]): SQL {
  if (ids.length === 0) throw new Error("Refusing to inline an empty list");
  return sql`(${sql.join(ids.map(uuidLiteral), sql`, `)})`;
}

/** Several constants, for `inArray(column, constantListLiteral(values))`. */
export function constantListLiteral(values: readonly string[]): SQL {
  if (values.length === 0) throw new Error("Refusing to inline an empty list");
  return sql`(${sql.join(values.map(constantLiteral), sql`, `)})`;
}
