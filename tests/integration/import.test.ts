import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import { clients, commissionRules, externalReferences, services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { parseCsv } from "@/domain/csv";
import { buildPreview, suggestMapping } from "@/domain/import-mapping";
import { importTemplates, type ImportableEntity } from "@/domain/import-templates";
import { applyImport } from "@/lib/import-service";
import { resetDatabase } from "../helpers/database";
import { createOrganization, createService, createUser } from "../helpers/factories";

/**
 * Gate 4: "повторный импорт не создаёт дубли". Checked against real rows,
 * because the failure mode is silent — nothing errors, the catalogue simply
 * doubles, and the owner discovers it a week later.
 */
describe("CSV import", () => {
  let organizationId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
  });

  async function importCsv(entity: ImportableEntity, csv: string) {
    return withTenant(organizationId, async (tx) => {
      const parsed = parseCsv(csv);
      const template = importTemplates[entity];
      const mapping = suggestMapping(template, parsed.headers);
      const preview = buildPreview(template, mapping, parsed.rows);
      const outcome = await applyImport(
        { tx, organizationId, actorUserId: userId, currency: "MDL", locale: "ru" },
        entity,
        preview.rows,
      );
      return { preview, outcome };
    });
  }

  const SERVICES = [
    "Название;Цена;Длительность",
    "Маникюр;600;90",
    "Педикюр;700;120",
  ].join("\n");

  describe("identity", () => {
    it("creates the catalogue", async () => {
      const { outcome } = await importCsv("service", SERVICES);

      expect(outcome).toMatchObject({ created: 2, updated: 0, failed: 0 });

      const rows = await withTenant(organizationId, (tx) =>
        tx.select().from(services).where(isNull(services.archivedAt)),
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.priceMinor).sort()).toEqual([60_000, 70_000]);
    });

    it("does not duplicate anything on a second import of the same file", async () => {
      await importCsv("service", SERVICES);
      const second = await importCsv("service", SERVICES);

      expect(second.outcome).toMatchObject({ created: 0, updated: 2 });

      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows).toHaveLength(2);
    });

    it("links to a service the owner had already typed by hand", async () => {
      // The first import of a price list must not duplicate the catalogue the
      // owner built before they discovered import existed.
      await createService(organizationId, { name: "Маникюр" });

      const { outcome } = await importCsv("service", SERVICES);

      expect(outcome).toMatchObject({ created: 1, updated: 1 });
      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows).toHaveLength(2);
    });

    it("matches a hand-created service whatever its capitalization", async () => {
      await createService(organizationId, { name: "МАНИКЮР" });
      const { outcome } = await importCsv("service", "Название;Цена\nманикюр;600\n");

      expect(outcome).toMatchObject({ created: 0, updated: 1 });
    });

    it("records how each row was identified", async () => {
      await importCsv("service", "ID;Название;Цена\nSRV-1;Маникюр;600\n;Педикюр;700\n");

      const references = await withTenant(organizationId, (tx) =>
        tx.select().from(externalReferences),
      );

      expect(references).toHaveLength(2);
      expect(references.map((reference) => reference.idKind).sort()).toEqual([
        "external",
        "fingerprint",
      ]);
    });

    it("follows the external id when the name changes", async () => {
      // A renamed row is the case only the external id survives — the
      // fingerprint is derived from the name and would create a second row.
      await importCsv("service", "ID;Название;Цена\nSRV-1;Маникюр;600\n");
      const { outcome } = await importCsv("service", "ID;Название;Цена\nSRV-1;Маникюр премиум;600\n");

      expect(outcome).toMatchObject({ created: 0, updated: 1 });
      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toEqual({ ru: "Маникюр премиум" });
    });

    it("writes the good rows and reports the broken one", async () => {
      const { preview, outcome } = await importCsv(
        "service",
        ["Название;Цена", "Маникюр;600", "Педикюр;по запросу", "Наращивание;900"].join("\n"),
      );

      expect(outcome.created).toBe(2);
      expect(preview.failed).toHaveLength(1);
      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows.map((row) => (row.name as { ru: string }).ru).sort()).toEqual([
        "Маникюр",
        "Наращивание",
      ]);
    });
  });

  describe("services", () => {
    it("stores the name under the organization locale", async () => {
      await importCsv("service", "Название;Цена;Длительность\nМаникюр;600;90\n");

      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows[0].name).toEqual({ ru: "Маникюр" });
      expect(rows[0].priceMinor).toBe(60_000);
      expect(rows[0].durationMinutes).toBe(90);
      expect(rows[0].currency).toBe("MDL");
    });

    it("imports a service with no price rather than rejecting it", async () => {
      const { outcome } = await importCsv("service", "Название;Цена;Длительность\nМаникюр;;90\n");

      expect(outcome.created).toBe(1);
      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows[0].priceMinor).toBeNull();
    });

    it("does not clear an existing price when the cell is blank", async () => {
      // A blank cell means "not in this file", not "make this service free".
      // Overwriting with null would silently un-cost the service.
      await importCsv("service", "Название;Цена;Длительность\nМаникюр;600;90\n");
      await importCsv("service", "Название;Цена;Длительность\nМаникюр;;90\n");

      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows[0].priceMinor).toBe(60_000);
    });

    it("keeps other locales when re-importing a renamed service", async () => {
      await importCsv("service", "ID;Название;Цена\nS-1;Маникюр;600\n");
      await withTenant(organizationId, (tx) =>
        tx.update(services).set({ name: { ru: "Маникюр", ro: "Manichiură" } }),
      );

      await importCsv("service", "ID;Название;Цена\nS-1;Маникюр классический;600\n");

      const rows = await withTenant(organizationId, (tx) => tx.select().from(services));
      expect(rows[0].name).toEqual({ ru: "Маникюр классический", ro: "Manichiură" });
    });
  });

  describe("specialists", () => {
    it("creates the master and their commission rule", async () => {
      await importCsv("specialist", "Имя;Формат работы;Процент мастера\nИрина;commission;40\n");

      const people = await withTenant(organizationId, (tx) => tx.select().from(specialists));
      expect(people[0].name).toBe("Ирина");

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(1);
      expect(rules[0].basisPoints).toBe(4_000);
    });

    it("does not add a rule when the percentage is unchanged", async () => {
      // Commission rules are versioned by activeFrom (CST-009); writing one per
      // import would rewrite the master's history every run.
      const csv = "Имя;Формат работы;Процент мастера\nИрина;commission;40\n";
      await importCsv("specialist", csv);
      await importCsv("specialist", csv);

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(1);
    });

    it("adds a rule when the percentage changes", async () => {
      await importCsv("specialist", "Имя;Процент мастера\nИрина;40\n");
      await importCsv("specialist", "Имя;Процент мастера\nИрина;45\n");

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(2);
    });
  });

  describe("clients", () => {
    it("stores the phone in E.164", async () => {
      await importCsv("client", "Имя;Телефон\nМария;069 123 456\n");

      const rows = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(rows[0].normalizedPhone).toBe("+37369123456");
    });

    it("recognises the same client written with a different format", async () => {
      await importCsv("client", "Имя;Телефон\nМария;069 123 456\n");
      const { outcome } = await importCsv("client", "Имя;Телефон\nМария Ион;+373 69 123 456\n");

      expect(outcome).toMatchObject({ created: 0, updated: 1 });
      const rows = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Мария Ион");
    });

    it("refuses to merge two source records that share a phone", async () => {
      // Two external ids are the source system's assertion that these are two
      // clients. Merging them on a shared phone would overwrite Мария with
      // Ольга and lose a client with nothing reported.
      await importCsv("client", "ID;Имя;Телефон\nC-1;Мария;069123456\n");
      const { outcome } = await importCsv("client", "ID;Имя;Телефон\nC-3;Ольга;069123456\n");

      expect(outcome.failed).toBe(1);
      const rows = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(rows.map((row) => row.name)).toEqual(["Мария"]);
    });

    it("keeps the rest of the file when one row breaks a database constraint", async () => {
      // Two rows claiming one phone number is a unique-index violation, not a
      // validation error — INT-005 still has to hold at that level, so a
      // savepoint per row keeps the other two.
      const { outcome } = await importCsv(
        "client",
        [
          "ID;Имя;Телефон",
          "C-1;Мария;069123456",
          "C-2;Анна;069123457",
          "C-3;Ольга;069123456",
        ].join("\n"),
      );

      expect(outcome.created).toBe(2);
      expect(outcome.failed).toBe(1);
      expect(outcome.issues[0]).toMatchObject({ code: "write_failed", line: 4 });

      const rows = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(rows.map((row) => row.name).sort()).toEqual(["Анна", "Мария"]);
    });
  });

  it("never reaches another organization's rows", async () => {
    const other = await createOrganization({ name: "Other" });
    await createService(other.id, { name: "Маникюр" });

    const { outcome } = await importCsv("service", SERVICES);

    // The other organization's service must not be found and updated.
    expect(outcome.created).toBe(2);

    const theirs = await withTenant(other.id, (tx) => tx.select().from(services));
    expect(theirs).toHaveLength(1);

    const references = await withTenant(other.id, (tx) =>
      tx
        .select()
        .from(externalReferences)
        .where(and(eq(externalReferences.provider, "csv"))),
    );
    expect(references).toEqual([]);
  });
});
