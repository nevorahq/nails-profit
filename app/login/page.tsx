import { headers } from "next/headers";

import { LoginForm } from "@/components/login-form";
import { auth } from "@/lib/auth";
import { resolveLocale } from "@/lib/locale";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : undefined;

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

  return (
    <main className="auth-shell">
      <LoginForm
        initialMode={params.mode === "signup" ? "signup" : "signin"}
        locale={await resolveLocale()}
        next={next}
        activeEmail={session?.user.email ?? null}
      />
    </main>
  );
}
