"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * Where the checklist stood when the page was drawn, or null once the guided
 * run is over. `loadSetupGuide` decides which, and a studio that has closed a
 * visit is handed null — no baseline, no window, nothing to opt out of.
 */
export type SetupGuideBaseline = Readonly<{ done: number; total: number }> | null;

/** A step as `GET /api/v1/onboarding` reports it. */
type GuideStep = Readonly<{ key: string; done: boolean; href: string }>;

type Reached = Readonly<{
  done: number;
  total: number;
  complete: boolean;
  /**
   * What is left, in the checklist's own order. This is what lets the window
   * send somebody onward to the next thing instead of back to a list — an
   * optional field so an older payload cannot crash the dialog.
   */
  steps?: readonly GuideStep[];
}>;

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
export function useSetupGuide(
  baseline: SetupGuideBaseline,
  /**
   * Which checklist this screen is a step of. The month's screens — the expense
   * ledger and the rota — ask the same question of a different list, and the
   * two must not share an answer: closing a visit is not progress on March's
   * rent.
   */
  endpoint: "/api/v1/onboarding" | "/api/v1/onboarding/month" = "/api/v1/onboarding",
): SetupGuide {
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

    const response = await fetch(endpoint).catch(() => null);
    if (!response?.ok) return false;
    const body = await response.json().catch(() => null);
    const progress = body?.data as Reached | undefined;
    if (!progress || typeof progress.done !== "number") return false;

    const advanced = progress.done > done.current;
    done.current = progress.done;
    if (!advanced) return false;

    setReached(progress);
    return true;
  }, [baseline, endpoint]);

  return {
    active: baseline !== null,
    reached,
    check,
    dismiss: useCallback(() => setReached(null), []),
  };
}

/**
 * The window itself: what was just finished, and the way to the next thing.
 *
 * It names the goal ahead rather than reporting on the list behind, and its
 * main button is that goal's own action — «Добавить услугу», not «Вернуться к
 * шагам». On the last step there is nothing ahead, so it shows what the visit
 * earned and opens the report.
 *
 * Two ways out on purpose. The owner who has just added their first master may
 * well want to add the second one before going anywhere, and a window with a
 * single door would make them travel to the dashboard and back to do it. Escape
 * and the backdrop both mean «остаться».
 */
export function SetupGuideDialog({
  guide,
  locale,
  strings = "setupGuide",
  doneHref = "/app",
  stayKey,
  onStay,
  doneSummary,
}: {
  guide: SetupGuide;
  locale: AppLocale;
  /**
   * Which checklist's wording to use. The two journeys end in different places
   * and say different things when they do — «Первый расчёт готов» against
   * «Расчёт месяца готов» — and one set of strings serving both would have to
   * be vague enough to fit neither.
   */
  strings?: "setupGuide" | "monthGuide";
  /** Where the last window leads. The month's report is not the dashboard. */
  doneHref?: string;
  /** What the second button says, when «остаться здесь» is not the honest word. */
  stayKey?: MessageKey;
  /** What it does, when leaving the window is not the whole of it. */
  onStay?: () => void;
  /**
   * What the last step produced, shown on the final window. The visit form
   * passes the figures the close just returned: «Первый расчёт» that ends by
   * promising a number somewhere else is not a first calculation.
   */
  doneSummary?: ReactNode;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const { reached, dismiss } = guide;
  const primary = useRef<HTMLButtonElement>(null);
  const say = (name: string) => t(`${strings}.${name}` as MessageKey);

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
  const next = reached.steps?.find((step) => !step.done) ?? null;

  /*
   * Forward, not back. This button used to read «Вернуться к шагам» and send
   * the owner to the dashboard checklist — praise for the step just done,
   * followed by a return to the list of what is still undone. It now goes
   * straight to the next thing to do, and only falls back to the dashboard
   * when there is nothing left, where the dashboard is the report they earned.
   *
   * Refreshed rather than merely navigated to: the destination is a server
   * component rendered before this step existed, and pushing alone can answer
   * from the router cache — showing the owner the very ○ they have just
   * filled in.
   */
  function onward() {
    dismiss();
    router.push(next?.href ?? doneHref);
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
        <h2 id="setup-guide-title">{say(reached.complete ? "doneTitle" : "title")}</h2>
        <p>
          {reached.complete
            ? say("doneBody")
            : t(`${strings}.body` as MessageKey, {
                count: remaining,
                done: reached.done,
                total: reached.total,
              })}
        </p>
        {reached.complete
          ? doneSummary
          : next && <p className="modal-goal">{t(`step.goal.${next.key}` as MessageKey)}</p>}
        <div className="button-row">
          <button className="primary-button" type="button" ref={primary} onClick={onward}>
            {reached.complete
              ? say("doneAction")
              : next
                ? t(`step.action.${next.key}` as MessageKey)
                : say("back")}
          </button>
          <button className="secondary-button" type="button" onClick={stay}>
            {stayKey ? t(stayKey) : say("stay")}
          </button>
        </div>
      </div>
    </div>
  );
}
