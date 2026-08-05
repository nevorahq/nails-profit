import { expect } from "vitest";

import { findPostgresError } from "@/lib/db-errors";

/**
 * Asserts on the SQLSTATE and constraint name rather than on the error text.
 *
 * Matching a message would pass for the wrong reason: Drizzle's wrapper says
 * only "Failed query", so `toThrow(/some_constraint/)` never matches and a test
 * written that way fails even when the constraint is doing its job. Worse, the
 * inverse — asserting on a substring that happens to appear — would pass for a
 * completely different failure.
 */
export async function expectDatabaseError(
  action: Promise<unknown>,
  expected: { code: string; constraint?: string },
) {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(
      `expected the query to fail with ${expected.constraint ?? expected.code}, but it succeeded`,
    );
  }

  const pg = findPostgresError(caught);
  expect(pg, `no PostgreSQL error in the cause chain of: ${String(caught)}`).not.toBeNull();
  expect(pg!.code).toBe(expected.code);
  if (expected.constraint) {
    expect(pg!.constraint_name ?? "").toContain(expected.constraint);
  }
}
