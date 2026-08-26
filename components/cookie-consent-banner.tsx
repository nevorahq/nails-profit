"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { hasRespondedToConsent, saveConsent, subscribeToConsent } from "@/lib/cookie-consent";

function getServerSnapshot() {
  return true;
}

/**
 * Opt-in by default: nothing here calls PostHog directly (see
 * `PostHogProvider`, which reacts to the same `saveConsent` cookie), so the
 * banner and the SDK stay decoupled — either can change without the other.
 */
export function CookieConsentBanner({ locale }: { locale: AppLocale }) {
  const t = getTranslator(locale);
  const hasResponded = useSyncExternalStore(subscribeToConsent, hasRespondedToConsent, getServerSnapshot);
  const [reopened, setReopened] = useState(false);
  const showBanner = !hasResponded || reopened;

  const respond = useCallback((analytics: boolean) => {
    saveConsent(analytics);
    setReopened(false);
  }, []);

  return (
    <>
      {showBanner && (
        <div className="cookie-consent-banner" role="region" aria-label={t("cookieConsent.regionLabel")}>
          <div className="cookie-consent-text">
            <strong>{t("cookieConsent.title")}</strong>
            <span className="cookie-consent-description">{t("cookieConsent.description")}</span>
          </div>
          <div className="cookie-consent-actions">
            <button type="button" className="cookie-consent-decline" onClick={() => respond(false)}>
              {t("cookieConsent.decline")}
            </button>
            <button type="button" className="cookie-consent-accept" onClick={() => respond(true)}>
              {t("cookieConsent.accept")}
            </button>
          </div>
        </div>
      )}

      {hasResponded && !reopened && (
        <button
          type="button"
          className="cookie-consent-reopen"
          aria-label={t("cookieConsent.preferencesLabel")}
          onClick={() => setReopened(true)}
        >
          {t("cookieConsent.preferencesLabel")}
        </button>
      )}
    </>
  );
}
