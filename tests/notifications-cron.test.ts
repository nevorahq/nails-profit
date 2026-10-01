import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The notification outbox is drained by a GitHub Actions schedule, and nothing
 * in the application notices when that schedule stops reaching it.
 *
 * Two ways it could break silently, both caught here rather than in production:
 * the endpoint is renamed and the workflow keeps posting to a 404, or a Netlify
 * Scheduled Function comes back beside it and the timer is paid for again on
 * Netlify's credit plan — the reason it moved in the first place.
 */
const WORKFLOW = ".github/workflows/notifications-cron.yml";

describe("the notification cron", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("posts to the operator endpoint that exists", () => {
    const path = workflow.match(/\/api\/v1\/ops\/[a-z-]+/)?.[0];
    expect(path).toBe("/api/v1/ops/notifications");
    expect(existsSync(`app${path}/route.ts`)).toBe(true);
  });

  it("runs every five minutes and can be started by hand", () => {
    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("takes the token from a secret, never from the file", () => {
    expect(workflow).toContain("${{ secrets.OPS_API_TOKEN }}");
    expect(workflow).not.toMatch(/Bearer [A-Za-z0-9]{16,}/);
  });

  it("is the only scheduler: no Netlify function runs the same timer", () => {
    expect(existsSync("netlify/functions/notifications.mts")).toBe(false);
  });
});
