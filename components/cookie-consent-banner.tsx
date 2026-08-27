"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { hasRespondedToConsent, saveConsent, subscribeToConsent } from "@/lib/cookie-consent";

function getServerSnapshot() {
  return true;
}

/**
 * The cookie itself, for the reopen control at phone widths where the label
 * does not fit. Drawn rather than lettered: the button's job is to be found
 * again later, and a biscuit with crumbs is what people look for.
 */
function IconCookie() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5 3 3 0 0 1-3.6-3.9A3 3 0 0 1 8 1.5Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" />
      <circle cx="9.5" cy="10" r="1" fill="currentColor" />
      <circle cx="5.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
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
          <IconCookie />
          <span className="btn-label">{t("cookieConsent.preferencesLabel")}</span>
        </button>
      )}
    </>
  );
}
