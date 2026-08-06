#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { buildBookingLatencyReport } from "./booking-latency-core.mjs";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function readInput() {
  const path = valueAfter("--file");
  return path ? readFile(path, "utf8") : readFile(0, "utf8");
}

try {
  const rawMinSamples = valueAfter("--min-samples");
  const minSamples = rawMinSamples === null ? 30 : Number(rawMinSamples);
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error("--min-samples must be a positive integer");
  }

  const input = await readInput();
  const records = [];
  let invalidLines = 0;

  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Hosting collectors often mix their own lifecycle text with application
      // stdout. Count it for traceability, but never print the source line: it
      // may contain data outside our redaction boundary.
      invalidLines += 1;
    }
  }

  const report = buildBookingLatencyReport(records, { minSamples });
  console.log(
    JSON.stringify(
      {
        ...report,
        input_lines: records.length + invalidLines,
        ignored_or_invalid_lines: records.length - report.accepted_samples + invalidLines,
      },
      null,
      2,
    ),
  );
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "Usage: npm run ops:booking-latency -- [--file redacted-timings.jsonl] [--min-samples 30]",
  );
  process.exitCode = 2;
}

