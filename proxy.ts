import { NextResponse, type NextRequest } from "next/server";

import { PREVIEW_COOKIE } from "@/lib/preview";

/**
 * The request boundary for "посмотреть как", and nothing else.
 *
 * An owner in preview is looking at a colleague's interface; they are not that
 * colleague, and nothing they click may be recorded as if they were. That makes
 * the mode read-only, and read-only wants enforcing somewhere no future
 * endpoint can miss. There are forty-eight route files behind `/api/v1`, each
 * with its own preamble, and a rule kept by forty-eight copies is a rule with
 * forty-eight chances to be forgotten.
 *
 * Every mutation in this application is an unsafe HTTP method against
 * `/api/v1`. There are no server actions, and pages only read, so refusing here
 * closes the whole surface in one place — and does it before any handler runs,
 * with an error the client already knows how to display, rather than letting
 * the read-only transaction in `db/tenant.ts` abort mid-way and surface as a
 * 500. That transaction remains the layer underneath: this is the polite
 * refusal, and it is the one that must never be the only one.
 *
 * The cookie is read but not trusted, which is exactly the right amount of
 * trust for a check that only ever denies. A forged preview cookie buys its
 * author nothing but their own writes refused.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has(PREVIEW_COOKIE)) return NextResponse.next();
  if (SAFE_METHODS.has(request.method)) return NextResponse.next();

  /*
   * Leaving is always allowed through. The exit path is a DELETE, and a rule
   * that refused it would lock an owner inside the mode it was meant to make
   * safe; entering is a POST on the same route, so an owner can also switch
   * from one colleague to another without stepping back out first. The route
   * itself writes nothing but the cookie — see `app/api/v1/preview/route.ts`.
   */
  if (request.nextUrl.pathname === "/api/v1/preview") return NextResponse.next();

  return NextResponse.json(
    {
      error: {
        code: "PREVIEW_READ_ONLY",
        message: "This request is read-only while previewing another member",
        request_id: request.headers.get("x-request-id") ?? crypto.randomUUID(),
        field_errors: [],
      },
    },
    { status: 403 },
  );
}

/**
 * `OPTIONS` is here because a preflight must never be answered with the refusal
 * that belongs to the request it precedes: the browser would report a CORS
 * failure instead of the 403 the application means to show.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const config = {
  /*
   * Scoped to the application's own API. `/api/auth` is deliberately outside
   * it: signing out is a POST, and an owner who forgot they were in preview
   * must still be able to leave the account entirely.
   *
   * `/api/v1/public` and `/api/v1/webhooks` are inside the matcher and stay
   * there. Their real callers — a client booking online, Resend delivering a
   * receipt — carry no session and therefore no preview cookie, so the rule
   * never sees them. It does catch one case: an owner who opens their own
   * public booking page while previewing. Refusing that is the consistent
   * answer rather than a special one, because the read-only transaction
   * underneath would refuse it regardless, and a clear 403 beats the 500 that
   * an aborted transaction would produce.
   */
  matcher: "/api/v1/:path*",
};
