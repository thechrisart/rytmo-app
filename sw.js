// Service worker do site (PWA): faz o app abrir sem internet.
// Arquivos do app: tenta a rede primeiro, para estar sempre na versão mais nova, e usa a cópia
// guardada se a internet falhar ou demorar. As músicas baixadas ficam no IndexedDB (offline.js);
// chamadas ao Google Drive e ao login nunca passam por aqui.
const CACHE = 'rytmo-v21';
const FONTS = 'rytmo-fonts-v1';
const NETWORK_TIMEOUT = 4000;
const SHELL = [
  './', 'index.html', 'oauth-callback.html', 'manifest.webmanifest',
  'css/style.css',
  'js/app.js', 'js/community.js', 'js/config.js', 'js/demo.js', 'js/drive.js', 'js/importer.js',
  'js/i18n.js', 'js/install.js', 'js/listen.js', 'js/offline.js', 'js/stats.js', 'js/tags.js', 'js/ui.js',
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
    // cópia desta versão ou, se faltar, de qualquer versão guardada antes
    const hit = (await cache.match(request, { ignoreSearch: true })) || (await caches.match(request, { ignoreSearch: true }));
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

// ---------- Música em pedaços (__stream/<id>) ----------
// O player pede faixas de bytes; aqui o pedido vai ao Google Drive com o login no cabeçalho.
// O Google não deixa o site ler o Content-Range da resposta, então ele é montado aqui com o
// tamanho do arquivo (lido uma vez).
let driveToken = null;
const fileInfo = new Map(); // id -> { size, mimeType }
self.addEventListener('message', (event) => {
  if (event.data?.type === 'token') driveToken = event.data.token;
});

async function stream(request, id) {
  const auth = { Authorization: `Bearer ${driveToken}` };
  const api = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  if (!fileInfo.has(id)) {
    const meta = await fetch(`${api}?fields=size,mimeType`, { headers: auth });
    if (!meta.ok) return new Response('', { status: meta.status });
    const m = await meta.json();
    fileInfo.set(id, { size: Number(m.size), mimeType: m.mimeType || 'audio/mpeg' });
  }
  const { size, mimeType } = fileInfo.get(id);
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!m) {
    const res = await fetch(`${api}?alt=media`, { headers: auth });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': mimeType, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const res = await fetch(`${api}?alt=media`, { headers: { ...auth, Range: `bytes=${start}-${end}` } });
  if (!res.ok) return new Response('', { status: res.status });
  return new Response(res.body, {
    status: 206,
    headers: { 'Content-Type': mimeType, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const streamId = url.origin === self.location.origin && url.pathname.match(/\/__stream\/([^/]+)$/);
  if (streamId) return event.respondWith(stream(request, decodeURIComponent(streamId[1])));
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') event.respondWith(fontsCacheFirst(request));
});
