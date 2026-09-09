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
 * margin and the commission behind it come out of the month's totals and do not
 * come back. The confirmation used to say that out loud; it no longer does, so
 * the second click is now the whole of the warning.
 *
 * Every visit is deletable, including one that closed an appointment: that used
 * to be refused, and now the appointment returns to `confirmed` along with it.
 * The server decides all of it again — see `app/api/v1/visits/[id]/route.ts`.
 */
export function VisitDeleteButton({ visitId, locale }: { visitId: string; locale: AppLocale }) {
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
        </>
      ) : (
        <button
          className="inline-action danger"
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t("visits.delete")}
        </button>
      )}
    </div>
  );
}
