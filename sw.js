/* Notify · Service Worker
   - 网络优先：每次改版都能拿到新代码
   - 离线时回落缓存壳（能打开界面，消息等联网后补）
   - 只缓存同源、无查询串的静态资源，避免 ?demo=1 之类污染缓存 */
const CACHE = "notify-v16";
const SHELL = [
  "./",
  "./index.html",
  "./js/crypto.js",
  "./js/api.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // 逐个添加：任何一个失败都不至于让整次安装失败
      Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // Supabase 请求不缓存

  // 带查询串的（如 ?demo=1）不进缓存，直接走网络
  const cacheable = !url.search;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (cacheable && res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      return new Response("离线中，恢复网络后请重新打开", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  })());
});

/* ---------- Web Push：锁屏通知（通知里只有固定文案，不含消息内容） ---------- */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(d.t || "Notify", {
      body: d.b || "收到一条新消息",
      tag: d.tag || "notify-msg",          // 连续多条只显示一条
      renotify: true,
      silent: false,
      sound: "default",                    // iOS/安卓锁屏通知带提示音
      badge: "./icons/icon-192.png",
      icon: "./icons/icon-192.png",
      data: { url: "./" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  })());
});
