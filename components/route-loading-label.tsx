"use client";

import { useSyncExternalStore } from "react";

/**
 * «Загрузка…» for a screen reader while a section of /app is on its way.
 *
 * The skeleton it sits in has to be static so that Next can prefetch it, which
 * rules out reading the studio's language on the server. The root layout has
 * already written that language into `<html lang>`, so the browser reads it from
 * there. The three words are written out here rather than taken from the
 * dictionary, which would ship every message in every language to say one.
 * They match `notifications.loading`.
 */
const LABELS = { ru: "Загрузка…", ro: "Se încarcă…", en: "Loading…" } as const;

function languageOfPage(): keyof typeof LABELS {
  const language = document.documentElement.lang.slice(0, 2);
  return language in LABELS ? (language as keyof typeof LABELS) : "ru";
}

/** `<html lang>` does not change while a skeleton is on screen. */
function subscribe() {
  return () => {};
}

export function RouteLoadingLabel() {
  const language = useSyncExternalStore(subscribe, languageOfPage, () => "ru" as const);
  return (
    <span className="sr-only" role="status">
      {LABELS[language]}
    </span>
  );
}
