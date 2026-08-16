import { headers } from "next/headers";

import { LoginForm } from "@/components/login-form";
import { auth } from "@/lib/auth";
import { invitationTokenFromNext, previewInvitation } from "@/lib/invitation-preview";
import { resolveLocale } from "@/lib/locale";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const params = await searchParams;
  /*
   * `//evil.example/x` also starts with a slash, and a browser reads it as a
   * protocol-relative address on that host — which would turn this page into an
   * open redirect reachable from any link. A local path is one leading slash
   * and no second one; a backslash counts as the second, because browsers
   * normalize it to one.
   */
  const next =
    typeof params.next === "string" && /^\/(?![/\\])/.test(params.next) ? params.next : undefined;

  /**
   * A session cookie is one slot per origin, so signing in here replaces
   * whoever is signed in now — the previous session becomes unreachable from
   * this browser even though the server never revoked it. Silently, that reads
   * as the first account having been logged out by something; named, it is a
   * choice. Read on the server rather than guessed on the client: the cookie is
   * HttpOnly, and the address in the warning has to be the real one.
   *
   * Nobody is redirected away. Arriving at /login while signed in is exactly
   * what someone does when they mean to switch accounts, and an invitation sent
   * to a second address routes through here on purpose — see `app/join`.
   */
  const session = await auth.api.getSession({ headers: await headers() });

  /**
   * Someone arriving from an invitation is registering one specific address —
   * the one the link was mailed to — and any other address produces an account
   * that cannot accept it. Typing it again is a step that can only go wrong, so
   * it is filled in for them.
   *
   * The address is resolved here, from the token already carried by `next`,
   * rather than passed along in a query parameter: an email in a URL ends up in
   * access logs, browser history and `Referer` headers, and this one belongs to
   * a person who has not yet agreed to anything.
   */
  const invitation = next ? await previewInvitation(invitationTokenFromNext(next) ?? "") : null;
  const pendingInvitation = invitation?.status === "pending" ? invitation : null;

  return (
    <main className="auth-shell">
      <LoginForm
        initialMode={params.mode === "signup" ? "signup" : "signin"}
        locale={pendingInvitation?.locale ?? (await resolveLocale())}
        next={next}
        activeEmail={session?.user.email ?? null}
        presetEmail={pendingInvitation?.email ?? null}
        inviteOrganization={pendingInvitation?.organizationName ?? null}
      />
    </main>
  );
}
