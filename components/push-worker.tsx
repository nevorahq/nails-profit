"use client";

import { useEffect } from "react";

import { registerPushWorker } from "@/lib/push-device";

/**
 * Registers the push worker once the signed-in shell is on screen.
 *
 * Registering is not subscribing: no permission is asked here, and nothing is
 * shown. It only has to exist before somebody presses «Включить», so that the
 * press asks one question rather than waiting on an install first — and so an
 * already-subscribed phone keeps the current worker after a deploy.
 */
export function PushWorker() {
  useEffect(() => {
    void registerPushWorker();
  }, []);
  return null;
}
