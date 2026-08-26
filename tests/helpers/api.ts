import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { setSessionHeaders } from "./session";

/**
 * A client that drives the real route handlers.
 *
 * Integration tests call domain code and SQL directly; these tests enter where a
 * browser enters — at the HTTP boundary, with a real Better Auth session cookie.
 * Everything between the request and the row is the code that ships:
 * authentication, the membership lookup, the RBAC check, the tenant transaction
 * and its RLS policies, the response envelope.
 *
 * The route table is read from the filesystem rather than written out by hand.
 * A hand-written table drifts the moment someone adds an endpoint, and a test
 * suite that silently stops covering a route is worse than one that never
 * covered it: `matchRoute` throws on an unknown path instead.
 */
const API_ROOT = join(process.cwd(), "app", "api");

type RouteFile = Readonly<{ pattern: readonly string[]; file: string }>;

function collectRoutes(directory: string, pattern: string[], out: RouteFile[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectRoutes(join(directory, entry.name), [...pattern, entry.name], out);
    } else if (entry.name === "route.ts") {
      out.push({ pattern, file: join(directory, entry.name) });
    }
  }
}

const routes: RouteFile[] = [];
collectRoutes(API_ROOT, ["api"], routes);

/**
 * Catch-all segments belong to Better Auth, which these tests call through its
 * own server API. Left in the table, `[...all]` would swallow every unmatched
 * path and turn a typo into a passing test.
 */
const matchable = routes
  .filter((route) => !route.pattern.some((segment) => segment.startsWith("[...")))
  /*
   * Static segments beat dynamic ones, as they do in Next.js itself. Without
   * this, `/api/v1/invitations/accept` matches `/api/v1/invitations/[id]`
   * whenever that file happens to be read first, and the test calls the wrong
   * handler — or, worse, quietly passes against it.
   *
   * The comparator has to be a *total* order, and the obvious version is not:
   * comparing only up to the shorter pattern calls unrelated routes equal,
   * which makes it intransitive, and V8's sort then reorders pairs that do
   * matter as soon as an unrelated route is added. That is not hypothetical —
   * adding `/api/v1/payment-methods/[id]` was enough to send
   * `/api/v1/bookings/[id]/preview` to `bookings/[id]`. Ties are broken by name
   * and then by length so the order is decided by the routes themselves rather
   * than by how many of them there happen to be.
   */
  .sort((left, right) => {
    const shared = Math.min(left.pattern.length, right.pattern.length);
    for (let index = 0; index < shared; index += 1) {
      const leftSegment = left.pattern[index];
      const rightSegment = right.pattern[index];
      const leftDynamic = isDynamic(leftSegment);
      const rightDynamic = isDynamic(rightSegment);
      if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
      if (leftSegment !== rightSegment) return leftSegment < rightSegment ? -1 : 1;
    }
    return left.pattern.length - right.pattern.length;
  });

function isDynamic(segment: string) {
  return segment.startsWith("[") && segment.endsWith("]");
}

/** Every route the client can reach, for tests that assert full coverage. */
export function listRoutes(): readonly RouteFile[] {
  return matchable;
}

export function matchRoute(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);

  for (const route of matchable) {
    if (route.pattern.length !== segments.length) continue;

    const params: Record<string, string> = {};
    const matched = route.pattern.every((patternSegment, index) => {
      if (isDynamic(patternSegment)) {
        params[patternSegment.slice(1, -1)] = segments[index];
        return true;
      }
      return patternSegment === segments[index];
    });

    if (matched) return { file: route.file, params };
  }

  return null;
}

export type ApiResponse<T> = Readonly<{
  status: number;
  body: T;
  headers: Headers;
}>;

type HandlerModule = Record<string, unknown>;

const moduleCache = new Map<string, Promise<HandlerModule>>();

export function loadRoute(file: string) {
  const cached = moduleCache.get(file);
  if (cached) return cached;
  const loading = import(/* @vite-ignore */ pathToFileURL(file).href) as Promise<HandlerModule>;
  moduleCache.set(file, loading);
  return loading;
}

const ORIGIN = "http://localhost:3000";

type RequestBody = FormData | Record<string, unknown> | undefined;

async function call<T>(
  cookie: string | null,
  method: string,
  path: string,
  body: RequestBody,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const url = new URL(path, ORIGIN);
  const match = matchRoute(url.pathname);
  if (!match) throw new Error(`No route handler matches ${url.pathname}`);

  const handler = (await loadRoute(match.file))[method];
  if (typeof handler !== "function") {
    throw new Error(`${match.file} does not export ${method}`);
  }

  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
  }

  // The route reads the session through `next/headers`, which has no request
  // scope here, so the same cookie is placed where both paths look for it.
  setSessionHeaders(headers);

  const response = (await handler(new Request(url, { method, headers, body: payload }), {
    params: Promise.resolve(match.params),
  })) as Response;

  const text = await response.text();
  // Not every endpoint answers JSON: a template download is a CSV file, and
  // parsing it as JSON would turn a working response into a test error.
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;

  return {
    status: response.status,
    body: (text && isJson ? JSON.parse(text) : (text as unknown)) as T,
    headers: response.headers,
  };
}

export type Actor = Readonly<{
  userId: string;
  email: string;
  cookie: string | null;
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: RequestBody, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body?: RequestBody, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body?: RequestBody, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  delete<T = unknown>(path: string, body?: RequestBody, headers?: Record<string, string>): Promise<ApiResponse<T>>;
}>;

function actorFor(identity: { userId: string; email: string; cookie: string | null }): Actor {
  return {
    ...identity,
    get: (path, headers) => call(identity.cookie, "GET", path, undefined, headers),
    post: (path, body, headers) => call(identity.cookie, "POST", path, body, headers),
    put: (path, body, headers) => call(identity.cookie, "PUT", path, body, headers),
    patch: (path, body, headers) => call(identity.cookie, "PATCH", path, body, headers),
    delete: (path, body, headers) => call(identity.cookie, "DELETE", path, body, headers),
  };
}

/** Nobody: no cookie at all, the shape every endpoint must reject with 401. */
export const anonymous: Actor = actorFor({ userId: "", email: "", cookie: null });

export const TEST_PASSWORD = "orchid-lacquer-42-crown";

/**
 * Registration through Better Auth itself rather than an inserted row: the
 * cookie has to be one the library will accept later, signature and all.
 */
export async function signUp(email: string, name = "Test"): Promise<Actor> {
  const { auth } = await import("@/lib/auth");
  const response = await auth.api.signUpEmail({
    body: { name, email, password: TEST_PASSWORD, legalAccepted: true },
    asResponse: true,
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Sign-up for ${email} returned no session cookie`);

  const body = (await response.json()) as { user: { id: string } };
  return actorFor({ userId: body.user.id, email, cookie: setCookie.split(";")[0] });
}

export async function signIn(email: string): Promise<Actor> {
  const { auth } = await import("@/lib/auth");
  const response = await auth.api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Sign-in for ${email} returned no session cookie`);

  const body = (await response.json()) as { user: { id: string } };
  return actorFor({ userId: body.user.id, email, cookie: setCookie.split(";")[0] });
}

/** Reads `{ data }` and fails loudly on an error envelope, so tests stay short. */
export function dataOf<T>(response: ApiResponse<unknown>): T {
  const body = response.body as { data?: T; error?: { code: string; message: string } };
  if (body?.error) {
    throw new Error(`Expected data, got ${response.status} ${body.error.code}: ${body.error.message}`);
  }
  if (body?.data === undefined) throw new Error(`Response has no data: ${JSON.stringify(body)}`);
  return body.data;
}

export function errorCodeOf(response: ApiResponse<unknown>): string {
  const body = response.body as { error?: { code: string } };
  if (!body?.error) throw new Error(`Expected an error envelope, got ${JSON.stringify(body)}`);
  return body.error.code;
}
