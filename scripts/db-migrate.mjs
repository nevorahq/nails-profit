#!/usr/bin/env node

/**
 * `npm run db:migrate` — `drizzle-kit migrate`, after the checks in
 * `db-migrate-core.mjs` say this checkout may migrate this database.
 *
 * The URL is resolved the way `drizzle.config.ts` resolves it, and the shell
 * wins over `.env` in both: `process.loadEnvFile` and drizzle-kit's dotenv
 * fill in only what the shell has not set. The checks and the run therefore
 * look at the same database.
 *
 *   npm run db:migrate
 *   npm run db:migrate -- --allow-unmerged --confirm-database=<name>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describeTarget, parseOptions, refusalsFor } from "./db-migrate-core.mjs";
import { databaseStatus } from "./db-status.mjs";
import { formatReport } from "./db-status-core.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const lines = (output) => output.split("\n").filter(Boolean);

function readGit() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { available: false, dirty: [], unmerged: [], mainRef: false };
  }
  try {
    // Fresh, so "merged" means merged now; offline, the last fetch is the answer.
    git(["fetch", "--quiet", "origin", "main"]);
  } catch {
    console.warn("Could not fetch origin/main; comparing with the last one fetched.");
  }
  let mainRef = true;
  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"]);
  } catch {
    mainRef = false;
  }
  return {
    available: true,
    dirty: lines(git(["status", "--porcelain", "--untracked-files=all", "--", "drizzle"])),
    unmerged: mainRef ? lines(git(["diff", "--name-status", "origin/main", "--", "drizzle"])) : [],
    mainRef,
  };
}

async function main() {
  const variable = ["MIGRATION_DATABASE_URL", "DATABASE_URL"].find((name) => process.env[name]?.trim());
  if (!variable) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL.");
  const url = process.env[variable];
  console.log(`${variable} → ${describeTarget(url)}`);

  const status = await databaseStatus(url, variable);
  const refusals = refusalsFor({ url, git: readGit(), verdict: status.verdict, options: parseOptions(process.argv.slice(2)) });

  if (refusals.length > 0) {
    if (status.verdict === "broken") for (const line of formatReport(status)) console.error(line);
    console.error(`\nNot migrating ${describeTarget(url)}:\n`);
    for (const refusal of refusals) console.error(`- ${refusal}\n`);
    process.exitCode = 1;
    return;
  }

  if (status.verdict === "ok") {
    console.log("Up to date: nothing to apply.");
    return;
  }

  const pending = status.migrations.filter((migration) => migration.status === "pending").map((migration) => migration.tag);
  console.log(`Applying ${pending.length}: ${pending.join(", ")}\n`);

  const run = spawnSync(join("node_modules", ".bin", "drizzle-kit"), ["migrate"], { stdio: "inherit", env: process.env });
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    return;
  }

  // What drizzle reports is what it ran; this is what the database now has.
  const after = await databaseStatus(url, variable);
  console.log("");
  for (const line of formatReport(after)) console.log(line);
  if (after.verdict !== "ok") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
