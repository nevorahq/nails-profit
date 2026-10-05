"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * The phone's floating «+» and the three things it starts.
 *
 * A `<details>` rather than a hand-rolled menu: it opens and closes without a
 * line of script, keyboard and screen reader included. The script here only
 * closes it where `<details>` alone would not — after a choice, since the shell
 * outlives the navigation and would otherwise arrive on the next page still
 * open, and on Escape or a tap outside, which is how a menu is left.
 *
 * Labels arrive translated from the server, like the rest of the shell's
 * client pieces; what is offered is decided there too (`quickActionsFor`).
 */
export function QuickActions({
  actions,
  openLabel,
  closeLabel,
}: {
  actions: readonly { href: string; label: string }[];
  openLabel: string;
  closeLabel: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // Mirrors the element rather than driving it: `toggle` fires however it was
  // opened or closed, so the label cannot fall out of step with the menu.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => {
      if (menu.current) menu.current.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  if (actions.length === 0) return null;

  return (
    <details
      className="quick-actions"
      ref={menu}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="quick-actions-toggle" aria-label={open ? closeLabel : openLabel}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </summary>
      <ul className="quick-actions-menu">
        {actions.map((action) => (
          <li key={action.href}>
            <Link
              href={action.href}
              onClick={() => {
                if (menu.current) menu.current.open = false;
              }}
            >
              {action.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
