"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";

/** The column's own ceiling, `client_notes_length` in `db/schema.ts`. */
const NOTE_LIMIT = 2000;

/**
 * The studio's note about a client, on their card.
 *
 * One field and one button rather than a list of dated entries: what a master
 * wants before the client sits down is the current state — the allergy, the
 * shape — not a log of who wrote what when, and a log is what would make the
 * note something nobody rereads.
 */
export function ClientNotes({
  clientId,
  initial,
  canWrite,
  locale,
}: {
  clientId: string;
  initial: string | null;
  canWrite: boolean;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const [value, setValue] = useState(initial ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!canWrite) {
    return initial ? (
      <p className="client-notes-text">{initial}</p>
    ) : (
      <p className="muted">{t("clients.notesNone")}</p>
    );
  }

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    const response = await fetch(`/api/v1/clients/${clientId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: value.trim() === "" ? null : value }),
    });
    setPending(false);
    if (response.ok) {
      setSaved(true);
      router.refresh();
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    setError(
      body?.error
        ? getErrorMessage(body.error.code, body.error.message, locale, register)
        : t("common.saveFailed"),
    );
  }

  const unchanged = value.trim() === (initial ?? "").trim();

  return (
    <div className="client-notes">
      <label htmlFor={`client-notes-${clientId}`} className="sr-only">
        {t("clients.notes")}
      </label>
      <textarea
        id={`client-notes-${clientId}`}
        name="notes"
        rows={4}
        maxLength={NOTE_LIMIT}
        placeholder={t("clients.notesPlaceholder")}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
        }}
      />
      <div className="inline-actions">
        <button type="button" className="primary-button" disabled={pending || unchanged} onClick={save}>
          {pending ? t("common.saving") : t("clients.notesSave")}
        </button>
        <span className="muted">{t("clients.notesCount", { count: value.length })}</span>
      </div>
      {saved && (
        <p className="booking-manage-notice" role="status">
          {t("clients.notesSaved")}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
