import { afterAll, describe, expect, test } from "vitest";

import { GET } from "@/app/api/health/route";
import { closeTestConnections } from "../helpers/database";

describe("GET /api/health", () => {
  afterAll(async () => {
    await closeTestConnections();
  });

  test("checks the database without exposing deployment details", async () => {
    const response = await GET(new Request("http://localhost/api/health", { headers: { "x-request-id": "health-1" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("health-1");
    expect(body).toEqual({ status: "ok", checks: { database: "ok" } });
    expect(JSON.stringify(body)).not.toMatch(/postgres|database_url|version|organization/i);
  });
});

