#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { buildLogEventsReport, parseLogLines } from "./log-events-core.mjs";

/**
 * The events half of section 7.10, read from the log stream: conflict rate,
 * double-booking attempts that reached the constraint, rate-limit blocks,
 * challenges, cross-site refusals and what the notification job did.
 *
 * It touches no database, which is the point: these numbers exist only in the
 * lines the application already writes, so the report runs against yesterday's
 * rotated file, a `docker logs` pipe or a download from the hosting platform,
 * none of which has to be production.
 *
 *   node scripts/log-events.mjs app.log
 *   docker compose logs --no-color app | node scripts/log-events.mjs
 *
 * Latency lives in `ops:booking-latency`, which owns Gate 7's two targets over
 * the same lines. Use both; they answer different halves of one question.
 */
const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const text =
  files.length > 0
    ? files.map((file) => readFileSync(file, "utf8")).join("\n")
    : await readStdin();

if (text.trim() === "") {
  console.error("No log input. Pass files as arguments or pipe a log stream on stdin.");
  console.error("Usage: node scripts/log-events.mjs [app.log …]");
  process.exit(2);
}

const { lines, skipped } = parseLogLines(text);
const report = buildLogEventsReport({ lines });

console.log(JSON.stringify({ ...report, ignored_lines: skipped }, null, 2));

// Same convention as the other operator reports: a failed criterion is a
// non-zero exit, so this can stand in a check that is supposed to go red.
process.exitCode = report.verdict === "PASS" ? 0 : 1;
