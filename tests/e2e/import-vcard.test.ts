import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resetRateLimits } from "@/lib/rate-limit";

import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Clients from a phone's contacts file, through the same upload, preview and
 * confirm as a CSV of clients — so the same rights, the same limit, the same
 * history and the same rule that a second import updates instead of doubling.
 *
 * The cards are synthetic: a 3.0 card with two numbers, a 4.0 card writing its
 * number as a URI, a card with no phone, and a card nobody ticked.
 */
const crlf = (...lines: string[]) => `${lines.join("\r\n")}\r\n`;

const PHONE_BOOK = crlf(
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Мария Попеску",
  "TEL;TYPE=HOME:022123456",
  "TEL;TYPE=CELL:069 123 456",
  "EMAIL:maria@example.com",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Анна",
  "TEL;VALUE=uri;TYPE=cell:tel:+373-69-123-457",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Сантехник",
  "TEL:079000000",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Без Номера",
  "END:VCARD",
);

/** Maria, Anna and the contact without a number; the plumber is left out. */
const TICKED = [0, 1, 3];

function upload(text: string, options: { entity?: string; selected?: unknown } = {}) {
  const form = new FormData();
  form.set("entity", options.entity ?? "client");
  form.set("file", new File([text], "contacts.vcf", { type: "text/vcard" }));
  if (options.selected !== undefined) form.set("selected", JSON.stringify(options.selected));
  return form;
}

type UploadResponse = {
  id: string;
  source: string;
  mapping: Record<string, number | null>;
  preview: { total: number; failed_count: number };
};
type ConfirmResponse = { result: { created: number; updated: number; skipped: number; failed: number } };
type Client = { id: string; name: string; phone: string | null; email: string | null };

async function importContacts(actor: Actor, text: string, selected: unknown = TICKED) {
  const job = dataOf<UploadResponse>(await actor.post("/api/v1/imports", upload(text, { selected })));
  const confirmed = dataOf<ConfirmResponse>(await actor.post(`/api/v1/imports/${job.id}/confirm`));
  return { job, result: confirmed.result };
}

let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("vcard-owner@studio.example", "Contacts Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("clients from a phone's contacts", () => {
  test("imports the ticked contacts with no column to match", async () => {
    const { job, result } = await importContacts(studio.owner, PHONE_BOOK);

    expect(job.source).toBe("vcard");
    expect(job.mapping).toEqual({ external_id: null, name: 0, phone: 1, email: 2 });
    expect(job.preview).toMatchObject({ total: 3, failed_count: 0 });
    expect(result).toEqual({ created: 3, updated: 0, skipped: 0, failed: 0 });

    const clients = dataOf<Client[]>(await studio.owner.get("/api/v1/clients"));
    const byName = new Map(clients.map((client) => [client.name, client]));
    expect(byName.get("Мария Попеску")).toMatchObject({ phone: "+37369123456", email: "maria@example.com" });
    expect(byName.get("Анна")).toMatchObject({ phone: "+37369123457" });
    expect(byName.get("Без Номера")).toMatchObject({ phone: null });
    expect(byName.has("Сантехник")).toBe(false);
  });

  test("the same file again updates the same clients rather than adding them twice", async () => {
    const before = dataOf<Client[]>(await studio.owner.get("/api/v1/clients"));

    const { result } = await importContacts(studio.owner, PHONE_BOOK);

    expect(result).toMatchObject({ created: 0, updated: 3, failed: 0 });
    const after = dataOf<Client[]>(await studio.owner.get("/api/v1/clients"));
    expect(after.map((client) => client.id).sort()).toEqual(before.map((client) => client.id).sort());
  });

  test("a later export that writes the numbers differently is still the same people", async () => {
    // Another phone, or the same one a year on: the numbers in another form,
    // the cards in another order, and the plumber ticked this time.
    const reexport = crlf(
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Сантехник",
      "TEL:079000000",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Анна",
      "TEL;TYPE=cell:+37369123457",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Мария Попеску",
      "TEL;TYPE=CELL:+373 69 123 456",
      "END:VCARD",
    );

    const before = dataOf<Client[]>(await studio.owner.get("/api/v1/clients"));
    const { result } = await importContacts(studio.owner, reexport, [0, 1, 2]);

    expect(result).toMatchObject({ created: 1, updated: 2, failed: 0 });
    const after = dataOf<Client[]>(await studio.owner.get("/api/v1/clients"));
    expect(after).toHaveLength(before.length + 1);
  });

  test("leaves a record in the import history", async () => {
    const history = dataOf<{ entity: string; file_name: string; status: string }[]>(
      await studio.owner.get("/api/v1/imports"),
    );

    expect(history.filter((job) => job.file_name === "contacts.vcf")).toHaveLength(3);
    expect(history.every((job) => job.entity === "client" && job.status === "completed")).toBe(true);
  });

  test("refuses a master, who may not import clients", async () => {
    const master = await inviteMember(studio.owner, "vcard-master@studio.example", "master");

    const response = await master.post("/api/v1/imports", upload(PHONE_BOOK, { selected: TICKED }));

    expect(response.status).toBe(403);
    expect(errorCodeOf(response)).toBe("FORBIDDEN");
  });

  test("refuses a contacts file offered as anything but clients", async () => {
    const response = await studio.owner.post("/api/v1/imports", upload(PHONE_BOOK, { entity: "service" }));

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
  });

  test("refuses a selection that is not a list of positions", async () => {
    // Every refusal below is an upload that counts toward the hourly limit.
    await resetRateLimits();
    for (const selected of ["все", [-1], [0.5], { 0: true }]) {
      const response = await studio.owner.post("/api/v1/imports", upload(PHONE_BOOK, { selected }));
      expect(response.status).toBe(422);
    }
  });

  test("has nothing to import when nobody is ticked", async () => {
    const response = await studio.owner.post("/api/v1/imports", upload(PHONE_BOOK, { selected: [] }));

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("EMPTY_FILE");
  });
});
