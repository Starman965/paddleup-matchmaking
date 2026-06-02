const CACHE_NAME = "paddleup-v4";
const APP_ASSETS = ["./manifest.webmanifest", "./pwa-icon.svg", "./paddleup-logo.png", "./app-icon-192.png", "./app-icon-512.png"];
const NETWORK_FIRST_PATHS = new Set(["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/version.json"]);

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  const title = data.title || "PaddleUp";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Open PaddleUp for the latest match update.",
      icon: "/app-icon-192.png",
      badge: "/favicon-32.png",
      data
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existingClient = clients.find((client) => "focus" in client);
      if (existingClient) return existingClient.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (NETWORK_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(() => caches.match(event.request)));
    return;
  }

  if (url.pathname.startsWith("/assets/") || APP_ASSETS.includes(`.${url.pathname}`)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        });
      })
    );
  }
});
