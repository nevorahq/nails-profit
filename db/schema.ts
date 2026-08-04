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

import type { LocalizedText } from "@/i18n/localized-text";

export const organizationType = pgEnum("organization_type", ["solo", "studio"]);
// Spec section 6.1 defines four roles. Analyst is carried here even though no
// capability check reads it yet: adding an enum value later, once memberships
// exist, is a migration; adding it now is free.
export const memberRole = pgEnum("member_role", ["owner", "manager", "master", "analyst"]);
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

export const services = pgTable(
  "service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Spec section 11.2 requires a localized name; LOC-008 requires a fallback
    // chain. Stored as jsonb keyed by locale ({"ru": "...", "ro": "..."}) rather
    // than a translation table: three locales do not justify the extra join, and
    // `resolveLocalizedText` owns the fallback.
    name: jsonb("name").$type<LocalizedText>().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [index("service_org_idx").on(table.organizationId)],
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
