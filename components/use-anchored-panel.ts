"use client";

import { type SetStateAction, useCallback, useState, useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const clientHash = () => location.hash;
// The server has no address bar, and hydration has to agree with it.
const serverHash = () => "";

/**
 * Whether a folded compose panel is open, starting open when the address ends
 * in its anchor (`/app/services#add-service`).
 *
 * The address used to be read in a lazy `useState` initializer. On a page
 * reached by a client-side link that worked — the component mounted in the
 * browser, where `location` exists. On a full page load it did not: the
 * initializer ran during hydration, the server had drawn the panel closed, and
 * React keeps the server's attributes on a mismatch rather than patching them,
 * so a bookmark, a reload or a link from outside the app opened the page with
 * the form shut. `useSyncExternalStore` is how React reads a browser value
 * without that mismatch: it hydrates with the server's answer and renders the
 * address's straight after.
 *
 * Once somebody presses the toggle their choice holds, whatever the address
 * still says — the hash stays `#add-service` after the panel is folded again.
 */
export function useAnchoredPanel(anchor: string): [boolean, (next: SetStateAction<boolean>) => void] {
  const hash = useSyncExternalStore(subscribe, clientHash, serverHash);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const target = `#${anchor}`;

  const setOpen = useCallback(
    (next: SetStateAction<boolean>) =>
      setChosen((current) => {
        // Only ever called from the browser, where the address is there to read.
        const open = current ?? location.hash === target;
        return typeof next === "function" ? next(open) : next;
      }),
    [target],
  );

  return [chosen ?? hash === target, setOpen];
}
