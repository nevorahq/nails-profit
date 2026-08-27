"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * Where the checklist stood when the page was drawn, or null once the guided
 * run is over. `loadSetupGuide` decides which, and a studio that has closed a
 * visit is handed null — no baseline, no window, nothing to opt out of.
 */
export type SetupGuideBaseline = Readonly<{ done: number; total: number }> | null;

type Reached = Readonly<{ done: number; total: number; complete: boolean }>;

export type SetupGuide = Readonly<{
  /** Whether this page is part of a guided run at all. */
  active: boolean;
  /** The window's contents while it is open, null while it is not. */
  reached: Reached | null;
  /**
   * Call after a successful write. Resolves true when a step was finished and
   * the window is now open — the visit form uses that to hold its redirect.
   */
  check: () => Promise<boolean>;
  dismiss: () => void;
}>;

/**
 * The guided setup, which is one question asked after every write: did that
 * finish a step?
 *
 * The answer comes from the server — `GET /api/v1/onboarding`, the same
 * `loadOnboarding` the dashboard panel is drawn from — rather than from
 * guessing here that adding a specialist must have completed the specialist
 * step. It often has not: the rule may cover only an archived service, and a
 * second service changes nothing once the first one counted. A window that
 * congratulated somebody on a step the panel still shows as ○ would be worse
 * than no window.
 *
 * Everything here fails quietly. A refused or broken request leaves the page
 * exactly as it was: this is a courtesy on top of a working screen, and it must
 * never be the reason a studio cannot get on with its work.
 */
export function useSetupGuide(baseline: SetupGuideBaseline): SetupGuide {
  /*
   * What the checklist stood at last time we looked — seeded from the server's
   * own count so the first write has something to be compared against.
   *
   * A ref, not state: `router.refresh()` re-renders this page with fresh props
   * while keeping client state, so a value derived from `baseline` would be
   * reset by the very refresh that follows each write, and every subsequent
   * save would re-announce the step that had already been announced.
   */
  const done = useRef(baseline?.done ?? 0);
  const [reached, setReached] = useState<Reached | null>(null);

  const check = useCallback(async () => {
    if (!baseline) return false;

    const response = await fetch("/api/v1/onboarding").catch(() => null);
    if (!response?.ok) return false;
    const body = await response.json().catch(() => null);
    const progress = body?.data as Reached | undefined;
    if (!progress || typeof progress.done !== "number") return false;

    const advanced = progress.done > done.current;
    done.current = progress.done;
    if (!advanced) return false;

    setReached(progress);
    return true;
  }, [baseline]);

  return {
    active: baseline !== null,
    reached,
    check,
    dismiss: useCallback(() => setReached(null), []),
  };
}

/**
 * The window itself: what was just finished, what is left, and the way back to
 * the list.
 *
 * Two ways out on purpose. The owner who has just added their first master may
 * well want to add the second one before going anywhere, and a window with a
 * single door would make them travel to the dashboard and back to do it. Escape
 * and the backdrop both mean «остаться».
 */
export function SetupGuideDialog({
  guide,
  locale,
  stayKey = "setupGuide.stay",
  onStay,
}: {
  guide: SetupGuide;
  locale: AppLocale;
  /** What the second button says, when «остаться здесь» is not the honest word. */
  stayKey?: MessageKey;
  /** What it does, when leaving the window is not the whole of it. */
  onStay?: () => void;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const { reached, dismiss } = guide;
  const primary = useRef<HTMLButtonElement>(null);

  const stay = useCallback(() => {
    dismiss();
    onStay?.();
  }, [dismiss, onStay]);

  useEffect(() => {
    if (!reached) return;
    /*
     * Focus follows the window. Without this the keyboard stays behind it — on
     * the field that was just saved — and «Вернуться к шагам» is reached by
     * tabbing through the whole form the window is covering.
     */
    primary.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") stay();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [reached, stay]);

  if (!reached) return null;

  const remaining = reached.total - reached.done;

  /*
   * Back to the panel, and refreshed rather than merely navigated to. The
   * dashboard is a server component whose checklist was rendered before this
   * step existed; pushing alone can answer from the router cache and show the
   * owner the very ○ they have just filled in.
   */
  function toDashboard() {
    dismiss();
    router.push("/app");
    router.refresh();
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={stay}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="setup-guide-title">
          {t(reached.complete ? "setupGuide.doneTitle" : "setupGuide.title")}
        </h2>
        <p>
          {reached.complete
            ? t("setupGuide.doneBody")
            : t("setupGuide.body", { count: remaining, done: reached.done, total: reached.total })}
        </p>
        <div className="button-row">
          <button className="primary-button" type="button" ref={primary} onClick={toDashboard}>
            {t(reached.complete ? "setupGuide.doneAction" : "setupGuide.back")}
          </button>
          <button className="secondary-button" type="button" onClick={stay}>
            {t(stayKey)}
          </button>
        </div>
      </div>
    </div>
  );
}
