/**
 * Capability matrix from spec section 6.1.
 *
 * The spec's cells are not booleans: they carry scope ("свои записи"), field
 * restrictions ("без телефонов и email") and granularity ("агрегаты"). Encoding
 * them as yes/no would lose exactly the parts that matter, so each cell becomes
 * a permission with an action set, a scope and constraints. Every cell keeps the
 * spec's own wording in `note` so the encoding stays auditable against the
 * document.
 *
 * Spec section 6.1: "Права должны проверяться backend-слоем. Скрытие кнопки в
 * интерфейсе не считается контролем доступа." This module is the backend
 * decision point; it must never be mirrored into a client-side check that the
 * server does not also make.
 */

export const memberRoles = ["owner", "manager", "master", "analyst"] as const;
export type MemberRole = (typeof memberRoles)[number];

/** One row of the section 6.1 table. */
export const capabilities = [
  "organization_settings",
  "user_management",
  "clients",
  "bookings",
  "services",
  "materials",
  "commissions",
  "dashboard",
  "campaigns",
  "data_export",
] as const;
export type Capability = (typeof capabilities)[number];

export type RbacAction = "read" | "write";

/** Whether the role sees every row in the org, or only rows tied to itself. */
export type RbacScope = "all" | "own";

export type RbacConstraint =
  /** Analyst reads client history without phone numbers or email. */
  | "exclude_pii"
  /** Analyst sees aggregates, never row-level financial detail. */
  | "aggregates_only"
  /** Manager administers users but may not touch an Owner. */
  | "exclude_owner";

export type Permission = Readonly<{
  actions: readonly RbacAction[];
  scope: RbacScope;
  constraints: readonly RbacConstraint[];
  /** The spec cell this encodes, verbatim. */
  note: string;
}>;

const DENIED: Permission = { actions: [], scope: "own", constraints: [], note: "Нет" };

function permission(
  actions: readonly RbacAction[],
  scope: RbacScope,
  note: string,
  constraints: readonly RbacConstraint[] = [],
): Permission {
  return { actions, scope, constraints, note };
}

const READ_WRITE: readonly RbacAction[] = ["read", "write"];
const READ_ONLY: readonly RbacAction[] = ["read"];

export const roleCapabilities: Readonly<Record<MemberRole, Readonly<Record<Capability, Permission>>>> = {
  owner: {
    organization_settings: permission(READ_WRITE, "all", "Да"),
    user_management: permission(READ_WRITE, "all", "Да"),
    clients: permission(READ_WRITE, "all", "Да"),
    bookings: permission(READ_WRITE, "all", "Да"),
    services: permission(READ_WRITE, "all", "Да"),
    materials: permission(READ_WRITE, "all", "Да"),
    commissions: permission(READ_WRITE, "all", "Да"),
    dashboard: permission(READ_ONLY, "all", "Все данные"),
    campaigns: permission(READ_WRITE, "all", "Да"),
    data_export: permission(READ_WRITE, "all", "Да"),
  },
  manager: {
    organization_settings: DENIED,
    user_management: permission(READ_WRITE, "all", "Да, кроме Owner", ["exclude_owner"]),
    clients: permission(READ_WRITE, "all", "Да"),
    bookings: permission(READ_WRITE, "all", "Да"),
    services: permission(READ_WRITE, "all", "Да"),
    materials: permission(READ_WRITE, "all", "Да"),
    commissions: permission(READ_WRITE, "all", "Да"),
    dashboard: permission(READ_ONLY, "all", "Все данные"),
    campaigns: permission(READ_WRITE, "all", "Да"),
    data_export: DENIED,
  },
  master: {
    organization_settings: DENIED,
    user_management: DENIED,
    clients: permission(READ_WRITE, "own", "Только назначенные клиенты/визиты"),
    bookings: permission(READ_WRITE, "own", "Свои записи"),
    services: permission(READ_ONLY, "all", "Чтение"),
    // Open question for Phase 2: the spec grants the write (recording actual
    // consumption) but never says whether a master may browse the material
    // catalogue needed to pick from. Encoded at the narrower reading.
    materials: permission(READ_WRITE, "own", "Фактическое списание по своим визитам"),
    commissions: permission(READ_ONLY, "own", "Только собственный результат"),
    dashboard: permission(READ_ONLY, "own", "Только собственные"),
    campaigns: DENIED,
    data_export: DENIED,
  },
  analyst: {
    organization_settings: DENIED,
    user_management: DENIED,
    clients: permission(READ_ONLY, "all", "Чтение без телефонов и email", ["exclude_pii"]),
    bookings: permission(READ_ONLY, "all", "Чтение"),
    services: permission(READ_ONLY, "all", "Чтение"),
    materials: permission(READ_ONLY, "all", "Чтение агрегатов", ["aggregates_only"]),
    commissions: permission(READ_ONLY, "all", "Агрегаты", ["aggregates_only"]),
    dashboard: permission(READ_ONLY, "all", "Все агрегаты", ["aggregates_only"]),
    campaigns: permission(READ_ONLY, "all", "Чтение результатов"),
    data_export: DENIED,
  },
};

export function permissionFor(role: MemberRole, capability: Capability): Permission {
  return roleCapabilities[role][capability];
}

export function can(role: MemberRole, capability: Capability, action: RbacAction): boolean {
  return permissionFor(role, capability).actions.includes(action);
}

/**
 * Scope the caller is limited to, or null when the capability is denied outright.
 * A query must filter to the acting specialist when this returns "own".
 */
export function scopeFor(role: MemberRole, capability: Capability): RbacScope | null {
  const granted = permissionFor(role, capability);
  return granted.actions.length === 0 ? null : granted.scope;
}

export function hasConstraint(
  role: MemberRole,
  capability: Capability,
  constraint: RbacConstraint,
): boolean {
  return permissionFor(role, capability).constraints.includes(constraint);
}

/**
 * True when the role may write across the whole organization, not merely its own
 * rows. Catalogue changes need this: section 6.1 grants a Master `materials`
 * write, but scoped to "фактическое списание по своим визитам" — recording what
 * they used on their own visit, not editing the shared catalogue every other
 * master calculates against. Checking `can` alone would let a Master rewrite it.
 */
export function canManageCatalogue(role: MemberRole, capability: Capability): boolean {
  return can(role, capability, "write") && scopeFor(role, capability) === "all";
}

/** True when `actor` may administer a member holding `target`'s role. */
export function canManageRole(actor: MemberRole, target: MemberRole): boolean {
  if (!can(actor, "user_management", "write")) return false;
  if (target === "owner" && hasConstraint(actor, "user_management", "exclude_owner")) return false;
  return true;
}
