import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Roadmap section 7.11: "Все новые public и calendar routes закрыты feature
 * flags до прохождения security и concurrency gates."
 *
 * That is a claim about every route, and the end-to-end suite can only make it
 * about the routes somebody remembered to write a case for. The failure is not
 * a wrong gate, it is a missing one: the next endpoint is added next to eleven
 * that all have the check, and nothing at all goes red when it does not. So
 * this reads the import graph instead — from each route file, follow the local
 * imports and require that a module which actually consults
 * `organizations.booking_access` is reachable.
 *
 * Reachability rather than a literal call, because the gate is genuinely three
 * modules deep on the public side: a route asks for a catalogue, the catalogue
 * loader asks for the organization, and that resolver is the only place the
 * level is compared. Insisting the handler name the guard itself would force
 * the check to be re-stated where it is not needed and would still not prove it
 * runs.
 *
 * What this cannot see is a handler that imports the gate and forgets to call
 * it. `tests/e2e/booking-rollout.test.ts` covers that from the outside, on the
 * levels themselves; this covers the file nobody wrote a case for.
 */
const API_ROOT = join("app", "api", "v1");

/**
 * The modules that read the level. Named rather than detected, so that adding a
 * fourth is a decision someone makes on purpose — and each is checked below to
 * still be doing the job, so the list cannot quietly become decoration.
 */
const GATE_MODULES = [
  // Calendar routes: `off` refuses writes and lets reads through.
  join("lib", "booking-http.ts"),
  // Public page: only `public` resolves an organization at all.
  join("lib", "public-booking.ts"),
  // A client's own manage link, which dies with the page it was issued from.
  join("lib", "public-booking-access.ts"),
];

/**
 * Where section 7.11's "public и calendar routes" live. Rotas, locations and a
 * location's booking settings are calendar routes even though the path does not
 * say `booking`: they decide what the module offers, so a module that is off
 * cannot keep taking edits to them.
 */
const BOOKING_SURFACE = [
  join(API_ROOT, "bookings"),
  join(API_ROOT, "availability"),
  join(API_ROOT, "locations"),
  join(API_ROOT, "public", "booking"),
  join(API_ROOT, "public", "bookings"),
  join(API_ROOT, "specialists", "[id]", "locations"),
  // The topbar's notification list: pending_confirmation bookings, read-only.
  join(API_ROOT, "notifications"),
];

/** Tables that belong to the booking module and to nothing else. */
const BOOKING_TABLES = [
  "bookings",
  "bookingLines",
  "bookingHolds",
  "bookingSettings",
  "bookingAccessTokens",
  "bookingVerifications",
  "bookingIdempotencyKeys",
  "scheduleRules",
  "availabilityExceptions",
  "locations",
  "specialistLocations",
  "workplaces",
];

/**
 * A route may touch booking rows and still not belong behind the flag. Erasing
 * a client is the case that exists: section 7.9 owes a person the removal of
 * their data whatever level the studio's booking module is on, and a switch
 * that also switches off a legal obligation would be the wrong switch.
 */
const OUTSIDE_THE_FLAG = [
  join(API_ROOT, "clients", "[id]", "route.ts"),
  /*
   * Removing a master is a team operation, not a booking one. Gating it would
   * mean a studio that switched the booking module off could no longer fix a
   * master entered with a typo — the same shape of wrong switch as above.
   *
   * It reaches booking tables only for a master who has none of their rows
   * that matter: the handler counts `booking` first and archives instead of
   * deleting the moment it finds one, so what it clears is the rota, the
   * assignments and any standing hold of somebody who never took an
   * appointment. Every one of those is `ON DELETE restrict`, which is why the
   * route has to name them rather than leave it to a cascade.
   */
  join(API_ROOT, "specialists", "[id]", "route.ts"),
];

function routeFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return specifiers;
}

/** `@/lib/x` is this repository's own alias; anything else is not ours to walk. */
function resolveLocal(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = specifier.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const local = resolveLocal(specifier);
      if (local && !seen.has(local)) queue.push(local);
    }
  }

  return seen;
}

/** Named imports pulled straight from the schema by the handler itself. */
function schemaImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@/db/schema" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        names.push(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return names;
}

const allRoutes = routeFiles(API_ROOT);
const surfaceRoutes = allRoutes.filter((file) =>
  BOOKING_SURFACE.some((directory) => file.startsWith(directory + "/")),
);

describe("the rollout flag", () => {
  it("is read by every module this file trusts to read it", () => {
    // Otherwise the list above becomes a way of passing rather than a way of
    // checking: a module renamed or emptied would keep vouching for the routes
    // that import it.
    for (const gate of GATE_MODULES) {
      expect(readFileSync(gate, "utf8")).toContain("bookingAccess");
    }
  });

  it("covers every public and calendar route", () => {
    // The surface is not empty for a reason that is easy to lose: a typo in a
    // directory name above would silence the whole check.
    expect(surfaceRoutes.length).toBeGreaterThanOrEqual(20);

    const ungated = surfaceRoutes.filter((route) => {
      const closure = importClosure(route);
      return !GATE_MODULES.some((gate) => closure.has(gate));
    });

    expect(ungated).toEqual([]);
  });

  it("has no route touching booking data from outside that surface", () => {
    // The other half of the same claim. A new endpoint that reads or writes
    // booking rows from some other path is either part of the module — and
    // belongs behind the flag — or is a deliberate exception like erasure.
    const stray = allRoutes
      .filter((route) => !surfaceRoutes.includes(route))
      .filter((route) => !OUTSIDE_THE_FLAG.includes(route))
      .filter((route) => schemaImports(route).some((name) => BOOKING_TABLES.includes(name)));

    expect(stray).toEqual([]);
  });
});
