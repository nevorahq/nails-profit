import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * Spec section 17.4, end-to-end scenario D.
 *
 * A thousand valid rows and twenty broken ones, uploaded the way a browser
 * uploads them: multipart form data, a mapping step, a confirm. The scenario
 * asks for three things and this checks all three — the valid rows land, every
 * bad row is reported with its line number and a reason, and importing the same
 * file again does not create a second catalogue.
 */
const VALID_ROWS = 1_000;
const INVALID_ROWS = 20;

function buildCsv() {
  const lines = ["Наименование;Единица;Объём упаковки;Цена закупки"];

  for (let index = 1; index <= VALID_ROWS; index += 1) {
    lines.push(`Материал ${index};ml;10;240,55`);
  }

  // Broken the way a real file is broken: a unit nobody's importer knows.
  for (let index = 1; index <= INVALID_ROWS; index += 1) {
    lines.push(`Битый ${index};литр;10;240,55`);
  }

  return lines.join("\r\n");
}

function upload(csv: string, fileName = "materials.csv") {
  const form = new FormData();
  form.set("entity", "material");
  form.set("file", new File([csv], fileName, { type: "text/csv" }));
  return form;
}

type UploadResponse = {
  id: string;
  mapping: Record<string, number | null>;
  preview: { failed: { line: number; issues: { line: number; field: string; code: string }[] }[] };
};

type ConfirmResponse = {
  result: { created: number; updated: number; skipped: number; failed: number };
  issues: { line: number; field: string; code: string; value: string }[];
};

describe("scenario D: import", () => {
  let owner: Actor;
  const csv = buildCsv();

  beforeAll(async () => {
    await resetDatabase();
    owner = await signUp("importer@studio.example");
    await owner.post("/api/v1/organizations", { name: "Import Studio", type: "solo" });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("the valid rows import and the broken ones are reported by line", async () => {
    const job = dataOf<UploadResponse>(await owner.post("/api/v1/imports", upload(csv)));

    // Every required column was recognised from its Russian header, so the
    // owner confirms without touching the mapping.
    expect(job.mapping).toMatchObject({ name: 0, base_unit: 1, package_size: 2, package_price: 3 });

    const confirmed = dataOf<ConfirmResponse>(await owner.post(`/api/v1/imports/${job.id}/confirm`));

    expect(confirmed.result).toMatchObject({
      created: VALID_ROWS,
      updated: 0,
      failed: INVALID_ROWS,
    });

    expect(confirmed.issues).toHaveLength(INVALID_ROWS);
    for (const issue of confirmed.issues) {
      expect(issue.field).toBe("base_unit");
      expect(issue.code).toBeTruthy();
      expect(issue.value).toBe("литр");
    }

    // Line numbers point into the file as Excel shows it: the header is line 1,
    // so the first broken row is the one after the last good one.
    const lines = confirmed.issues.map((issue) => issue.line).sort((a, b) => a - b);
    expect(lines[0]).toBe(VALID_ROWS + 2);
    expect(lines.at(-1)).toBe(VALID_ROWS + INVALID_ROWS + 1);

    const materials = dataOf<{ id: string; current_price: { package_price_minor: number } | null }[]>(
      await owner.get("/api/v1/materials"),
    );
    expect(materials).toHaveLength(VALID_ROWS);
    // "240,55" is a comma-decimal price read through strings, not parseFloat.
    expect(materials[0].current_price?.package_price_minor).toBe(24_055);
  });

  test("the same file again updates rather than duplicates", async () => {
    const job = dataOf<UploadResponse>(await owner.post("/api/v1/imports", upload(csv)));
    const confirmed = dataOf<ConfirmResponse>(await owner.post(`/api/v1/imports/${job.id}/confirm`));

    expect(confirmed.result).toMatchObject({ created: 0, updated: VALID_ROWS, failed: INVALID_ROWS });

    const materials = dataOf<unknown[]>(await owner.get("/api/v1/materials"));
    expect(materials).toHaveLength(VALID_ROWS);
  });

  test("a confirmed job cannot be applied twice", async () => {
    const job = dataOf<UploadResponse>(await owner.post("/api/v1/imports", upload(csv)));
    await owner.post(`/api/v1/imports/${job.id}/confirm`);

    // INT-004: a double-clicked confirm is not a second import.
    const again = await owner.post(`/api/v1/imports/${job.id}/confirm`);
    expect(again.status).toBe(409);

    const materials = dataOf<unknown[]>(await owner.get("/api/v1/materials"));
    expect(materials).toHaveLength(VALID_ROWS);
  });
});
