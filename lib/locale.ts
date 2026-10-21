import { headers } from "next/headers";

import { getAuthenticatedMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";
import { localeFromHeader } from "@/i18n/accept-language";

/**
 * Which language the interface renders in, spec LOC-008.
 *
 * The organization's own setting wins — a Chișinău studio that works in
 * Romanian should not have its interface flip because a master's laptop is
 * configured in English. `Accept-Language` is only the fallback for visitors
 * who have no organization yet: the landing and login pages, where guessing
 * from the browser is the only signal there is.
 */
export async function resolveLocale(): Promise<AppLocale> {
  // Read the request before touching anything else. `headers()` is what tells
  // Next this render depends on the request, and it has to be the first thing
  // that happens: a build has no request and no secrets, so reaching for the
  // auth instance first would construct it — and fail — before the render had a
  // chance to say it cannot be prerendered at all.
  const requestHeaders = await headers();

  // The same memoized lookup the shell and the page use, so a render that asks
  // for the language three times — the root layout twice and the page once —
  // reads the session once. It used to read the session, the user and the
  // membership afresh each time: nine queries for a page of static text.
  const caller = await getAuthenticatedMembership();
  if (caller.session && caller.organization) return caller.organization.locale as AppLocale;

  return localeFromHeader(requestHeaders.get("accept-language"));
}
