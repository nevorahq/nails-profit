export type PublicContactField = "name" | "phone" | "email" | "legalAccepted";

export type PublicContactDraft = Readonly<{
  name: string;
  phone: string;
  email: string;
  legalAccepted: boolean;
}>;

export type PublicContactError = "required" | "nameTooShort" | "phoneInvalid" | "emailInvalid";

/**
 * Client-side guardrails for the public form. The API remains authoritative;
 * this exists so a keyboard or screen-reader user gets errors next to the
 * actual field instead of a browser-specific tooltip with no summary.
 */
export function validatePublicContact(
  draft: PublicContactDraft,
  emailRequired: boolean,
): Partial<Record<PublicContactField, PublicContactError>> {
  const errors: Partial<Record<PublicContactField, PublicContactError>> = {};
  const name = draft.name.trim();
  const phoneDigits = draft.phone.replace(/\D/g, "");
  const email = draft.email.trim();

  if (!name) errors.name = "required";
  else if (name.length < 2) errors.name = "nameTooShort";

  if (!draft.phone.trim()) errors.phone = "required";
  else if (phoneDigits.length < 6) errors.phone = "phoneInvalid";

  if (emailRequired && !email) errors.email = "required";
  else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "emailInvalid";

  if (!draft.legalAccepted) errors.legalAccepted = "required";
  return errors;
}
