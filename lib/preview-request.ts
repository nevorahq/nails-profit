import { headers } from "next/headers";

import { parsePreview, PREVIEW_COOKIE, readCookieHeader, type PreviewSelection } from "@/lib/preview";

/**
 * Reading the preview selection off the request being served.
 *
 * Separate from `lib/preview.ts` only because of `next/headers`: the proxy runs
 * before a request scope exists and must not import it, while everything here
 * runs inside one.
 *
 * The header is read directly rather than through `cookies()`, for two reasons
 * that are both about the callers. The E2E suite replaces `next/headers` with a
 * store holding the headers of the request under test and makes `cookies()`
 * throw on purpose — see `tests/e2e/setup.ts` — so a preview that reads the
 * header is a preview those tests can actually exercise. And `db/tenant.ts`
 * calls this on every tenant transaction, including the ones integration tests
 * and ops scripts run with no request scope at all; there, `headers()` throws
 * and the answer is simply "no preview".
 */
export async function readPreviewCookie(): Promise<PreviewSelection | null> {
  let header: string | null;
  try {
    header = (await headers()).get("cookie");
  } catch {
    // No request scope: an integration test, an ops script, a background job.
    return null;
  }

  return parsePreview(readCookieHeader(header, PREVIEW_COOKIE));
}

/**
 * Whether this request carries a preview selection at all, valid or not.
 *
 * Deliberately coarser than `readPreviewCookie` plus a membership check: this
 * is what makes the transaction read-only, and a refusal to write needs no
 * proof that the preview is genuine. Erring towards read-only costs the owner
 * a stale cookie's worth of writes and one click to leave; erring the other way
 * would let a mutation through in a mode whose entire promise is that none do.
 */
export async function isPreviewRequested(): Promise<boolean> {
  return (await readPreviewCookie()) !== null;
}
