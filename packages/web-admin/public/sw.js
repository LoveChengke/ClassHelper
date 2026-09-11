/**
 * Service Worker：让 Web 管理端可以被浏览器「安装为应用」，并在断网时打开应用外壳。
 *
 * 策略：
 * - 导航请求（打开页面/刷新/前端路由）：network-first，失败时回退缓存的 index.html
 * - 构建产物 /assets/*（带内容哈希）：cache-first（文件名变化即自动失效）
 * - /api 与 /socket.io：完全透传，绝不缓存（避免脏数据与鉴权问题）
 */
const CACHE_NAME = 'classhelper-admin-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只接管同源请求
  if (url.origin !== self.location.origin) return;
  // 接口与实时通道透传
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // 页面导航：网络优先，离线时用缓存外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached ?? Response.error());
        return cached ?? network;
      }),
    );
  }
});
