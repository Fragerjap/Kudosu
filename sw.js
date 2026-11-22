/*
 * Bolt: Kudosu service worker — cache-first offline shell.
 * All app assets are pre-cached on install; every fetch is answered from the
 * cache when possible so the game works fully offline (airplane mode test).
 */
const CACHE = "kudosu-v3";

const ASSETS = [
  "./",
  "./index.html",
  "./public/manifest.webmanifest",
  "./public/styles.css",
  "./public/game.js",
  "./public/db.js",
  "./public/vendor/localforage.min.js",
  "./src/utils/sudoku-generator.js",
  "./public/assets/icons/icon.png",
  "./public/assets/img/kucoin.webp",
  "./public/assets/img/Magical_Wizard_Shop_Inventory.webp",
  "./public/assets/img/Sudoku_Adventure_Castle_Map.webp"
];

self.addEventListener("install", (event) => {
  // Bolt: cache files one by one so a single missing/404 file cannot abort
  // the whole install (addAll fails atomically).
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Bolt: cache-first strategy with network fallback + runtime cache fill.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Bolt: offline navigation fallback to the app shell.
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
          return Response.error();
        });
    })
  );
});
