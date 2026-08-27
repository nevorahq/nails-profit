"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * Removing a visit recorded by hand.
 *
 * Two steps for the same reason every other destructive control in the product
 * has two: what leaves with the row is not visible on the row. The revenue, the
 * margin and the commission behind it come out of the month's totals, and the
 * confirmation is where that is said out loud rather than discovered in a
 * report later. The server decides all of it again — see
 * `app/api/v1/visits/[id]/route.ts`.
 */
export function VisitDeleteButton({
  visitId,
  fromBooking,
  locale,
}: {
  visitId: string;
  /**
   * Whether this visit closed an appointment. The endpoint refuses those, and
   * the control stays on the card saying so rather than vanishing from it — a
   * button that is missing from some cards and not others is a question the
   * screen leaves the owner to answer alone.
   */
  fromBooking: boolean;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/visits/${visitId}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(getErrorMessage(body?.error?.code, t("visits.deleteFailed"), locale));
      setPending(false);
      setConfirming(false);
      return;
    }

    setPending(false);
    setConfirming(false);
    router.refresh();
  }

  return (
    <div className="visit-card-delete">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {confirming ? (
        <>
          <button className="inline-action danger" type="button" disabled={pending} onClick={remove}>
            {pending ? t("common.saving") : t("visits.deleteConfirm")}
          </button>
          <button
            className="inline-action"
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </button>
          <span className="muted">{t("visits.deleteHint")}</span>
        </>
      ) : (
        <>
          <button
            className="inline-action danger"
            type="button"
            disabled={pending || fromBooking}
            title={fromBooking ? t("visits.deleteFromBooking") : undefined}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t("visits.delete")}
          </button>
          {fromBooking && <span className="muted">{t("visits.deleteFromBooking")}</span>}
        </>
      )}
    </div>
  );
}
