import type { Instrumentation } from "next";

import { logEvent, safePath } from "@/lib/logger";

/**
 * Server-side error tracking, spec section 15.6.
 *
 * Next.js calls this for every error the server captures, which is the one
 * place that sees them all — a handler that throws, a server component that
 * fails to render, an action that rejects. Wrapping twenty-six route files in a
 * try/catch would cover less and drift the moment someone adds the
 * twenty-seventh.
 *
 * The request id travels in a header so a log line can be matched to the
 * response the user was shown: every API response carries `x-request-id`.
 *
 * Nothing here is sent anywhere. A pilot on one instance reads its own logs,
 * and an error tracker is a decision about a vendor, not about this file: it
 * plugs in below, after the same masking.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const requestId = request.headers["x-request-id"];

  logEvent(
    "error",
    "request.error",
    { requestId: typeof requestId === "string" ? requestId : undefined },
    {
      // The query string is dropped and the path masked: a filter parameter is
      // the most ordinary way for a phone number to reach a log.
      path: safePath(request.path),
      method: request.method,
      route: context.routePath,
      route_type: context.routeType,
      error,
    },
  );
};
