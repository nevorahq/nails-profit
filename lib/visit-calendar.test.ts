import { describe, expect, test } from "vitest";

import { getTranslator } from "@/i18n/t";
import { googleCalendarUrl, visitEvent, visitIcs, type VisitView } from "@/lib/visit-calendar";

const t = getTranslator("ru");

const view: VisitView = {
  organization_name: "Green Nails",
  location: { name: "Центр", address: "str. Ismail 33, of. 4; etaj 2" },
  specialist: { name: "Татьяна" },
  starts_at: "2026-10-22T08:00:00.000Z",
  ends_at: "2026-10-22T09:30:00.000Z",
  status: "confirmed",
  version: 3,
  lines: [
    { kind: "service", name: "Маникюр с покрытием" },
    { kind: "add_on", name: "Снятие" },
    { kind: "service", name: "Педикюр" },
  ],
};

const MANAGE = "https://app.example.com/booking/abc.def";

/** The lines a calendar reads, with RFC 5545 folding undone. */
function unfolded(ics: string) {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("the visit as a calendar entry", () => {
  test("is titled by the services and the studio, and placed at its address", () => {
    const event = visitEvent(view, t, MANAGE);

    expect(event.title).toBe("Маникюр с покрытием + Педикюр — Green Nails");
    expect(event.location).toBe("Центр, str. Ismail 33, of. 4; etaj 2");
    expect(event.details).toBe(`Мастер: Татьяна\nПеренести или отменить: ${MANAGE}`);
    expect(event.tentative).toBe(false);
  });

  test("a location without an address is still somewhere", () => {
    const event = visitEvent({ ...view, location: { name: "Центр", address: null } }, t, null);
    expect(event.location).toBe("Центр");
    expect(event.details).toBe("Мастер: Татьяна");
  });

  test("a request not answered yet goes in as tentative", () => {
    const ics = visitIcs(visitEvent({ ...view, status: "pending_confirmation" }, t, MANAGE), "b-1");
    expect(unfolded(ics)).toContain("STATUS:TENTATIVE");
  });

  test("the file is one event, in UTC, with an alarm two hours ahead", () => {
    const ics = visitIcs(visitEvent(view, t, MANAGE), "b-1", new Date("2026-10-21T10:00:00Z"));
    const lines = unfolded(ics);

    expect(ics.endsWith("\r\n")).toBe(true);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("UID:booking-b-1@nail-profit-os");
    expect(lines).toContain("SEQUENCE:3");
    expect(lines).toContain("DTSTAMP:20261021T100000Z");
    expect(lines).toContain("DTSTART:20261022T080000Z");
    expect(lines).toContain("DTEND:20261022T093000Z");
    expect(lines).toContain("STATUS:CONFIRMED");
    expect(lines).toContain("TRIGGER:-PT120M");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
  });

  test("text is escaped the way RFC 5545 asks", () => {
    const lines = unfolded(visitIcs(visitEvent(view, t, MANAGE), "b-1"));

    expect(lines).toContain("LOCATION:Центр\\, str. Ismail 33\\, of. 4\\; etaj 2");
    expect(lines).toContain(`DESCRIPTION:Мастер: Татьяна\\nПеренести или отменить: ${MANAGE}`);
  });

  test("no line is longer than 75 octets, and none is cut through a letter", () => {
    const long = { ...view, lines: [{ kind: "service", name: "Маникюр ".repeat(20).trim() }] };
    const ics = visitIcs(visitEvent(long, t, MANAGE), "b-1");
    const encoder = new TextEncoder();

    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }
    expect(unfolded(ics)).toContain(`SUMMARY:${"Маникюр ".repeat(20).trim()} — Green Nails`);
  });

  test("Google's link carries the visit, and never the manage link", () => {
    const url = new URL(googleCalendarUrl(visitEvent(view, t, null)));

    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Маникюр с покрытием + Педикюр — Green Nails");
    expect(url.searchParams.get("dates")).toBe("20261022T080000Z/20261022T093000Z");
    expect(url.searchParams.get("location")).toBe("Центр, str. Ismail 33, of. 4; etaj 2");
    expect(url.searchParams.get("details")).toBe("Мастер: Татьяна");
    expect(url.toString()).not.toContain("/booking/");
  });
});
