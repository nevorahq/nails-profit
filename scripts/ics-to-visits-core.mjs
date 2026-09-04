/**
 * An iCalendar feed turned into the rows the `visit` import template expects.
 *
 * The reason this exists: Masters (masters-app.ru) publishes no API and no
 * export of its records. The one machine-readable channel it offers is the
 * webcal subscription behind "Синхронизация с календарем" — an ordinary .ics
 * over HTTPS. That feed is therefore the whole migration path, and it carries
 * two limits worth knowing before trusting a number that came through it:
 * events start at the 1st of the *previous* month, and a calendar entry has no
 * price. Neither is a defect here — the visit importer takes price and duration
 * from the service catalogue on purpose.
 *
 * Pure and dependency-free for the same reason `pilot-core.mjs` is: the parts
 * that are easy to get quietly wrong — an hour lost to a timezone, a cancelled
 * appointment counted as revenue — have to be checkable without a network and
 * without a calendar server.
 */

/* ------------------------------------------------------------------ *
 * RFC 5545 surface
 * ------------------------------------------------------------------ */

/**
 * Undoes the 75-octet line folding.
 *
 * A folded line continues on the next one, marked by a leading space or tab,
 * and long values fold constantly — a service name with a client name beside it
 * is past 75 octets after four Cyrillic words, since each costs two. Parsing
 * before unfolding silently truncates exactly the events that carry the most.
 */
export function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

/**
 * Splits `NAME;PARAM=VALUE:the value` into its three parts.
 *
 * The colon is found outside double quotes, because a parameter may legally
 * hold one: `DTSTART;TZID="Europe/Chisinau":...` is valid, and cutting at the
 * first colon would make the name `DTSTART;TZID="Europe/Chisinau"`.
 */
export function parseContentLine(line) {
  let quoted = false;
  let colon = -1;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at];
    if (character === '"') quoted = !quoted;
    else if (character === ":" && !quoted) {
      colon = at;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rawParams] = head.split(";");

  const params = {};
  for (const param of rawParams) {
    const equals = param.indexOf("=");
    if (equals === -1) continue;
    params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/^"|"$/g, "");
  }

  return { name: name.toUpperCase(), params, value };
}

/** The four escapes RFC 5545 defines for TEXT values. */
export function unescapeText(value) {
  return value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\([,;\\])/g, "$1");
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const formatters = new Map();

function formatterFor(timeZone) {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/** The wall clock a person in that zone reads at this instant. */
export function instantToWall(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    minutes: value("hour") * 60 + value("minute"),
  };
}

function offsetMinutes(instant, timeZone) {
  const wall = instantToWall(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minutes, 0, 0);
  return (asUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000;
}

function readsAs(instant, wall, timeZone) {
  const actual = instantToWall(instant, timeZone);
  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.minutes === wall.minutes
  );
}

/**
 * A local wall time to the instant it names, DST included.
 *
 * The offset cannot be looked up before the instant is known and the instant
 * cannot be computed without the offset. The way out is the one `domain/
 * timezone.ts` takes: guess with the offsets on either side of the target, then
 * keep the candidate that actually reads back as the time asked for. On the
 * spring Sunday neither does — the hour was skipped — and the earlier candidate
 * is the instant the clock jumps onto.
 */
export function wallTimeToInstant(wall, timeZone) {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minutes, 0, 0);
  const before = offsetMinutes(new Date(guess - 12 * 3_600_000), timeZone);
  const after = offsetMinutes(new Date(guess + 12 * 3_600_000), timeZone);

  const first = new Date(guess - before * 60_000);
  if (readsAs(first, wall, timeZone)) return first;
  const second = new Date(guess - after * 60_000);
  if (readsAs(second, wall, timeZone)) return second;
  return first;
}

/**
 * A DATE-TIME property to an instant, in each of the three forms a feed uses.
 *
 * `...Z` is already an instant. `TZID=` names the zone the written time belongs
 * to. A bare value is "floating" — it means whatever the reader's clock says,
 * and for a salon's own calendar that is the salon's zone.
 */
export function propertyToInstant(property, studioZone) {
  const raw = property.value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(raw);
  if (!match) return null;

  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    minutes: Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0),
  };

  if (match[7] === "Z") {
    return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minutes, 0, 0));
  }
  return wallTimeToInstant(wall, property.params.TZID || studioZone);
}

/** `PT1H30M`, `PT90M`, `P1D` — minutes, or null when it is not a duration. */
export function parseIcsDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match || match.slice(2).every((part) => part === undefined)) return null;

  const minutes =
    Number(match[2] ?? 0) * 7 * 24 * 60 +
    Number(match[3] ?? 0) * 24 * 60 +
    Number(match[4] ?? 0) * 60 +
    Number(match[5] ?? 0) +
    Math.floor(Number(match[6] ?? 0) / 60);

  return match[1] === "-" ? -minutes : minutes;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * Every VEVENT in the feed, with the properties this converter reads.
 *
 * Unknown properties are kept as raw text rather than dropped: `--inspect` is
 * how the owner finds out what their feed actually names things, and it can
 * only show what was retained.
 */
export function parseIcs(text, studioZone = "Europe/Chisinau") {
  const events = [];
  let current = null;

  for (const line of unfoldLines(text)) {
    if (line === "BEGIN:VEVENT") {
      current = { properties: {}, extra: {} };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(finishEvent(current, studioZone));
      current = null;
      continue;
    }
    if (!current) continue;

    const parsed = parseContentLine(line);
    if (!parsed) continue;
    // First one wins. A feed that repeats a property is malformed, and taking
    // the last would silently prefer whichever copy came later.
    if (!(parsed.name in current.properties)) current.properties[parsed.name] = parsed;
  }

  return events;
}

function finishEvent(collected, studioZone) {
  const { properties } = collected;
  const start = properties.DTSTART ? propertyToInstant(properties.DTSTART, studioZone) : null;
  const end = properties.DTEND ? propertyToInstant(properties.DTEND, studioZone) : null;
  const duration = properties.DURATION ? parseIcsDuration(properties.DURATION.value) : null;

  const minutes =
    end && start
      ? Math.round((end.getTime() - start.getTime()) / 60_000)
      : duration !== null
        ? duration
        : null;

  return {
    uid: properties.UID?.value.trim() ?? "",
    summary: unescapeText(properties.SUMMARY?.value ?? "").trim(),
    description: unescapeText(properties.DESCRIPTION?.value ?? "").trim(),
    location: unescapeText(properties.LOCATION?.value ?? "").trim(),
    status: (properties.STATUS?.value ?? "").trim().toUpperCase(),
    recurring: "RRULE" in properties,
    // An all-day entry carries no clock, so it is not a visit anybody performed
    // at a time — it is a note. Flagged rather than dropped, so `--inspect`
    // still counts it.
    allDay: properties.DTSTART?.params.VALUE === "DATE",
    start,
    durationMinutes: minutes !== null && minutes > 0 ? minutes : null,
  };
}

/* ------------------------------------------------------------------ *
 * Reading a client and a service out of an event
 * ------------------------------------------------------------------ */

const LABELS = {
  client: ["клиент", "гость", "client", "clientul", "nume"],
  service: ["услуга", "услуги", "процедура", "service", "serviciu", "serviciul"],
  specialist: ["мастер", "специалист", "сотрудник", "master", "specialist", "maestru"],
};

/**
 * `Ключ: значение` lines out of a DESCRIPTION.
 *
 * Tried before the title is split, because a label is a statement and a split
 * is a guess. A feed that writes "Клиент: Мария" has told us which half is
 * which, and no separator heuristic can be as reliable as that.
 */
export function readLabelled(description) {
  const found = {};
  for (const line of description.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase().replace(/\s+/g, " ");
    const value = line.slice(separator + 1).trim();
    if (value === "") continue;

    for (const [field, labels] of Object.entries(LABELS)) {
      if (found[field] === undefined && labels.includes(key)) found[field] = value;
    }
  }
  return found;
}

/** The separators a title uses between two things. */
const TITLE_SPLIT = /\s+[—–·|]\s+|\s+-\s+|,\s+/;

export function normalizeName(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Splits a title into a client and a service.
 *
 * Which half is which cannot be known from the string alone, so there are two
 * ways to decide and they are tried in order of how much they actually know:
 *
 *  1. the studio's own service list, when `--services` supplies one. A half
 *     that names a real service *is* the service; this is evidence, not a
 *     preference, and it also survives a feed that is inconsistent between
 *     events;
 *  2. `order`, the owner's answer to what their own calendar looks like.
 *
 * A title that does not split at all is taken as the service, because a booking
 * app that writes one thing in an event title writes what was booked.
 */
export function splitTitle(summary, { order = "client-service", services = null } = {}) {
  const parts = summary
    .split(TITLE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== "");

  if (parts.length === 0) return { client: "", service: "" };
  if (parts.length === 1) return { client: "", service: parts[0] };

  const head = parts[0];
  const tail = parts.slice(1).join(", ");

  if (services && services.size > 0) {
    const headIsService = services.has(normalizeName(head));
    const tailIsService = services.has(normalizeName(tail));
    if (headIsService !== tailIsService) {
      return headIsService ? { client: tail, service: head } : { client: head, service: tail };
    }
  }

  return order === "service-client" ? { client: tail, service: head } : { client: head, service: tail };
}

/** Everything the row needs, from whichever part of the event carries it. */
export function readEvent(event, options = {}) {
  const labelled = readLabelled(event.description);
  const split = splitTitle(event.summary, options);

  return {
    client: labelled.client ?? split.client,
    service: labelled.service ?? split.service,
    specialist: labelled.specialist ?? options.specialist ?? "",
  };
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** The header of the `visit` template, spelled exactly as its labels are. */
export const VISIT_HEADERS = [
  "ID в источнике",
  "Дата и время",
  "Мастер",
  "Услуга",
  "Клиент",
  "Фактическая длительность",
];

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

/** `03.04.2026 14:30` — the `dd.MM.yyyy` of LOC-007, which the importer reads. */
export function formatWall(wall) {
  return `${pad(wall.day)}.${pad(wall.month)}.${pad(wall.year, 4)} ${pad(Math.floor(wall.minutes / 60))}:${pad(wall.minutes % 60)}`;
}

/**
 * Which events become rows, and why the others do not.
 *
 * Each exclusion is counted and reported rather than applied quietly: a
 * converter that turns 400 events into 180 rows without saying what happened to
 * the other 220 is a converter nobody should trust with their history.
 */
export function selectEvents(events, { from = null, to = null } = {}) {
  const skipped = { cancelled: 0, recurring: 0, allDay: 0, undated: 0, outOfRange: 0 };
  const kept = [];

  for (const event of events) {
    if (event.status === "CANCELLED") skipped.cancelled += 1;
    else if (event.recurring) skipped.recurring += 1;
    else if (event.allDay) skipped.allDay += 1;
    else if (!event.start) skipped.undated += 1;
    else if ((from && event.start < from) || (to && event.start >= to)) skipped.outOfRange += 1;
    else kept.push(event);
  }

  kept.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { kept, skipped };
}

export function eventsToRows(events, options = {}) {
  const { timeZone = "Europe/Chisinau" } = options;
  const { kept, skipped } = selectEvents(events, options);

  const rows = kept.map((event) => {
    const read = readEvent(event, options);
    return [
      event.uid,
      formatWall(instantToWall(event.start, timeZone)),
      read.specialist,
      read.service,
      read.client,
      event.durationMinutes === null ? "" : String(event.durationMinutes),
    ];
  });

  return {
    rows,
    skipped,
    // Counted here so the CLI can refuse a file the importer would only reject
    // row by row half an hour later.
    missingSpecialist: rows.filter((row) => row[2] === "").length,
    missingService: rows.filter((row) => row[3] === "").length,
  };
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d   ']*[.,]?\d+(?:[eE][+-]?\d+)?$/;

/** The rule of `domain/csv-safety.ts`, restated here so the script needs no build step. */
export function looksLikeFormula(value) {
  if (value.length < 2) return false;
  if (!FORMULA_LEAD.test(value)) return false;
  return !PLAIN_NUMBER.test(value);
}

export function escapeCsvCell(value, delimiter = ";") {
  const guarded = looksLikeFormula(value) ? `'${value}` : value;
  const needsQuotes =
    guarded.includes(delimiter) ||
    guarded.includes('"') ||
    guarded.includes("\n") ||
    guarded.includes("\r");
  return needsQuotes ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * With the BOM and CRLF the rest of the product writes: without them Excel on a
 * Russian or Romanian Windows reads UTF-8 as Windows-1251 and every name in the
 * file arrives as mojibake.
 */
export function toCsv(rows, delimiter = ";") {
  const body = rows
    .map((row) => row.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter))
    .join("\r\n");
  return `﻿${body}\r\n`;
}

/** What the feed looks like, for the run that happens before any conversion. */
export function inspect(events, limit = 12) {
  const titles = new Map();
  for (const event of events) {
    if (event.summary === "") continue;
    titles.set(event.summary, (titles.get(event.summary) ?? 0) + 1);
  }

  const dated = events.filter((event) => event.start).map((event) => event.start.getTime());

  return {
    total: events.length,
    cancelled: events.filter((event) => event.status === "CANCELLED").length,
    recurring: events.filter((event) => event.recurring).length,
    allDay: events.filter((event) => event.allDay).length,
    withDescription: events.filter((event) => event.description !== "").length,
    earliest: dated.length > 0 ? new Date(Math.min(...dated)) : null,
    latest: dated.length > 0 ? new Date(Math.max(...dated)) : null,
    titles: [...titles.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([summary, count]) => ({ summary, count })),
    descriptions: events
      .filter((event) => event.description !== "")
      .slice(0, 3)
      .map((event) => event.description),
  };
}
