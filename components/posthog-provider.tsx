"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

import { loadConsent, subscribeToConsent } from "@/lib/cookie-consent";

let initialized = false;

/**
 * `config` is `null` whenever `NEXT_PUBLIC_POSTHOG_KEY`/`_HOST` aren't set —
 * this renders nothing rather than initializing PostHog against an empty key.
 *
 * PostHog itself always loads (so consent given on a later visit takes effect
 * immediately, with no reload); `opt_out_capturing_by_default` keeps it silent
 * until `saveConsent(true)` — via the cookie-consent banner — flips it.
 */
export function PostHogProvider({ config }: { config: { key: string; host: string } | null }) {
  useEffect(() => {
    if (!config) return;

    // Guards only the one-time SDK init, never the subscription below — Strict
    // Mode's dev-only mount/cleanup/remount cycle must still end with an
    // active subscription, which an early return here would skip on remount.
    if (!initialized) {
      initialized = true;
      posthog.init(config.key, {
        api_host: config.host,
        defaults: "2026-05-30",
        opt_out_capturing_by_default: true,
        persistence: "localStorage+cookie",
      });
      if (loadConsent()?.analytics) posthog.opt_in_capturing();
    }

    return subscribeToConsent((state) => {
      if (state?.analytics) posthog.opt_in_capturing();
      else posthog.opt_out_capturing();
    });
  }, [config]);

  return null;
}
