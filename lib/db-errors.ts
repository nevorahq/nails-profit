/**
 * Drizzle wraps driver failures in a generic "Failed query" Error and hangs the
 * real PostgresError off `cause`. Anything that wants the SQLSTATE has to walk
 * the chain — reading `error.message` finds only the wrapper, which is how a
 * duplicate invitation once turned into a 500 instead of a 409.
 */
export type PostgresErrorLike = {
  code?: string;
  constraint_name?: string;
  detail?: string;
  message?: string;
};

/** SQLSTATE codes worth naming. */
export const PG_ERROR = {
  notNull: "23502",
  foreignKey: "23503",
  unique: "23505",
  check: "23514",
  insufficientPrivilege: "42501",
} as const;

export function findPostgresError(error: unknown): PostgresErrorLike | null {
  for (let current = error; current != null; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== "object") break;
    const candidate = current as PostgresErrorLike;
    if (typeof candidate.code === "string") return candidate;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = findPostgresError(error);
  if (pg?.code !== PG_ERROR.unique) return false;
  return constraint === undefined || (pg.constraint_name ?? "").includes(constraint);
}
