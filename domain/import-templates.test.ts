import { describe, expect, it } from "vitest";

import { parseCsv } from "@/domain/csv";
import { toCsv } from "@/domain/csv-safety";
import { buildPreview, suggestMapping } from "@/domain/import-mapping";
import { importTemplates, importableEntities, templateSample } from "@/domain/import-templates";

describe("downloadable templates", () => {
  it.each(importableEntities)("%s survives download, fill and upload", (entity) => {
    // The round trip the owner actually performs. If our own file does not map
    // back without a manual correction, no one else's will either — and the
    // thirty minutes Gate 4 allows for a first calculation are gone.
    const template = importTemplates[entity];
    const file = new TextEncoder().encode(toCsv(templateSample(entity)));

    const parsed = parseCsv(file);
    const mapping = suggestMapping(template, parsed.headers);
    const result = buildPreview(template, mapping, parsed.rows);

    expect(result.missingRequiredFields).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toHaveLength(templateSample(entity).length - 1);
  });

  it.each(importableEntities)("%s sample has one cell per column", (entity) => {
    const [headers, ...rows] = templateSample(entity);
    for (const row of rows) expect(row).toHaveLength(headers.length);
  });

  it.each(importableEntities)("%s maps every field it declares", (entity) => {
    const template = importTemplates[entity];
    const mapping = suggestMapping(
      template,
      template.fields.map((field) => field.label),
    );

    const unmapped = Object.entries(mapping)
      .filter(([, column]) => column === null)
      .map(([key]) => key);
    expect(unmapped).toEqual([]);
  });

  it.each(importableEntities)("%s natural key names real fields", (entity) => {
    const template = importTemplates[entity];
    const keys = template.fields.map((field) => field.key);
    for (const part of template.naturalKey) expect(keys).toContain(part);
  });
});
