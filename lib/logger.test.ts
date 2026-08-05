import { describe, expect, test, vi } from "vitest";

import { buildLogLine, logEvent, redact, safePath } from "@/lib/logger";

describe("redact", () => {
  test("masks an address wherever it appears in a string", () => {
    const masked = redact("failed to invite irina@salon.md twice") as string;
    expect(masked).not.toContain("irina@salon.md");
    expect(masked).toMatch(/\[email#[0-9a-f]{4}\]/);
  });

  test("the same address gets the same tag, a different one does not", () => {
    const first = redact("irina@salon.md") as string;
    const again = redact("irina@salon.md") as string;
    const other = redact("ana@salon.md") as string;

    // Correlating two lines must be possible; recovering the address must not.
    expect(first).toBe(again);
    expect(other).not.toBe(first);
  });

  test("masks phone numbers in any of the forms people type", () => {
    for (const phone of ["+373 60 123 456", "+37360123456", "060-123-456"]) {
      const masked = redact(`client ${phone} confirmed`) as string;
      expect(masked).not.toContain("123");
      expect(masked).toMatch(/\[phone#[0-9a-f]{4}\]/);
    }
  });

  test("masks by key even when the value looks harmless", () => {
    const masked = redact({ client_name: "Ирина", note: "аллергия", user_id: "u-1" }) as Record<
      string,
      unknown
    >;

    expect(masked.client_name).toMatch(/^\[redacted#[0-9a-f]{4}\]$/);
    expect(masked.note).toMatch(/^\[redacted#/);
    // Section 15.6 asks for exactly these ids in the line, so they stay.
    expect(masked.user_id).toBe("u-1");
  });

  test("reaches through nesting and arrays", () => {
    const masked = redact({
      rows: [{ contact: { email: "a@b.md" } }, { free_text: "написать на a@b.md" }],
    }) as { rows: [{ contact: { email: string } }, { free_text: string }] };

    expect(masked.rows[0].contact.email).toMatch(/^\[redacted#/);
    expect(masked.rows[1].free_text).not.toContain("a@b.md");
  });

  test("masks an error's message and stack without dropping the type", () => {
    const error = new Error("no account for irina@salon.md");
    const masked = redact(error) as { name: string; message: string };

    expect(masked.name).toBe("Error");
    expect(masked.message).not.toContain("irina@salon.md");
  });

  test("a cycle does not take the logger down", () => {
    const cyclic: Record<string, unknown> = { id: "1" };
    cyclic.self = cyclic;

    expect(redact(cyclic)).toEqual({ id: "1", self: "[circular]" });
  });
});

describe("buildLogLine", () => {
  test("carries the ids section 15.6 asks for", () => {
    const line = buildLogLine(
      "info",
      "import.completed",
      { requestId: "r-1", organizationId: "o-1", userId: "u-1" },
      { created: 10 },
    );

    expect(line).toMatchObject({
      level: "info",
      event: "import.completed",
      request_id: "r-1",
      organization_id: "o-1",
      user_id: "u-1",
      created: 10,
    });
    expect(Date.parse(line.timestamp)).not.toBeNaN();
  });

  test("fields are redacted even when the caller forgets", () => {
    const line = buildLogLine("warn", "invite.failed", {}, { email: "irina@salon.md" });
    expect(JSON.stringify(line)).not.toContain("irina@salon.md");
  });
});

describe("logEvent", () => {
  test("writes one JSON line, and errors go to stderr", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("error", "request.error", { requestId: "r-1" }, { path: "/api/v1/clients" });

    expect(stdout).not.toHaveBeenCalled();
    const written = `${String(stderr.mock.calls[0][0])}\n`;
    // One line: a collector splits on newlines, and a multi-line event is two
    // broken records rather than one readable one.
    expect(written.endsWith("\n")).toBe(true);
    expect(written.trimEnd()).not.toContain("\n");
    expect(JSON.parse(written)).toMatchObject({ level: "error", event: "request.error", request_id: "r-1" });

    stderr.mockRestore();
    stdout.mockRestore();
  });
});

describe("safePath", () => {
  test("drops the query string", () => {
    // A filter parameter is the most ordinary way for a phone number to end up
    // in a log line.
    expect(safePath("/api/v1/clients?phone=%2B37360123456")).toBe("/api/v1/clients");
  });

  test("masks anything left in the path itself", () => {
    expect(safePath("/api/v1/clients/irina@salon.md")).toMatch(/\[email#[0-9a-f]{4}\]$/);
  });
});
