/*
 * Reading an invitation link, and nothing else.
 *
 * Its own file because both sides need it: `/login` resolves the invited
 * address from it on the server, and the sign-in form accepts the invitation
 * with it in the browser. `domain/invitation.ts` reaches for `node:crypto` and
 * `lib/invitation-preview.ts` for the database — neither belongs in a client
 * bundle, and this function needs neither.
 */

/**
 * The invitation token carried by a `next` parameter, so `/login` can fill in
 * the address the invitation was issued for.
 *
 * The address itself never travels in a URL — the token is already in one
 * because an emailed link has nowhere else to put it, and the email is resolved
 * from it on the server. Anything that is not a `/join` link yields null; the
 * caller has already checked that `next` is a local path.
 */
export function invitationTokenFromNext(next: string | undefined): string | null {
  if (!next) return null;
  let parsed: URL;
  try {
    parsed = new URL(next, "http://invitation.local");
  } catch {
    return null;
  }
  // A `next` that resolved onto another host is not a local path, whatever it
  // looked like: `//evil.example/join?token=…` parses as one of those.
  if (parsed.host !== "invitation.local") return null;
  if (parsed.pathname !== "/join") return null;
  return parsed.searchParams.get("token");
}
