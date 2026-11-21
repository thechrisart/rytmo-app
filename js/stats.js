// "Seu rytmo": o que você mais ouviu no mês, no ano e desde sempre.
// Uma música conta como tocada depois de 30 segundos (ou metade, se for curta).
// Cada aparelho guarda a própria contagem, por mês, e envia para o stats.json no Drive;
// a página soma todos os aparelhos.

const DEVICE_KEY = 'rytmo.deviceId';
let storeKey = 'rytmo.stats';
let mine = {}; // { 'AAAA-MM': { minutes, tracks: {id: n}, albums: {id: n}, artists: {nome: n} } }
let others = {}; // { deviceId: meses } dos outros aparelhos, vindos do Drive
let remote = null; // { load(), save(data) } ou null (demo / ouvinte: só neste aparelho)
let saveTimer = null;

export const deviceId = (() => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return 'este-aparelho'; }
})();

export async function initStats({ key, store }) {
  storeKey = key;
  remote = store;
  try { mine = JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { mine = {}; }
  if (!remote) return;
  try {
    const data = (await remote.load()) || {};
    others = { ...(data.devices || {}) };
    // a cópia do Drive deste aparelho pode estar mais completa (ex.: app reinstalado)
    const fromDrive = others[deviceId];
    delete others[deviceId];
    if (fromDrive) mine = mergeMax(mine, fromDrive);
  } catch (e) {
    console.warn('Seu rytmo: não deu para ler do Drive', e);
  }
}

function mergeMax(a, b) {
  const out = structuredClone(a);
  for (const [month, m] of Object.entries(b)) {
    const t = (out[month] ||= { minutes: 0, tracks: {}, albums: {}, artists: {} });
    t.minutes = Math.max(t.minutes || 0, m.minutes || 0);
    for (const k of ['tracks', 'albums', 'artists']) {
      for (const [id, n] of Object.entries(m[k] || {})) t[k][id] = Math.max(t[k][id] || 0, n);
    }
  }
  return out;
}

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const month = () => (mine[monthKey()] ||= { minutes: 0, tracks: {}, albums: {}, artists: {} });

function persist(remoteSoon = false) {
  try { localStorage.setItem(storeKey, JSON.stringify(mine)); } catch {}
  if (!remote) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, remoteSoon ? 2000 : 60000);
}

export async function flush() {
  clearTimeout(saveTimer);
  if (!remote) return;
  try { await remote.save({ devices: { ...others, [deviceId]: mine } }); } catch (e) { console.warn('Seu rytmo: não salvou no Drive', e); }
}

// ---------- Contagem enquanto toca ----------

let current = null; // { trackId, albumId, artist, duration, heard, counted }
let lastTime = null;

export function trackStarted({ track, album }) {
  current = { trackId: track.id, albumId: album.id, artist: track.artist || album.artist || '', duration: track.duration || 0, heard: 0, counted: false };
  lastTime = null;
}

// Chamado a cada timeupdate com o tempo atual do player.
export function tick(time, playing) {
  if (!current || !playing) { lastTime = null; return; }
  if (lastTime != null) {
    const delta = time - lastTime;
    if (delta > 0 && delta < 3) { // ignora pulos (arrastou a barra)
      current.heard += delta;
      month().minutes += delta / 60;
    }
  }
  lastTime = time;
  const need = current.duration ? Math.min(30, current.duration / 2) : 30;
  if (!current.counted && current.heard >= need) {
    current.counted = true;
    const m = month();
    m.tracks[current.trackId] = (m.tracks[current.trackId] || 0) + 1;
    m.albums[current.albumId] = (m.albums[current.albumId] || 0) + 1;
    if (current.artist) m.artists[current.artist] = (m.artists[current.artist] || 0) + 1;
    persist();
  } else if (Math.random() < 0.02) persist(); // minutos ouvidos, de vez em quando
}

// ---------- Leitura para a página ----------

// period: 'month' | 'year' | 'all'
export function summary(period) {
  const now = new Date();
  const keep = (key) => period === 'all' || (period === 'year' ? key.startsWith(`${now.getFullYear()}-`) : key === monthKey(now));
  const total = { minutes: 0, tracks: {}, albums: {}, artists: {} };
  for (const months of [mine, ...Object.values(others)]) {
    for (const [key, m] of Object.entries(months || {})) {
      if (!keep(key)) continue;
      total.minutes += m.minutes || 0;
      for (const k of ['tracks', 'albums', 'artists']) {
        for (const [id, n] of Object.entries(m[k] || {})) total[k][id] = (total[k][id] || 0) + n;
      }
    }
  }
  const top = (obj, n = 5) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    minutes: Math.round(total.minutes),
    plays: Object.values(total.tracks).reduce((s, n) => s + n, 0),
    tracks: top(total.tracks),
    albums: top(total.albums),
    artists: top(total.artists),
  };
}

export const hasStats = () => [mine, ...Object.values(others)].some((m) => Object.keys(m || {}).length);

// ---------- Cartão para compartilhar (1080x1920, formato de story) ----------

const loadImage = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

// rows: { label, tracks: [{title, sub}], artists: [{name, n}], cover, minutes, plays }
export async function drawCard(data) {
  const W = 1080, H = 1920;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  await document.fonts?.ready;
  const font = (w, s) => `${w} ${s}px Poppins, system-ui, sans-serif`;

  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#ff6b00'); bg.addColorStop(0.42, '#3a1800'); bg.addColorStop(1, '#050505');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);

  x.fillStyle = '#fff';
  x.font = font(800, 76); x.fillText('rytmo', 80, 150);
  x.fillStyle = '#050505'; x.fillText('.', 80 + x.measureText('rytmo').width, 150);
  x.fillStyle = 'rgba(255,255,255,.85)'; x.font = font(600, 40); x.fillText(`Seu rytmo • ${data.label}`, 80, 220);

  const cover = await loadImage(data.cover);
  const cy = 300, cs = 520;
  x.save();
  x.shadowColor = 'rgba(0,0,0,.5)'; x.shadowBlur = 60; x.shadowOffsetY = 20;
  if (cover) {
    x.beginPath(); x.roundRect((W - cs) / 2, cy, cs, cs, 36); x.clip();
    x.drawImage(cover, (W - cs) / 2, cy, cs, cs);
  } else {
    x.fillStyle = '#ff6b00'; x.beginPath(); x.roundRect((W - cs) / 2, cy, cs, cs, 36); x.fill();
  }
  x.restore();

  let y = cy + cs + 120;
  x.fillStyle = '#fff'; x.font = font(800, 110); x.textAlign = 'center';
  x.fillText(data.minutes.toLocaleString('pt-BR'), W / 2, y);
  x.font = font(500, 40); x.fillStyle = 'rgba(255,255,255,.8)';
  x.fillText(`minutos ouvidos • ${data.plays.toLocaleString('pt-BR')} músicas`, W / 2, y + 60);
  x.textAlign = 'left';

  const fit = (text, max) => {
    let t = text;
    while (x.measureText(t).width > max && t.length > 1) t = t.slice(0, -1);
    return t === text ? t : `${t.trimEnd()}…`;
  };
  const column = (title, rows, left) => {
    let yy = y + 180;
    x.fillStyle = '#ff6b00'; x.font = font(700, 38); x.fillText(title, left, yy);
    rows.forEach((r, i) => {
      yy += 78;
      x.fillStyle = 'rgba(255,255,255,.55)'; x.font = font(700, 40); x.fillText(String(i + 1), left, yy);
      x.fillStyle = '#fff'; x.font = font(600, 38); x.fillText(fit(r, 380), left + 48, yy);
    });
  };
  column('Artistas', data.artists.slice(0, 5), 80);
  column('Músicas', data.tracks.slice(0, 5), 560);

  x.fillStyle = 'rgba(255,255,255,.6)'; x.font = font(500, 32); x.textAlign = 'center';
  x.fillText('kbtlab.net/rytmo', W / 2, H - 80);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Cartão "Minha trilha": 3 músicas que marcaram fases, para mandar nos stories.
// items: [{ label, title, artist, cover }]
export async function drawTrilha({ name, items }) {
  const W = 1080, H = 1920;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  await document.fonts?.ready;
  const font = (w, s) => `${w} ${s}px Poppins, system-ui, sans-serif`;
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#ff6b00'); bg.addColorStop(0.45, '#3a1800'); bg.addColorStop(1, '#050505');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff'; x.font = font(800, 76); x.fillText('rytmo', 80, 150);
  x.fillStyle = '#050505'; x.fillText('.', 80 + x.measureText('rytmo').width, 150);
  x.fillStyle = '#fff'; x.font = font(800, 84); x.fillText('Trilha da', 80, 330); x.fillText('minha vida', 80, 430);
  x.fillStyle = 'rgba(255,255,255,.8)'; x.font = font(500, 40); x.fillText(name || '', 80, 500);
  const fit = (text, max) => { let t = String(text || ''); while (t && x.measureText(t).width > max) t = t.slice(0, -2); return t === String(text || '') ? t : `${t}…`; };
  let y = 620;
  for (const it of items.slice(0, 3)) {
    const img = await loadImage(it.cover);
    const s = 300;
    x.save(); x.beginPath(); x.roundRect(80, y, s, s, 28); x.clip();
    if (img) x.drawImage(img, 80, y, s, s); else { x.fillStyle = '#ff6b00'; x.fillRect(80, y, s, s); }
    x.restore();
    x.fillStyle = '#ff9a4d'; x.font = font(700, 34); x.fillText(fit(it.label, 560), 420, y + 70);
    x.fillStyle = '#fff'; x.font = font(800, 50); x.fillText(fit(it.title, 580), 420, y + 150);
    x.fillStyle = 'rgba(255,255,255,.75)'; x.font = font(500, 38); x.fillText(fit(it.artist, 580), 420, y + 210);
    y += 380;
  }
  x.fillStyle = 'rgba(255,255,255,.6)'; x.font = font(500, 32); x.textAlign = 'center';
  x.fillText('kbtlab.net/rytmo', W / 2, H - 80);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}
