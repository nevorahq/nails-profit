"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server's HTML and until React has taken the page over, true
 * after. For controls whose only behaviour is JavaScript: a form whose submit
 * handler has not been attached yet is a native form, and a native form with a
 * password field sends it wherever its `method` says.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
