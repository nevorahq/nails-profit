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

/**
 * What this browser can do, in the four cases the switch says differently.
 *
 * `install` is the iPhone case, and the reason the switch has an instruction
 * at all: Safari on iOS has no push for a page in a tab, only for a site added
 * to the home screen and opened from there. Everything else that lacks push —
 * an old browser, a private window that refused the worker — is `unsupported`.
 */
export type PushSupport = "supported" | "install" | "unsupported";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS asks for the desktop site and says it is a Mac with a touchscreen.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "install";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    ? "supported"
    : "unsupported";
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE)) ?? (await registerPushWorker());
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    return (await (await registration())?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** The VAPID public key in the form `pushManager.subscribe` takes. */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function sendSubscription(subscription: PushSubscription): Promise<Response> {
  return fetch("/api/v1/push/subscription", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
}

export type EnableOutcome = "enabled" | "denied" | "unsupported" | "failed";

/**
 * «Включить»: the permission, the subscription, and the server told.
 *
 * Only ever called from a press — browsers refuse, or quietly remember as a
 * refusal, a permission prompt nobody asked for, and a refusal is very hard
 * for a person to undo.
 *
 * A 409 means this browser's endpoint belongs to another studio's account. A
 * fresh subscription is a fresh endpoint, so that is retried once; the old one
 * dies at the push service and the other studio's row goes at its first 410.
 */
export async function enablePush(publicKey: string): Promise<EnableOutcome> {
  if (pushSupport() !== "supported") return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const worker = await registration();
  if (!worker) return "unsupported";
  await navigator.serviceWorker.ready;

  try {
    let subscription =
      (await worker.pushManager.getSubscription()) ??
      (await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      }));

    let response = await sendSubscription(subscription);
    if (response.status === 409) {
      await subscription.unsubscribe();
      subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      response = await sendSubscription(subscription);
    }
    return response.ok ? "enabled" : "failed";
  } catch {
    // Most often a subscription made with a key this server no longer uses.
    // Dropping it lets the next press start clean.
    await (await worker.pushManager.getSubscription())?.unsubscribe().catch(() => false);
    return "failed";
  }
}

/**
 * This device's subscription, re-sent to the server.
 *
 * The browser is the source of truth for whether this device is subscribed —
 * it can drop a subscription on its own — so the switch reads it from there and
 * tells the server again. Idempotent on the server, and what restores a row the
 * table lost while the browser kept its half.
 */
export async function syncPush(): Promise<boolean> {
  if (pushSupport() !== "supported" || Notification.permission !== "granted") return false;
  const subscription = await currentSubscription();
  if (!subscription) return false;
  const response = await sendSubscription(subscription).catch(() => null);
  return response?.ok ?? false;
}

/**
 * «Выключить», and what signing out does to this device.
 *
 * The server first and the browser second: a server row left behind would go on
 * putting a studio's clients on a lock screen nobody is signed in to, while a
 * browser subscription left behind is only a key nobody sends to.
 */
export async function forgetThisDevice(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // Looked up, never registered: signing out of a page outside `/app` must not
  // install a worker on the way.
  const existing = await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE).catch(() => undefined);
  const subscription = await existing?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return;
  await fetch("/api/v1/push/subscription", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => null);
  await subscription.unsubscribe().catch(() => false);
}

export type TestOutcome = "sent" | "gone" | "failed";

/** «Проверить»: a real push to this device, through the real push service. */
export async function testPush(): Promise<TestOutcome> {
  const subscription = await currentSubscription();
  if (!subscription) return "gone";
  const response = await fetch("/api/v1/push/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => null);
  if (response?.ok) return "sent";
  if (response?.status === 404 || response?.status === 410) return "gone";
  return "failed";
}
