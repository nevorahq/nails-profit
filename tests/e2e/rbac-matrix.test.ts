import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { memberRoles, type MemberRole } from "@/domain/rbac";
import { anonymous, dataOf, listRoutes, loadRoute, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The negative tests the release gate asks for by name (spec section 17.6:
 * "tenant isolation и RBAC прошли отдельные negative tests").
 *
 * `domain/rbac.test.ts` checks that the matrix module encodes section 6.1. This
 * checks something else: that every endpoint asks it. The expectations below
 * are written out from the specification by hand rather than derived from
 * `roleCapabilities` — a test that computes its expectation from the module
 * under test agrees with any bug that module has.
 *
 * Section 6.1 is explicit that this is where access control lives: "Права
 * должны проверяться backend-слоем. Скрытие кнопки в интерфейсе не считается
 * контролем доступа."
 */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Fixture = Readonly<{
  studio: Studio;
  actors: Readonly<Record<MemberRole, Actor>>;
  clientId: string;
  visitId: string;
  addOnId: string;
  otherOrganization: Readonly<{ owner: Actor; serviceId: string; specialistId: string }>;
}>;

type Case = Readonly<{
  /** The route file's own pattern, so coverage can be checked against the tree. */
  route: string;
  method: Method;
  allowed: readonly MemberRole[];
  /** Public infrastructure endpoints are still listed so route coverage cannot hide them. */
  public?: boolean;
  /** The section 6.1 cell this encodes, or why the endpoint has no cell. */
  note: string;
  request: (fixture: Fixture) => Promise<{ path: string; body?: Record<string, unknown> }>;
}>;

const ALL_ROLES = memberRoles;
const CATALOGUE_MANAGERS: readonly MemberRole[] = ["owner", "manager"];

/** A one-row file, so an import job can be created on demand. */
function importForm() {
  const form = new FormData();
  form.set("entity", "material");
  form.set(
    "file",
    new File(["Наименование;Единица;Объём упаковки;Цена закупки\r\nТоп;ml;10;120"], "one.csv", {
      type: "text/csv",
    }),
  );
  return form;
}

async function freshImportJob(fixture: Fixture) {
  const form = importForm();
  const response = await fixture.studio.owner.post("/api/v1/imports", form);
  return dataOf<{ id: string }>(response).id;
}

async function freshInvitation(fixture: Fixture) {
  const email = `revoked-${crypto.randomUUID()}@studio.example`;
  return dataOf<{ id: string }>(
    await fixture.studio.owner.post("/api/v1/invitations", { email, role: "master" }),
  ).id;
}

const cases: readonly Case[] = [
  {
    route: "/api/health",
    method: "GET",
    allowed: ALL_ROLES,
    public: true,
    note: "Public liveness/readiness probe; response contains no tenant or deployment data",
    request: async () => ({ path: "/api/health" }),
  },
  {
    route: "/api/v1/organizations",
    method: "GET",
    allowed: ALL_ROLES,
    note: "Own memberships, not tenant data",
    request: async () => ({ path: "/api/v1/organizations" }),
  },
  {
    route: "/api/v1/organizations",
    method: "POST",
    allowed: ALL_ROLES,
    note: "Any account may found an organization; membership makes it a 409, not a 403",
    request: async () => ({ path: "/api/v1/organizations", body: { name: "Second", type: "solo" } }),
  },
  {
    route: "/api/v1/organizations/settings",
    method: "PATCH",
    allowed: ["owner"],
    note: "organization_settings: Owner да, остальные нет",
    request: async () => ({ path: "/api/v1/organizations/settings", body: { locale: "ro" } }),
  },
  {
    route: "/api/v1/organizations/export",
    method: "GET",
    allowed: ["owner"],
    note: "data_export: Owner да, Manager нет",
    request: async () => ({ path: "/api/v1/organizations/export" }),
  },
  {
    route: "/api/v1/organizations/delete",
    method: "POST",
    allowed: ["owner"],
    note: "data_export write: Owner alone. The name is wrong on purpose — a 422, not a deleted fixture",
    request: async () => ({ path: "/api/v1/organizations/delete", body: { confirmation_name: "wrong" } }),
  },
  {
    route: "/api/v1/materials",
    method: "GET",
    allowed: ALL_ROLES,
    note: "materials read: all four roles",
    request: async () => ({ path: "/api/v1/materials" }),
  },
  {
    route: "/api/v1/materials",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "Master's materials write is scope own — consumption, not the shared catalogue",
    request: async () => ({ path: "/api/v1/materials", body: { name: "Проба", base_unit: "ml" } }),
  },
  {
    route: "/api/v1/materials/[id]/prices",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "A purchase price is catalogue data everyone is costed by",
    request: async (fixture) => ({
      path: `/api/v1/materials/${fixture.studio.materialId}/prices`,
      body: { package_price_minor: 10_000, package_size: 10 },
    }),
  },
  {
    route: "/api/v1/materials/starter",
    method: "GET",
    allowed: ALL_ROLES,
    note: "A static list of names, no tenant data",
    request: async () => ({ path: "/api/v1/materials/starter" }),
  },
  {
    route: "/api/v1/materials/starter",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "Writes the shared catalogue",
    request: async () => ({ path: "/api/v1/materials/starter" }),
  },
  {
    route: "/api/v1/services",
    method: "GET",
    allowed: ALL_ROLES,
    note: "services read: Master и Analyst — чтение",
    request: async () => ({ path: "/api/v1/services" }),
  },
  {
    route: "/api/v1/services",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "services write: Owner и Manager",
    request: async () => ({ path: "/api/v1/services", body: { name: { ru: "Новая" }, price_minor: 1_000 } }),
  },
  {
    route: "/api/v1/services/[id]",
    method: "GET",
    allowed: ALL_ROLES,
    note: "services read",
    request: async (fixture) => ({ path: `/api/v1/services/${fixture.studio.serviceId}` }),
  },
  {
    route: "/api/v1/services/[id]",
    method: "PATCH",
    allowed: CATALOGUE_MANAGERS,
    note: "services write",
    request: async (fixture) => ({
      path: `/api/v1/services/${fixture.studio.serviceId}`,
      body: { price_minor: 60_000 },
    }),
  },
  {
    route: "/api/v1/services/[id]/recipe",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "A recipe is the norm every master is measured against",
    request: async (fixture) => ({
      path: `/api/v1/services/${fixture.studio.serviceId}/recipe`,
      body: { items: [{ material_id: fixture.studio.materialId, quantity: 3.5 }] },
    }),
  },
  {
    route: "/api/v1/services/[id]/add-ons",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "services write",
    request: async (fixture) => ({
      path: `/api/v1/services/${fixture.studio.serviceId}/add-ons`,
      body: { add_on_ids: [fixture.addOnId] },
    }),
  },
  {
    route: "/api/v1/add-ons",
    method: "GET",
    allowed: ALL_ROLES,
    note: "services read",
    request: async () => ({ path: "/api/v1/add-ons" }),
  },
  {
    route: "/api/v1/add-ons",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "services write",
    request: async () => ({ path: "/api/v1/add-ons", body: { name: { ru: "Опция" } } }),
  },
  {
    route: "/api/v1/add-ons/[id]/recipe",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "materials write, scope all",
    request: async (fixture) => ({
      path: `/api/v1/add-ons/${fixture.addOnId}/recipe`,
      body: { items: [{ material_id: fixture.studio.materialId, quantity: 1 }] },
    }),
  },
  {
    route: "/api/v1/specialists",
    method: "GET",
    allowed: ALL_ROLES,
    note: "commissions read; a Master's scope narrows the rows, not the access",
    request: async () => ({ path: "/api/v1/specialists" }),
  },
  {
    route: "/api/v1/specialists",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "A master must not edit the rule they are paid by",
    request: async () => ({ path: "/api/v1/specialists", body: { name: "Новый мастер" } }),
  },
  {
    route: "/api/v1/specialists/[id]",
    method: "PATCH",
    allowed: CATALOGUE_MANAGERS,
    note: "Linking an account decides who sees which visits",
    request: async (fixture) => ({
      path: `/api/v1/specialists/${fixture.studio.specialistId}`,
      body: { name: "Мастер" },
    }),
  },
  {
    route: "/api/v1/specialists/[id]/commission-rules",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "Комиссии мастеров: Owner и Manager управляют",
    request: async (fixture) => ({
      path: `/api/v1/specialists/${fixture.studio.specialistId}/commission-rules`,
      body: { type: "percentage", basis_points: 4_000 },
    }),
  },
  {
    route: "/api/v1/visits",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read; a Master sees their own, an Analyst reads",
    request: async () => ({ path: "/api/v1/visits" }),
  },
  {
    route: "/api/v1/visits",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; the Master's own specialist is the fixture's",
    request: async (fixture) => ({
      path: "/api/v1/visits",
      body: {
        service_id: fixture.studio.serviceId,
        specialist_id: fixture.studio.specialistId,
        actual_duration_minutes: 90,
      },
    }),
  },
  {
    route: "/api/v1/visits/[id]/adjust",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write, own visit for a Master",
    request: async (fixture) => ({
      path: `/api/v1/visits/${fixture.visitId}/adjust`,
      body: { actual_duration_minutes: 95 },
    }),
  },
  {
    route: "/api/v1/clients",
    method: "GET",
    allowed: ALL_ROLES,
    note: "clients read; an Analyst without phone and email, a Master only their own",
    request: async () => ({ path: "/api/v1/clients" }),
  },
  {
    route: "/api/v1/clients",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "clients write; an Analyst reads only",
    request: async () => ({ path: "/api/v1/clients", body: { name: `Клиент ${crypto.randomUUID()}` } }),
  },
  {
    route: "/api/v1/invitations",
    method: "GET",
    allowed: CATALOGUE_MANAGERS,
    note: "user_management: Owner да, Manager кроме Owner, остальные нет",
    request: async () => ({ path: "/api/v1/invitations" }),
  },
  {
    route: "/api/v1/invitations",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "user_management write",
    request: async () => ({
      path: "/api/v1/invitations",
      body: { email: `new-${crypto.randomUUID()}@studio.example`, role: "master" },
    }),
  },
  {
    route: "/api/v1/invitations/[id]",
    method: "DELETE",
    allowed: CATALOGUE_MANAGERS,
    note: "user_management write",
    request: async (fixture) => ({ path: `/api/v1/invitations/${await freshInvitation(fixture)}` }),
  },
  {
    route: "/api/v1/invitations/accept",
    method: "POST",
    allowed: ALL_ROLES,
    note: "Accepting is an account's own act; an invalid token is 404, never 403",
    request: async () => ({ path: "/api/v1/invitations/accept", body: { token: "not-a-token" } }),
  },
  {
    route: "/api/v1/me/permissions",
    method: "GET",
    allowed: ALL_ROLES,
    note: "The caller's own capability list",
    request: async () => ({ path: "/api/v1/me/permissions" }),
  },
  {
    route: "/api/v1/imports",
    method: "GET",
    allowed: ALL_ROLES,
    note: "Filtered to what the role may import, so a Master sees an empty history",
    request: async () => ({ path: "/api/v1/imports" }),
  },
  {
    route: "/api/v1/imports",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "Importing materials is a catalogue write",
    request: async () => ({ path: "/api/v1/imports" }),
  },
  {
    route: "/api/v1/imports/[id]",
    method: "GET",
    allowed: CATALOGUE_MANAGERS,
    note: "The detail carries the file's own rows; reading them is importing them",
    request: async (fixture) => ({ path: `/api/v1/imports/${await freshImportJob(fixture)}` }),
  },
  {
    route: "/api/v1/imports/[id]",
    method: "PATCH",
    allowed: CATALOGUE_MANAGERS,
    note: "Re-mapping columns is part of the import",
    request: async (fixture) => ({
      path: `/api/v1/imports/${await freshImportJob(fixture)}`,
      body: { mapping: { name: 0 } },
    }),
  },
  {
    route: "/api/v1/imports/[id]/confirm",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "Applying the file writes the catalogue",
    request: async (fixture) => ({ path: `/api/v1/imports/${await freshImportJob(fixture)}/confirm` }),
  },
  {
    route: "/api/v1/imports/templates/[entity]",
    method: "GET",
    allowed: ALL_ROLES,
    note: "An empty CSV template; no tenant data in it",
    request: async () => ({ path: "/api/v1/imports/templates/material" }),
  },
];

async function send(actor: Actor, method: Method, path: string, body?: Record<string, unknown>) {
  // The import upload is the one multipart endpoint; everything else is JSON.
  if (path === "/api/v1/imports" && method === "POST") return actor.post(path, importForm());

  switch (method) {
    case "GET":
      return actor.get(path);
    case "POST":
      return actor.post(path, body);
    case "PUT":
      return actor.put(path, body);
    case "PATCH":
      return actor.patch(path, body);
    case "DELETE":
      return actor.delete(path, body);
  }
}

describe("RBAC and tenant isolation", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    const studio = await createCanonicalStudio("matrix-owner@studio.example", "Matrix Studio");

    const manager = await inviteMember(studio.owner, "matrix-manager@studio.example", "manager");
    const master = await inviteMember(studio.owner, "matrix-master@studio.example", "master");
    const analyst = await inviteMember(studio.owner, "matrix-analyst@studio.example", "analyst");

    // Section 6.1's "own" scopes resolve through this link; without it the
    // Master role has no rows of its own and the matrix would prove nothing.
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

    const clientId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", { name: "Клиент матрицы" }),
    ).id;

    const visitId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        client_id: clientId,
        actual_duration_minutes: 90,
      }),
    ).id;

    const addOnId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/add-ons", { name: { ru: "Дизайн" }, price_delta_minor: 5_000 }),
    ).id;

    const otherOwner = await (await import("../helpers/studio")).createCanonicalStudio(
      "other-owner@studio.example",
      "Other Studio",
    );

    fixture = {
      studio,
      actors: { owner: studio.owner, manager, master, analyst },
      clientId,
      visitId,
      addOnId,
      otherOrganization: {
        owner: otherOwner.owner,
        serviceId: otherOwner.serviceId,
        specialistId: otherOwner.specialistId,
      },
    };
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("every endpoint is in the matrix", async () => {
    const declared = new Set(cases.map((entry) => `${entry.method} ${entry.route}`));
    const missing: string[] = [];

    for (const route of listRoutes()) {
      const handlers = await loadRoute(route.file);
      const path = `/${route.pattern.join("/")}`;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        if (typeof handlers[method] !== "function") continue;
        if (!declared.has(`${method} ${path}`)) missing.push(`${method} ${path}`);
      }
    }

    // A new endpoint that nobody wrote a row for is the way an access-control
    // hole ships: this fails until its permission is stated here on purpose.
    expect(missing).toEqual([]);
  });

  for (const role of ALL_ROLES) {
    describe(role, () => {
      for (const entry of cases) {
        const permitted = entry.allowed.includes(role);
        const label = `${permitted ? "may" : "may not"} ${entry.method} ${entry.route} — ${entry.note}`;

        test(label, async () => {
          const { path, body } = await entry.request(fixture);
          const response = await send(fixture.actors[role], entry.method, path, body);

          if (permitted) {
            expect(response.status).not.toBe(403);
            expect(response.status).not.toBe(401);
          } else {
            expect(response.status).toBe(403);
          }
        });
      }
    });
  }

  describe("without a session", () => {
    for (const entry of cases) {
      test(`${entry.method} ${entry.route} ${entry.public ? "is public" : "is refused"}`, async () => {
        const { path, body } = await entry.request(fixture);
        const response = await send(anonymous, entry.method, path, body);
        expect(response.status).toBe(entry.public ? 200 : 401);
      });
    }
  });

  describe("across organizations", () => {
    // Bodies are valid on purpose: a request rejected at validation would never
    // reach the lookup, and the probe would prove nothing about isolation.
    const probes: readonly {
      method: Method;
      label: string;
      path: (fixture: Fixture) => Promise<string> | string;
      body?: Record<string, unknown>;
    }[] = [
      { method: "GET", label: "service", path: (f) => `/api/v1/services/${f.studio.serviceId}` },
      {
        method: "PATCH",
        label: "service",
        path: (f) => `/api/v1/services/${f.studio.serviceId}`,
        body: { price_minor: 1_000 },
      },
      {
        method: "PUT",
        label: "recipe",
        path: (f) => `/api/v1/services/${f.studio.serviceId}/recipe`,
        body: { items: [] },
      },
      {
        method: "PUT",
        label: "service add-ons",
        path: (f) => `/api/v1/services/${f.studio.serviceId}/add-ons`,
        body: { add_on_ids: [] },
      },
      {
        method: "POST",
        label: "material price",
        path: (f) => `/api/v1/materials/${f.studio.materialId}/prices`,
        body: { package_price_minor: 1_000, package_size: 1 },
      },
      {
        method: "PUT",
        label: "add-on recipe",
        path: (f) => `/api/v1/add-ons/${f.addOnId}/recipe`,
        body: { items: [] },
      },
      {
        method: "PATCH",
        label: "specialist",
        path: (f) => `/api/v1/specialists/${f.studio.specialistId}`,
        body: { name: "Чужое" },
      },
      {
        method: "POST",
        label: "commission rule",
        path: (f) => `/api/v1/specialists/${f.studio.specialistId}/commission-rules`,
        body: { type: "percentage", basis_points: 1_000 },
      },
      {
        method: "POST",
        label: "visit adjustment",
        path: (f) => `/api/v1/visits/${f.visitId}/adjust`,
        body: { actual_duration_minutes: 90 },
      },
      { method: "GET", label: "import job", path: async (f) => `/api/v1/imports/${await freshImportJob(f)}` },
      {
        method: "PATCH",
        label: "import mapping",
        path: async (f) => `/api/v1/imports/${await freshImportJob(f)}`,
        body: { mapping: { name: 0 } },
      },
      {
        method: "POST",
        label: "import confirm",
        path: async (f) => `/api/v1/imports/${await freshImportJob(f)}/confirm`,
      },
    ];

    for (const probe of probes) {
      test(`${probe.method} of another organization's ${probe.label} answers 404`, async () => {
        const path = await probe.path(fixture);
        const response = await send(fixture.otherOrganization.owner, probe.method, path, probe.body);

        // 404, not 403: RLS makes another tenant's row invisible rather than
        // forbidden, so the answer never confirms that the id exists (§6.2).
        expect(response.status).toBe(404);
      });
    }

    test("collections show nothing from the other organization", async () => {
      const other = fixture.otherOrganization.owner;

      expect(dataOf<unknown[]>(await other.get("/api/v1/clients"))).toHaveLength(0);
      expect(dataOf<unknown[]>(await other.get("/api/v1/visits"))).toHaveLength(0);
      expect(dataOf<unknown[]>(await other.get("/api/v1/add-ons"))).toHaveLength(0);
      expect(dataOf<unknown[]>(await other.get("/api/v1/invitations"))).toHaveLength(0);
      expect(dataOf<unknown[]>(await other.get("/api/v1/imports"))).toHaveLength(0);

      // The other studio has exactly its own canonical service and material.
      expect(dataOf<{ id: string }[]>(await other.get("/api/v1/services"))).toEqual([
        expect.objectContaining({ id: fixture.otherOrganization.serviceId }),
      ]);
      expect(dataOf<{ id: string }[]>(await other.get("/api/v1/specialists"))).toEqual([
        expect.objectContaining({ id: fixture.otherOrganization.specialistId }),
      ]);
    });
  });

  describe("scopes that narrow rows rather than access", () => {
    test("a master sees only clients they have served", async () => {
      const { master, owner } = { master: fixture.actors.master, owner: fixture.studio.owner };

      const unseen = dataOf<{ id: string }>(
        await owner.post("/api/v1/clients", { name: "Чужой клиент", phone: "+37360000001" }),
      ).id;

      const visible = dataOf<{ id: string; phone?: string }[]>(await master.get("/api/v1/clients"));
      expect(visible.map((client) => client.id)).toContain(fixture.clientId);
      expect(visible.map((client) => client.id)).not.toContain(unseen);
    });

    test("an analyst reads clients without phone or email", async () => {
      const rows = dataOf<Record<string, unknown>[]>(await fixture.actors.analyst.get("/api/v1/clients"));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty("phone");
        expect(row).not.toHaveProperty("email");
      }
    });

    test("a master sees only their own specialist", async () => {
      const rows = dataOf<{ id: string }[]>(await fixture.actors.master.get("/api/v1/specialists"));
      expect(rows).toEqual([expect.objectContaining({ id: fixture.studio.specialistId })]);
    });
  });
});
