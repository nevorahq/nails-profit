import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const REQUIRED_ROUTES: Record<string, readonly Method[]> = {
  "app/api/v1/public/booking/[slug]/route.ts": ["GET"],
  "app/api/v1/public/booking/[slug]/catalog/route.ts": ["GET"],
  "app/api/v1/public/booking/[slug]/availability/route.ts": ["GET"],
  "app/api/v1/public/booking/[slug]/holds/route.ts": ["POST"],
  "app/api/v1/public/booking/[slug]/bookings/route.ts": ["POST"],
  "app/api/v1/public/booking/[slug]/verify/route.ts": ["POST"],
  "app/api/v1/public/bookings/[token]/route.ts": ["GET"],
  "app/api/v1/public/bookings/[token]/reschedule/route.ts": ["POST"],
  "app/api/v1/public/bookings/[token]/cancel/route.ts": ["POST"],
  "app/api/v1/bookings/route.ts": ["GET", "POST"],
  "app/api/v1/bookings/[id]/route.ts": ["GET", "PATCH"],
  "app/api/v1/bookings/[id]/confirm/route.ts": ["POST"],
  "app/api/v1/bookings/[id]/reschedule/route.ts": ["POST"],
  "app/api/v1/bookings/[id]/cancel/route.ts": ["POST"],
  "app/api/v1/bookings/[id]/no-show/route.ts": ["POST"],
  "app/api/v1/bookings/[id]/complete/route.ts": ["POST"],
  "app/api/v1/availability/rules/route.ts": ["GET", "PUT"],
  "app/api/v1/availability/exceptions/route.ts": ["GET", "POST", "DELETE"],
};

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function exportsMethod(contents: string, method: Method) {
  return new RegExp(`export\\s+(?:async\\s+function|const)\\s+${method}\\b`).test(contents);
}

describe("roadmap section 7.6 booking API contract", () => {
  it("keeps every required public and internal route implemented", () => {
    for (const [path, methods] of Object.entries(REQUIRED_ROUTES)) {
      const contents = source(path);
      for (const method of methods) expect(exportsMethod(contents, method), `${method} ${path}`).toBe(true);
    }
  });

  it("keeps every anonymous route behind the shared public request guard", () => {
    for (const path of Object.keys(REQUIRED_ROUTES).filter((entry) => entry.includes("/public/"))) {
      expect(source(path), path).toContain("publicRequest(");
    }
  });

  it("keeps every staff route behind membership and calendar access", () => {
    for (const path of Object.keys(REQUIRED_ROUTES).filter((entry) => !entry.includes("/public/"))) {
      const contents = source(path);
      expect(
        contents.includes("requireCalendarCaller(") || contents.includes("getActiveMembership("),
        path,
      ).toBe(true);
    }
  });

  it("does not lose idempotency on the three mutations that require it", () => {
    for (const path of [
      "app/api/v1/public/booking/[slug]/bookings/route.ts",
      "app/api/v1/public/bookings/[token]/reschedule/route.ts",
      "app/api/v1/bookings/route.ts",
    ]) {
      const contents = source(path);
      expect(contents, path).toContain('request.headers.get("idempotency-key")');
      expect(contents, path).toContain("IDEMPOTENCY_KEY_REQUIRED");
    }
  });
});
