/**
 * Cross-site protection for cookie-authenticated requests, roadmap section 7.6
 * ("CSRF применяется к cookie-authenticated internal mutations") and spec
 * section 15.3.
 *
 * The API is JSON-only, which already refuses most of the classic attack: a
 * cross-site form can send `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/plain`, and a handler that parses JSON answers
 * those with a 422. `multipart/form-data` is the hole in that argument — the
 * import upload takes exactly that — and "the cookie is SameSite by default in
 * this version of that library" is a control nobody in this repository owns.
 *
 * So the session is simply not honoured on a request the browser labels
 * cross-site. `Sec-Fetch-Site` is sent by every current browser and cannot be
 * set by page JavaScript; `Origin` is the fallback for the rest. A request with
 * neither — curl, a job, a test — is not a browser and carries no ambient
 * cookie to abuse, so it passes.
 */
export type CrossSiteVerdict = "allow" | "refuse";

export function checkRequestOrigin(requestHeaders: Headers, appOrigin: string): CrossSiteVerdict {
  const fetchSite = requestHeaders.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) {
    // `none` is a typed address or a bookmark: no initiator, nothing to forge.
    return fetchSite === "cross-site" ? "refuse" : "allow";
  }

  const origin = requestHeaders.get("origin")?.trim();
  if (!origin) return "allow";

  // `null` is the opaque origin — a sandboxed iframe, a `file://` page, some
  // redirected form posts. None of them is this application, and the browsers
  // that produce it without `Sec-Fetch-Site` are exactly the old ones.
  return origin !== "null" && sameOrigin(origin, appOrigin) ? "allow" : "refuse";
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    // An unparsable Origin is not a same-origin one.
    return false;
  }
}
