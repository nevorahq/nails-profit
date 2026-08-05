import { NextResponse } from "next/server";

import { sqlClient } from "@/db";
import { requestId } from "@/lib/http";
import { logEvent } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Load-balancer and uptime-monitor probe. It deliberately exposes no version,
 * environment, tenant count or database error detail: a health endpoint is
 * public operational surface, not a diagnostics dump.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const started = performance.now();

  try {
    await sqlClient`select 1`;
    return NextResponse.json(
      { status: "ok", checks: { database: "ok" } },
      {
        headers: {
          "cache-control": "no-store",
          "x-request-id": id,
        },
      },
    );
  } catch (error) {
    logEvent("error", "health.database_failed", { requestId: id }, { error });
    return NextResponse.json(
      { status: "unavailable", checks: { database: "failed" } },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "retry-after": "30",
          "x-request-id": id,
          "server-timing": `health;dur=${(performance.now() - started).toFixed(0)}`,
        },
      },
    );
  }
}

