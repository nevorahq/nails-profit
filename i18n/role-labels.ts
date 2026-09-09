import type { MemberRole } from "@/domain/rbac";
import type { MessageKey } from "@/i18n/t";

/**
 * What each role is, in the owner's words rather than the matrix's.
 *
 * `domain/rbac.ts` carries the spec's own wording in every cell — «Да, кроме
 * Owner», «Только собственный результат», «Агрегаты» — and those are notes for
 * whoever encodes the rules, not sentences for whoever is choosing who to
 * invite. For as long as the product existed the four roles reached the screen
 * as four bare words, so an owner picked «аналитик» with no way of knowing what
 * an analyst would see. That is also why nobody noticed the role was being
 * shown every master's rate: nothing on any screen claimed otherwise.
 */
export const ROLE_HINTS: Record<MemberRole, MessageKey> = {
  owner: "roles.ownerHint",
  manager: "roles.managerHint",
  master: "roles.masterHint",
  analyst: "roles.analystHint",
};

/**
 * The roles an invitation may be written for.
 *
 * An owner is not among them: the studio has one, the removal endpoint refuses
 * to leave it with none, and a second one is a decision nobody has asked for.
 * `POST /api/v1/invitations` still accepts the whole enum — this is the list
 * the screen offers, not the rule the server keeps.
 */
export const INVITABLE_ROLES: readonly MemberRole[] = ["master", "manager", "analyst"];
