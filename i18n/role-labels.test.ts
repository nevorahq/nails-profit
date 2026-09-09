import { describe, expect, it } from "vitest";

import { memberRoles } from "@/domain/rbac";
import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";
import { INVITABLE_ROLES, ROLE_HINTS } from "@/i18n/role-labels";

describe("role descriptions", () => {
  it("says something about every role, in every language", () => {
    const missing = memberRoles.flatMap((role) =>
      supportedLocales
        .filter((locale) => !dictionaries[locale][ROLE_HINTS[role]])
        .map((locale) => `${locale}/${role}`),
    );

    expect(missing).toEqual([]);
  });

  it("does not describe two roles with the same sentence", () => {
    /*
     * The failure this catches is a copy-paste, and it is worse than a missing
     * line: an owner reading the manager's powers under «аналитик» invites the
     * wrong person and has no reason to doubt it.
     */
    for (const locale of supportedLocales) {
      const said = memberRoles.map((role) => dictionaries[locale][ROLE_HINTS[role]]);
      expect(new Set(said).size).toBe(memberRoles.length);
    }
  });

  it("offers every role but the owner's", () => {
    // The studio has one owner, and `DELETE /memberships/[id]` refuses to
    // leave it with none — a second one is a decision nobody has asked for.
    expect(INVITABLE_ROLES).not.toContain("owner");
    expect([...INVITABLE_ROLES].sort()).toEqual(
      memberRoles.filter((role) => role !== "owner").sort(),
    );
  });
});
