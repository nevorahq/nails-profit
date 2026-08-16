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

import { commissionBases, commissionTypes, type TaxRates } from "@/domain/costing";
import { expenseCategories } from "@/domain/expense-categories";
import { materialCostingModes } from "@/domain/material-pricing";
import { materialDataSources, materialKinds } from "@/domain/material-provenance";
import { materialStockCheckBases } from "@/domain/material-stock";
import type { MaterialUsageSource } from "@/domain/material-usage";
import { memberRoles } from "@/domain/rbac";
import type { LocalizedText } from "@/i18n/localized-text";

export const organizationType = pgEnum("organization_type", ["solo", "studio"]);
// Derived from the section 6.1 capability matrix so the database enum and the
// permission table can never list different roles.
export const memberRole = pgEnum("member_role", memberRoles);
export const currency = pgEnum("currency", ["MDL", "EUR"]);
export const locale = pgEnum("locale", ["ru", "ro", "en"]);
export const unit = pgEnum("material_unit", ["ml", "g", "piece"]);
export const materialCostingMode = pgEnum("material_costing_mode", materialCostingModes);
// Generated from the domain lists for the same reason as the roles above: the
// database and the code cannot drift into disagreeing about what a source is.
export const materialDataSource = pgEnum("material_data_source", materialDataSources);
export const materialKind = pgEnum("material_kind", materialKinds);
export const materialStockCheckBasis = pgEnum("material_stock_check_basis", materialStockCheckBases);
// Generated from the domain list so a category can never exist in one and not
// the other.
export const expenseCategory = pgEnum("expense_category", expenseCategories);

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
    /**
     * What the owner keeps in the business before anything counts as safe to
     * take out. Zero by default — a reserve nobody chose is not a reserve, and
     * inventing one would understate what they may withdraw.
     */
    withdrawalReserveMinor: bigint("withdrawal_reserve_minor", { mode: "number" }).notNull().default(0),
    /**
     * The share of scheduled hours that can realistically be sold, in basis
     * points. 75% by default, the middle of the 70–80% range that management
     * accounting has used for practical capacity since Kaplan.
     *
     * It exists so that fixed costs are spread over the capacity the studio
     * *has*, not over the hours a slow month happened to fill. Dividing by
     * actual hours makes every service look dearer exactly when custom dries
     * up, which is the moment an owner is deciding what to charge — the error
     * feeds itself. Idle capacity is reported as its own figure instead.
     */
    practicalCapacityBasisPoints: integer("practical_capacity_basis_points").notNull().default(7500),
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
  (table) => [
    uniqueIndex("organization_slug_idx").on(table.slug),
    // Above zero, because zero practical capacity is a studio that cannot sell
    // an hour, and every rate computed from it would be a division by nothing.
    // Not above 100% either: practical capacity is a share of scheduled hours,
    // and a figure over the schedule is a different claim than this column makes.
    check(
      "organization_practical_capacity_range",
      sql`${table.practicalCapacityBasisPoints} between 1 and 10000`,
    ),
  ],
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

/**
 * The curated catalogue behind Fast Setup, epic E3.1 §F1.
 *
 * Global on purpose: it carries no organization_id because it is product data,
 * not tenant data — the same bottle of base coat is the same bottle in every
 * salon, and copying 120 rows into each new organization would make a shared
 * correction impossible to ship. A template is only ever read; what a tenant
 * owns is the `material` it creates from one.
 *
 * `systemKey` is the bridge to the recipe presets in `domain/material-presets`,
 * which map by `material.sku = 'SYSTEM:<key>'`. Without it a Fast Setup that
 * created fourteen materials would leave every preset recipe unable to find
 * them, and the owner would finish onboarding with a catalogue that still
 * costs nothing.
 */
export const materialTemplates = pgTable(
  "material_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The seed file's own identifier, and the only thing the seed matches on.
     *
     * A natural key over brand, name and packaging would look sufficient and is
     * not: correcting a template's package size — the whole reason the
     * catalogue is curated centrally — would then insert a second row instead
     * of fixing the first, and every organization that had already used it
     * would keep pointing at the wrong one.
     */
    slug: text("slug").notNull(),
    /** Null for generic entries: "coloured gel polish" belongs to no brand. */
    brand: text("brand"),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    /** Ties the template to a recipe-preset ingredient; null when it maps to none. */
    systemKey: text("system_key"),
    category: text("category").notNull(),
    /**
     * Thousandths of the base unit — or null when the catalogue does not claim
     * to know the packaging.
     *
     * Null is the honest answer for a generic entry: "База" is sold in 8, 12,
     * 15 and 35 ml bottles, and picking one would put a number into the
     * denominator of every cost derived from it that nobody verified. The owner
     * supplies the size of the bottle in front of them.
     */
    packageSizeMilliUnits: bigint("package_size_milli_units", { mode: "number" }),
    baseUnit: unit("base_unit").notNull(),
    kind: materialKind("kind").notNull().default("sku"),
    /** The 12–18 rows Fast Setup offers first; the rest are found by search. */
    isCore: boolean("is_core").notNull().default(false),
    profiles: text("profiles").array().notNull().default(sql`'{}'::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("material_template_slug_idx").on(table.slug),
    index("material_template_core_idx").on(table.isCore, table.sortOrder),
    check(
      "material_template_size_positive",
      sql`${table.packageSizeMilliUnits} is null or ${table.packageSizeMilliUnits} > 0`,
    ),
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
    /** E3.1 §F2. Inert in the costing arithmetic; see `domain/material-provenance`. */
    kind: materialKind("kind").notNull().default("sku"),
    /** E3.1 §F5. How this row first entered the catalogue. */
    source: materialDataSource("source").notNull().default("manual"),
    templateId: uuid("template_id").references(() => materialTemplates.id, {
      onDelete: "set null",
    }),
    /**
     * The name with everything a spreadsheet varies stripped out, so that
     * `Гель-лак`, `гель лак ` and `ГЕЛЬ–ЛАК` collapse to one value.
     *
     * Generated by the database rather than by the application because it backs
     * a unique index, and an index is only as trustworthy as the writer that
     * maintains it: a second pasted block arriving while the first is still
     * committing would pass an application-side check and still create the
     * duplicate. Mirrors `normalizeKeyPart` in `domain/import-identity`, which
     * stays the reader-side normalizer for import fingerprints.
     */
    matchKey: text("match_key").generatedAlwaysAs(
      sql`lower(regexp_replace(name, '[^0-9a-zа-яîăâșț]+', '', 'gi'))`,
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("material_org_idx").on(table.organizationId),
    // Partial on `archived_at`, so that archiving a material frees its name for
    // reuse — a studio that stopped buying a brand and started again should not
    // be told the row already exists when nothing on their screen shows it.
    uniqueIndex("material_natural_key")
      .on(table.organizationId, table.matchKey, table.baseUnit)
      .where(sql`${table.archivedAt} is null`),
  ],
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
    /** How the user entered this ratio; the costing arithmetic remains shared. */
    costingMode: materialCostingMode("costing_mode").notNull().default("quantity"),
    /**
     * E3.1 §F5, per version rather than per material: a material created from a
     * template whose price was later pasted has two different provenances, and
     * only the price history can say which number came from where.
     */
    priceSource: materialDataSource("price_source").notNull().default("manual"),
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

/**
 * A crate of gel actually bought, spec CST-011 and section 34 of the materials
 * brief.
 *
 * Two things it is not. It is not a second cost basis: recording a purchase
 * writes a `material_price_version` and points at it, so what a future visit is
 * costed on stays the one append-only history it has always been. And it is not
 * a warehouse receipt — there is no lot, no location, no reservation. It exists
 * so the estimated balance has a positive side to it, and so the card can say
 * whether the price on file still resembles what is being paid.
 *
 * The packaging is copied rather than read from the material, because a studio
 * that switched from 15 ml bottles to a 30 ml one has bought both, and the
 * quantity that reaches the balance depends on which.
 */
export const materialPurchases = pgTable(
  "material_purchase",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    /** Packages bought, not base units: the owner counts bottles. */
    packageQuantity: integer("package_quantity").notNull(),
    packageSizeMilliUnits: bigint("package_size_milli_units", { mode: "number" }).notNull(),
    unitPackageCostMinor: bigint("unit_package_cost_minor", { mode: "number" }).notNull(),
    /**
     * Generated rather than written, so the two figures can never disagree.
     * The brief lists `totalCost` as a field; storing it as a column the
     * application also computes would be a second truth one insert away from
     * drifting.
     */
    totalCostMinor: bigint("total_cost_minor", { mode: "number" }).generatedAlwaysAs(
      sql`package_quantity * unit_package_cost_minor`,
    ),
    currency: currency("currency").notNull(),
    /**
     * When it was bought, which is not when it was typed in. A receipt entered
     * a week late belongs to the week it was paid — the balance and the monthly
     * comparison both read this column.
     */
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
    supplier: text("supplier"),
    note: text("note"),
    /**
     * The price version this purchase produced. Nullable: a backdated receipt
     * entered after a newer price is on file records what was paid without
     * pretending to be the current cost basis.
     */
    priceVersionId: uuid("price_version_id").references(() => materialPriceVersions.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("material_purchase_org_material_idx").on(
      table.organizationId,
      table.materialId,
      table.purchasedAt,
    ),
    check("material_purchase_quantity_positive", sql`${table.packageQuantity} > 0`),
    check("material_purchase_size_positive", sql`${table.packageSizeMilliUnits} > 0`),
    check("material_purchase_cost_non_negative", sql`${table.unitPackageCostMinor} >= 0`),
  ],
);

/**
 * What was actually left on the shelf when somebody looked, spec section 38.
 *
 * The measurement that makes the estimate self-correcting. Append-only like
 * every other history in this schema: a count is something that happened at a
 * time, and editing yesterday's count would move a balance that has already
 * been reported. `domain/material-stock.ts` reads the newest one as the
 * baseline and replays only what came after it.
 *
 * Stored in base units even though the interface asks for a rough share of a
 * package, because "≈25%" is a question about a bottle and the balance is
 * arithmetic over millilitres. The conversion belongs to the screen that knows
 * which bottle was being looked at.
 */
export const materialStockChecks = pgTable(
  "material_stock_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    observedQuantityMilliUnits: bigint("observed_quantity_milli_units", { mode: "number" }).notNull(),
    /**
     * Whether the figure was eyeballed against a bucket or actually measured.
     * The calibration suggestion is worth more from a scale than from a glance,
     * and a later iteration that weights them needs to be able to tell.
     */
    basis: materialStockCheckBasis("basis").notNull().default("bucket"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("material_stock_check_org_material_idx").on(
      table.organizationId,
      table.materialId,
      table.checkedAt,
    ),
    check("material_stock_check_non_negative", sql`${table.observedQuantityMilliUnits} >= 0`),
  ],
);

/**
 * A purchase recorded as a lump sum: rent, a lamp, an ad, a box of files.
 *
 * Deliberately not a `material`. A material is priced per base unit so a recipe
 * can consume 0.3 ml of it; an expense is a single amount that happened once and
 * has no unit, no package and no consumption. Forcing one into the other would
 * mean inventing a package size, which `baseUnitCostMinor` would then divide by.
 *
 * Rows are archived, never deleted, for the reason section 15.3 gives for the
 * organization itself: financial records are kept even when the person who
 * entered them wants the line gone from their screen.
 */
export const expenses = pgTable(
  "expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    category: expenseCategory("category").notNull(),
    /**
     * The day the money was spent, which is not the day the row was written:
     * a receipt from last week gets entered today, and the period filter has
     * to answer for the purchase, not for the typing.
     *
     * `date`, not a timestamp — a purchase happens on a day, and giving it a
     * time would invite a timezone question nobody asked. Defaulted rather
     * than required so the column could be added without breaking the
     * previous version's inserts (`tests/migration-compatibility.test.ts`).
     */
    spentOn: date("spent_on", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: currency("currency").notNull(),
    note: text("note"),
    /**
     * Rent, a subscription — something the business pays every month.
     *
     * Held as one row with an interval rather than materialised twelve times.
     * Raising the rent in June must not rewrite January, and the way to
     * guarantee that is for January never to have held a row June could edit:
     * the old row gets a `recurringTo`, a new one starts at `recurringFrom`,
     * and every month keeps the amount that was true in it.
     *
     * `spentOn` still means the day of the payment, so a recurring row says
     * which day of the month the money goes out.
     */
    isRecurring: boolean("is_recurring").notNull().default(false),
    recurringFrom: date("recurring_from", { mode: "string" }),
    /** Null for "still running". The month it falls in is charged in full. */
    recurringTo: date("recurring_to", { mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    // The list is read by period, so the index carries the day it sorts by.
    index("expense_org_idx").on(table.organizationId, table.spentOn),
    check("expense_amount_non_negative", sql`${table.amountMinor} >= 0`),
    // A recurring row with no start would be read as "since forever" by
    // anything less careful than `domain/expense-periods.ts`, and would charge
    // every month in history. Refused here so that only one layer has to be
    // careful.
    check(
      "expense_recurring_shape",
      sql`not ${table.isRecurring} or ${table.recurringFrom} is not null`,
    ),
    check(
      "expense_recurring_order",
      sql`${table.recurringTo} is null or ${table.recurringFrom} is null or ${table.recurringTo} >= ${table.recurringFrom}`,
    ),
  ],
);

/**
 * Money the owner took out of the business, for themselves.
 *
 * Its own table rather than an expense category, because it is not an expense:
 * a draw does not make the business poorer at the level of profit — it moves
 * money that was already earned from one pocket to another. Filed under
 * `payroll` in the ledger, as it is today, it either shrinks the profit that
 * pays for it or hides inside the `cash_only` class where nothing can see it.
 * Neither is a report anybody can act on.
 *
 * So it appears in exactly one place: the cash flow, where it belongs, and
 * nowhere in the profit and loss.
 */
export const ownerDraws = pgTable(
  "owner_draw",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: currency("currency").notNull(),
    /** The day the money left, like `expense.spent_on` and for the same reason. */
    occurredOn: date("occurred_on", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    note: text("note"),
    ...auditColumns,
  },
  (table) => [
    index("owner_draw_org_idx").on(table.organizationId, table.occurredOn),
    // A negative draw would be money going the other way — an owner putting
    // funds in. That is a different event and would need its own row; letting
    // it in through the sign would make the total mean two things at once.
    check("owner_draw_amount_non_negative", sql`${table.amountMinor} >= 0`),
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
    /**
     * This person takes the residual profit rather than a wage — the owner who
     * also stands at the table, and the owner who only runs the place.
     *
     * Kept on the specialist rather than on the organization because it is a
     * property of a person: `organization.type` cannot tell a studio whose
     * owner works from one whose owner does not, and both exist. A commission
     * booked to a principal never leaves the business, so the monthly report
     * adds it back before subtracting their imputed wage — see
     * `docs/cost-engine-redesign-plan.md`, section 1.
     */
    isPrincipal: boolean("is_principal").notNull().default(false),
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
export const commissionBase = pgEnum("commission_base", commissionBases);

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
    /** Set for percentage and hybrid rules; 4000 = 40%. */
    basisPoints: integer("basis_points"),
    /** Set for fixed rules, and for the guaranteed part of a hybrid one. */
    fixedAmountMinor: bigint("fixed_amount_minor", { mode: "number" }),
    /**
     * What the percentage applies to. `after_discount` is what every rule
     * written before this column did, so it is the default and no history moves.
     */
    base: commissionBase("base").notNull().default("after_discount"),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeTo: timestamp("active_to", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("commission_rule_lookup_idx").on(table.organizationId, table.specialistId, table.activeFrom),
    /*
     * Exactly the fields the rule's own type needs, and not the others.
     *
     * Rewritten for `hybrid`, which is the first type that needs both a rate
     * and an amount. The previous form said «not fixed ⇒ no amount», so it had
     * to be replaced rather than extended — the one working integrity rule the
     * redesign changes, and the reason this stage went last.
     *
     * Compared as text on purpose. PostgreSQL refuses to *use* an enum value in
     * the transaction that added it, and drizzle-kit applies every pending
     * migration in one transaction — so a constraint naming the enum label
     * `'hybrid'` cannot be created in the same run that adds it. Against text
     * the label is an ordinary constant, and the whole change applies in one
     * go. The rule enforced is identical.
     */
    check(
      "commission_rule_shape",
      sql`(${table.type}::text = 'fixed' and ${table.fixedAmountMinor} is not null and ${table.basisPoints} is null)
        or (${table.type}::text in ('percentage', 'percentage_after_materials') and ${table.basisPoints} is not null and ${table.fixedAmountMinor} is null)
        or (${table.type}::text = 'hybrid' and ${table.basisPoints} is not null and ${table.fixedAmountMinor} is not null)`,
    ),
    check(
      "commission_rule_non_negative",
      sql`(${table.basisPoints} is null or ${table.basisPoints} >= 0)
        and (${table.fixedAmountMinor} is null or ${table.fixedAmountMinor} >= 0)`,
    ),
  ],
);

/**
 * Which services a rule covers, when it does not cover all of them.
 *
 * Absence of rows means «every service», which is what every rule written
 * before this table did. A filter rather than a fourth commission base: «5% of
 * the full price, but only on colouring» is a sentence the product should be
 * able to say, and folding the choice of services into the choice of arithmetic
 * would have made it unsayable.
 */
export const commissionRuleServices = pgTable(
  "commission_rule_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    commissionRuleId: uuid("commission_rule_id")
      .notNull()
      .references(() => commissionRules.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("commission_rule_service_idx").on(table.commissionRuleId, table.serviceId),
  ],
);

export const laborCostRecipient = pgEnum("labor_cost_recipient", ["owner", "specialist"]);
export const laborCostBasis = pgEnum("labor_cost_basis", ["fixed_monthly", "percent_revenue"]);

/**
 * Labour that a month owes and no single visit does.
 *
 * Two things that look different and are the same mechanism: a master on a
 * monthly salary, and what the owner's own work is worth. Neither can be
 * attached to a visit — a salary does not divide into the visits that happened
 * to occur, and the owner is paid by what is left over — so both are subtracted
 * once, at the level of the month.
 *
 * They sit on opposite sides of the operating profit all the same. A salary is
 * a cost of running the place; the owner's imputed wage is what the owner's own
 * hours were worth, and subtracting it turns operating profit into economic
 * profit — the answer to «зарабатывает ли бизнес сверх моего труда».
 *
 * Versioned by `activeFrom` rather than edited, like `commission_rule`: raising
 * a salary in June must leave January reporting January's.
 *
 * A salaried master's rule here is only half the arrangement. The other half is
 * a commission rule of 0% on their visits, so that the visit charges nothing
 * and the month charges once — see `docs/cost-engine-redesign-plan.md`, 5.3.
 */
export const laborCostRules = pgTable(
  "labor_cost_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recipient: laborCostRecipient("recipient").notNull(),
    /** Required for a specialist, absent for the owner. */
    specialistId: uuid("specialist_id").references(() => specialists.id, { onDelete: "restrict" }),
    /** «Оклад Марии», «Моя работа». Free text, so it can hold a person's name. */
    label: text("label"),
    basis: laborCostBasis("basis").notNull(),
    /** Set for `fixed_monthly`. */
    amountMinor: bigint("amount_minor", { mode: "number" }),
    /** Set for `percent_revenue`; 1500 = 15% of the month's revenue. */
    basisPoints: integer("basis_points"),
    /** Employer's contributions on top of the wage. 0 where there are none. */
    payrollTaxBasisPoints: integer("payroll_tax_basis_points").notNull().default(0),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeTo: timestamp("active_to", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("labor_cost_rule_lookup_idx").on(table.organizationId, table.recipient, table.activeFrom),
    check(
      "labor_cost_rule_shape",
      sql`(${table.basis} = 'fixed_monthly' and ${table.amountMinor} is not null and ${table.basisPoints} is null)
        or (${table.basis} = 'percent_revenue' and ${table.basisPoints} is not null and ${table.amountMinor} is null)`,
    ),
    // The owner is the organization's, not a row in the specialist table; a
    // specialist's salary without a specialist would be charged to nobody.
    check(
      "labor_cost_rule_recipient",
      sql`(${table.recipient} = 'specialist') = (${table.specialistId} is not null)`,
    ),
    check(
      "labor_cost_rule_non_negative",
      sql`(${table.amountMinor} is null or ${table.amountMinor} >= 0)
        and (${table.basisPoints} is null or ${table.basisPoints} >= 0)
        and ${table.payrollTaxBasisPoints} >= 0`,
    ),
  ],
);

export const paymentMethodKind = pgEnum("payment_method_kind", ["cash", "card", "transfer", "other"]);

/**
 * How a visit was paid for, and what that costs.
 *
 * Not versioned, unlike `commission_rule` and `tax_rule`: the rate is copied
 * into the visit when it closes, so a new contract with the bank is a plain
 * edit here and every closed visit keeps the rate it was charged at. The two
 * approaches are not in disagreement — versioning exists for rules that have to
 * be resolved for a *past* date, and this one never is.
 *
 * `is_default` is the whole acquiring feature in one column: the fee is only
 * counted if someone picks a method at closing, and the way to make that happen
 * is to have the right one already chosen rather than to refuse the visit.
 */
export const paymentMethods = pgTable(
  "payment_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: paymentMethodKind("kind").notNull(),
    /** The acquirer's percentage. Zero for cash, which is the point of the row. */
    commissionBasisPoints: integer("commission_basis_points").notNull().default(0),
    /** A flat charge per transaction, on top of the percentage. */
    fixedFeeMinor: bigint("fixed_fee_minor", { mode: "number" }).notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("payment_method_org_idx").on(table.organizationId),
    // One default, and only among the live ones: archiving the default must not
    // stand in the way of naming another.
    uniqueIndex("payment_method_default_idx")
      .on(table.organizationId)
      .where(sql`${table.isDefault} and ${table.archivedAt} is null`),
    check(
      "payment_method_non_negative",
      sql`${table.commissionBasisPoints} >= 0 and ${table.fixedFeeMinor} >= 0`,
    ),
  ],
);

/**
 * Taxes that attach to a visit.
 *
 * Three kinds and deliberately not four. v1 of the plan also had
 * `fixed_contribution` — a fixed monthly payment — and it is left out because
 * the expense ledger already records exactly that, as a recurring row in the
 * `taxes` category. Two ways to enter the same money is how a sum gets
 * subtracted twice, which invariant 6 of the plan forbids.
 *
 * Versioned like `commission_rule`: a rate that changes in July must leave June
 * reporting June's, and the rule in force is chosen by `active_from` at the
 * moment the visit closed.
 */
export const taxKind = pgEnum("tax_kind", ["vat", "turnover", "payroll"]);

export const taxRules = pgTable(
  "tax_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: taxKind("kind").notNull(),
    basisPoints: integer("basis_points").notNull(),
    /**
     * Whether the VAT collected is handed on to the state.
     *
     * Only meaningful for `vat`. False records the rate without taking it out
     * of revenue — for a business that shows VAT on a document but is not a
     * payer under its regime. Deducting it anyway would understate the margin
     * of every visit.
     */
    remittable: boolean("remittable").notNull().default(true),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull().defaultNow(),
    activeTo: timestamp("active_to", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    index("tax_rule_lookup_idx").on(table.organizationId, table.kind, table.activeFrom),
    check("tax_rule_basis_points_range", sql`${table.basisPoints} >= 0 and ${table.basisPoints} <= 10000`),
    check(
      "tax_rule_active_range",
      sql`${table.activeTo} is null or ${table.activeTo} > ${table.activeFrom}`,
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
    /** Client-generated key that makes a retried manual close return one visit. */
    completionKey: text("completion_key"),
    /** Refuses reuse of a key for a different close request. */
    completionFingerprint: text("completion_fingerprint"),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    plannedDurationMinutes: integer("planned_duration_minutes").notNull(),
    actualDurationMinutes: integer("actual_duration_minutes"),
    status: visitStatus("status").notNull().default("completed"),
    /**
     * The currency the visit was charged in, copied like every other figure it
     * owns. Re-costing used to hardcode "MDL", so an organization on EUR got
     * its first snapshot in EUR and every correction afterwards in MDL — a
     * silent swap, because the screen formats by the organization's currency
     * either way. Defaulted rather than required so the column could be added
     * without breaking the previous version's inserts.
     */
    currency: currency("currency").notNull().default("MDL"),
    /**
     * Whether the specialist was a principal when the visit closed, snapshotted
     * for the same reason the commission rule is: marking someone a principal
     * next year must not rewrite what last year's months reported. Nullable
     * because it arrives by the expand step; `domain/period-pl.ts` reads a null
     * as false rather than the database doing it, so the gap stays visible.
     */
    masterIsPrincipal: boolean("master_is_principal"),
    /**
     * Whether every sold line had a saved standard material profile at close.
     * True by default preserves the interpretation of legacy visits.
     */
    standardMaterialUsageKnown: boolean("standard_material_usage_known").notNull().default(true),
    /**
     * How it was paid, and what the acquirer took, copied at closing time.
     *
     * `set null` on the reference and the rate kept separately: deleting a
     * payment method must not silently make a closed visit cheaper. The
     * snapshot is what the costing reads; the id is for reporting.
     *
     * Null means cash as far as the margin is concerned — no fee. A visit
     * closed before any of this existed therefore costs exactly what it always
     * did, which is what lets `costing-v2` recompute the whole history without
     * moving a figure.
     */
    paymentMethodId: uuid("payment_method_id").references((): AnyPgColumn => paymentMethods.id, {
      onDelete: "set null",
    }),
    paymentCommissionBasisPointsSnapshot: integer("payment_commission_basis_points_snapshot"),
    paymentFixedFeeMinorSnapshot: bigint("payment_fixed_fee_minor_snapshot", { mode: "number" }),
    /**
     * The tax rules in force when the visit closed:
     * `{ vat_bp, remittable_vat, turnover_bp, payroll_bp }`.
     *
     * One JSON column rather than four: they are read together, written
     * together and never queried apart, and a visit that predates the feature
     * holds one null instead of four.
     */
    taxSnapshot: jsonb("tax_snapshot").$type<TaxRates>(),
    // CST-009: the commission rule is copied into the visit. Resolving it from
    // the rule table by date would almost work, but it would leave a closed
    // visit depending on rows that live elsewhere and can still be edited.
    commissionType: commissionType("commission_type").notNull(),
    commissionBasisPoints: integer("commission_basis_points"),
    commissionFixedAmountMinor: bigint("commission_fixed_amount_minor", { mode: "number" }),
    /**
     * What the percentage applied to. Nullable because it arrives by the expand
     * step; a null reads as `after_discount`, which is what every visit closed
     * before this column was costed on.
     */
    commissionBase: commissionBase("commission_base"),
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
    uniqueIndex("visit_completion_key_idx").on(table.organizationId, table.completionKey),
    check("visit_planned_duration_positive", sql`${table.plannedDurationMinutes} > 0`),
    // Rewritten alongside `commission_rule_shape`, and text-compared for the
    // same reason spelled out there.
    check(
      "visit_commission_shape",
      sql`(${table.commissionType}::text = 'fixed' and ${table.commissionFixedAmountMinor} is not null and ${table.commissionBasisPoints} is null)
        or (${table.commissionType}::text in ('percentage', 'percentage_after_materials') and ${table.commissionBasisPoints} is not null and ${table.commissionFixedAmountMinor} is null)
        or (${table.commissionType}::text = 'hybrid' and ${table.commissionBasisPoints} is not null and ${table.commissionFixedAmountMinor} is not null)`,
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
    /**
     * Money given back for this line after the visit closed.
     *
     * A separate column rather than a larger discount: a discount is what was
     * agreed before the work, a refund is what happened after it, and a report
     * that cannot tell them apart cannot answer why the month was short. The
     * revenue of the visit is `price − discount − refund`.
     */
    refundMinor: bigint("refund_minor", { mode: "number" }).notNull().default(0),
    /**
     * Whether the master's percentage applies to this line, decided when the
     * visit closed from the services the rule covers.
     *
     * True by default, which is every line ever written before this: a rule
     * with no service list covers everything. Kept per line rather than as a
     * list of service ids on the visit, so that a refund on one line still
     * recomputes the base correctly — the filter and the arithmetic stay in the
     * place the numbers are.
     */
    commissionable: boolean("commissionable").notNull().default(true),
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
    // Nothing can be given back that was never charged. Without this a refund
    // typo turns a visit's revenue negative, and every total above it with it.
    check(
      "visit_line_refund_within_charged",
      sql`${table.refundMinor} >= 0 and ${table.refundMinor} <= ${table.priceMinor} - ${table.discountMinor}`,
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
    /** Null identifies a legacy snapshot whose stored cost remains authoritative. */
    materialUsageSource: text("material_usage_source").$type<MaterialUsageSource>(),
    /**
     * What the master's work cost. The name stays as it is: renaming a column
     * every reader of history already knows would buy a better word at the
     * price of the history reading correctly.
     */
    commissionMinor: bigint("commission_minor", { mode: "number" }),
    /*
     * The `costing-v2` figures. All nullable, because they arrive by the expand
     * step and because a snapshot written under `costing-v1` never had them —
     * and a zero there would be a claim that the VAT was nil rather than that
     * nobody asked. `formula_version` is what tells the two apart.
     */
    netRevenueMinor: bigint("net_revenue_minor", { mode: "number" }),
    vatMinor: bigint("vat_minor", { mode: "number" }),
    turnoverTaxMinor: bigint("turnover_tax_minor", { mode: "number" }),
    paymentCommissionMinor: bigint("payment_commission_minor", { mode: "number" }),
    payrollTaxMinor: bigint("payroll_tax_minor", { mode: "number" }),
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
    check(
      "financial_snapshot_material_source",
      sql`${table.materialUsageSource} is null or ${table.materialUsageSource} in ('standard', 'actual')`,
    ),
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
    /**
     * One anonymous visit to the public booking page, so section 7.10's funnel
     * can count visits instead of distinct entities.
     *
     * Without it the dedupe key below made `booking_page_viewed` mean "someone
     * has opened this page at least once, ever" — one row per organization for
     * all time — and `booking_availability_searched` one row per service. A
     * funnel built on that measures the catalogue, not the clients.
     *
     * A random identifier the browser mints per visit and forgets. It is not a
     * user id and not a device id: it never leaves this table, it is not joined
     * to a client, and a second visit from the same phone is a second key.
     *
     * Empty rather than null for the events that have no visit behind them —
     * staff actions, imports — because it is part of a unique index, and in one
     * NULL is never equal to another.
     */
    sessionKey: text("session_key").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pilot_product_event_dedupe_idx").on(
      table.organizationId,
      table.eventName,
      table.entityType,
      table.entityId,
      table.sessionKey,
    ),
    index("pilot_product_event_org_time_idx").on(table.organizationId, table.occurredAt),
    index("pilot_product_event_session_idx").on(table.sessionKey, table.occurredAt),
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
    /**
     * The answer that was sent, for retries whose result is not a booking.
     *
     * E3.1 needs "the same key returns the same counts and creates nothing",
     * and `booking_id` cannot carry that: a bulk paste that created 28
     * materials has no single row to point at. The table was already generic
     * over `scope`; this is the missing half of it. The name stays
     * `booking_idempotency_key` because renaming a table is the one change in
     * this migration that would not roll back cleanly.
     */
    result: jsonb("result").$type<Record<string, unknown>>(),
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
export const notificationProviderStatus = pgEnum("notification_provider_status", [
  "accepted",
  "sent",
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
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
    /** Latest chronologically observed provider state, never recipient PII. */
    providerStatus: notificationProviderStatus("provider_status"),
    providerEventAt: timestamp("provider_event_at", { withTimezone: true }),
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

/**
 * Resend delivers webhooks at least once and does not guarantee ordering.
 * Keeping only the provider event id/type/time gives us durable deduplication
 * and an audit trail without copying recipient, subject or message body.
 */
export const notificationProviderEvents = pgTable(
  "notification_provider_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notificationOutbox.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    eventType: notificationProviderStatus("event_type").notNull(),
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_provider_event_provider_id_idx").on(table.providerEventId),
    index("notification_provider_event_notification_idx").on(
      table.notificationId,
      table.eventCreatedAt,
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
