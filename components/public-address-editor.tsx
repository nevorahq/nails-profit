"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { checkSlug, SLUG_MAX_LENGTH, type SlugProblem } from "@/domain/slug";
import type { AppLocale } from "@/i18n/messages";
import { type MessageKey } from "@/i18n/t";
import { useTranslator } from "@/components/lexicon-provider";

/**
 * Where the studio's public booking page lives, and the one place it can be moved.
 *
 * The address is derived from the studio's name when the organization is
 * created, and for a while that was all there was: the field that edited it was
 * taken off «Онлайн-запись» on the theory that the derived link would do. It did
 * not, for anybody who named the studio in a hurry at sign-up — they were left
 * with `/book/some-one` and no screen that could change it, while the «Название»
 * field on the address card below looked like it should and saved somewhere
 * else entirely.
 *
 * It saves through `PATCH /api/v1/organizations/settings`, because the link
 * names the whole studio rather than any one address on it. Changing it breaks
 * every copy of the old link a client has, so the warning is shown before the
 * save, not after.
 */

const PROBLEM_KEYS: Readonly<Record<SlugProblem, MessageKey>> = {
  too_short: "bookingSetup.publicAddressInvalid",
  too_long: "bookingSetup.publicAddressInvalid",
  invalid_characters: "bookingSetup.publicAddressInvalid",
  reserved: "bookingSetup.publicAddressReserved",
};

export function PublicAddressEditor({
  slug,
  locale,
  canEdit,
  suggested,
  onDone,
}: {
  slug: string | null;
  locale: AppLocale;
  canEdit: boolean;
  /**
   * A new address to offer, opening the form with it already typed. Set by
   * settings after a rename, where the question is whether the link should
   * follow the name.
   */
  suggested?: string;
  /** Called after a save or a cancel, for a caller that shows this only briefly. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const [editing, setEditing] = useState(suggested !== undefined);
  const [draft, setDraft] = useState(suggested ?? slug ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const href = slug === null ? null : `/book/${slug}`;
  const normalized = draft.trim().toLowerCase();

  function close() {
    setEditing(false);
    setError(null);
    setDraft(slug ?? "");
    onDone?.();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The same rule the server applies, checked first so the answer arrives
    // without a round trip and in words rather than a code.
    const problem = checkSlug(normalized);
    if (problem) {
      setError(t(PROBLEM_KEYS[problem]));
      return;
    }

    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/organizations/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: normalized }),
    });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code as string | undefined;
      const fieldProblem = body?.error?.field_errors?.[0]?.code as SlugProblem | undefined;
      setError(
        code === "SLUG_TAKEN"
          ? t("bookingSetup.publicAddressTaken")
          : code === "INVALID_SLUG" && fieldProblem && fieldProblem in PROBLEM_KEYS
            ? t(PROBLEM_KEYS[fieldProblem])
            : (body?.error?.message ?? t("common.saveFailed")),
      );
      return;
    }

    setEditing(false);
    onDone?.();
    router.refresh();
  }

  if (!editing) {
    return (
      <p className="muted">
        {/* An expression rather than JSX text: `tests/accessibility.test.ts`
            refuses literals the dictionary does not own, and «/book/» is a
            path, not a sentence. */}
        {t("bookingSetup.publicPageLabel")}{" "}
        {href && (
          <a className="text-link" href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
        )}
        {canEdit && (
          <>
            {" "}
            <button className="inline-action" type="button" onClick={() => setEditing(true)}>
              {t("bookingSetup.publicAddressChange")}
            </button>
          </>
        )}
      </p>
    );
  }

  return (
    <form className="inline-form" onSubmit={save}>
      <label>
        {t("bookingSetup.publicAddressLabel")}
        <input
          name="public_slug"
          value={draft}
          required
          maxLength={SLUG_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value.toLowerCase())}
        />
      </label>
      <button
        className="secondary-button"
        type="submit"
        disabled={pending || normalized === (slug ?? "")}
      >
        {t("bookingSetup.publicAddressSave")}
      </button>
      <button className="inline-action" type="button" disabled={pending} onClick={close}>
        {suggested !== undefined ? t("settings.slugKeep") : t("common.cancel")}
      </button>
      <p className="muted field-note">
        {`/book/${normalized}`} · {t("bookingSetup.publicAddressHint")}
      </p>
      {slug !== null && <p className="muted field-note">{t("bookingSetup.publicAddressWarning")}</p>}
      {error && (
        <p className="form-error field-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
