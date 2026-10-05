/*
 * The studio's service worker: it shows a push and opens what the push is
 * about. Nothing else.
 *
 * There is deliberately no `fetch` handler and no cache. Every screen of this
 * application is about money and appointments that change by the minute, and an
 * offline copy of yesterday's calendar is a wrong answer that looks right. A
 * worker without a fetch handler is never in the path of a page load, so it
 * cannot serve a stale one either.
 *
 * The payload is written by `lib/push-message.ts`:
 *   { title, body, url, tag }
 * `url` is a path inside `/app`; anything else is ignored rather than opened,
 * so a payload can never send somebody off the site.
 */

self.addEventListener("install", () => {
  // A new worker has nothing to migrate and no cache to warm.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function insideApp(url) {
  return typeof url === "string" && (url === "/app" || url.startsWith("/app/") || url.startsWith("/app?"));
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push that is not ours to read still has to show something: browsers
    // penalise a site whose pushes arrive and display nothing.
  }

  const title = typeof data.title === "string" ? data.title : "Nail Profit OS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One line per appointment on the lock screen: a request and the reminder
      // about it replace each other instead of piling up.
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: typeof data.tag === "string",
      data: { url: insideApp(data.url) ? data.url : "/app" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/app", self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // An open tab of the application is reused rather than joined by another.
      // `navigate` only works on a tab this worker controls — one inside /app —
      // so a tab elsewhere on the site, or a refusal, falls through to a new one.
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (!new URL(client.url).pathname.startsWith("/app") || !("navigate" in client)) continue;
        try {
          const moved = await client.navigate(target);
          await (moved ?? client).focus();
          return;
        } catch {
          break;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
