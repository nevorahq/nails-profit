import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { commissionTypes } from "@/domain/costing";
import { memberRoles } from "@/domain/rbac";
import type { LocalizedText } from "@/i18n/localized-text";

export const organizationType = pgEnum("organization_type", ["solo", "studio"]);
// Derived from the section 6.1 capability matrix so the database enum and the
// permission table can never list different roles.
export const memberRole = pgEnum("member_role", memberRoles);
export const currency = pgEnum("currency", ["MDL", "EUR"]);
export const locale = pgEnum("locale", ["ru", "ro", "en"]);
export const unit = pgEnum("material_unit", ["ml", "g", "piece"]);

// Better Auth core tables. IDs are text because Better Auth owns their generation.
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("session_token_idx").on(table.token), index("session_user_idx").on(table.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * Spec section 11.1 requires these on every main table: `version` for optimistic
 * locking (`If-Match` in section 12.1) and the actor columns. `created_by` and
 * `updated_by` are `text`, not the spec's `uuid`, because Better Auth owns user
 * ID generation and issues text IDs. They stay nullable and `set null` on delete
 * so removing a user never blocks a business row.
 */
const auditColumns = {
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: organizationType("type").notNull(),
  currency: currency("currency").notNull().default("MDL"),
  locale: locale("locale").notNull().default("ru"),
  timezone: text("timezone").notNull().default("Europe/Chisinau"),
  /**
   * Owner-requested erasure, spec sections 4.3 and 15.3. Deletion is recorded
   * here rather than by dropping the row: the financial tables reference the
   * organization with ON DELETE RESTRICT precisely so history survives, and
   * section 15.3 asks for PII to be anonymized while required financial records
   * are kept. Memberships and invitations are removed, so a marked row is
   * unreachable.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...auditColumns,
});

export const memberships = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("membership_org_user_idx").on(table.organizationId, table.userId),
    index("membership_user_idx").on(table.userId),
  ],
);

export const materials = pgTable(
  "material",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Spec section 11.2 lists Material with a plain name; only Service,
    // ServiceCategory and AddOn carry localized names.
    name: text("name").notNull(),
    // CST-001 catalogue fields. Optional: a solo master rarely tracks suppliers,
    // and requiring them would block the first calculation for no benefit.
    sku: text("sku"),
    category: text("category"),
    supplier: text("supplier"),
    baseUnit: unit("base_unit").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [index("material_org_idx").on(table.organizationId)],
);

export const materialPriceVersions = pgTable(
  "material_price_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    packagePriceMinor: bigint("package_price_minor", { mode: "number" }).notNull(),
    packageSizeMilliUnits: bigint("package_size_milli_units", { mode: "number" }).notNull(),
    currency: currency("currency").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("material_price_org_material_idx").on(table.organizationId, table.materialId),
    check("material_price_non_negative", sql`${table.packagePriceMinor} >= 0`),
    check("material_package_size_positive", sql`${table.packageSizeMilliUnits} > 0`),
  ],
);

export const serviceCategories = pgTable(
  "service_category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [index("service_category_org_idx").on(table.organizationId)],
);

export const services = pgTable(
  "service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => serviceCategories.id, { onDelete: "set null" }),
    // Spec section 11.2 requires a localized name; LOC-008 requires a fallback
    // chain. Stored as jsonb keyed by locale ({"ru": "...", "ro": "..."}) rather
    // than a translation table: three locales do not justify the extra join, and
    // `resolveLocalizedText` owns the fallback.
    name: jsonb("name").$type<LocalizedText>().notNull(),
    // SRV-002. Nullable so a service can be created before its price is known:
    // SRV-007 wants the gap flagged, not the row rejected, and the costing
    // engine already refuses to invent a number it does not have.
    priceMinor: bigint("price_minor", { mode: "number" }),
    durationMinutes: integer("duration_minutes"),
    currency: currency("currency"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("service_org_idx").on(table.organizationId),
    check("service_price_non_negative", sql`${table.priceMinor} is null or ${table.priceMinor} >= 0`),
    check(
      "service_duration_positive",
      sql`${table.durationMinutes} is null or ${table.durationMinutes} > 0`,
    ),
  ],
);

/** SRV-003: an add-on shifts a service's price, duration and recipe. */
export const addOns = pgTable(
  "add_on",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    // Deltas, not absolutes, and signed: a "short nails" add-on may reduce both.
    priceDeltaMinor: bigint("price_delta_minor", { mode: "number" }).notNull().default(0),
    durationDeltaMinutes: integer("duration_delta_minutes").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [index("add_on_org_idx").on(table.organizationId)],
);

/** Section 11.2 models AddOn as many-to-many with Service. */
export const serviceAddOns = pgTable(
  "service_add_on",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    addOnId: uuid("add_on_id")
      .notNull()
      .references(() => addOns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("service_add_on_idx").on(table.serviceId, table.addOnId)],
);

/** RES-004: cooperation type is stored for analytical classification only. */
export const cooperationType = pgEnum("cooperation_type", ["commission", "rent", "staff"]);

export const specialists = pgTable(
  "specialist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Optional: a studio records masters who have no login of their own.
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    cooperationType: cooperationType("cooperation_type").notNull().default("commission"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("specialist_org_idx").on(table.organizationId),
    index("specialist_user_idx").on(table.userId),
  ],
);

export const commissionType = pgEnum("commission_type", commissionTypes);

/**
 * RES-005: a default commission rule per specialist plus per-service exceptions.
 * Versioned by `activeFrom` rather than updated in place — CST-009 requires that
 * changing a rule leave completed visits alone, which is only possible if the
 * old rule still exists.
 */
export const commissionRules = pgTable(
  "commission_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    /** Null is the specialist's default rule; a value makes it a per-service exception. */
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    type: commissionType("type").notNull(),
    /** Set for percentage rules; 4000 = 40%. */
    basisPoints: integer("basis_points"),
    /** Set for fixed rules. */
    fixedAmountMinor: bigint("fixed_amount_minor", { mode: "number" }),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeTo: timestamp("active_to", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("commission_rule_lookup_idx").on(table.organizationId, table.specialistId, table.activeFrom),
    // Exactly the field the rule's own type needs, and not the other one.
    check(
      "commission_rule_shape",
      sql`(${table.type} = 'fixed' and ${table.fixedAmountMinor} is not null and ${table.basisPoints} is null)
        or (${table.type} <> 'fixed' and ${table.basisPoints} is not null and ${table.fixedAmountMinor} is null)`,
    ),
    check(
      "commission_rule_non_negative",
      sql`(${table.basisPoints} is null or ${table.basisPoints} >= 0)
        and (${table.fixedAmountMinor} is null or ${table.fixedAmountMinor} >= 0)`,
    ),
  ],
);

/**
 * CST-005. A recipe belongs to exactly one of a service or an add-on, and is
 * versioned: CST-004 and the roadmap both require that editing a recipe leave
 * finished visits untouched, so a new version is written instead of an update.
 */
export const recipes = pgTable(
  "recipe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    addOnId: uuid("add_on_id").references(() => addOns.id, { onDelete: "cascade" }),
    recipeVersion: integer("recipe_version").notNull().default(1),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => [
    index("recipe_service_idx").on(table.organizationId, table.serviceId, table.activeFrom),
    index("recipe_add_on_idx").on(table.organizationId, table.addOnId, table.activeFrom),
    check(
      "recipe_single_target",
      sql`(${table.serviceId} is not null and ${table.addOnId} is null)
        or (${table.serviceId} is null and ${table.addOnId} is not null)`,
    ),
  ],
);

export const recipeItems = pgTable(
  "recipe_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    /** Thousandths of the material's base unit, matching `domain/units.ts`. */
    normativeQuantityMilliUnits: bigint("normative_quantity_milli_units", { mode: "number" }).notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("recipe_item_material_idx").on(table.recipeId, table.materialId),
    check("recipe_item_quantity_positive", sql`${table.normativeQuantityMilliUnits} > 0`),
  ],
);

export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked"]);

/**
 * Staff invitations, spec section 4.3. Only the token hash is stored, per the
 * one-time-token rule in section 12.3. Expiry is a timestamp rather than a
 * fourth status so no background job is needed to keep the row honest.
 */
export const invitations = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stored normalized (trimmed, lower-cased) so one address cannot be invited twice. */
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: invitationStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("invitation_token_hash_idx").on(table.tokenHash),
    index("invitation_org_status_idx").on(table.organizationId, table.status),
    // At most one live invitation per address per organization. Revoked and
    // accepted rows stay out of the way so an address can be re-invited.
    uniqueIndex("invitation_pending_email_idx")
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * Minimal client card, roadmap P0. Contacts are optional: a walk-in may leave a
 * name and nothing else, and requiring more would block the first visit.
 *
 * Section 15.3 requires erasure to anonymize a client while keeping the
 * financial records. `anonymizedAt` is what makes that possible without
 * deleting the row the visits point at.
 */
export const clients = pgTable(
  "client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** E.164, normalized on the way in (LOC-005). */
    normalizedPhone: text("normalized_phone"),
    email: text("email"),
    locale: locale("locale"),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("client_org_idx").on(table.organizationId),
    // Section 11.3: partial unique on normalized contacts, so the same person
    // cannot be entered twice, while any number of clients may have no contact.
    uniqueIndex("client_org_phone_idx")
      .on(table.organizationId, table.normalizedPhone)
      .where(sql`${table.normalizedPhone} is not null`),
    uniqueIndex("client_org_email_idx")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
  ],
);

export const visitStatus = pgEnum("visit_status", ["completed", "adjusted"]);

/**
 * A completed visit, entered by hand (roadmap phase 3). There is no booking to
 * point at: the MVP deliberately has no calendar.
 */
export const visits = pgTable(
  "visit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    plannedDurationMinutes: integer("planned_duration_minutes").notNull(),
    actualDurationMinutes: integer("actual_duration_minutes"),
    status: visitStatus("status").notNull().default("completed"),
    // CST-009: the commission rule is copied into the visit. Resolving it from
    // the rule table by date would almost work, but it would leave a closed
    // visit depending on rows that live elsewhere and can still be edited.
    commissionType: commissionType("commission_type").notNull(),
    commissionBasisPoints: integer("commission_basis_points"),
    commissionFixedAmountMinor: bigint("commission_fixed_amount_minor", { mode: "number" }),
    ...auditColumns,
  },
  (table) => [
    index("visit_org_completed_idx").on(table.organizationId, table.completedAt),
    index("visit_specialist_idx").on(table.specialistId, table.completedAt),
    check("visit_planned_duration_positive", sql`${table.plannedDurationMinutes} > 0`),
    check(
      "visit_commission_shape",
      sql`(${table.commissionType} = 'fixed' and ${table.commissionFixedAmountMinor} is not null and ${table.commissionBasisPoints} is null)
        or (${table.commissionType} <> 'fixed' and ${table.commissionBasisPoints} is not null and ${table.commissionFixedAmountMinor} is null)`,
    ),
    check(
      "visit_actual_duration_positive",
      sql`${table.actualDurationMinutes} is null or ${table.actualDurationMinutes} > 0`,
    ),
  ],
);

/**
 * SRV-004: price and duration are copied into the visit. The name is copied
 * too, so a renamed or archived service still reads correctly in history.
 */
export const visitLines = pgTable(
  "visit_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** References are for reporting only; the snapshot is what is charged. */
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    addOnId: uuid("add_on_id").references(() => addOns.id, { onDelete: "set null" }),
    nameSnapshot: jsonb("name_snapshot").$type<LocalizedText>().notNull(),
    priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),
    durationMinutes: integer("duration_minutes").notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    index("visit_line_visit_idx").on(table.visitId),
    check("visit_line_price_non_negative", sql`${table.priceMinor} >= 0`),
    check(
      "visit_line_discount_within_price",
      sql`${table.discountMinor} >= 0 and ${table.discountMinor} <= ${table.priceMinor}`,
    ),
  ],
);

/**
 * CST-006: the recipe is copied into the visit and the master fills in what was
 * actually used. The purchase price is snapshotted as the package pair rather
 * than a rounded per-unit cost, so the arithmetic stays exact — the same reason
 * `materialCostMinor` never multiplies a rounded unit price.
 */
export const consumptions = pgTable(
  "consumption",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    materialNameSnapshot: text("material_name_snapshot").notNull(),
    baseUnitSnapshot: unit("base_unit_snapshot").notNull(),
    normativeQuantityMilliUnits: bigint("normative_quantity_milli_units", { mode: "number" }).notNull(),
    /** Null until the master records it; never read as zero. */
    actualQuantityMilliUnits: bigint("actual_quantity_milli_units", { mode: "number" }),
    packagePriceMinorSnapshot: bigint("package_price_minor_snapshot", { mode: "number" }),
    packageSizeMilliUnitsSnapshot: bigint("package_size_milli_units_snapshot", { mode: "number" }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("consumption_visit_material_idx").on(table.visitId, table.materialId),
    check("consumption_normative_non_negative", sql`${table.normativeQuantityMilliUnits} >= 0`),
    check(
      "consumption_actual_non_negative",
      sql`${table.actualQuantityMilliUnits} is null or ${table.actualQuantityMilliUnits} >= 0`,
    ),
    check(
      "consumption_package_size_positive",
      sql`${table.packageSizeMilliUnitsSnapshot} is null or ${table.packageSizeMilliUnitsSnapshot} > 0`,
    ),
  ],
);

/**
 * Append-only financial result of a visit, spec section 11.2 and 8.8.1.
 *
 * Adjusting a visit writes a new version; nothing here is ever updated. That is
 * what lets a dashboard total be reproduced months later, and what makes the
 * roadmap's "прошлые расчёты не меняются" checkable rather than aspirational.
 */
export const financialSnapshots = pgTable(
  "financial_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    snapshotVersion: integer("snapshot_version").notNull(),
    formulaVersion: text("formula_version").notNull(),
    currency: currency("currency").notNull(),
    revenueMinor: bigint("revenue_minor", { mode: "number" }).notNull(),
    materialCostMinor: bigint("material_cost_minor", { mode: "number" }),
    normativeMaterialCostMinor: bigint("normative_material_cost_minor", { mode: "number" }),
    commissionMinor: bigint("commission_minor", { mode: "number" }),
    contributionMarginMinor: bigint("contribution_margin_minor", { mode: "number" }),
    marginBasisPoints: integer("margin_basis_points"),
    profitPerHourMinor: bigint("profit_per_hour_minor", { mode: "number" }),
    durationMinutes: integer("duration_minutes"),
    estimatedDuration: boolean("estimated_duration").notNull().default(false),
    /** Empty when the visit costed cleanly; otherwise why it could not. */
    incompleteReasons: jsonb("incomplete_reasons").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("financial_snapshot_visit_version_idx").on(table.visitId, table.snapshotVersion),
    index("financial_snapshot_org_idx").on(table.organizationId, table.createdAt),
    check("financial_snapshot_version_positive", sql`${table.snapshotVersion} > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_event_org_created_idx").on(table.organizationId, table.createdAt)],
);

export const organizationRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  materials: many(materials),
  services: many(services),
}));

export const membershipRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));
