import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { proxy } from "./proxy";
import { PREVIEW_COOKIE } from "@/lib/preview";

/**
 * The read-only boundary of "посмотреть как", tested where it lives.
 *
 * The E2E suite calls route handlers directly and never passes through a proxy,
 * so the rule that closes every mutation at once is not something those tests
 * can see. It is pure, though — a request in, a decision out — so it is checked
 * here instead, and the E2E suite checks the layer underneath it in
 * `db/tenant.ts`, which does run there.
 */
function request(method: string, path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers: cookie ? { cookie } : {},
  });
}

const PREVIEWING = `${PREVIEW_COOKIE}=owner-id:master-id`;
const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** `NextResponse.next()` is the "carry on"; anything else here is a refusal. */
function refused(response: Response) {
  return response.status === 403;
}

describe("without a preview selection", () => {
  for (const method of UNSAFE) {
    test(`${method} passes through untouched`, () => {
      expect(refused(proxy(request(method, "/api/v1/clients")))).toBe(false);
    });
  }
});

describe("while previewing", () => {
  for (const method of UNSAFE) {
    test(`${method} is refused`, async () => {
      const response = proxy(request(method, "/api/v1/clients", PREVIEWING));
      expect(response.status).toBe(403);

      const body = (await response.json()) as { error: { code: string; request_id: string } };
      expect(body.error.code).toBe("PREVIEW_READ_ONLY");
      // The envelope is section 12.1's, so the client localizes on the code and
      // shows this refusal the way it shows every other one.
      expect(body.error.request_id).toBeTruthy();
    });
  }

  test("reads are untouched — the whole point is to see the colleague's screens", () => {
    expect(refused(proxy(request("GET", "/api/v1/clients", PREVIEWING)))).toBe(false);
    expect(refused(proxy(request("HEAD", "/api/v1/visits", PREVIEWING)))).toBe(false);
  });

  test("a preflight is not answered with the refusal meant for the request behind it", () => {
    expect(refused(proxy(request("OPTIONS", "/api/v1/clients", PREVIEWING)))).toBe(false);
  });

  test("leaving is always allowed through, or the mode would have no exit", () => {
    expect(refused(proxy(request("DELETE", "/api/v1/preview", PREVIEWING)))).toBe(false);
  });

  test("switching to another colleague does not require stepping out first", () => {
    expect(refused(proxy(request("POST", "/api/v1/preview", PREVIEWING)))).toBe(false);
  });

  test("an unparseable cookie still refuses: denial needs no proof of a genuine preview", () => {
    expect(refused(proxy(request("POST", "/api/v1/clients", `${PREVIEW_COOKIE}=junk`)))).toBe(true);
  });
});
