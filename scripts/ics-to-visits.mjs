#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import {
  eventsToRows,
  inspect,
  parseIcs,
  toCsv,
  VISIT_HEADERS,
  wallTimeToInstant,
} from "./ics-to-visits-core.mjs";

/**
 * A Masters calendar feed, converted into a file the `visit` import accepts.
 *
 * The feed is the only machine-readable channel that product offers: there is
 * no API and no export of records, but "Синхронизация с календарем" hands out a
 * webcal link, and a webcal link is an .ics over HTTPS. Download it first —
 * the script reads a file, not a URL, so that what gets converted is a copy the
 * owner can look at:
 *
 *   curl -sL "<webcal-ссылка, webcal:// заменить на https://>" -o masters.ics
 *
 * Then look before converting. Nobody knows what a given feed writes into an
 * event title until they have seen it, and every guess this script could make
 * about "Мария — Маникюр" is a guess about whose name comes first:
 *
 *   node scripts/ics-to-visits.mjs masters.ics --inspect
 *   node scripts/ics-to-visits.mjs masters.ics --master Ирина --out visits.csv
 *
 * Options:
 *   --master <имя>      Мастер for every row. A single master's feed never
 *                       names them — the calendar is already theirs.
 *   --tz <IANA>         Studio timezone (default Europe/Chisinau). The importer
 *                       reads the written time as studio time, so the feed's
 *                       UTC instants are converted into it here.
 *   --order <c-s|s-c>   Which half of a title is the client: `client-service`
 *                       (default) or `service-client`.
 *   --services <файл>   The studio's service names, one per line or the CSV the
 *                       import template downloads. When given, the half that
 *                       names a real service decides the split and --order is
 *                       only the fallback.
 *   --from / --to       dd.MM.yyyy bounds. --to defaults to now: a future entry
 *                       is an appointment, not a visit that happened.
 *   --out <файл>        Write there instead of stdout.
 *   --inspect           Report what the feed contains and convert nothing.
 */

function flag(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at === -1 || at + 1 >= process.argv.length ? fallback : process.argv[at + 1];
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [file] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (!file) fail("usage: node scripts/ics-to-visits.mjs <file.ics> [--master Имя] [--inspect]");

const timeZone = flag("--tz", "Europe/Chisinau");
try {
  new Intl.DateTimeFormat("en-US", { timeZone });
} catch {
  fail(`--tz is not an IANA timezone: ${timeZone}`);
}

/** A bound written the way the rest of the product writes a date. */
function boundary(value, name) {
  if (value === null) return null;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (!match) fail(`${name} must be written dd.MM.yyyy, got: ${value}`);
  return wallTimeToInstant(
    { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]), minutes: 0 },
    timeZone,
  );
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  fail(`could not read ${file}: ${error.message}`);
}

if (!text.includes("BEGIN:VCALENDAR")) {
  // Nearly always the webcal link answering with an HTML sign-in page rather
  // than a calendar, which would otherwise parse to zero events and look like
  // an empty schedule.
  fail(`${file} does not look like an iCalendar file — no BEGIN:VCALENDAR in it`);
}

const events = parseIcs(text, timeZone);

if (process.argv.includes("--inspect")) {
  const report = inspect(events);
  console.log(`Событий в фиде: ${report.total}`);
  console.log(`  отменённых: ${report.cancelled}, повторяющихся: ${report.recurring}, на весь день: ${report.allDay}`);
  console.log(`  с описанием: ${report.withDescription}`);
  if (report.earliest) {
    console.log(`  период: ${report.earliest.toISOString()} — ${report.latest.toISOString()}`);
  }
  console.log("\nЗаголовки событий (что писать в --order и --services):");
  for (const title of report.titles) console.log(`  ${String(title.count).padStart(4)} × ${title.summary}`);
  if (report.descriptions.length > 0) {
    console.log("\nОписания, первые несколько:");
    for (const description of report.descriptions) {
      console.log(`  ---\n${description.split("\n").map((line) => `  ${line}`).join("\n")}`);
    }
  }
  process.exit(0);
}

const servicesFile = flag("--services");
let services = null;
if (servicesFile) {
  try {
    // Both shapes the owner has to hand: a bare list, and the CSV our own
    // template downloads, whose service name is not always the first column.
    services = new Set(
      readFileSync(servicesFile, "utf8")
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .flatMap((line) => line.split(";"))
        .map((cell) => cell.replace(/^"|"$/g, "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
        .filter((cell) => cell !== ""),
    );
  } catch (error) {
    fail(`could not read ${servicesFile}: ${error.message}`);
  }
}

const order = flag("--order", "client-service");
if (!["client-service", "service-client"].includes(order)) {
  fail("--order must be client-service or service-client");
}

const result = eventsToRows(events, {
  timeZone,
  order,
  services,
  specialist: flag("--master", "") ?? "",
  from: boundary(flag("--from"), "--from"),
  // A visit is something that happened. Everything still ahead is an
  // appointment, and importing one as a completed visit invents revenue.
  to: boundary(flag("--to"), "--to") ?? new Date(),
});

const { skipped } = result;
console.error(
  `Строк к импорту: ${result.rows.length}. ` +
    `Пропущено — отменённых ${skipped.cancelled}, повторяющихся ${skipped.recurring}, ` +
    `на весь день ${skipped.allDay}, без даты ${skipped.undated}, вне периода ${skipped.outOfRange}.`,
);

if (result.missingSpecialist > 0) {
  fail(
    `${result.missingSpecialist} строк без мастера — импорт отклонит их все. ` +
      "Укажите --master «Имя», как мастер записан в студии.",
  );
}
if (result.missingService > 0) {
  console.error(
    `Внимание: ${result.missingService} строк без услуги. Импорт их отклонит — ` +
      "проверьте --order на выводе --inspect.",
  );
}

const csv = toCsv([VISIT_HEADERS, ...result.rows]);
const out = flag("--out");
if (out) {
  writeFileSync(out, csv, "utf8");
  console.error(`Записано: ${out}`);
} else {
  process.stdout.write(csv);
}
