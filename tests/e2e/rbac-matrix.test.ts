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
  locationId: string;
  bookingId: string;
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

async function freshException(fixture: Fixture) {
  return dataOf<{ id: string }>(
    await fixture.studio.owner.post("/api/v1/availability/exceptions", {
      specialist_id: fixture.studio.specialistId,
      kind: "unavailable",
      starts_at: "2026-12-24T08:00:00.000Z",
      ends_at: "2026-12-24T12:00:00.000Z",
    }),
  ).id;
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
    route: "/api/v1/public/booking/[slug]",
    method: "GET",
    allowed: ALL_ROLES,
    public: true,
    note: "Public booking profile; an unknown slug is deliberately a 404",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio" }),
  },
  {
    route: "/api/v1/public/booking/[slug]/catalog",
    method: "GET",
    allowed: ALL_ROLES,
    public: true,
    note: "Public catalogue; identifiers are validated before tenant data is read",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio/catalog?location_id=00000000-0000-4000-8000-000000000000" }),
  },
  {
    route: "/api/v1/public/booking/[slug]/availability",
    method: "GET",
    allowed: ALL_ROLES,
    public: true,
    note: "Public availability is rate-limited and needs no account session",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio/availability" }),
  },
  {
    route: "/api/v1/public/booking/[slug]/holds",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "A public client may hold a slot before identifying themselves",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio/holds", body: {} }),
  },
  {
    route: "/api/v1/public/booking/[slug]/bookings",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Public creation uses a hold and idempotency key, not authentication",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio/bookings", body: {} }),
  },
  {
    route: "/api/v1/public/booking/[slug]/verify",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Contact verification is what a public visitor does before they have any account",
    request: async () => ({ path: "/api/v1/public/booking/unknown-studio/verify", body: {} }),
  },
  {
    route: "/api/v1/ops/notifications",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Operator job authenticated by a shared secret, not a session; absent without one",
    request: async () => ({ path: "/api/v1/ops/notifications", body: {} }),
  },
  {
    route: "/api/v1/webhooks/resend",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Provider callback authenticated by a Svix signature, not a user session; absent without its secret",
    request: async () => ({ path: "/api/v1/webhooks/resend", body: {} }),
  },
  {
    route: "/api/v1/public/bookings/[token]",
    method: "GET",
    allowed: ALL_ROLES,
    public: true,
    note: "Possession of a purpose-bound token grants access to one booking",
    request: async () => ({ path: "/api/v1/public/bookings/invalid-token" }),
  },
  {
    route: "/api/v1/public/bookings/[token]/cancel",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "A client cancels through the manage token, without a Nail Profit account",
    request: async () => ({ path: "/api/v1/public/bookings/invalid-token/cancel", body: {} }),
  },
  {
    route: "/api/v1/public/bookings/[token]/reschedule",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "A client reschedules through the same scoped manage token",
    request: async () => ({ path: "/api/v1/public/bookings/invalid-token/reschedule", body: {} }),
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
    route: "/api/v1/clients/[id]",
    method: "DELETE",
    allowed: ["owner", "manager"],
    note: "privacy erasure requires organization-wide client scope; a Master's scope is own",
    // A missing UUID exercises authorization without mutating the shared client
    // that the scope checks later in this suite rely on.
    request: async () => ({ path: `/api/v1/clients/${crypto.randomUUID()}` }),
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
    route: "/api/v1/locations",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read: a master cannot be told their Tuesday is at an address they may not see",
    request: async () => ({ path: "/api/v1/locations" }),
  },
  {
    route: "/api/v1/locations",
    method: "POST",
    allowed: ["owner"],
    note: "An address and its timezone are organization settings in all but name",
    request: async () => ({
      path: "/api/v1/locations",
      body: { name: "Второй адрес", slug: `addr-${crypto.randomUUID().slice(0, 8)}` },
    }),
  },
  {
    route: "/api/v1/locations/[id]",
    method: "PATCH",
    allowed: ["owner"],
    note: "organization_settings write",
    request: async (fixture) => ({
      path: `/api/v1/locations/${fixture.locationId}`,
      body: { name: "Основной адрес" },
    }),
  },
  {
    route: "/api/v1/locations/[id]/booking-settings",
    method: "PUT",
    allowed: ["owner"],
    note: "Publishing a public booking page is an organization-level decision",
    request: async (fixture) => ({
      path: `/api/v1/locations/${fixture.locationId}/booking-settings`,
      body: { min_lead_minutes: 90 },
    }),
  },
  {
    route: "/api/v1/availability/rules",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read; a Master sees their own rota",
    request: async () => ({ path: "/api/v1/availability/rules" }),
  },
  {
    route: "/api/v1/availability/rules",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "A rota decides which clients reach whom, so it takes the organization-wide scope",
    request: async (fixture) => ({
      path: "/api/v1/availability/rules",
      body: {
        specialist_id: fixture.studio.specialistId,
        location_id: fixture.locationId,
        effective_from: "2026-08-05",
        intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
      },
    }),
  },
  {
    route: "/api/v1/availability/exceptions",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read, narrowed to their own for a Master",
    request: async () => ({ path: "/api/v1/availability/exceptions" }),
  },
  {
    route: "/api/v1/availability/exceptions",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; a Master may block their own time and nobody else's",
    request: async (fixture) => ({
      path: "/api/v1/availability/exceptions",
      body: {
        specialist_id: fixture.studio.specialistId,
        kind: "unavailable",
        starts_at: "2026-12-25T08:00:00.000Z",
        ends_at: "2026-12-25T12:00:00.000Z",
      },
    }),
  },
  {
    route: "/api/v1/availability/exceptions",
    method: "DELETE",
    allowed: ["owner", "manager", "master"],
    note: "bookings write, own schedule for a Master",
    request: async (fixture) => ({
      path: `/api/v1/availability/exceptions?id=${await freshException(fixture)}`,
    }),
  },
  {
    route: "/api/v1/specialists/[id]/locations",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "Where someone works is scheduling data, not a personal preference",
    request: async (fixture) => ({
      path: `/api/v1/specialists/${fixture.studio.specialistId}/locations`,
      body: { location_ids: [fixture.locationId] },
    }),
  },
  {
    route: "/api/v1/specialists/[id]/services",
    method: "PUT",
    allowed: CATALOGUE_MANAGERS,
    note: "Which services someone performs, and how long they take them",
    request: async (fixture) => ({
      path: `/api/v1/specialists/${fixture.studio.specialistId}/services`,
      body: { services: [{ service_id: fixture.studio.serviceId, duration_minutes: 120 }] },
    }),
  },
  {
    route: "/api/v1/bookings",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read; a Master sees their own calendar",
    request: async () => ({ path: "/api/v1/bookings" }),
  },
  {
    route: "/api/v1/bookings",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; an Analyst reads only. Without an Idempotency-Key this is a 422, never a 403",
    request: async (fixture) => ({
      path: "/api/v1/bookings",
      body: {
        location_id: fixture.locationId,
        specialist_id: fixture.studio.specialistId,
        service_id: fixture.studio.serviceId,
        starts_at: "2026-09-02T07:00:00.000Z",
      },
    }),
  },
  {
    route: "/api/v1/bookings/[id]",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read; an Analyst opens the card without the client's phone or email",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}` }),
  },
  {
    route: "/api/v1/bookings/[id]",
    method: "PATCH",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; an Analyst reads only",
    request: async (fixture) => ({
      path: `/api/v1/bookings/${fixture.bookingId}`,
      body: { client_id: fixture.clientId, version: 1 },
    }),
  },
  {
    route: "/api/v1/bookings/[id]/confirm",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; already confirmed is a 409, never a 403",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}/confirm`, body: {} }),
  },
  {
    route: "/api/v1/bookings/[id]/reschedule",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; a Master moves their own appointments",
    request: async (fixture) => ({
      path: `/api/v1/bookings/${fixture.bookingId}/reschedule`,
      body: { starts_at: "2026-09-09T07:00:00.000Z", version: 1 },
    }),
  },
  {
    route: "/api/v1/bookings/[id]/manage-link",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; the reissued link goes to the client, never to the caller",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}/manage-link` }),
  },
  {
    route: "/api/v1/bookings/[id]/cancel",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; the reason is a code, so no PII reaches the column",
    request: async (fixture) => ({
      path: `/api/v1/bookings/${fixture.bookingId}/cancel`,
      body: { reason: "duplicate" },
    }),
  },
  {
    route: "/api/v1/bookings/[id]/no-show",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; recorded, never charged for",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}/no-show`, body: {} }),
  },
  {
    route: "/api/v1/bookings/[id]/complete",
    method: "POST",
    allowed: ["owner", "manager", "master"],
    note: "bookings write; closing into a visit is the same right as recording one",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}/complete`, body: {} }),
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

    const locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Главный зал", slug: "matrix-studio" }),
    ).id;

    // The lifecycle endpoints need something to act on. It belongs to the
    // Master's own specialist, so a 403 from those rows means the role was
    // refused rather than merely out of scope.
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    const bookingId = dataOf<{ id: string }>(
      await studio.owner.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
          starts_at: "2026-09-02T07:00:00.000Z",
        },
        { "idempotency-key": `matrix-${crypto.randomUUID()}` },
      ),
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
      locationId,
      bookingId,
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
        if (entry.public) expect(response.status).not.toBe(401);
        else expect(response.status).toBe(401);
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
      {
        method: "DELETE",
        label: "client erasure",
        path: (f) => `/api/v1/clients/${f.clientId}`,
      },
      {
        method: "GET",
        // The card carries the client's name, phone and email; a leak here is
        // a leak of the studio's client list, not merely of a timetable.
        label: "booking card",
        path: (f) => `/api/v1/bookings/${f.bookingId}`,
      },
      {
        method: "POST",
        label: "booking cancellation",
        path: (f) => `/api/v1/bookings/${f.bookingId}/cancel`,
        body: { reason: "duplicate" },
      },
      {
        method: "POST",
        label: "booking reschedule",
        path: (f) => `/api/v1/bookings/${f.bookingId}/reschedule`,
        body: { starts_at: "2026-09-16T07:00:00.000Z", version: 1 },
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
