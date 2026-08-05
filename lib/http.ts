import { NextResponse } from "next/server";
import type { $ZodIssue } from "zod/v4/core";

import { logEvent } from "@/lib/logger";

/**
 * API envelope from spec section 12.1. Field names are snake_case because the
 * spec's error example is (`request_id`, `field_errors`), and a single API
 * should not mix conventions.
 */
export type FieldError = {
  field: string;
  code: string;
  message: string;
};

export type ApiErrorBody = {
  error: {
    /** Stable machine-readable code; the client localizes on this, not on `message`. */
    code: string;
    /** Developer-facing English fallback. Not for display when a translation exists. */
    message: string;
    request_id: string;
    field_errors: FieldError[];
    details?: Record<string, unknown>;
  };
};

export function requestId(request: Request) {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function apiError(
  status: number,
  code: string,
  message: string,
  id: string,
  extra: {
    fieldErrors?: FieldError[];
    details?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      request_id: id,
      field_errors: extra.fieldErrors ?? [],
      ...(extra.details ? { details: extra.details } : {}),
    },
  };

  return NextResponse.json(body, {
    status,
    headers: { "x-request-id": id, ...extra.headers },
  });
}

/**
 * The one error that has to say when to come back. Retry-After is what turns a
 * refusal into an instruction; without it a client retries immediately and
 * spends its next window on requests that cannot succeed.
 */
export function rateLimited(
  id: string,
  retryAfterSeconds: number,
  context: { organizationId?: string | null; userId?: string | null; bucket: string } = { bucket: "unknown" },
) {
  // Section 15.6 wants an alert on error spikes; a limit that starts refusing
  // is the earliest signal of one, and it is invisible unless it is logged.
  logEvent(
    "warn",
    "rate_limit.exceeded",
    { requestId: id, organizationId: context.organizationId, userId: context.userId },
    { bucket: context.bucket, retry_after_seconds: retryAfterSeconds },
  );

  return apiError(429, "RATE_LIMITED", "Too many requests; try again later", id, {
    details: { retry_after_seconds: retryAfterSeconds },
    headers: { "retry-after": String(retryAfterSeconds) },
  });
}

/** Maps Zod issues onto the spec's `field_errors`, one entry per invalid path. */
export function toFieldErrors(issues: readonly $ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "_root",
    code: issue.code,
    message: issue.message,
  }));
}

export function apiSuccess<T>(data: T, id: string, status = 200) {
  return NextResponse.json({ data, request_id: id }, { status, headers: { "x-request-id": id } });
}
