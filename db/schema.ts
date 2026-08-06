import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
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
  /**
   * Versioned legal acceptance for pilot accounts. Existing development users
   * remain `false/null`; every new email signup is required by Better Auth to
   * submit `legalAccepted=true`, while the server supplies the trusted version
   * and timestamp rather than accepting those values from the browser.
   */
  legalAccepted: boolean("legal_accepted").notNull().default(false),
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  privacyVersion: text("privacy_version"),
  privacyAcknowledgedAt: timestamp("privacy_acknowledged_at", { withTimezone: true }),
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

/** The rollout ladder of section 7.11: nothing, the staff calendar, the public page. */
export const bookingAccessLevel = pgEnum("booking_access_level", ["off", "calendar", "public"]);

export const organizations = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: organizationType("type").notNull(),
    /**
     * Public booking path segment, roadmap section 7.2 (`/book/{slug}`).
     *
     * Nullable because it arrives by the expand step of an expand/migrate/contract
     * migration, and because an organization that never publishes a booking page
     * never needs one. Unique across tenants — it is a public address rather than
     * a tenant-scoped name — and deliberately not derived from the id, which
     * section 7.9 forbids exposing.
     */
    slug: text("slug"),
    /**
     * How far the booking module is rolled out for this tenant, roadmap
     * section 7.11: "Все новые public и calendar routes закрыты feature flags
     * до прохождения security и concurrency gates".
     *
     * Three levels rather than a boolean, because the pilot rollout has three
     * states and the rollback plan needs the middle one: a studio gets the
     * internal calendar first, the public page once its rota and prices are
     * real, and `off` is how both are taken back without touching the
     * appointments already made.
     *
     * `calendar` by default: every organization that exists today already has
     * the calendar, and a default of `off` would take it from them on deploy.
     */
    bookingAccess: bookingAccessLevel("booking_access").notNull().default("calendar"),
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
  },
  (table) => [uniqueIndex("organization_slug_idx").on(table.slug)],
);

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
    /** Stable tie-breaker for the public “any available” assignment. */
    sortOrder: integer("sort_order").notNull().default(0),
    cooperationType: cooperationType("cooperation_type").notNull().default("commission"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("specialist_org_idx").on(table.organizationId),
    index("specialist_user_idx").on(table.userId),
    // One specialist per account. Every "own" scope from section 6.1 resolves a
    // master to their specialist row with a single lookup; two rows for one
    // account would make which visits they may see depend on row order.
    uniqueIndex("specialist_org_user_idx")
      .on(table.organizationId, table.userId)
      .where(sql`${table.userId} is not null`),
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
    /**
     * What a client agreed to when they booked themselves, section 7.2.
     *
     * Versioned, like the account-side columns above and for the same reason:
     * "they ticked a box once" is not an answer to which terms they were shown.
     * Null for everyone a studio entered by hand — staff cannot consent on
     * somebody else's behalf, and a default would claim they had.
     */
    termsVersion: text("terms_version"),
    privacyVersion: text("privacy_version"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
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
    /**
     * The booking this visit came from, section 7.4. Nullable and never
     * backfilled: visits recorded by hand before booking existed are not
     * missing anything, and a visit will always be creatable without one.
     */
    bookingId: uuid("booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
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
    // Gate 7: "перенос, отмена и завершение оставляют audit trail и не создают
    // дубли". Closing a booking twice would double its revenue in every report,
    // and the application check that prevents it is one retry away from being
    // raced. Partial, because visits recorded by hand have no booking at all.
    uniqueIndex("visit_booking_idx")
      .on(table.bookingId)
      .where(sql`${table.bookingId} is not null`),
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

/**
 * Spec section 11.2 ExternalReference, unique on provider + entity + external
 * ID + tenant.
 *
 * This is what makes INT-004 true: importing the same file twice updates rows
 * instead of doubling the catalogue. `external_id` is either an id the source
 * system gave us or the fingerprint derived from the row's natural key, and the
 * distinction is recorded so a later live connector can tell a real id from a
 * derived one rather than inheriting our guess as fact.
 */
export const externalIdKind = pgEnum("external_id_kind", ["external", "fingerprint"]);

export const externalReferences = pgTable(
  "external_reference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** `csv` today; a CRM connector later, without touching the domain model. */
    provider: text("provider").notNull(),
    entityType: text("entity_type").notNull(),
    externalId: text("external_id").notNull(),
    localId: uuid("local_id").notNull(),
    idKind: externalIdKind("id_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_reference_identity_idx").on(
      table.organizationId,
      table.provider,
      table.entityType,
      table.externalId,
    ),
    index("external_reference_local_idx").on(table.organizationId, table.localId),
  ],
);

export const importJobStatus = pgEnum("import_job_status", [
  "uploaded",
  "completed",
  "failed",
]);

/**
 * One run of the INT-002 flow: upload, mapping, validation preview, confirm,
 * result.
 *
 * The uploaded text is kept between upload and confirm so both steps read the
 * same bytes — a preview computed from one file and applied to another is a
 * quiet way to import something nobody reviewed. It is cleared on completion:
 * a client list is PII, and section 15.3 gives no reason to keep the raw file
 * once the rows are in. The mapping and the counts stay, which is what an audit
 * of "where did this row come from" actually needs.
 */
export const importJobs = pgTable(
  "import_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    entityType: text("entity_type").notNull(),
    status: importJobStatus("status").notNull().default("uploaded"),
    fileName: text("file_name").notNull(),
    delimiter: text("delimiter").notNull(),
    encoding: text("encoding").notNull(),
    /** Null once the job is finished; see the note above. */
    sourceText: text("source_text"),
    headers: jsonb("headers").$type<string[]>().notNull().default([]),
    mapping: jsonb("mapping").$type<Record<string, number | null>>().notNull().default({}),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** Per-row problems, kept so the owner can fix the file after the fact. */
    issues: jsonb("issues").$type<unknown[]>().notNull().default([]),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("import_job_org_created_idx").on(table.organizationId, table.createdAt)],
);

/**
 * Phase 6 rollout state. It is deliberately separate from Organization: a
 * workspace remains valid domain data after a pilot pauses or finishes, and a
 * commercial status must never become an authorization shortcut.
 */
export const pilotWave = pgEnum("pilot_wave", [
  "demo",
  "design_partner",
  "first_paid",
  "extended",
]);
export const pilotEnrollmentStatus = pgEnum("pilot_enrollment_status", [
  "pending",
  "active",
  "paused",
  "completed",
  "withdrawn",
]);

export const pilotEnrollments = pgTable(
  "pilot_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    wave: pilotWave("wave").notNull(),
    status: pilotEnrollmentStatus("status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    monthlyPriceMinor: bigint("monthly_price_minor", { mode: "number" }),
    billingCurrency: currency("billing_currency"),
    renewedSecondMonth: boolean("renewed_second_month"),
    renewalRecordedAt: timestamp("renewal_recorded_at", { withTimezone: true }),
    operatorRef: text("operator_ref").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pilot_enrollment_org_idx").on(table.organizationId),
    check(
      "pilot_enrollment_payment_shape",
      sql`(${table.monthlyPriceMinor} is null and ${table.billingCurrency} is null)
        or (${table.monthlyPriceMinor} >= 0 and ${table.billingCurrency} is not null and ${table.paidAt} is not null)`,
    ),
  ],
);

/**
 * Versioned, PII-free product telemetry for Gate 6. `entity_id` is always an
 * internal identifier (or the organization id for lifecycle events), making
 * the unique index an idempotency key rather than an analytics guess.
 */
export const pilotProductEvents = pgTable(
  "pilot_product_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventName: text("event_name").notNull(),
    eventVersion: integer("event_version").notNull().default(1),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorRole: memberRole("actor_role"),
    source: text("source").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pilot_product_event_dedupe_idx").on(
      table.organizationId,
      table.eventName,
      table.entityType,
      table.entityId,
    ),
    index("pilot_product_event_org_time_idx").on(table.organizationId, table.occurredAt),
    check("pilot_product_event_version_positive", sql`${table.eventVersion} > 0`),
  ],
);

export const pilotInteractionKind = pgEnum("pilot_interaction_kind", [
  "onboarding",
  "interview",
  "profit_review",
  "support",
  "decision",
]);
export const pilotDecisionType = pgEnum("pilot_decision_type", [
  "price",
  "service_composition",
  "material_consumption",
]);

/** Founder/operator work is entered through the local operator CLI, never a
 * tenant-facing endpoint. There is intentionally no notes field: support logs
 * measure time and outcome without becoming a second store for client PII. */
export const pilotInteractions = pgTable(
  "pilot_interaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: pilotInteractionKind("kind").notNull(),
    durationMinutes: integer("duration_minutes"),
    decisionType: pilotDecisionType("decision_type"),
    recordedBy: text("recorded_by").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pilot_interaction_org_time_idx").on(table.organizationId, table.occurredAt),
    check(
      "pilot_interaction_shape",
      sql`(${table.durationMinutes} is null or ${table.durationMinutes} > 0)
        and ((${table.kind} = 'decision' and ${table.decisionType} is not null)
          or (${table.kind} <> 'decision' and ${table.decisionType} is null))`,
    ),
  ],
);

export const pilotIssueCategory = pgEnum("pilot_issue_category", [
  "financial",
  "technical",
  "privacy",
  "support",
]);
export const pilotIssueStatus = pgEnum("pilot_issue_status", ["open", "resolved"]);

/** Structured pilot issue register. `issue_code` is a non-PII identifier that
 * links to the incident tracker; free-form descriptions stay in that system. */
export const pilotIssues = pgTable(
  "pilot_issue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    issueCode: text("issue_code").notNull(),
    category: pilotIssueCategory("category").notNull(),
    severity: integer("severity").notNull(),
    status: pilotIssueStatus("status").notNull().default("open"),
    recordedBy: text("recorded_by").notNull(),
    resolvedBy: text("resolved_by"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pilot_issue_org_code_idx").on(table.organizationId, table.issueCode),
    index("pilot_issue_org_status_idx").on(table.organizationId, table.status),
    check("pilot_issue_severity", sql`${table.severity} between 1 and 3`),
    check(
      "pilot_issue_resolution_shape",
      sql`(${table.status} = 'open' and ${table.resolvedAt} is null and ${table.resolvedBy} is null)
        or (${table.status} = 'resolved' and ${table.resolvedAt} is not null and ${table.resolvedBy} is not null)`,
    ),
  ],
);

/* --- Phase 7.1: locations, schedules and booking configuration --- */

export const locationStatus = pgEnum("location_status", ["active", "archived"]);
export const workplaceStatus = pgEnum("workplace_status", ["active", "archived"]);
export const bookingPublicStatus = pgEnum("booking_public_status", ["draft", "published", "paused"]);
export const bookingConfirmationMode = pgEnum("booking_confirmation_mode", ["instant", "manual"]);
/** `code` sends a one-time code to the contact before a booking may be created. */
export const bookingVerificationMode = pgEnum("booking_verification_mode", ["off", "code"]);
export const availabilityExceptionKind = pgEnum("availability_exception_kind", ["available", "unavailable"]);

/**
 * Where the work happens, roadmap section 7.4.
 *
 * The timezone lives here rather than on the organization: a studio with two
 * addresses can straddle a border, and every schedule rule is written in the
 * local time of one address. `organization.timezone` stays as the default a new
 * location inherits.
 */
export const locations = pgTable(
  "location",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Public path segment. Section 7.9: it must not reveal an internal id. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    /** IANA name, validated against the runtime's own database on the way in. */
    timezone: text("timezone").notNull(),
    status: locationStatus("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("location_org_slug_idx").on(table.organizationId, table.slug),
    index("location_org_idx").on(table.organizationId, table.status),
  ],
);

/**
 * A chair, a table, a room — a resource a service may require in addition to a
 * specialist. Only services with a resource constraint use one, so most solo
 * studios never create a single row here.
 */
export const workplaces = pgTable(
  "workplace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: workplaceStatus("status").notNull().default("active"),
    /** Ties in the "any available" pick are broken by this, then by id. */
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    index("workplace_location_idx").on(table.locationId, table.status),
    uniqueIndex("workplace_location_name_idx").on(table.locationId, table.name),
  ],
);

/** Which addresses a specialist actually works at. */
export const specialistLocations = pgTable(
  "specialist_location",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("specialist_location_pair_idx").on(table.specialistId, table.locationId),
    index("specialist_location_location_idx").on(table.locationId),
  ],
);

/**
 * Which services a specialist performs, and how long they take *them*.
 *
 * The duration override is why this is not a boolean: the same service takes a
 * beginner longer than the master who trained them, and a slot search that
 * ignores the difference either overbooks one or wastes the other's day.
 */
export const specialistServices = pgTable(
  "specialist_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    durationOverrideMinutes: integer("duration_override_minutes"),
    requiresWorkplace: boolean("requires_workplace").notNull().default(false),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("specialist_service_pair_idx").on(table.specialistId, table.serviceId),
    index("specialist_service_service_idx").on(table.serviceId),
    check(
      "specialist_service_duration_positive",
      sql`${table.durationOverrideMinutes} is null or ${table.durationOverrideMinutes} > 0`,
    ),
  ],
);

/**
 * One booking configuration per location, section 7.4.
 *
 * Every number here narrows what the availability engine may offer, and each
 * has a reason a salon can state out loud: a lead time so nobody books the slot
 * starting in four minutes, an advance window so next year's calendar is not a
 * commitment, buffers for cleaning between clients.
 */
export const bookingSettings = pgTable(
  "booking_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    publicStatus: bookingPublicStatus("public_status").notNull().default("draft"),
    slotStepMinutes: integer("slot_step_minutes").notNull().default(15),
    minLeadMinutes: integer("min_lead_minutes").notNull().default(120),
    maxAdvanceDays: integer("max_advance_days").notNull().default(60),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(10),
    confirmationMode: bookingConfirmationMode("confirmation_mode").notNull().default("instant"),
    /** How long a manually confirmed booking may hold a slot before it lapses. */
    confirmationTtlMinutes: integer("confirmation_ttl_minutes").notNull().default(120),
    /**
     * Whether a public booking has to prove the contact belongs to whoever is
     * typing it, section 7.2 step 7. Off by default: a studio without a
     * messaging provider would otherwise publish a page nobody can book on.
     */
    verificationMode: bookingVerificationMode("verification_mode").notNull().default("off"),
    verificationTtlMinutes: integer("verification_ttl_minutes").notNull().default(10),
    /** Section 7.7's reminder interval; zero switches reminders off. */
    reminderLeadMinutes: integer("reminder_lead_minutes").notNull().default(1_440),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("booking_settings_location_idx").on(table.locationId),
    check("booking_settings_step", sql`${table.slotStepMinutes} in (5, 10, 15, 20, 30, 60)`),
    check("booking_settings_lead", sql`${table.minLeadMinutes} between 0 and 43200`),
    check("booking_settings_advance", sql`${table.maxAdvanceDays} between 1 and 365`),
    check(
      "booking_settings_buffers",
      sql`${table.bufferBeforeMinutes} between 0 and 240 and ${table.bufferAfterMinutes} between 0 and 240`,
    ),
    check("booking_settings_ttl", sql`${table.confirmationTtlMinutes} between 15 and 1440`),
    check("booking_settings_verification_ttl", sql`${table.verificationTtlMinutes} between 3 and 60`),
    check("booking_settings_reminder_lead", sql`${table.reminderLeadMinutes} between 0 and 10080`),
  ],
);

/**
 * The weekly working pattern, written in local time.
 *
 * Minutes from midnight rather than a `time` column: the engine adds durations
 * and buffers to these values, and an integer is the type arithmetic is defined
 * on. `end_minute` may reach 1440 so a shift can end at midnight, and several
 * rows per weekday are allowed — a split shift is two intervals, not a special
 * case.
 */
export const scheduleRules = pgTable(
  "schedule_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    /** ISO-8601 weekday: 1 is Monday, 7 is Sunday. */
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    /** Local dates: a schedule change takes effect on a day, not at an instant. */
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Exclusive, like `commission_rule.active_to`, so a handover has no gap. */
    effectiveTo: date("effective_to", { mode: "string" }),
    ...auditColumns,
  },
  (table) => [
    index("schedule_rule_specialist_idx").on(table.specialistId, table.weekday),
    index("schedule_rule_location_idx").on(table.locationId, table.weekday),
    check("schedule_rule_weekday", sql`${table.weekday} between 1 and 7`),
    check(
      "schedule_rule_interval",
      sql`${table.startMinute} >= 0 and ${table.endMinute} <= 1440 and ${table.startMinute} < ${table.endMinute}`,
    ),
    check(
      "schedule_rule_effective_range",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

/**
 * Holidays, sick days and the Tuesday someone works late — what a weekly
 * pattern cannot express.
 *
 * Stored as instants because an exception is a real interval of time rather
 * than a repeating rule; the API accepts local time and converts through the
 * location's timezone. A null location means every location: a holiday is not
 * taken at one address.
 */
export const availabilityExceptions = pgTable(
  "availability_exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    kind: availabilityExceptionKind("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /**
     * A short operational label such as "отпуск" — never a medical or personal
     * note. Section 7.9 keeps PII out of scheduling data, and this field is
     * visible to every manager.
     */
    reason: text("reason"),
    ...auditColumns,
  },
  (table) => [
    index("availability_exception_specialist_idx").on(table.specialistId, table.startsAt),
    index("availability_exception_org_idx").on(table.organizationId, table.startsAt),
    check("availability_exception_interval", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

/* --- Phase 7.5: bookings, holds and double-booking protection --- */

export const bookingStatus = pgEnum("booking_status", [
  "pending_confirmation",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
]);
export const bookingSource = pgEnum("booking_source", [
  "public_booking",
  "staff",
  "rebooking",
  "waitlist",
  "import",
  "api",
]);
export const bookingActor = pgEnum("booking_actor", ["client", "staff", "system"]);
export const bookingHoldStatus = pgEnum("booking_hold_status", [
  "active",
  "converted",
  "expired",
  "released",
]);

/**
 * A booking, roadmap section 7.4.
 *
 * `pending_confirmation` and `confirmed` are the *active* statuses: both occupy
 * the specialist, and a cancelled or completed booking does not. Section 7.5
 * puts a PostgreSQL exclusion constraint over exactly those two, written by
 * hand in the migration because Drizzle cannot express `EXCLUDE USING gist`.
 * The application checks for conflicts first; the constraint is what holds when
 * two transactions race past the same check.
 *
 * Prices and durations live in `booking_line` as snapshots, for the same reason
 * a visit snapshots them: a catalogue edit tomorrow must not restate what a
 * client was quoted today.
 */
export const bookings = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    /** Only for services that occupy a chair or a room. */
    workplaceId: uuid("workplace_id").references(() => workplaces.id, { onDelete: "restrict" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: bookingStatus("status").notNull().default("pending_confirmation"),
    source: bookingSource("source").notNull(),
    /**
     * When a manually confirmed booking lapses. It holds the slot until then —
     * a request the studio has not answered still stops someone else taking the
     * time — and never past the appointment itself.
     */
    confirmationDueAt: timestamp("confirmation_due_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: bookingActor("cancelled_by"),
    /** A short reason code, never free text: section 7.9 keeps PII out of this. */
    cancellationReason: text("cancellation_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("booking_org_starts_idx").on(table.organizationId, table.startsAt),
    index("booking_specialist_starts_idx").on(table.specialistId, table.startsAt),
    index("booking_location_starts_idx").on(table.locationId, table.startsAt),
    index("booking_client_idx").on(table.clientId),
    check("booking_interval", sql`${table.endsAt} > ${table.startsAt}`),
    check(
      "booking_cancellation_shape",
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null and ${table.cancelledBy} is not null)
        or (${table.status} <> 'cancelled' and ${table.cancelledAt} is null and ${table.cancelledBy} is null)`,
    ),
  ],
);

/** What was booked and at what price, snapshotted like a visit line. */
export const bookingLines = pgTable(
  "booking_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    addOnId: uuid("add_on_id").references(() => addOns.id, { onDelete: "set null" }),
    nameSnapshot: jsonb("name_snapshot").$type<LocalizedText>().notNull(),
    priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    index("booking_line_booking_idx").on(table.bookingId),
    check("booking_line_price_non_negative", sql`${table.priceMinor} >= 0`),
  ],
);

/**
 * A five-minute reservation of a slot while a client fills in their name and
 * phone, section 7.5.
 *
 * Without it the last step of the public flow is a lottery: the slot shown on
 * the previous screen can be taken while the form is being typed. With it, the
 * loser of that race finds out at the moment they pick the time, not after
 * entering their details.
 *
 * Expiry is not enforced by the exclusion constraint — `now()` is not immutable
 * and cannot appear in one — so a stale hold is marked expired by the next
 * request touching that specialist, and by a sweep that runs on its own.
 */
export const bookingHolds = pgTable(
  "booking_hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    specialistId: uuid("specialist_id")
      .notNull()
      .references(() => specialists.id, { onDelete: "restrict" }),
    workplaceId: uuid("workplace_id").references(() => workplaces.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: bookingHoldStatus("status").notNull().default("active"),
    /**
     * Only the hash. The raw token goes to the browser once and is the proof
     * that this visitor — not another one who guessed the id — may convert it.
     */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    convertedBookingId: uuid("converted_booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_hold_token_idx").on(table.tokenHash),
    index("booking_hold_specialist_idx").on(table.specialistId, table.startsAt),
    index("booking_hold_expiry_idx").on(table.status, table.expiresAt),
    check("booking_hold_interval", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

/**
 * Idempotency for the mutations section 7.5 requires it on: public create,
 * reschedule and staff create.
 *
 * A retried request must return the first result rather than book a second
 * appointment — mobile networks retry, and a client who taps "confirm" twice
 * on a slow connection is not asking for two Tuesdays. The fingerprint is
 * stored so that reusing a key for a *different* request is refused instead of
 * silently answering with someone else's booking.
 */
export const bookingIdempotencyKeys = pgTable(
  "booking_idempotency_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_idempotency_key_idx").on(
      table.organizationId,
      table.scope,
      table.idempotencyKey,
    ),
    index("booking_idempotency_created_idx").on(table.createdAt),
  ],
);

/* --- Phase 7.4: client manage links and transactional notification outbox --- */

export const bookingAccessPurpose = pgEnum("booking_access_purpose", ["manage", "verify"]);

/** Raw public tokens are returned once; only a purpose-bound SHA-256 hash lives here. */
export const bookingAccessTokens = pgTable(
  "booking_access_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    purpose: bookingAccessPurpose("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_access_token_hash_idx").on(table.tokenHash),
    index("booking_access_token_booking_idx").on(table.bookingId, table.purpose),
    index("booking_access_token_expiry_idx").on(table.expiresAt),
  ],
);

export const notificationChannel = pgEnum("notification_channel", ["email", "sms"]);
export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "processing",
  "sent",
  "retry",
  "dead_letter",
]);

/**
 * A one-time code proving the contact belongs to whoever is booking, section
 * 7.2 step 7.
 *
 * It hangs off the hold rather than off a booking: verification happens before
 * there is a booking, and tying it to the hold is what stops a code obtained
 * for one slot from being replayed against another. Only the hash of the code
 * is stored, for the same reason no raw access token ever is.
 *
 * The destination is kept in the clear because a message cannot be sent to a
 * hash — and it is the only copy, deleted with the hold once the challenge has
 * served its purpose.
 */
export const bookingVerifications = pgTable(
  "booking_verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    holdId: uuid("hold_id")
      .notNull()
      .references(() => bookingHolds.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    destination: text("destination").notNull(),
    locale: text("locale").notNull().default("ru"),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One live challenge per hold: asking for a new code replaces the old one
    // rather than leaving two codes that both open the same slot.
    uniqueIndex("booking_verification_hold_idx").on(table.holdId),
    index("booking_verification_expiry_idx").on(table.expiresAt),
    check("booking_verification_attempts", sql`${table.attempts} >= 0`),
  ],
);

/**
 * Transactional outbox. It points to a booking/client instead of copying a
 * phone or email into payload JSON, keeping PII out of the queue and logs.
 *
 * Exactly one target: a booking for everything a client is told about their
 * appointment, a verification for the code that has to arrive before an
 * appointment exists at all.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    verificationId: uuid("verification_id").references(() => bookingVerifications.id, {
      onDelete: "cascade",
    }),
    channel: notificationChannel("channel").notNull(),
    template: text("template").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * The one thing a message cannot be rebuilt from the database without: the
     * one-time code, which is stored nowhere else in the clear. It is written
     * for verification messages only and cleared the moment the row leaves the
     * queue, so a code lives here for minutes rather than for the history's
     * lifetime.
     */
    payload: jsonb("payload").$type<{ code?: string }>(),
    status: notificationStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_outbox_idempotency_idx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("notification_outbox_delivery_idx").on(table.status, table.nextAttemptAt),
    check("notification_outbox_attempts", sql`${table.attempts} >= 0`),
    check(
      "notification_outbox_target",
      sql`(${table.bookingId} is not null) <> (${table.verificationId} is not null)`,
    ),
  ],
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
