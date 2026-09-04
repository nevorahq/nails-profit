import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import {
  clients,
  commissionRules,
  externalReferences,
  financialSnapshots,
  services,
  specialists,
  visitLines,
  visits,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { parseCsv } from "@/domain/csv";
import { buildPreview, suggestMapping } from "@/domain/import-mapping";
import { importTemplates, type ImportableEntity } from "@/domain/import-templates";
import { applyImport } from "@/lib/import-service";
import type { TenantTransaction } from "@/db/tenant";
import { resetDatabase } from "../helpers/database";
import {
  createClient,
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

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

  function context(tx: TenantTransaction) {
    return {
      tx,
      organizationId,
      actorUserId: userId,
      currency: "MDL" as const,
      locale: "ru" as const,
      actorRole: "owner" as const,
      // The schema default, and the zone every date in these files is written in.
      timezone: "Europe/Chisinau",
      requestId: "test-request",
    };
  }

  async function importCsv(entity: ImportableEntity, csv: string) {
    return withTenant(organizationId, async (tx) => {
      const parsed = parseCsv(csv);
      const template = importTemplates[entity];
      const mapping = suggestMapping(template, parsed.headers);
      const preview = buildPreview(template, mapping, parsed.rows);
      const outcome = await applyImport(context(tx), entity, preview.rows);
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

    it("starts the percentage on the date the file gives", async () => {
      await importCsv(
        "specialist",
        "Имя;Процент мастера;Процент действует с\nИрина;40;01.01.2026\n",
      );

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(1);
      // Midnight in Chișinău, which is UTC+2 in January.
      expect(rules[0].activeFrom.toISOString()).toBe("2025-12-31T22:00:00.000Z");
    });

    it("lays down the earlier rule a studio needs for its history", async () => {
      // The masters were set up today, so their rule starts today and no visit
      // from last spring can be costed. Re-importing with a start date has to
      // add the earlier rule rather than see 40% and decide nothing changed.
      await importCsv("specialist", "Имя;Процент мастера\nИрина;40\n");
      await importCsv(
        "specialist",
        "Имя;Процент мастера;Процент действует с\nИрина;40;01.01.2026\n",
      );

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(2);
      expect(rules.some((rule) => rule.activeFrom < new Date("2026-01-02"))).toBe(true);
    });

    it("does not stack a second rule when the dated file is imported again", async () => {
      const csv = "Имя;Процент мастера;Процент действует с\nИрина;40;01.01.2026\n";
      await importCsv("specialist", csv);
      await importCsv("specialist", csv);

      const rules = await withTenant(organizationId, (tx) => tx.select().from(commissionRules));
      expect(rules).toHaveLength(1);
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

  describe("visits", () => {
    const VISITS = ["Дата и время;Мастер;Услуга;Клиент", "03.04.2026 14:30;Ирина;Маникюр;Мария"].join(
      "\n",
    );

    /** The catalogue a visit file needs before any of its rows can be costed. */
    async function studio() {
      const specialist = await createSpecialist(organizationId, { name: "Ирина" });
      await createCommissionRule(organizationId, specialist.id, {
        basisPoints: 4_000,
        activeFrom: new Date("2026-01-01T00:00:00Z"),
      });
      const service = await createService(organizationId, {
        name: "Маникюр",
        priceMinor: 60_000,
        durationMinutes: 90,
      });
      return { specialist, service };
    }

    it("records the visit and costs it from the catalogue", async () => {
      await studio();
      const { outcome } = await importCsv("visit", VISITS);

      expect(outcome).toMatchObject({ created: 1, failed: 0 });

      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows).toHaveLength(1);
      // Neither figure is in the file: the price and the planned duration come
      // from the service, the rate from the master's rule.
      expect(rows[0].plannedDurationMinutes).toBe(90);
      expect(rows[0].commissionBasisPoints).toBe(4_000);

      const lines = await withTenant(organizationId, (tx) => tx.select().from(visitLines));
      expect(lines[0].priceMinor).toBe(60_000);

      const snapshots = await withTenant(organizationId, (tx) =>
        tx.select().from(financialSnapshots),
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].revenueMinor).toBe(60_000);
    });

    it("reads the written time as studio time, not as UTC", async () => {
      await studio();
      await importCsv("visit", VISITS);

      const [visit] = await withTenant(organizationId, (tx) => tx.select().from(visits));
      // Chișinău is UTC+3 on 3 April 2026. Storing 14:30 as 14:30Z would move
      // every visit three hours, and an evening one into the next day — which
      // is the next month's report for anything on the 30th.
      expect(visit.completedAt.toISOString()).toBe("2026-04-03T11:30:00.000Z");
    });

    it("does not record the same visit twice", async () => {
      await studio();
      await importCsv("visit", VISITS);
      const second = await importCsv("visit", VISITS);

      expect(second.outcome).toMatchObject({ created: 0, updated: 0, skipped: 1 });
      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows).toHaveLength(1);
    });

    it("leaves a closed visit at the figures it closed with when the price moves", async () => {
      // INT-008: the financial snapshot of a completed visit is not rewritten
      // automatically. Re-importing after a price rise must not restate spring.
      const { service } = await studio();
      await importCsv("visit", VISITS);
      await withTenant(organizationId, (tx) =>
        tx.update(services).set({ priceMinor: 90_000 }).where(eq(services.id, service.id)),
      );

      await importCsv("visit", VISITS);

      const snapshots = await withTenant(organizationId, (tx) =>
        tx.select().from(financialSnapshots),
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].revenueMinor).toBe(60_000);
    });

    it("fails the row whose master is unknown and keeps the rest", async () => {
      await studio();
      const { outcome } = await importCsv(
        "visit",
        [
          "Дата и время;Мастер;Услуга;Клиент",
          "03.04.2026 14:30;Ирина;Маникюр;Мария",
          "03.04.2026 16:00;Ольга;Маникюр;Анна",
        ].join("\n"),
      );

      expect(outcome).toMatchObject({ created: 1, failed: 1 });
      expect(outcome.issues[0]).toMatchObject({ code: "write_failed", line: 3 });
      expect(outcome.issues[0].value).toContain("Ольга");
    });

    it("refuses a visit whose service is not in the catalogue", async () => {
      const specialist = await createSpecialist(organizationId, { name: "Ирина" });
      await createCommissionRule(organizationId, specialist.id, {
        activeFrom: new Date("2026-01-01T00:00:00Z"),
      });

      const { outcome } = await importCsv("visit", VISITS);

      expect(outcome).toMatchObject({ created: 0, failed: 1 });
      expect(outcome.issues[0].value).toContain("Маникюр");
    });

    it("refuses a visit for a master with no commission rule", async () => {
      // Recording it would report the master's payout as zero, and a zero reads
      // as an answer rather than as a missing agreement.
      await createSpecialist(organizationId, { name: "Ирина" });
      await createService(organizationId, { name: "Маникюр" });

      const { outcome } = await importCsv("visit", VISITS);

      expect(outcome).toMatchObject({ created: 0, failed: 1 });
      expect(outcome.issues[0].value).toContain("правила комиссии");
      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows).toEqual([]);
    });

    it("refuses a visit that predates the master's rule", async () => {
      // The trap the specialist file's start date exists for: a master set up
      // today earns nothing on a visit from last month, so the row is refused
      // rather than costed at a commission of zero.
      const specialist = await createSpecialist(organizationId, { name: "Ирина" });
      await createCommissionRule(organizationId, specialist.id, { activeFrom: new Date() });
      await createService(organizationId, { name: "Маникюр", durationMinutes: 90 });

      const { outcome } = await importCsv(
        "visit",
        "Дата и время;Мастер;Услуга\n03.04.2020 14:30;Ирина;Маникюр\n",
      );

      expect(outcome).toMatchObject({ created: 0, failed: 1 });
      expect(outcome.issues[0].value).toContain("правила комиссии");
    });

    it("links the client the studio already has", async () => {
      await studio();
      const client = await createClient(organizationId, { name: "Мария" });

      await importCsv("visit", VISITS);

      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows[0].clientId).toBe(client.id);
      const everyone = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(everyone).toHaveLength(1);
    });

    it("creates a client the visit file names for the first time", async () => {
      await studio();
      await importCsv("visit", VISITS);

      const everyone = await withTenant(organizationId, (tx) => tx.select().from(clients));
      expect(everyone.map((row) => row.name)).toEqual(["Мария"]);
    });

    it("records a visit that names no client", async () => {
      await studio();
      const { outcome } = await importCsv(
        "visit",
        "Дата и время;Мастер;Услуга\n03.04.2026 14:30;Ирина;Маникюр\n",
      );

      expect(outcome.created).toBe(1);
      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows[0].clientId).toBeNull();
      expect(await withTenant(organizationId, (tx) => tx.select().from(clients))).toEqual([]);
    });

    it("keeps the actual duration the file gives", async () => {
      await studio();
      await importCsv(
        "visit",
        "Дата и время;Мастер;Услуга;Фактическая длительность\n03.04.2026 14:30;Ирина;Маникюр;1:45\n",
      );

      const rows = await withTenant(organizationId, (tx) => tx.select().from(visits));
      expect(rows[0].actualDurationMinutes).toBe(105);
      expect(rows[0].plannedDurationMinutes).toBe(90);
    });

    it("keeps two visits one master did for two clients on one day", async () => {
      await studio();
      const { preview, outcome } = await importCsv(
        "visit",
        ["Дата;Мастер;Услуга;Клиент", "03.04.2026;Ирина;Маникюр;Мария", "03.04.2026;Ирина;Маникюр;Анна"].join(
          "\n",
        ),
      );

      // The client is in the natural key for exactly this file — a date with no
      // time. Without it both rows fingerprint the same and the second is
      // dropped as a duplicate of the first.
      expect(preview.skipped).toEqual([]);
      expect(outcome.created).toBe(2);
    });

    it("refuses a row whose date never parsed", async () => {
      await studio();
      // The preview would have failed this row. The guard is what stops a
      // caller that skipped the preview from recording a visit at the epoch.
      const outcome = await withTenant(organizationId, (tx) =>
        applyImport(context(tx), "visit", [
          {
            line: 2,
            externalId: "V-1",
            identityKind: "external",
            values: {
              date: null,
              specialist: "Ирина",
              service: "Маникюр",
              client: null,
              actual_duration: null,
            },
            raw: { date: "позавчера" },
            warnings: [],
          },
        ]),
      );

      expect(outcome).toMatchObject({ created: 0, failed: 1 });
      expect(outcome.issues[0].value).toContain("позавчера");
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
