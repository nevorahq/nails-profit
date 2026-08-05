/**
 * Structured logs, spec section 15.6: "structured JSON logs с `request_id`,
 * `organization_id`, `user_id` без PII", and section 15.3: "PII маскируется в
 * логах и error tracking".
 *
 * One line of JSON per event, because a pilot's logs are read by grep and by a
 * collector, and a multi-line message is legible to neither.
 *
 * The redaction is not a convention for call sites to remember. Every field
 * passes through `redact`, which masks by key *and* by value: a key called
 * `email` is masked whether or not it holds an address, and an address is
 * masked wherever it appears — inside an error message, inside a URL, three
 * levels down an object. A rule that depends on the caller doing the right
 * thing is not a control, and the day it is broken is the day a client list
 * ends up in a log aggregator.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Readonly<{
  requestId?: string;
  organizationId?: string | null;
  userId?: string | null;
}>;

/**
 * Keys whose values never belong in a log, matched as substrings so that
 * `client_name`, `actor_email` and `file_name` are covered without listing
 * every spelling. Ids are deliberately absent: `organization_id` and `user_id`
 * are exactly what section 15.6 asks the lines to carry.
 */
const SENSITIVE_KEY_PARTS = [
  "email",
  "phone",
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "name",
  "note",
  "comment",
  "address",
] as const;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** E.164 and the loose forms people actually type; LOC-005 normalizes the rest. */
const PHONE_PATTERN = /\+?\d[\d\s()-]{7,17}\d/g;

/**
 * A short tag, not a mask alone. Support needs to see that two lines concern
 * the same address without the address being present; four hex characters put
 * every value into one of 65 536 buckets, which correlates inside a request
 * trace and identifies nobody outside it.
 *
 * FNV-1a rather than SHA-256 because this module also loads in the Edge
 * runtime, where `node:crypto` does not exist. The truncation is what makes the
 * tag safe, not the strength of the function — and nothing here may ever be
 * treated as a cryptographic digest.
 */
function tag(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

function maskString(value: string) {
  return value
    .replace(EMAIL_PATTERN, (match) => `[email#${tag(match)}]`)
    .replace(PHONE_PATTERN, (match) => `[phone#${tag(match.replace(/\D/g, ""))}]`);
}

function isSensitiveKey(key: string) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return maskString(value);
  if (value === null || typeof value !== "object") return value;

  // A cycle in a logged object must not take the process down with it.
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskString(value.message),
      // The stack is code, not data, but a thrown value can be interpolated
      // into it, so it goes through the same masking.
      stack: value.stack ? maskString(value.stack) : undefined,
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? redactedValue(item) : redact(item, seen);
  }
  return output;
}

function redactedValue(value: unknown) {
  if (typeof value === "string" && value.length > 0) return `[redacted#${tag(value)}]`;
  if (value === null || value === undefined) return value;
  return "[redacted]";
}

export type LogLine = Readonly<{
  level: LogLevel;
  event: string;
  timestamp: string;
  request_id?: string;
  organization_id?: string;
  user_id?: string;
  [field: string]: unknown;
}>;

/** Separated from writing so tests can assert the line without capturing stdout. */
export function buildLogLine(
  level: LogLevel,
  event: string,
  context: LogContext = {},
  fields: Record<string, unknown> = {},
): LogLine {
  return {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.organizationId ? { organization_id: context.organizationId } : {}),
    ...(context.userId ? { user_id: context.userId } : {}),
    ...(redact(fields) as Record<string, unknown>),
  };
}

export function logEvent(
  level: LogLevel,
  event: string,
  context: LogContext = {},
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify(buildLogLine(level, event, context, fields));
  // Errors and warnings go to stderr so a collector can split severity without
  // parsing; everything else to stdout. Through `console` rather than
  // `process.stdout`, which the Edge runtime does not have — and this module is
  // reachable from instrumentation, which is bundled for it.
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/**
 * A path with its query string removed. Section 15.3 forbids PII in logs, and a
 * search or a filter parameter is the most ordinary way for a phone number to
 * end up in one.
 */
export function safePath(path: string) {
  const [pathname] = path.split("?");
  return maskString(pathname);
}
