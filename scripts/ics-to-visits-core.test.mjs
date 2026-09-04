import { describe, expect, it } from "vitest";

import { buildPreview, suggestMapping } from "@/domain/import-mapping";
import { importTemplates } from "@/domain/import-templates";
import { parseCsv } from "@/domain/csv";

import {
  escapeCsvCell,
  eventsToRows,
  formatWall,
  instantToWall,
  parseContentLine,
  parseIcs,
  parseIcsDuration,
  readLabelled,
  splitTitle,
  toCsv,
  unescapeText,
  unfoldLines,
  VISIT_HEADERS,
  wallTimeToInstant,
} from "./ics-to-visits-core.mjs";

const ZONE = "Europe/Chisinau";

function calendar(...events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
}

function event(...lines) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("iCalendar surface", () => {
  it("rejoins a folded line", () => {
    // Cyrillic costs two octets a letter, so a title with a client and a
    // service in it folds after about four words. Parsing before unfolding
    // truncates exactly the events that carry the most.
    const lines = unfoldLines("SUMMARY:Мария — Маникюр\r\n  с покрытием\r\nUID:1");
    expect(lines[0]).toBe("SUMMARY:Мария — Маникюр с покрытием");
    expect(lines[1]).toBe("UID:1");
  });

  it("finds the value colon outside a quoted parameter", () => {
    const parsed = parseContentLine('DTSTART;TZID="Europe/Chisinau":20260403T143000');
    expect(parsed).toMatchObject({
      name: "DTSTART",
      params: { TZID: "Europe/Chisinau" },
      value: "20260403T143000",
    });
  });

  it("returns nothing for a line with no value", () => {
    expect(parseContentLine("BEGIN")).toBeNull();
  });

  it("unescapes the four TEXT escapes", () => {
    expect(unescapeText("Клиент: Мария\\nУслуга: Маникюр\\, френч\; 2\\\\3")).toBe(
      "Клиент: Мария\nУслуга: Маникюр, френч; 2\\3",
    );
  });

  it.each([
    ["PT1H30M", 90],
    ["PT90M", 90],
    ["PT2H", 120],
    ["P1D", 1_440],
    ["PT45S", 0],
    ["сорок минут", null],
  ])("reads the duration %s", (written, minutes) => {
    expect(parseIcsDuration(written)).toBe(minutes);
  });
});

describe("time", () => {
  it("converts a UTC instant into studio wall time in winter", () => {
    const [visit] = parseIcs(calendar(event("UID:1", "DTSTART:20260115T120000Z")), ZONE);
    // Chișinău is UTC+2 in January.
    expect(formatWall(instantToWall(visit.start, ZONE))).toBe("15.01.2026 14:00");
  });

  it("converts a UTC instant into studio wall time in summer", () => {
    const [visit] = parseIcs(calendar(event("UID:1", "DTSTART:20260715T120000Z")), ZONE);
    // And UTC+3 in July. A fixed offset would put this hour in the wrong place
    // for half the year.
    expect(formatWall(instantToWall(visit.start, ZONE))).toBe("15.07.2026 15:00");
  });

  it("reads a zoned wall time as the instant it names", () => {
    const [visit] = parseIcs(
      calendar(event("UID:1", "DTSTART;TZID=Europe/Chisinau:20260403T143000")),
      ZONE,
    );
    expect(visit.start.toISOString()).toBe("2026-04-03T11:30:00.000Z");
  });

  it("treats a floating time as studio time", () => {
    const [visit] = parseIcs(calendar(event("UID:1", "DTSTART:20260403T143000")), ZONE);
    expect(visit.start.toISOString()).toBe("2026-04-03T11:30:00.000Z");
  });

  it("survives the hour that happens twice", () => {
    // Autumn fall-back: 03:30 comes round twice, and the earlier instant is the
    // one a schedule means. Anything is better than NaN in a date column.
    const instant = wallTimeToInstant(
      { year: 2026, month: 10, day: 25, minutes: 3 * 60 + 30 },
      ZONE,
    );
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(instantToWall(instant, ZONE).minutes).toBe(3 * 60 + 30);
  });

  it("survives the hour that never happens", () => {
    // Spring forward: 03:30 does not exist on 29 March 2026.
    const instant = wallTimeToInstant({ year: 2026, month: 3, day: 29, minutes: 3 * 60 + 30 }, ZONE);
    expect(Number.isNaN(instant.getTime())).toBe(false);
  });
});

describe("events", () => {
  const PAST = { to: new Date("2026-09-01T00:00:00Z") };

  it("measures the visit from DTSTART to DTEND", () => {
    const events = parseIcs(
      calendar(
        event("UID:1", "DTSTART:20260403T113000Z", "DTEND:20260403T131500Z", "SUMMARY:Маникюр"),
      ),
      ZONE,
    );
    expect(events[0].durationMinutes).toBe(105);
  });

  it("falls back to DURATION when there is no DTEND", () => {
    const events = parseIcs(
      calendar(event("UID:1", "DTSTART:20260403T113000Z", "DURATION:PT1H30M")),
      ZONE,
    );
    expect(events[0].durationMinutes).toBe(90);
  });

  it("leaves out what is not a completed visit", () => {
    const events = parseIcs(
      calendar(
        event("UID:1", "DTSTART:20260403T113000Z", "SUMMARY:Маникюр"),
        event("UID:2", "DTSTART:20260404T113000Z", "SUMMARY:Педикюр", "STATUS:CANCELLED"),
        event("UID:3", "DTSTART:20260405T113000Z", "SUMMARY:Обед", "RRULE:FREQ=WEEKLY"),
        event("UID:4", "DTSTART;VALUE=DATE:20260406", "SUMMARY:Отпуск"),
        event("UID:5", "SUMMARY:Без даты"),
      ),
      ZONE,
    );

    const result = eventsToRows(events, { ...PAST, timeZone: ZONE, specialist: "Ирина" });

    expect(result.rows).toHaveLength(1);
    // A cancelled appointment counted as revenue is the failure this guards.
    expect(result.skipped).toEqual({
      cancelled: 1,
      recurring: 1,
      allDay: 1,
      undated: 1,
      outOfRange: 0,
    });
  });

  it("keeps a future appointment out of a file of completed visits", () => {
    const events = parseIcs(
      calendar(
        event("UID:1", "DTSTART:20260403T113000Z", "SUMMARY:Маникюр"),
        event("UID:2", "DTSTART:20261203T113000Z", "SUMMARY:Маникюр"),
      ),
      ZONE,
    );

    const result = eventsToRows(events, { ...PAST, timeZone: ZONE, specialist: "Ирина" });

    // Importing one as a completed visit would invent revenue that has not
    // happened yet.
    expect(result.rows).toHaveLength(1);
    expect(result.skipped.outOfRange).toBe(1);
  });

  it("orders the rows by when they happened", () => {
    const events = parseIcs(
      calendar(
        event("UID:2", "DTSTART:20260405T113000Z", "SUMMARY:Педикюр"),
        event("UID:1", "DTSTART:20260403T113000Z", "SUMMARY:Маникюр"),
      ),
      ZONE,
    );

    const result = eventsToRows(events, { ...PAST, timeZone: ZONE, specialist: "Ирина" });
    expect(result.rows.map((row) => row[0])).toEqual(["UID:1", "UID:2"].map((uid) => uid.slice(4)));
  });

  it("counts the rows the importer would refuse", () => {
    const events = parseIcs(calendar(event("UID:1", "DTSTART:20260403T113000Z")), ZONE);
    const result = eventsToRows(events, { ...PAST, timeZone: ZONE });

    expect(result.missingSpecialist).toBe(1);
    expect(result.missingService).toBe(1);
  });
});

describe("reading a title", () => {
  it("takes a labelled description over any guess", () => {
    expect(readLabelled("Клиент: Мария\nУслуга: Маникюр\nМастер: Ирина\nТелефон: 069123456")).toEqual(
      { client: "Мария", service: "Маникюр", specialist: "Ирина" },
    );
  });

  it("ignores a description line that is not a label", () => {
    expect(readLabelled("просто заметка\nКлиент: Мария")).toEqual({ client: "Мария" });
  });

  it.each([["Мария — Маникюр"], ["Мария – Маникюр"], ["Мария - Маникюр"], ["Мария, Маникюр"], ["Мария | Маникюр"]])(
    "splits %s on its separator",
    (summary) => {
      expect(splitTitle(summary)).toEqual({ client: "Мария", service: "Маникюр" });
    },
  );

  it("honours the order the owner declares", () => {
    expect(splitTitle("Маникюр — Мария", { order: "service-client" })).toEqual({
      client: "Мария",
      service: "Маникюр",
    });
  });

  it("lets the studio's own service list decide which half is which", () => {
    // Evidence beats a preference: the list says which half names a service, so
    // a wrong --order cannot flip the columns.
    const services = new Set(["маникюр"]);
    expect(splitTitle("Маникюр — Мария", { order: "client-service", services })).toEqual({
      client: "Мария",
      service: "Маникюр",
    });
  });

  it("keeps the declared order when the list recognises neither half", () => {
    const services = new Set(["педикюр"]);
    expect(splitTitle("Мария — Маникюр", { services })).toEqual({
      client: "Мария",
      service: "Маникюр",
    });
  });

  it("reads a title that does not split as the service", () => {
    // A booking app that writes one thing into an event title writes what was
    // booked, not who booked it.
    expect(splitTitle("Маникюр с покрытием")).toEqual({ client: "", service: "Маникюр с покрытием" });
  });

  it("reads nothing out of an empty title", () => {
    expect(splitTitle("")).toEqual({ client: "", service: "" });
  });
});

describe("the CSV it writes", () => {
  it("neutralizes a formula without changing the name", () => {
    // A client called `=HYPERLINK(...)` runs when the owner opens the file.
    expect(escapeCsvCell("=HYPERLINK(\"http://evil\")")).toBe(
      '"\'=HYPERLINK(""http://evil"")"',
    );
    expect(escapeCsvCell("-5")).toBe("-5");
  });

  it("carries the BOM and CRLF Excel needs", () => {
    const csv = toCsv([["Имя"], ["Мария"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
  });

  it("imports cleanly through the visit template it was written for", () => {
    // The end of the whole path: what the converter writes has to map back
    // without a single manual correction, or the owner discovers at the mapping
    // step that the file they were handed does not fit.
    const events = parseIcs(
      calendar(
        event(
          "UID:masters-1",
          "DTSTART;TZID=Europe/Chisinau:20260403T143000",
          "DTEND;TZID=Europe/Chisinau:20260403T161500",
          "SUMMARY:Мария — Маникюр с покрытием",
        ),
      ),
      ZONE,
    );

    const { rows } = eventsToRows(events, {
      timeZone: ZONE,
      specialist: "Ирина",
      to: new Date("2026-09-01T00:00:00Z"),
    });
    expect(rows[0]).toEqual([
      "masters-1",
      "03.04.2026 14:30",
      "Ирина",
      "Маникюр с покрытием",
      "Мария",
      "105",
    ]);

    const parsed = parseCsv(toCsv([VISIT_HEADERS, ...rows]));
    const template = importTemplates.visit;
    const preview = buildPreview(template, suggestMapping(template, parsed.headers), parsed.rows);

    expect(preview.missingRequiredFields).toEqual([]);
    expect(preview.failed).toEqual([]);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].values).toMatchObject({
      specialist: "Ирина",
      service: "Маникюр с покрытием",
      client: "Мария",
      actual_duration: 105,
    });
    expect(preview.rows[0].identityKind).toBe("external");
  });
});
