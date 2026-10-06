import { describe, expect, it } from "vitest";

import { importableEntities } from "@/domain/import-templates";
import { memberRoles } from "@/domain/rbac";
import { parseCsv } from "@/domain/csv";
import { canImport, readUpload } from "@/lib/import-flow";

describe("canImport", () => {
  it("lets an owner import everything", () => {
    for (const entity of importableEntities) expect(canImport("owner", entity)).toBe(true);
  });

  it("lets a manager import the catalogue", () => {
    expect(canImport("manager", "service")).toBe(true);
    expect(canImport("manager", "client")).toBe(true);
  });

  it("refuses a master, whose write is scoped to their own rows", () => {
    // Section 6.1 gives a Master `services` as `create_only` — adding their
    // own. Bulk-replacing the studio's catalogue is not that, and reading the
    // permission without its constraints is exactly how that line gets
    // crossed.
    for (const entity of importableEntities) expect(canImport("master", entity)).toBe(false);
  });

  it("refuses an analyst, who is read-only", () => {
    for (const entity of importableEntities) expect(canImport("analyst", entity)).toBe(false);
  });

  it("gives an answer for every role and entity", () => {
    for (const role of memberRoles) {
      for (const entity of importableEntities) {
        expect(typeof canImport(role, entity)).toBe("boolean");
      }
    }
  });
});

describe("readUpload", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const phoneBook = bytes(
    "BEGIN:VCARD\r\nFN:Мария\r\nTEL:069123456\r\nEND:VCARD\r\n" +
      "BEGIN:VCARD\r\nFN:Анна\r\nEND:VCARD\r\n" +
      "BEGIN:VCARD\r\nFN:Ольга\r\nEND:VCARD\r\n",
  );
  const names = (text: string) => parseCsv(text).rows.map((row) => row.cells[0]);

  it("passes a CSV through with its own separator", () => {
    const upload = readUpload(bytes("Наименование;Цена\nМаникюр;600\n"), "service", null);

    expect(upload).toMatchObject({ kind: "csv", delimiter: ";", encoding: "utf-8" });
  });

  it("turns a contacts file into a client CSV of every contact", () => {
    const upload = readUpload(phoneBook, "client", null);

    expect(upload).toMatchObject({ kind: "vcard", delimiter: "," });
    expect(names((upload as { text: string }).text)).toEqual(["Мария", "Анна", "Ольга"]);
  });

  it("keeps only the contacts ticked, by position", () => {
    const upload = readUpload(phoneBook, "client", new Set([0, 2, 99]));

    expect(names((upload as { text: string }).text)).toEqual(["Мария", "Ольга"]);
  });

  it("refuses a contacts file offered as anything but clients", () => {
    expect(readUpload(phoneBook, "service", null)).toEqual({ error: "VCARD_NOT_CLIENTS" });
  });
});
