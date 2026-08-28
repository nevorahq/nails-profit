import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { db } from "@/db";
import { memberships } from "@/db/schema";
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
  request: (
    fixture: Fixture,
  ) => Promise<{ path: string; body?: Record<string, unknown>; headers?: Record<string, string> }>;
}>;

const ALL_ROLES = memberRoles;
const CATALOGUE_MANAGERS: readonly MemberRole[] = ["owner", "manager"];
/**
 * Adding a service is not managing the catalogue. A Master may create one — a
 * row nobody is costed against yet — while editing and archiving stay with the
 * managers, because a service's price and duration are what every other
 * master's margin and commission are computed from. See `create_only` in
 * `domain/rbac.ts`.
 */
const SERVICE_AUTHORS: readonly MemberRole[] = ["owner", "manager", "master"];

/** A one-row file, so an import job can be created on demand. */
function importForm() {
  const form = new FormData();
  form.set("entity", "service");
  form.set(
    "file",
    new File(["Наименование;Цена;Длительность\r\nТоп-услуга;600;90"], "one.csv", {
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

/**
 * A colleague who exists only to be removed by the case below.
 *
 * Fresh per call, like the invitation above, and for a sharper reason: the
 * roles allowed to remove someone actually succeed, so pointing the case at a
 * fixture member would delete an actor the rest of the matrix still needs.
 */
async function freshMembership(fixture: Fixture) {
  const email = `removed-${crypto.randomUUID()}@studio.example`;
  const member = await inviteMember(fixture.studio.owner, email, "master");
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, member.userId))
    .limit(1);
  return row.id;
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
    route: "/api/v1/webhooks/paddle",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Billing callback authenticated by a Paddle signature, not a user session; 404 without its secret",
    request: async () => ({ path: "/api/v1/webhooks/paddle", body: {} }),
  },
  {
    route: "/api/v1/webhooks/lemon-squeezy",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Billing callback authenticated by an X-Signature digest, not a user session; 404 without its secret",
    request: async () => ({ path: "/api/v1/webhooks/lemon-squeezy", body: {} }),
  },
  {
    route: "/api/v1/webhooks/messaggio/[token]",
    method: "POST",
    allowed: ALL_ROLES,
    public: true,
    note: "Delivery report authenticated by the token in the URL itself, not a user session; 404 without a matching MESSAGGIO_WEBHOOK_TOKEN",
    request: async () => ({ path: "/api/v1/webhooks/messaggio/placeholder-token", body: {} }),
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
    route: "/api/v1/expenses",
    method: "GET",
    allowed: ["owner"],
    note: "the expense ledger is the owner's alone — rent and payroll, not catalogue data",
    request: async () => ({ path: "/api/v1/expenses" }),
  },
  {
    route: "/api/v1/expenses",
    method: "POST",
    allowed: ["owner"],
    note: "Recording a purchase is the owner's write; no manager, master or analyst",
    request: async () => ({
      path: "/api/v1/expenses",
      body: { name: "Аренда", category: "rent", amount_minor: 120_000 },
    }),
  },
  {
    route: "/api/v1/expenses/[id]",
    method: "PATCH",
    allowed: ["owner"],
    note: "Editing a recorded purchase is the same owner-only write as making one",
    // A missing UUID exercises authorization alone: the role check runs before
    // the lookup, so a permitted role gets 404 and a denied one still gets 403.
    request: async () => ({
      path: `/api/v1/expenses/${crypto.randomUUID()}`,
      body: { name: "Аренда за июль" },
    }),
  },
  {
    route: "/api/v1/expenses/[id]",
    method: "DELETE",
    allowed: ["owner"],
    note: "Archiving a recorded purchase is an owner-only write",
    request: async () => ({ path: `/api/v1/expenses/${crypto.randomUUID()}` }),
  },
  {
    route: "/api/v1/labor-costs",
    method: "GET",
    allowed: ["owner"],
    note: "Salaries and what the owner's own work is worth — the owner's alone, reading included",
    request: async () => ({ path: "/api/v1/labor-costs" }),
  },
  {
    route: "/api/v1/labor-costs",
    method: "POST",
    allowed: ["owner"],
    note: "Setting a wage is an owner's decision; no manager, master or analyst",
    request: async () => ({
      path: "/api/v1/labor-costs",
      body: { recipient: "owner", basis: "fixed_monthly", amount_minor: 1_500_000 },
    }),
  },
  {
    route: "/api/v1/labor-costs/[id]",
    method: "DELETE",
    allowed: ["owner"],
    // A missing UUID exercises authorization alone: the role check runs before
    // the lookup, so a permitted role gets 404 and a denied one still gets 403.
    note: "Ending a wage is the same owner-only write as starting one",
    request: async () => ({ path: `/api/v1/labor-costs/${crypto.randomUUID()}` }),
  },
  {
    route: "/api/v1/payment-methods",
    method: "GET",
    allowed: ALL_ROLES,
    // The list is a field on the closing form: a master who cannot read it
    // cannot say the client paid by card, and the fee goes uncounted.
    note: "Anyone who may record a visit needs to see how it can be paid for",
    request: async () => ({ path: "/api/v1/payment-methods" }),
  },
  {
    route: "/api/v1/payment-methods",
    method: "POST",
    allowed: ["owner"],
    note: "The acquirer's rate is a financial setting, so it takes organization_settings",
    request: async () => ({
      path: "/api/v1/payment-methods",
      body: { name: "Терминал", kind: "card", commission_basis_points: 220 },
    }),
  },
  {
    route: "/api/v1/payment-methods/[id]",
    method: "PATCH",
    allowed: ["owner"],
    note: "Changing a rate is the same owner-only write as adding one",
    request: async () => ({
      path: `/api/v1/payment-methods/${crypto.randomUUID()}`,
      body: { commission_basis_points: 300 },
    }),
  },
  {
    route: "/api/v1/payment-methods/[id]",
    method: "DELETE",
    allowed: ["owner"],
    note: "Retiring a method changes what new visits cost; owner only",
    request: async () => ({ path: `/api/v1/payment-methods/${crypto.randomUUID()}` }),
  },
  {
    route: "/api/v1/owner-draws",
    method: "GET",
    allowed: ["owner"],
    note: "What the owner took for themselves — the most personal figure the product holds",
    request: async () => ({ path: "/api/v1/owner-draws" }),
  },
  {
    route: "/api/v1/owner-draws",
    method: "POST",
    allowed: ["owner"],
    note: "Recording a draw is the owner's own business; no manager, master or analyst",
    request: async () => ({
      path: "/api/v1/owner-draws",
      body: { amount_minor: 100_000, currency: "MDL" },
    }),
  },
  {
    route: "/api/v1/owner-draws",
    method: "DELETE",
    allowed: ["owner"],
    note: "Same owner-only write as recording one",
    request: async () => ({ path: `/api/v1/owner-draws?id=${crypto.randomUUID()}` }),
  },
  {
    route: "/api/v1/tax-rules",
    method: "GET",
    allowed: ["owner"],
    note: "What a business owes the state is the owner's, like rent — reading included",
    request: async () => ({ path: "/api/v1/tax-rules" }),
  },
  {
    route: "/api/v1/tax-rules",
    method: "POST",
    allowed: ["owner"],
    note: "A tax rate reaches the margin of every visit; owner alone",
    request: async () => ({ path: "/api/v1/tax-rules", body: { kind: "vat", basis_points: 2_000 } }),
  },
  {
    route: "/api/v1/tax-rules/[id]",
    method: "DELETE",
    allowed: ["owner"],
    note: "Ending a tax rule is the same owner-only write as starting one",
    request: async () => ({ path: `/api/v1/tax-rules/${crypto.randomUUID()}` }),
  },
  {
    route: "/api/v1/onboarding",
    method: "GET",
    allowed: CATALOGUE_MANAGERS,
    note: "onboarding read: чеклист первичной настройки — работа с каталогом, не отчёт",
    request: async () => ({ path: "/api/v1/onboarding" }),
  },
  {
    route: "/api/v1/onboarding/month",
    method: "GET",
    allowed: ["owner"],
    note: "чеклист месяца читает реестр затрат — owner-only, как сами затраты",
    request: async () => ({ path: "/api/v1/onboarding/month" }),
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
    allowed: SERVICE_AUTHORS,
    note: "services write: Owner, Manager и Master (создание)",
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
    route: "/api/v1/services/[id]",
    method: "DELETE",
    allowed: CATALOGUE_MANAGERS,
    note: "services write; archiving a service is managing the catalogue, not authoring one",
    // Not the studio's own service: every later case in this suite is priced
    // against it.
    request: async () => ({ path: `/api/v1/services/${crypto.randomUUID()}` }),
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
    route: "/api/v1/specialists/[id]",
    method: "DELETE",
    allowed: CATALOGUE_MANAGERS,
    // The fixture's master has a visit, so a permitted caller is archived with
    // a 200 rather than deleted — which keeps the row every other case here
    // depends on, and is the behaviour the endpoint is meant to have.
    note: "Removing a master is the same decision as hiring one",
    request: async (fixture) => ({ path: `/api/v1/specialists/${fixture.studio.specialistId}` }),
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
    route: "/api/v1/visits/[id]",
    method: "DELETE",
    allowed: CATALOGUE_MANAGERS,
    note: "Deleting takes revenue out of the studio's month, so it asks for the organization-wide scope a Master does not have",
    // A missing UUID: the authorization question is asked before the lookup,
    // and the studio's own visit is what later cases read.
    request: async () => ({ path: `/api/v1/visits/${crypto.randomUUID()}` }),
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
    method: "PATCH",
    allowed: ["owner", "manager", "master"],
    note: "clients write; an Analyst reads only",
    // A missing UUID for the same reason as the erasure row below: the
    // authorization check runs before the lookup, so nothing shared is touched.
    request: async () => ({
      path: `/api/v1/clients/${crypto.randomUUID()}`,
      body: { name: `Клиент ${crypto.randomUUID()}` },
    }),
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
    route: "/api/v1/invitations/send",
    method: "POST",
    allowed: CATALOGUE_MANAGERS,
    note: "user_management write; sending the letter is the same act as creating the invitation",
    // A malformed token is 400 for whoever may send at all, which is what this
    // row asks about — the address the letter would go to is decided later.
    request: async () => ({ path: "/api/v1/invitations/send", body: { token: "not-a-token" } }),
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
    route: "/api/v1/memberships/[id]",
    method: "DELETE",
    allowed: CATALOGUE_MANAGERS,
    note: "user_management write; «кроме Owner», сам себя и последний владелец — в member-removal",
    request: async (fixture) => ({
      path: `/api/v1/memberships/${await freshMembership(fixture)}`,
    }),
  },
  {
    route: "/api/v1/preview",
    method: "POST",
    allowed: ["owner"],
    note: "«Посмотреть как» — административный взгляд владельца; ни одна другая роль его не имеет",
    request: async (fixture) => ({
      path: "/api/v1/preview",
      body: { member_user_id: fixture.actors.master.userId },
    }),
  },
  {
    route: "/api/v1/preview",
    method: "DELETE",
    allowed: ALL_ROLES,
    note: "Leaving preview is never refused: a mode nobody can exit is worse than one nobody entered",
    request: async () => ({ path: "/api/v1/preview" }),
  },
  {
    route: "/api/v1/account/delete",
    method: "POST",
    allowed: ALL_ROLES,
    note: "уйти может каждый за себя; адрес нарочно неверный — 422, а не удалённая фикстура",
    request: async () => ({
      path: "/api/v1/account/delete",
      body: { confirmation_email: "wrong@example.test" },
    }),
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
    note: "Importing the catalogue is a catalogue write",
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
    route: "/api/v1/locations/[id]",
    method: "DELETE",
    allowed: ["owner"],
    // The fixture's address carries a booking, so a permitted caller is refused
    // with 409 rather than 403 — which is what this matrix asserts, and it
    // keeps the row from deleting the address every other case depends on.
    note: "organization_settings write; removing an address is the same decision as creating one",
    request: async (fixture) => ({ path: `/api/v1/locations/${fixture.locationId}` }),
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
    allowed: ["owner", "manager", "master"],
    /*
     * Written when the rota belonged to the managers alone. A Master owns their
     * own working hours now — the booking screen offers them that form and
     * nothing else (`components/booking-setup.tsx`, `canSaveRota`) — and the
     * scope is what this row cannot express: `allowed` asks who may call the
     * endpoint, not whose rota they may write. The half this drops is covered
     * by name in `tests/e2e/booking-schedule.test.ts`, "a master may set their
     * own rota and nobody else's".
     */
    note: "bookings write, own schedule for a Master; a colleague's rota is 403 there",
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
    route: "/api/v1/notifications",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read, same scope as GET /api/v1/bookings — pending_confirmation requests for the topbar bell",
    request: async () => ({ path: "/api/v1/notifications" }),
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
    route: "/api/v1/bookings/[id]/preview",
    method: "GET",
    allowed: ALL_ROLES,
    note: "bookings read: what the appointment would earn, costed but not written",
    request: async (fixture) => ({ path: `/api/v1/bookings/${fixture.bookingId}/preview` }),
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
    request: async () => ({ path: "/api/v1/imports/templates/service" }),
  },
];

async function send(
  actor: Actor,
  method: Method,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  // The import upload is the one multipart endpoint; everything else is JSON.
  if (path === "/api/v1/imports" && method === "POST") return actor.post(path, importForm());

  switch (method) {
    case "GET":
      return actor.get(path, headers);
    case "POST":
      return actor.post(path, body, headers);
    case "PUT":
      return actor.put(path, body, headers);
    case "PATCH":
      return actor.patch(path, body, headers);
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
          const { path, body, headers } = await entry.request(fixture);
          const response = await send(fixture.actors[role], entry.method, path, body, headers);

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
        const { path, body, headers } = await entry.request(fixture);
        const response = await send(anonymous, entry.method, path, body, headers);
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
        label: "service add-ons",
        path: (f) => `/api/v1/services/${f.studio.serviceId}/add-ons`,
        body: { add_on_ids: [] },
      },
      {
        method: "DELETE",
        label: "location",
        path: (f) => `/api/v1/locations/${f.locationId}`,
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

      // The other studio has exactly its own canonical service.
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
