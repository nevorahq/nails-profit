/**
 * This browser's side of web push: the worker, the permission, the
 * subscription. Browser-only — every function here touches `navigator` — and
 * kept out of components so the two places that offer the switch (the bell and
 * «Настройки») cannot drift into two different ideas of what «включено» means.
 */

/**
 * Narrower than the site: the worker exists for signed-in screens, and a
 * landing page visitor should not register anything. `/app` rather than
 * `/app/` so the start page itself is inside it.
 */
export const PUSH_WORKER_SCOPE = "/app";

export async function registerPushWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", {
      scope: PUSH_WORKER_SCOPE,
      // The worker is never served from the HTTP cache; see `next.config.ts`.
      updateViaCache: "none",
    });
  } catch {
    // A browser that refuses a worker — private mode, a policy — is a browser
    // without push, which the switch already knows how to say.
    return null;
  }
}
