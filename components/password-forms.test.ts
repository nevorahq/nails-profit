import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { LoginForm } from "@/components/login-form";
import { ResetPasswordForm } from "@/components/reset-password-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

/**
 * What a password form is before React takes the page over: the server's HTML.
 *
 * Regression: a press before hydration submitted the form natively, as a GET,
 * and the browser put the email and the password into the address bar —
 * `/login?email=…&password=…` — and from there into history, access logs and
 * the next page's Referer. Playwright caught it as a flaky test on a loaded
 * machine; a slow phone would do it to a person.
 */
function formOf(markup: string) {
  const form = /<form[^>]*>/.exec(markup)?.[0] ?? "";
  const submit = /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "";
  return { form, submit };
}

describe("password forms before hydration", () => {
  test.each([
    ["sign-in", () => createElement(LoginForm, { locale: "en", initialMode: "signin" })],
    ["sign-up", () => createElement(LoginForm, { locale: "en", initialMode: "signup" })],
    ["password reset", () => createElement(ResetPasswordForm, { locale: "en", token: "t" })],
  ])("the %s form would post, and its button waits for the page", (_, element) => {
    const { form, submit } = formOf(renderToStaticMarkup(element()));
    expect(form).toContain('method="post"');
    expect(submit).toContain("disabled");
  });
});
