// Service worker do site (PWA): faz o app abrir sem internet.
// Arquivos do app: tenta a rede primeiro, para estar sempre na versão mais nova, e usa a cópia
// guardada se a internet falhar ou demorar. As músicas baixadas ficam no IndexedDB (offline.js);
// chamadas ao Google Drive e ao login nunca passam por aqui.
const CACHE = 'rytmo-v1';
const FONTS = 'rytmo-fonts-v1';
const NETWORK_TIMEOUT = 4000;
const SHELL = [
  './', 'index.html', 'oauth-callback.html', 'manifest.webmanifest',
  'css/style.css',
  'js/app.js', 'js/community.js', 'js/config.js', 'js/demo.js', 'js/drive.js', 'js/importer.js',
  'js/install.js', 'js/listen.js', 'js/offline.js', 'js/ui.js',
  'assets/icon.svg', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  // no-cache: confere com o servidor em vez de aceitar a cópia de até 10 minutos do navegador.
  const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res.ok) cache.put(url.pathname === new URL('./', self.location).pathname ? './' : request, res.clone());
    return res;
  });
  const saved = async () => {
    const hit = await cache.match(request, { ignoreSearch: true });
    // ?demo, ?ouvir=... e os atalhos abrem a mesma página.
    return hit || (request.mode === 'navigate' ? cache.match('./') : undefined);
  };
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
  const fast = await Promise.race([network.catch(() => null), timeout]);
  if (fast) return fast;
  const copy = await saved();
  return copy || network;
}

async function fontsCacheFirst(request) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') event.respondWith(fontsCacheFirst(request));
});
