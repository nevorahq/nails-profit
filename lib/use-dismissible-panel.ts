"use client";

import { useEffect, useRef } from "react";

/**
 * The open/close wiring shared by every topbar panel-on-a-button — the
 * account menu and the notification list alike: a click outside the root
 * closes it, Escape closes it and hands focus back to the trigger that opened
 * it. Listens on the document rather than a backdrop element, since a
 * backdrop would swallow the very click that is supposed to open a different
 * button's panel.
 */
export function useDismissiblePanel(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) close();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return { root, trigger };
}
