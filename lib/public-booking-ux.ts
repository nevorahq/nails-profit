import type { MessageKey } from "@/i18n/t";

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

export type PublicApiFieldError = Readonly<{ field: string; code: string; message: string }>;

export type PublicApiError = Readonly<{
  code: string | null;
  status: number;
  fieldErrors: readonly PublicApiFieldError[];
  retryAfterSeconds: number | null;
  requestId: string | null;
}>;

/**
 * Reading a refusal from the public API into something the form can show.
 *
 * The API answers section 12.1's shape — a stable `code`, a `field_errors`
 * list, a `request_id` — and the form used to read the code alone, translate
 * five of the twenty it can receive, and print "check the details and try
 * again" for the rest. A client who had simply tried once too often in an hour
 * was told their name was wrong; a studio asked why could not say which of the
 * twenty it had been, because the one identifier that would have answered it
 * was in a response nobody kept.
 *
 * Parsed defensively: a refusal that arrives as an HTML error page, or from a
 * proxy that never reached a handler, still has a status, and a status alone is
 * enough to tell "we are down" from "you sent something we cannot accept".
 */
export function readApiError(body: unknown, status: number): PublicApiError {
  const error = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const details = error?.details as { retry_after_seconds?: unknown } | undefined;
  const retryAfter = details?.retry_after_seconds;

  return {
    code: typeof error?.code === "string" ? error.code : null,
    status,
    fieldErrors: Array.isArray(error?.field_errors)
      ? (error.field_errors as unknown[]).filter(isFieldError)
      : [],
    retryAfterSeconds: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : null,
    requestId: typeof error?.request_id === "string" ? error.request_id : null,
  };
}

function isFieldError(value: unknown): value is PublicApiFieldError {
  const entry = value as PublicApiFieldError | null;
  return typeof entry?.field === "string" && typeof entry?.code === "string";
}

/**
 * Every code the public surface can refuse with, and what it means to the
 * person reading it.
 *
 * Grouped by the action it asks for rather than by the layer it came from:
 * "pick another time", "start again", "wait", "fix a field". A client does not
 * care that a hold and an idempotency key are different mechanisms; they care
 * that one wants a new slot and the other wants the form resubmitted from the
 * top.
 */
const ERROR_MESSAGES: Readonly<Record<string, MessageKey>> = {
  SLOT_UNAVAILABLE: "publicBooking.slotUnavailable",
  SLOT_OR_CONTACT_CONFLICT: "publicBooking.slotUnavailable",
  HOLD_EXPIRED: "publicBooking.holdExpired",
  HOLD_MISMATCH: "publicBooking.holdMismatch",
  SERVICE_NOT_BOOKABLE: "publicBooking.serviceUnavailable",
  VERIFICATION_FAILED: "publicBooking.verifyFailed",
  VERIFICATION_EXPIRED: "publicBooking.verifyExpired",
  VERIFICATION_LOCKED: "publicBooking.verifyLocked",
  VERIFICATION_REQUIRED: "publicBooking.verifyRequired",
  VERIFICATION_NOT_REQUIRED: "publicBooking.staleStep",
  CHALLENGE_REQUIRED: "publicBooking.staleStep",
  CONTACT_CONFLICT: "publicBooking.contactConflict",
  IDEMPOTENCY_KEY_REUSED: "publicBooking.retryFromStart",
  IDEMPOTENCY_KEY_REQUIRED: "publicBooking.retryFromStart",
  VALIDATION_ERROR: "publicBooking.checkFields",
  INVALID_PHONE: "publicBooking.checkFields",
  INVALID_EMAIL: "publicBooking.checkFields",
  BOOKING_PAGE_NOT_FOUND: "publicBooking.pageUnavailable",
  PREVIEW_READ_ONLY: "publicBooking.previewReadOnly",
  VERSION_CONFLICT: "publicBooking.versionConflict",
  CANNOT_RESCHEDULE: "publicBooking.cannotReschedule",
  ILLEGAL_TRANSITION: "publicBooking.illegalTransition",
};

/**
 * `publicBooking.rateLimited` promises nothing about when; the `In` variant
 * names the minute. Which one is honest depends on whether the refusal carried
 * `retry_after_seconds`, so the choice belongs here rather than at the call
 * site, where "later" would quietly become "in 1 minute".
 */
export function publicBookingErrorKey(error: PublicApiError): MessageKey {
  if (error.code === "RATE_LIMITED") {
    return error.retryAfterSeconds === null
      ? "publicBooking.rateLimited"
      : "publicBooking.rateLimitedIn";
  }

  const known = error.code === null ? undefined : ERROR_MESSAGES[error.code];
  if (known) return known;

  // A 5xx is never the client's data. Saying so stops them editing a correct
  // form until the deployment recovers on its own.
  return error.status >= 500 ? "publicBooking.serverError" : "publicBooking.error";
}

/** Whole minutes, rounded up, because "wait 0 minutes" is not an instruction. */
export function retryAfterMinutes(error: PublicApiError): number {
  return Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
}

export type BookingStateForClient = Readonly<{
  status: "pending_confirmation" | "confirmed" | "cancelled" | "completed" | "no_show";
  cancelledBy: "client" | "staff" | "system" | null;
  /** A code from `STAFF_CANCELLATION_REASONS`, or the job's `confirmation_expired`. */
  cancellationReason: string | null;
  /** Whether `confirmation_due_at` is set — only manual confirmation has one. */
  hasConfirmationDeadline: boolean;
}>;

/**
 * The sentence under the status badge: what this state means for the client.
 *
 * The badge names the state and stops there, which for four of the five is
 * nearly enough and for the fifth is nothing at all. "Отменена" is one word
 * covering four different events — the client called it off themselves, the
 * studio did, nobody could reach them, or a request ran out of time unanswered
 * — and they need different words and different next steps. Only the client's
 * own cancellation is a thing they already know about.
 *
 * Here rather than in the component for the same reason `publicBookingErrorKey`
 * is: choosing which sentence is true is logic with branches, and it should be
 * testable without rendering anything. The wording itself stays in the
 * dictionary, in all three languages.
 */
export function bookingNextStepKey(state: BookingStateForClient): MessageKey {
  if (state.status === "pending_confirmation") {
    // Without a deadline there is nothing honest to promise: an instant-
    // confirmation studio leaves `confirmation_due_at` null, and naming an hour
    // the request will not lapse at would be inventing one.
    return state.hasConfirmationDeadline
      ? "publicBooking.next.pending"
      : "publicBooking.next.pendingSoon";
  }
  if (state.status === "confirmed") return "publicBooking.next.confirmed";
  if (state.status === "completed") return "publicBooking.next.completed";
  if (state.status === "no_show") return "publicBooking.next.noShow";

  if (state.cancellationReason === "confirmation_expired") {
    return "publicBooking.next.cancelledExpired";
  }
  if (state.cancellationReason === "no_contact") {
    return "publicBooking.next.cancelledNoContact";
  }
  if (state.cancellationReason === "duplicate") {
    return "publicBooking.next.cancelledDuplicate";
  }
  /*
   * `client_request` is the studio recording that a client asked them to cancel
   * — a phone call, not a click — so the actor is what separates "you did this"
   * from "we did this at your request", and the actor is `staff` for both.
   */
  return state.cancelledBy === "client"
    ? "publicBooking.next.cancelledByClient"
    : "publicBooking.next.cancelledByStudio";
}

/**
 * The same sentence on the studio's own page, where the record is thinner.
 *
 * The manage page knows why a booking was cancelled — who did it, and under
 * which reason — and has five ways of saying so. The strip on `/book/[slug]`
 * has a status and a version and nothing else, because that is all the status
 * endpoint answers with and all the browser kept. So a cancellation here says
 * only that there was one and sends the client to the page that can name it;
 * the other four states read the same in both places and share the wording
 * rather than growing a second set of it.
 */
export function bookingStripKey(status: BookingStateForClient["status"]): MessageKey {
  if (status === "cancelled") return "publicBooking.yoursCancelled";
  return bookingNextStepKey({
    status,
    cancelledBy: null,
    cancellationReason: null,
    hasConfirmationDeadline: false,
  });
}

/**
 * The API's `field_errors` placed back on the fields of this form.
 *
 * Server field names are the request body's — `legal_accepted`, and a nested
 * Zod path joined with dots — while the form's are its input names, so the two
 * have to be reconciled somewhere. Anything that does not belong to a field the
 * client can see is dropped rather than shown headless: `hold_token` is not
 * something a person can correct, and an error pointing at nothing is worse
 * than the summary line above it.
 */
export function toContactFieldErrors(
  error: PublicApiError,
): Partial<Record<PublicContactField, PublicContactError>> {
  const errors: Partial<Record<PublicContactField, PublicContactError>> = {};

  for (const entry of error.fieldErrors) {
    const field = contactFieldOf(entry.field);
    if (!field || errors[field]) continue;
    errors[field] = contactErrorOf(field, entry.code);
  }

  return errors;
}

function contactFieldOf(field: string): PublicContactField | null {
  const name = field.split(".")[0];
  if (name === "name" || name === "phone" || name === "email") return name;
  return name === "legal_accepted" || name === "legalAccepted" ? "legalAccepted" : null;
}

function contactErrorOf(field: PublicContactField, code: string): PublicContactError {
  // `invalid_type` is Zod's answer to a field that was not sent at all, which
  // for a form means it was left empty; everything else reached the format
  // check and failed it.
  if (field === "legalAccepted") return "required";
  if (code === "invalid_type" || code === "required") return "required";
  if (field === "name") return "nameTooShort";
  return field === "phone" ? "phoneInvalid" : "emailInvalid";
}

export type BookingRequestDraft = Readonly<{
  holdToken: string;
  serviceId: string;
  addOnIds: readonly string[];
  name: string;
  phone: string;
  email: string | null;
  locale: string;
}>;

/**
 * What makes two booking attempts the same request.
 *
 * The API fingerprints the body an idempotency key arrives with and refuses the
 * key if the two stop matching, so the browser has to mint a new key exactly
 * when the payload changes — no sooner, or a double tap books two Tuesdays; no
 * later, and a client who corrects a digit is locked out of their own form.
 * These are the fields `fingerprintOf` sees, in a fixed order, with the add-ons
 * sorted because the checkbox order is not part of the request.
 */
export function bookingRequestSignature(draft: BookingRequestDraft): string {
  return [
    draft.holdToken,
    draft.serviceId,
    [...draft.addOnIds].sort().join(","),
    draft.name,
    draft.phone,
    draft.email ?? "",
    draft.locale,
  ].join("\n");
}
