/* 山の中 (電波なし) でも開けるように、アプリの本体と背景地図のタイルをキャッシュする。データと記録は IndexedDB にある。 */
const CACHE = "forestfield-v4";
const TILE_CACHE = "forestfield-tiles";      // 背景地図 (地理院タイル)。アプリの版が変わっても消さない
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
  "crs_jp.js", "vendor/proj4.js", "vendor/shp.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // 背景地図のタイル: 保存してあればそれを (電波が無くても出る)、無ければ取りに行って保存する
  if (url.hostname === "cyberjapandata.gsi.go.jp") {
    e.respondWith(caches.open(TILE_CACHE).then((c) => c.match(e.request.url).then((hit) => hit ||
      fetch(e.request).then((r) => { if (r.ok) c.put(e.request.url, r.clone()); return r; }))));
    return;
  }
  if (url.origin !== location.origin) return;
  // アプリ本体: 電波があれば新しい版を取りに行き、無ければキャッシュを使う
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
