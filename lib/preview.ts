/**
 * The owner's "посмотреть как" context: which colleague's interface the owner
 * is currently looking at.
 *
 * This is not a second session and it is not a credential. Better Auth keeps
 * one session per browser origin — signing in as a second person replaces the
 * first, which is the whole reason this module exists — so the owner stays the
 * one authenticated actor and this cookie only says which member's view to
 * render for them. Every request re-checks, against the database, that the
 * actor may look and that the target is theirs to look at; the cookie is a
 * selection, never a grant. See `lib/membership.ts` for those checks.
 *
 * That is also why it is unsigned. The two things a forged value can do are
 * both harmless: name a member the server then refuses, or turn the request
 * read-only against the person who forged it. Neither reaches another
 * organization's rows, because the check that follows reads the membership
 * table rather than the cookie.
 *
 * Nothing here touches `next/headers`, so `proxy.ts` can share the cookie's
 * name and parser with the rest of the application instead of restating them.
 */
export const PREVIEW_COOKIE = "npo_preview_member";

/**
 * Long enough to survive a session of looking around, short enough that a
 * forgotten preview expires on its own. The banner and the exit control are
 * what actually end it; this is the backstop for a tab left open overnight.
 */
export const PREVIEW_COOKIE_MAX_AGE = 60 * 60 * 8;

export type PreviewSelection = Readonly<{ actorUserId: string; targetUserId: string }>;

/**
 * Bound to the actor, so a cookie left behind by whoever used this browser
 * before is inert rather than merely stale: the membership lookup would refuse
 * it anyway, but refusing it here means a second account never inherits the
 * first one's preview even for the length of one request.
 */
export function serializePreview(selection: PreviewSelection): string {
  return `${selection.actorUserId}:${selection.targetUserId}`;
}

export function parsePreview(value: string | null): PreviewSelection | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;

  const actorUserId = value.slice(0, separator);
  const targetUserId = value.slice(separator + 1);
  if (!actorUserId || !targetUserId) return null;

  return { actorUserId, targetUserId };
}

/** Minimal cookie-header lookup; the value never contains `;` or a space. */
export function readCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }

  return null;
}
