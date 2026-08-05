/**
 * The session cookie the mocked `next/headers` hands back.
 *
 * Route handlers read their session through `next/headers`, which needs a
 * request scope that only the Next.js server provides. Rather than reimplement
 * that scope, the E2E setup mocks the module and the client writes the headers
 * of the request it is about to make here, so both the handler and Better Auth
 * see one and the same cookie.
 */
let current = new Headers();

export function setSessionHeaders(headers: Headers) {
  current = headers;
}

export function currentSessionHeaders() {
  return current;
}
