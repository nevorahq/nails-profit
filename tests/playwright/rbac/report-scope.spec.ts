import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signUp, signedInContext, type Account, type Studio } from "../helpers/studio";

/**
 * Whose figures «Итог» reads, decided on the server rather than by which
 * controls are drawn.
 *
 * Two regressions. An analyst holds «Все агрегаты», so the page offers them no
 * master picker — but it used to honour a typed `?specialist=` all the same,
 * and narrowed their report to one master's month. And an owner previewing a
 * master's interface used to get the master's card looked up by the owner's
 * own account, so «Ваш заработок» showed somebody else's earnings, or none.
 *
 * The canonical studio: two manicures by the master and one by the colleague,
 * 600 MDL each at 40%.
 */
async function userIdOf(request: APIRequestContext): Promise<string> {
  const session = (await (await request.get("/api/auth/get-session")).json()) as { user?: { id?: string } };
  if (!session.user?.id) throw new Error("no session");
  return session.user.id;
}

test.describe("whose figures the report reads", () => {
  let studio: Studio;
  let analyst: Account;
  let manager: Account;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    for (const specialistId of [studio.specialistId, studio.specialistId, studio.colleagueId]) {
      await studio.owner.post("/api/v1/visits", { specialist_id: specialistId, service_id: studio.serviceId });
    }

    const join = async (role: "analyst" | "manager") => {
      const email = `pw-${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${testInfo.project.name}@example.com`;
      const invitation = await studio.owner.post<{ token: string }>("/api/v1/invitations", { email, role });
      const account = await signUp(baseURL!, { email, name: role });
      await account.post("/api/v1/invitations/accept", { token: invitation.token });
      return account;
    };
    analyst = await join("analyst");
    manager = await join("manager");
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
    await Promise.all([analyst?.dispose(), manager?.dispose()]);
  });

  const revenueCard = (page: import("@playwright/test").Page) =>
    page.locator(".metric-card").filter({ hasText: "Revenue" });

  test("an analyst's typed master is not a filter", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, analyst, baseURL!);
    const page = await context.newPage();

    await page.goto(`/app?specialist=${studio.colleagueId}`);
    // The studio's three visits, not the colleague's one.
    await expect(revenueCard(page)).toContainText("MDL 1,800.00");
    await expect(page.getByRole("combobox", { name: "Specialist" })).toHaveCount(0);
    await context.close();
  });

  test("a manager may still narrow the report to one master", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, manager, baseURL!);
    const page = await context.newPage();

    await page.goto(`/app?specialist=${studio.colleagueId}`);
    await expect(revenueCard(page)).toContainText("MDL 600.00");
    await context.close();
  });

  test("an owner previewing a master reads that master's earnings", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    await studio.owner.post("/api/v1/preview", { member_user_id: await userIdOf(studio.master.request) });
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Your earnings this month" })).toBeVisible();
    // Two manicures at 40%: the master's, not the owner's nothing.
    await expect(page.getByTestId("headline-value")).toHaveText("MDL 480.00");
    await context.close();
  });
});
