// Background helper for alerts (Settings > Alerts, docs/push.js). It only shows the alerts src/push.py sends
// and opens the right page when one is tapped. No caching: the site always loads fresh from the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "The Cupcake Index", {
    body: d.body || "",
    icon: "icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag, // a new score replaces the last one for that game, and still buzzes
    data: { url: d.url || "/#/rankings" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.registration.scope).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = open.find((c) => c.url.startsWith(self.registration.scope) && !c.url.includes("/pc"));
    if (tab) {
      // tell the open app where to go: iPhone home-screen apps don't support tab.navigate()
      try { await tab.focus(); tab.postMessage({ type: "open", url }); return; } catch (_) { /* fall through: open a new one */ }
    }
    await self.clients.openWindow(url);
  })());
});
