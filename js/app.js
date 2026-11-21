import * as drive from './drive.js';
import { demoStore } from './demo.js';
import { listenStore } from './listen.js';
import { CONFIG } from './config.js';
import * as community from './community.js';
import * as offline from './offline.js';
import { canInstall, shouldSuggest, installCardHTML, onInstallChange, isInstalled } from './install.js';
import * as stats from './stats.js';
import { startI18n, bindLangButton } from './i18n.js';

window.__rytmoBooted = true; // a recuperação do index.html sabe que o código carregou
try { startI18n(); } catch (e) { console.warn('idioma', e); }
try { bindWebPhonePortrait(); } catch {} // já na tela de login
import { initImporter, openImporter, pickAndImport, storeCover } from './importer.js';
import { IS_IOS, $, $$, esc, fmtTime, fmtTotal, coverHTML, toast, openModal, closeModal, resizeImage, pickFile } from './ui.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
// Link de ouvinte (?ouvir=<id do library.json>): o visitante entra com o Google e só ouve.
const LISTEN_ID = params.get('ouvir');
const READONLY = !!LISTEN_ID || params.has('ouvinte'); // ?demo&ouvinte = testar o modo ouvinte
const PICK = IS_IOS ? 'files' : 'folder'; // iPhone/iPad só escolhem arquivos
document.documentElement.classList.toggle('ios', IS_IOS);
document.documentElement.classList.toggle('readonly', READONLY);
if (LISTEN_ID) drive.configureListener();
if (DEMO) offline.configure('demo'); // o modo demo não mexe nas músicas baixadas de verdade
const store = DEMO ? demoStore : LISTEN_ID ? listenStore(LISTEN_ID) : drive;

let library = { version: 1, albums: [], playlists: [], artists: {} };
// Sem internet: o app abriu com a biblioteca guardada no aparelho e só toca o que foi baixado.
let offlineMode = false;
const offlineNow = () => !navigator.onLine;

// Trava o zoom e o arrasto da tela: pinça no iPhone/iPad e no trackpad do Mac.
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
const LIBRARY_CACHE_KEY = LISTEN_ID ? `library.${LISTEN_ID}` : 'library';
let user = null;
let editMode = false; // botão Editar: mostra as funções de edição da página atual
let communityPlaylists = []; // playlists públicas criadas pelos ouvintes (servidor da comunidade)
let communityOn = false; // servidor da comunidade respondeu

// ---------- Inicialização ----------

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-about]')) openAbout();
});

// Botão da tela de login e cartões seguem o que o navegador permite instalar agora.
function paintInstall() {
  $('#btn-install').classList.toggle('hidden', !canInstall());
  const page = location.hash.split('/')[1] || '';
  if (!$('#app').classList.contains('hidden') && ['', 'library'].includes(page)) route();
}
onInstallChange(paintInstall);

async function boot() {
  paintInstall();
  if (DEMO) return startApp();

  $('#login').classList.remove('hidden');
  const err = $('#login-error');
  if (LISTEN_ID) {
    $('.login-sub').innerHTML = 'Você recebeu um convite para ouvir uma biblioteca no rytmo.<br />Entre com sua conta Google para começar.';
    $('.login-demo').classList.add('hidden');
    $('#login-optin').classList.remove('hidden');
    $('#login-privacy').classList.remove('hidden');
    const optin = $('#optin');
    try { optin.checked = localStorage.getItem('rytmo.optin') === '1'; } catch {}
    optin.onchange = () => { try { localStorage.setItem('rytmo.optin', optin.checked ? '1' : '0'); } catch {} };
    if (!CONFIG.API_KEY) err.textContent = 'O dono deste app ainda não configurou a chave de API do modo ouvinte.';
  }
  if (!drive.isConfigured()) {
    err.textContent = 'Configure seu CLIENT_ID em js/config.js (veja o README) ou use o modo demo.';
    $('#btn-login').disabled = true;
    return;
  }
  $('#btn-login').onclick = async () => {
    err.textContent = drive.NATIVE ? 'Continue o login na janela do navegador que abriu…' : '';
    try {
      await drive.signIn('select_account');
      startApp();
    } catch (e) {
      err.textContent = `Não foi possível entrar: ${e.message}`;
    }
  };
  // Sem internet, mas com a biblioteca guardada: abre direto para ouvir o que foi baixado.
  if (!navigator.onLine && await offline.loadLibrary(LIBRARY_CACHE_KEY)) {
    offlineMode = true;
    drive.initAuth().catch(() => {}); // deixa o login pronto para quando a internet voltar
    return startApp();
  }
  try {
    if (await drive.initAuth()) return startApp();
  } catch (e) {
    err.textContent = e.message;
  }
  // O acesso venceu, mas a pessoa não tocou em "Sair": continua dentro do app e renova
  // quando precisar do Drive, em vez de voltar para a tela de login.
  if (drive.hasSession() && await offline.loadLibrary(LIBRARY_CACHE_KEY)) {
    offlineMode = true;
    startApp();
  }
}

// ---------- Biblioteca: cópia no aparelho + conferência rápida no Drive ----------

const MD5_KEY = `rytmo.libraryMd5.${LIBRARY_CACHE_KEY}`;
let librarySync = Promise.resolve(); // edições esperam a conferência terminar

let libraryRepaired = false;
function normalizeLibrary() {
  library.albums ||= [];
  library.playlists ||= [];
  library.artists ||= {};
  for (const album of library.albums) {
    for (const k of ['title', 'artist']) if (album[k]) album[k] = fixText(album[k]);
    for (const t of album.tracks || []) for (const k of ['title', 'artist']) if (t[k]) t[k] = fixText(t[k]);
  }
}

// "barÃ© dj" -> "baré dj": texto UTF-8 que foi lido como latin1.
function fixText(text) {
  if (!/[ÃÂ][\u0080-\u00bf]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    if (bytes.some((b, i) => text.charCodeAt(i) > 255)) return text;
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    libraryRepaired = true;
    return fixed;
  } catch { return text; }
}

async function fetchLibrary(knownMd5) {
  if (store.loadLibraryFast) return store.loadLibraryFast(knownMd5);
  return { library: await store.loadLibrary(), md5: null };
}

function saveLibraryCache(md5) {
  if (DEMO) return;
  offline.saveLibrary(library, LIBRARY_CACHE_KEY);
  try { md5 ? localStorage.setItem(MD5_KEY, md5) : localStorage.removeItem(MD5_KEY); } catch {}
}

async function syncLibrary() {
  let known = null;
  try { known = localStorage.getItem(MD5_KEY); } catch {}
  try {
    const r = await fetchLibrary(known);
    libraryRepaired = false;
    if (!r.unchanged) {
      library = r.library;
      normalizeLibrary();
      saveLibraryCache(r.md5);
      refresh();
    } else normalizeLibrary();
    if (libraryRepaired && !READONLY && !DEMO) persist(); // grava os acentos corrigidos no Drive
    if (!READONLY) backfillCovers();
  } catch (e) {
    console.error(e);
    offlineMode = true;
    paintMode();
    if (drive.NATIVE && navigator.onLine && !READONLY) askDrive();
  }
}

// O app abriu com a biblioteca guardada e o acesso ao Drive voltou: atualiza tudo.
function reconnect() {
  if (!offlineMode) return Promise.resolve();
  reconnect.job ||= doReconnect().finally(() => { reconnect.job = null; });
  return reconnect.job;
}

async function doReconnect() {
  try {
    const r = await fetchLibrary(null);
    library = r.library;
    normalizeLibrary();
    offlineMode = false;
    saveLibraryCache(r.md5);
    paintMode();
    await loadUser();
    if (!READONLY) backfillCovers();
    refresh();
    loadCommunity();
  } catch (e) {
    console.error(e);
  }
}

// Pede o acesso de novo. silent = só renova sem abrir janela (app instalado, com login salvo).
let reconnectFailed = false;
async function askDrive(silent = false) {
  if (askDrive.busy) return; // um pedido por vez: outro descartaria a resposta da janela de login
  askDrive.busy = true;
  try {
    await drive.signIn(silent ? 'none' : '');
    reconnectFailed = false;
    await reconnect();
  } catch (e) {
    if (silent) return;
    reconnectFailed = true;
    if (e.message !== 'network') toast(`Não foi possível conectar ao Drive: ${e.message}`, 6000);
  } finally {
    askDrive.busy = false;
  }
  paintMode();
}

// Selo do topo. Só aparece no modo demo/ouvinte, sem internet ou se a reconexão falhou.
function paintMode() {
  const badge = $('#mode-badge');
  const retry = offlineMode && navigator.onLine && reconnectFailed;
  document.documentElement.classList.toggle('readonly', READONLY || offlineMode);
  badge.classList.toggle('hidden', !DEMO && !READONLY && !retry && !(offlineMode && !navigator.onLine));
  badge.classList.toggle('badge-action', retry);
  badge.textContent = offlineMode ? (navigator.onLine ? 'Reconectar ao Drive' : 'sem internet') : READONLY ? 'modo ouvinte' : 'modo demo';
  badge.onclick = retry ? () => askDrive() : null;
}

function paintUser() {
  if (!user) return;
  $('#user-chip').innerHTML = `${user.photoLink ? `<img src="${esc(user.photoLink)}" alt="" referrerpolicy="no-referrer" />` : ''}<span>${esc(user.displayName || user.emailAddress)}</span>`;
  $('#user-chip').title = READONLY ? `Ouvindo como ${user.emailAddress}` : `Músicas salvas no Google Drive de ${user.emailAddress}`;
}

// A conta fica guardada para o nome e a foto aparecerem mesmo sem acesso ao Drive.
const USER_KEY = `rytmo.user${LISTEN_ID ? `.${LISTEN_ID}` : ''}`;
async function loadUser() {
  try { user = await store.getUser?.(); } catch {}
  if (user && !DEMO) try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
  if (!user) try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch {}
  paintUser();
}

async function startApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  paintMode();
  $('#view').innerHTML = `<p class="empty">Carregando ${READONLY ? 'a biblioteca' : 'sua biblioteca do Google Drive'}…</p>`;

  await offline.init();
  const cached = DEMO ? null : await offline.loadLibrary(LIBRARY_CACHE_KEY);
  let needSync = false;
  if (offlineMode) {
    if (cached) library = cached;
    if (!navigator.onLine) toast('Sem internet: tocando só as músicas baixadas no aparelho', 5000);
  } else if (cached) {
    // Abre na hora com a cópia do aparelho e confere o Drive logo depois, em segundo plano.
    library = cached;
    needSync = true;
  } else {
    try {
      const r = await fetchLibrary(null);
      library = r.library;
      saveLibraryCache(r.md5);
    } catch (e) {
      toast(LISTEN_ID ? e.message : 'Erro ao carregar a biblioteca do Drive');
      console.error(e);
    }
  }
  normalizeLibrary();

  // Quem entrou: as músicas vão para o Google Drive desta conta.
  // A conta guardada aparece na hora; a do Drive atualiza em seguida.
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch {}
  paintUser();
  if (!offlineMode) loadUser();
  if (!DEMO) drive.onTokenRenewed(reconnect);

  if (!READONLY) initImporter({ store, demo: DEMO, getLibrary: () => library, persist, onChange: refresh });
  bindChrome();
  refresh();
  loadCommunity();
  restorePlayback();
  librarySync = needSync ? syncLibrary() : Promise.resolve();
  // Seu rytmo: cada aparelho conta o que toca; o dono junta tudo no stats.json do Drive.
  stats.initStats({
    key: `rytmo.stats${LISTEN_ID ? `.${LISTEN_ID}` : DEMO ? '.demo' : ''}`,
    store: !DEMO && !READONLY && !offlineMode && store.loadStats ? { load: () => store.loadStats(), save: (d) => store.saveStats(d) } : null,
  });
  if (!offlineMode && !READONLY && !needSync) backfillCovers();
  // App instalado sem acesso ao Drive (login vencido ou sem a permissão): já pede sozinho.
  if (offlineMode && drive.NATIVE && navigator.onLine && !READONLY) askDrive();
}

// Lista de ouvintes e playlists públicas (se o servidor estiver configurado).
async function loadCommunity() {
  if (!community.enabled() || DEMO || offlineMode) return;
  try {
    if (READONLY) {
      let optIn = false;
      try { optIn = localStorage.getItem('rytmo.optin') === '1'; } catch {}
      await community.hello(user?.displayName || '', optIn); // registra o acesso deste ouvinte
    }
    if (!READONLY) claimCommunity(); // primeira vez no servidor novo: o dono se registra e os dados antigos vêm junto
    const pls = await community.listPlaylists();
    communityPlaylists = pls.map((p) => ({ ...p, community: true }));
    communityOn = true;
    $$('.owner-only').forEach((el) => el.classList.toggle('hidden', READONLY));
    route();
    renderNowPanel();
  } catch (e) {
    console.error('Comunidade indisponível', e);
  }
}

// Servidor da comunidade no VPS: na primeira vez que o dono abre o app, ele confirma quem é
// com o servidor antigo (Google Apps Script) e copia ouvintes, playlists, Mural e placar.
async function claimCommunity() {
  try {
    const st = await community.status();
    if (st.hasOwner) return;
    const res = await community.claim();
    if (res?.report) {
      const r = res.report;
      toast(`Comunidade no seu servidor: ${r.listeners} ouvintes, ${r.playlists} playlists e ${r.posts} recados copiados`);
      communityPlaylists = (await community.listPlaylists()).map((p) => ({ ...p, community: true }));
      muralPosts = null;
      route();
    }
  } catch (e) { console.warn('comunidade (dono)', e.message); }
}

// Álbuns criados antes de as capas irem para o Drive: envia a capa para a pasta deles.
async function backfillCovers() {
  const missing = library.albums.filter((a) => a.cover && a.folderId && !a.coverFileId);
  if (!missing.length) return;
  for (const album of missing) await storeCover(album, album.cover);
  persist();
}

// Salva o library.json em fila (evita gravações simultâneas).
let saving = Promise.resolve();
function persist() {
  // Com a biblioteca guardada (talvez antiga), gravar no Drive apagaria mudanças de outros aparelhos.
  if (offlineMode) return Promise.resolve();
  saving = saving.then(() => librarySync).then(async () => {
    if (offlineMode) return;
    const md5 = await store.saveLibrary(library);
    saveLibraryCache(typeof md5 === 'string' ? md5 : null);
  }).catch((e) => {
    console.error(e);
    toast('Erro ao salvar a biblioteca no Drive');
  });
  return saving;
}

function refresh() {
  renderLibraryList();
  route();
  window.webkit?.messageHandlers?.rytmo?.postMessage({ type: 'libraryChanged' }); // CarPlay atualiza as listas
}

// ---------- CarPlay ----------
// O app de iPhone mostra no carro as listas que pede aqui e manda tocar por aqui.
// O áudio continua saindo deste player (o carro mostra a capa e os botões do iOS).
window.rytmoCarPlay = {
  snapshot() {
    if ($('#app').classList.contains('hidden')) return { ready: false };
    const albumInfo = (a) => ({ id: a.id, title: a.title, subtitle: [a.artist, a.year].filter(Boolean).join(' • '), cover: a.cover || '' });
    return {
      ready: true,
      albums: [...library.albums].sort(byArtist).map(albumInfo),
      playlists: allPlaylists().map((p) => ({ id: p.id, title: p.name, subtitle: `${playlistItems(p).length} músicas`, cover: playlistCover(p)?.cover || p.cover || '' })),
      offline: library.albums.filter((a) => a.tracks.some((t) => offline.has(t.id))).map(albumInfo),
    };
  },
  play(kind, id) {
    let items = [];
    if (kind === 'album') {
      const album = albumById(id);
      items = album ? album.tracks.map((track) => ({ track, album })) : [];
    } else if (kind === 'playlist') items = playlistById(id) ? playlistItems(playlistById(id)) : [];
    if (items.length) playQueue(items, 0);
    return items.length > 0;
  },
};

// ---------- Rotas ----------

window.addEventListener('hashchange', route);

// Páginas anteriores ficam guardadas (do jeito que estavam, na mesma rolagem): voltar,
// pelo botão ou arrastando o dedo, mostra a mesma página na hora, sem recarregar as capas.
const pageStack = [];
const TOP_PAGES = new Set(['', 'library', 'playlists', 'artists', 'offline', 'search', 'rytmo']);

function route() {
  if ($('#app').classList.contains('hidden')) return;
  const [, page = '', param = ''] = location.hash.split('/');
  const id = decodeURIComponent(param);
  if (page === 'ouvintes') return location.replace('#/rytmo/visitantes');
  if (page === 'mural') return location.replace('#/rytmo/mural');
  const main = $('#main');
  const view = $('#view');
  const prev = route.last;
  const changed = location.hash !== prev;
  if (changed) editMode = false; // sai do modo edição ao mudar de página
  route.last = location.hash;
  endSwipe();

  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'home')));
  $$('#library-list a').forEach((a) => a.classList.toggle('active', page === 'album' && a.dataset.id === id));

  if (changed && prev !== undefined) {
    const top = pageStack[pageStack.length - 1];
    if (top && top.hash === location.hash) {
      // voltando: a página volta inteira, no mesmo ponto da rolagem
      pageStack.pop();
      view.replaceChildren(...top.el.childNodes);
      main.scrollTop = top.scroll;
      markPlaying();
      return;
    }
    const leftAt = main.scrollTop; // antes de tirar a página (sem ela a rolagem vira 0)
    const keep = document.createElement('div');
    keep.append(...view.childNodes);
    pageStack.push({ hash: prev, el: keep, scroll: leftAt });
    if (pageStack.length > 8) pageStack.shift();
  }
  const scroll = main.scrollTop;

  if (page === 'album') renderAlbum(id);
  else if (page === 'library') renderLibrary();
  else if (page === 'playlists') renderPlaylists();
  else if (page === 'playlist') renderPlaylist(id);
  else if (page === 'artists') renderArtists();
  else if (page === 'artist') renderArtist(id);
  else if (page === 'search') renderSearch();
  else if (page === 'offline') renderOffline();
  else if (page === 'rytmo') renderRytmoSite(id);
  else renderHome();

  // página nova começa do topo; a mesma página redesenhada (ex.: biblioteca sincronizou) fica onde estava
  main.scrollTop = changed ? 0 : scroll;
  markPlaying();
}

// ---------- Helpers de dados ----------

const albumById = (id) => library.albums.find((a) => a.id === id);
const albumDuration = (a) => a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24"><path d="M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4 3.6 3.6zM5 18h14v2H5z"/></svg>';
const DOWNLOADED_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 5v6.2l-2.6-2.6L7 12l5 5 5-5-1.4-1.4-2.6 2.6V7z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm14.7-8.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.6 1.6 2.8 2.8z"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>';
const kindLabel = (a) => (a.kind === 'single' ? 'Single' : 'Álbum');
const firstName = () => (user?.displayName || '').split(' ')[0];

function artistCover(name, albums) {
  const custom = library.artists[name]?.cover;
  return custom ? { cover: custom } : albums.find((a) => a.cover) || albums[0];
}

function artistsMap() {
  const map = new Map();
  for (const a of library.albums) {
    const name = a.artist || 'Artista desconhecido';
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(a);
  }
  return map;
}

// ---------- Sidebar ----------

function renderLibraryList() {
  pageStack.length = 0; // a biblioteca mudou: as páginas guardadas seriam antigas
  const ul = $('#library-list');
  if (!library.albums.length) {
    ul.innerHTML = '<li class="library-empty">Sua biblioteca está vazia.<br/>Arraste uma pasta de músicas aqui.</li>';
    return;
  }
  const sorted = [...library.albums].sort(byArtist);
  ul.innerHTML = sorted
    .map((a) => `
      <li><a href="#/album/${encodeURIComponent(a.id)}" data-id="${esc(a.id)}">
        ${coverHTML(a, 'cover-sm')}
        <div class="lib-text"><div class="lib-title">${esc(a.title)}</div>
        <div class="lib-sub">${kindLabel(a)} • ${esc(a.artist || 'Artista desconhecido')}</div></div>
      </a></li>`)
    .join('');
}

// ---------- Telas ----------

function albumCard(a) {
  return `
    <div class="card" data-open="#/album/${encodeURIComponent(a.id)}">
      <div class="card-cover-wrap">${coverHTML(a)}
        <button class="card-play" data-play-album="${esc(a.id)}" title="Tocar">${PLAY_SVG}</button>
      </div>
      <div class="card-title">${esc(a.title)}</div>
      <div class="card-sub">${esc([a.kind === 'single' ? 'Single' : a.year, a.artist || 'Artista desconhecido'].filter(Boolean).join(' • '))}</div>
    </div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function dropHero(compact = false) {
  if (READONLY) return '<p class="empty">Ainda não há músicas nesta biblioteca.</p>';
  return `
    <div class="hero-drop" ${compact ? 'style="padding:32px 24px"' : ''}>
      <svg viewBox="0 0 24 24"><path d="M12 3 7 8h3v6h4V8h3zM5 18h14v2H5z"/></svg>
      <h2>${IS_IOS ? 'Cadastre suas músicas' : 'Arraste suas pastas de músicas para cá'}</h2>
      <div>${IS_IOS ? 'Escolha arquivos de áudio no app Arquivos.' : 'Cada pasta vira um álbum; músicas soltas viram faixas solo.'}
        Tudo vai para o Google Drive${user ? ` de <b>${esc(user.emailAddress)}</b>` : ''}.</div>
      <div class="actions">
        <button class="btn btn-primary" data-pick="album">Cadastrar álbum</button>
        <button class="btn btn-ghost" data-pick="single">Cadastrar faixa solo</button>
      </div>
    </div>`;
}

function renderHome() {
  const view = $('#view');
  if (!library.albums.length) {
    view.innerHTML = `<h1>${greeting()}${firstName() ? `, ${esc(firstName())}` : ''} 👋</h1>
      ${homeBrand()}
      ${shouldSuggest() ? installCardHTML() : ''}
      ${READONLY ? listenerNote() : '<p class="empty" style="padding-top:0">Bem-vindo ao rytmo. Comece cadastrando seus álbuns e faixas.</p>'}${dropHero()}`;
    return;
  }
  const recent = [...library.albums].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const artists = [...artistsMap().entries()].slice(0, 12);
  view.innerHTML = `
    <h1>${greeting()}${firstName() ? `, ${esc(firstName())}` : ''}</h1>
    ${homeBrand()}
    ${shouldSuggest() ? installCardHTML() : ''}
    ${READONLY ? listenerNote() : ''}
    ${muralCardHTML()}
    <h2>Adicionados recentemente</h2>
    <div class="grid">${recent.slice(0, 12).map(albumCard).join('')}</div>
    ${recentAlbums().length ? `<h2>Tocadas recentemente</h2><div class="grid">${recentAlbums().slice(0, 6).map(albumCard).join('')}</div>` : ''}
    ${allPlaylists().length ? `<h2>Playlists</h2><div class="grid">${allPlaylists().slice(0, 6).map(playlistCard).join('')}</div>` : ''}
    <h2>${READONLY ? 'Artistas' : 'Seus artistas'}</h2>
    <div class="grid">${artists.map(([name, albums]) => artistCard(name, albums)).join('')}</div>
    ${READONLY ? '' : `<h2>Adicionar mais</h2>${dropHero(true)}`}`;
}

// Logo e nome em destaque no início (só aparece no celular; no Mac a marca já está na lateral).
function homeBrand() {
  return `<div class="home-brand"><svg class="mark" viewBox="0 0 64 48" aria-hidden="true"><use href="#mark" /></svg>
    <span class="wordmark">rytmo<b>.</b></span></div>`;
}

function listenerNote() {
  return `<p class="listen-note">🎧 Você está ouvindo a biblioteca${library.ownerName ? ` de <b>${esc(library.ownerName)}</b>` : ''}. Modo ouvinte: só para ouvir.</p>`;
}

function artistCard(name, albums) {
  return `
    <div class="card round" data-open="#/artist/${encodeURIComponent(name)}">
      ${coverHTML(artistCover(name, albums))}
      <div class="card-title">${esc(name)}</div>
      <div class="card-sub">Artista • ${albums.length} álbu${albums.length > 1 ? 'ns' : 'm'}</div>
    </div>`;
}

// Álbuns em ordem alfabética de artista; do mesmo artista, por ano e depois pelo nome.
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
function byArtist(a, b) {
  return collator.compare(a.artist || '\uffff', b.artist || '\uffff')
    || (Number(a.year) || 0) - (Number(b.year) || 0)
    || collator.compare(a.title || '', b.title || '');
}

function renderLibrary() {
  const albums = [...library.albums].sort(byArtist);
  $('#view').innerHTML = `
    <div class="page-head"><h1>Sua biblioteca</h1>
      <div class="row-actions">
        ${canInstall() ? `<button class="btn btn-ghost" data-install>${PLUS_SVG} Instalar app</button>` : ''}
        <a class="btn btn-ghost" href="#/offline">${DOWNLOAD_SVG} Baixadas${offline.count() ? ` (${offline.count()})` : ''}</a>
        ${READONLY ? '' : `<button class="btn btn-ghost edit-only" id="lib-add">${PLUS_SVG} Adicionar</button>`}
      </div></div>
    ${albums.length ? `<div class="grid">${albums.map(albumCard).join('')}</div>` : dropHero()}
    ${albums.length ? `<h2>Artistas</h2><div class="grid">${[...artistsMap().entries()].map(([n, a]) => artistCard(n, a)).join('')}</div>` : ''}`;
  $('#lib-add')?.addEventListener('click', () => pickAndImport(PICK));
}

function renderArtists() {
  const entries = [...artistsMap().entries()].sort((a, b) => a[0].localeCompare(b[0]));
  $('#view').innerHTML = `
    <h1>Artistas</h1>
    ${entries.length ? `<div class="grid">${entries.map(([n, a]) => artistCard(n, a)).join('')}</div>` : '<p class="empty">Nenhum artista ainda.</p>'}`;
}

// Barra de ações: fora do modo edição só aparece "Editar"; dentro, as funções + "Concluir".
function editActions(buttons, allowed = !READONLY) {
  if (!allowed) return '';
  return editMode
    ? `${buttons}<button class="btn btn-primary" id="edit-toggle">Concluir</button>`
    : `<button class="btn btn-ghost" id="edit-toggle">${PENCIL_SVG} Editar</button>`;
}

function bindEditToggle() {
  if (!$('#edit-toggle')) return;
  $('#edit-toggle').onclick = async () => {
    // Editar grava no Drive: com a biblioteca guardada, primeiro reconecta.
    if (offlineMode) {
      if (!navigator.onLine) return toast('Sem internet: conecte-se para editar');
      await askDrive();
      if (offlineMode) return;
    }
    await librarySync; // edita sobre a biblioteca mais nova
    editMode = !editMode;
    route();
  };
}

// Capa grande: só vira botão de "trocar capa" no modo edição.
function heroCover(obj, id, round = false) {
  if (!editMode) return round ? `<div class="hero-round">${coverHTML(obj)}</div>` : coverHTML(obj);
  return `<div class="cover-pick hero-pick ${round ? 'round' : ''}" id="${id}" title="Trocar capa">${coverHTML(obj)}<div class="cover-hint">Trocar<br/>capa</div></div>`;
}

function renderArtist(name) {
  const albums = artistsMap().get(name) || [];
  const items = albums.flatMap((album) => album.tracks.map((track) => ({ track, album })));
  $('#view').innerHTML = `
    <div class="album-hero">
      ${heroCover(artistCover(name, albums), 'artist-cover', true)}
      <div><div class="kind">Artista</div><h1>${esc(name)}</h1>
      <div class="meta">${albums.length} lançamento${albums.length > 1 ? 's' : ''} • ${items.length} músicas</div></div>
    </div>
    <div class="album-actions">
      <button class="big-play" id="play-all" title="Tocar tudo">${PLAY_SVG}</button>
      <button class="btn btn-ghost" id="radio-btn">${RADIO_SVG} Rádio</button>
      ${editActions(`<button class="btn btn-ghost" id="artist-cover-btn">Trocar capa</button>
        ${library.artists[name]?.cover ? '<button class="btn btn-ghost" id="artist-cover-remove">Remover capa</button>' : ''}`)}
    </div>
    <h2>Álbuns e singles</h2>
    <div class="grid">${albums.map(albumCard).join('')}</div>
    <h2>Todas as músicas</h2>
    ${tracksTable(items, true)}`;
  $('#play-all').onclick = () => items.length && playQueue(items, 0);
  $('#radio-btn').onclick = () => albums[0] && startRadio({ artist: name, year: albums[0].year, title: name });
  bindEditToggle();
  if (editMode) {
    $('#artist-cover').onclick = $('#artist-cover-btn').onclick = () => changeArtistCover(name);
    if ($('#artist-cover-remove')) {
      $('#artist-cover-remove').onclick = async () => {
        delete library.artists[name].cover;
        route();
        await persist();
        toast('Capa do artista removida');
      };
    }
  }
  bindTrackRows(items);
}

async function changeArtistCover(name) {
  const file = await pickFile('image/*');
  if (!file) return;
  library.artists[name] = { ...library.artists[name], cover: await resizeImage(file) };
  route();
  await persist();
  toast('Capa do artista atualizada');
}

function renderAlbum(id) {
  const album = albumById(id);
  if (!album) {
    $('#view').innerHTML = '<p class="empty">Álbum não encontrado.</p>';
    return;
  }
  const items = album.tracks.map((track) => ({ track, album }));
  $('#view').innerHTML = `
    <div class="album-hero">
      ${heroCover(album, 'album-cover')}
      <div>
        <div class="kind">${kindLabel(album)}</div>
        <h1>${esc(album.title)}</h1>
        <div class="meta"><b><a href="#/artist/${encodeURIComponent(album.artist || 'Artista desconhecido')}">${esc(album.artist || 'Artista desconhecido')}</a></b>
          ${album.year ? ` • ${esc(album.year)}` : ''} • ${album.tracks.length} músicas, ${fmtTotal(albumDuration(album))}</div>
      </div>
    </div>
    <div class="album-actions">
      <button class="big-play" id="play-all" title="Tocar">${PLAY_SVG}</button>
      ${dlGroupButton(items)}
      <button class="btn btn-ghost" id="radio-btn">${RADIO_SVG} Rádio</button>
      ${editActions(`
        <button class="btn btn-ghost" id="edit-album">Editar informações</button>
        <button class="btn btn-ghost" id="add-to-album">Adicionar músicas</button>
        <button class="btn btn-danger" id="delete-album">Excluir ${album.kind === 'single' ? 'single' : 'álbum'}</button>`)}
    </div>
    ${editMode ? '<p class="remove-hint">Use o lápis para renomear uma música e a lixeira para removê-la (vai para a lixeira do Google Drive).</p>' : ''}
    ${tracksTable(items, false, editMode ? 'edit' : 'add')}`;

  $('#play-all').onclick = () => items.length && playQueue(items, 0);
  $('#radio-btn').onclick = () => startRadio(album);
  bindDlGroup(items, album.title);
  bindEditToggle();
  if (editMode) {
    $('#album-cover').onclick = $('#edit-album').onclick = () => editAlbum(album);
    $('#delete-album').onclick = () => deleteAlbum(album);
    $('#add-to-album').onclick = () => pickAndImport('files', { title: album.title, artist: album.artist, year: album.year, cover: album.cover, kind: album.kind });
  }
  bindTrackRows(items);
}

// ---------- Playlists ----------

const allPlaylists = () => [...library.playlists, ...communityPlaylists];
const playlistById = (id) => allPlaylists().find((p) => p.id === id);
const myEmail = () => (user?.emailAddress || '').toLowerCase();

// Playlists do dono: editáveis no app do dono. Playlists da comunidade: só quem criou
// edita; o dono pode excluir (moderação).
function canEditPlaylist(pl) {
  return pl.community ? communityOn && pl.ownerEmail?.toLowerCase() === myEmail() : !READONLY;
}
const canDeletePlaylist = (pl) => canEditPlaylist(pl) || (pl.community && !READONLY && communityOn);
// Pode criar playlists: o dono sempre; o ouvinte quando a comunidade está ligada.
const canCreatePlaylist = () => !offlineMode && (!READONLY || communityOn);

// Salva uma playlist onde ela mora (library.json do dono ou servidor da comunidade).
async function savePlaylist(pl) {
  if (!pl.community) return persist();
  try {
    const saved = await community.savePlaylist({ id: pl.id, name: pl.name, tracks: pl.tracks }, user?.displayName || '');
    Object.assign(pl, saved, { community: true });
  } catch (e) {
    console.error(e);
    toast(`Não foi possível salvar a playlist: ${e.message}`);
  }
}

function playlistItems(pl) {
  return pl.tracks.flatMap((ref) => {
    const album = albumById(ref.albumId);
    const track = album?.tracks.find((t) => t.id === ref.trackId);
    return track ? [{ track, album }] : [];
  });
}

// Capa própria da playlist ou, se não houver, a capa da primeira música.
function playlistCover(pl) {
  if (pl.cover) return { cover: pl.cover };
  return playlistItems(pl).find((i) => i.album.cover)?.album || null;
}

function playlistCard(pl) {
  const n = playlistItems(pl).length;
  return `
    <div class="card" data-open="#/playlist/${encodeURIComponent(pl.id)}">
      <div class="card-cover-wrap">${coverHTML(playlistCover(pl))}
        <button class="card-play" data-play-playlist="${esc(pl.id)}" title="Tocar">${PLAY_SVG}</button>
      </div>
      <div class="card-title">${esc(pl.name)}</div>
      <div class="card-sub">${pl.community ? `Pública • por ${esc(pl.ownerName || 'ouvinte')}` : `Playlist • ${n} música${n === 1 ? '' : 's'}`}</div>
    </div>`;
}

const ownPlaylists = () => library.playlists;

function renderPlaylists() {
  $('#view').innerHTML = `
    <div class="page-head"><h1>Playlists</h1>${canCreatePlaylist() ? `<button class="btn btn-primary" id="new-playlist">${PLUS_SVG} Criar playlist</button>` : ''}</div>
    ${READONLY && library.playlists.length ? `<h2>Playlists${library.ownerName ? ` de ${esc(library.ownerName)}` : ''}</h2>` : ''}
    ${ownPlaylists().length
      ? `<div class="grid">${ownPlaylists().map(playlistCard).join('')}</div>`
      : READONLY ? '' : '<p class="empty">Você ainda não tem playlists. Crie uma e adicione músicas pelo botão + ao lado de cada faixa.</p>'}
    ${communityPlaylists.length ? `<h2>Playlists públicas dos ouvintes</h2><div class="grid">${communityPlaylists.map(playlistCard).join('')}</div>` : ''}
    ${READONLY && communityOn && !communityPlaylists.length ? '<p class="empty">Crie a primeira playlist pública: toque em Criar playlist e use o + ao lado das músicas.</p>' : ''}`;
  if (!canCreatePlaylist()) return;
  $('#new-playlist').onclick = async () => {
    const pl = await createPlaylist();
    if (pl) location.hash = `#/playlist/${encodeURIComponent(pl.id)}`;
  };
}

function renderPlaylist(id) {
  const pl = playlistById(id);
  if (!pl) {
    $('#view').innerHTML = '<p class="empty">Playlist não encontrada.</p>';
    return;
  }
  const items = playlistItems(pl);
  const total = items.reduce((s, i) => s + (i.track.duration || 0), 0);
  $('#view').innerHTML = `
    <div class="album-hero">
      ${heroCover(playlistCover(pl), 'pl-cover')}
      <div><div class="kind">${pl.community ? 'Playlist pública' : 'Playlist'}</div><h1>${esc(pl.name)}</h1>
      <div class="meta">${pl.community ? `por <b>${esc(pl.ownerName || 'ouvinte')}</b> • ` : ''}${items.length} músicas, ${fmtTotal(total)}</div></div>
    </div>
    <div class="album-actions">
      <button class="big-play" id="play-all" title="Tocar">${PLAY_SVG}</button>
      ${dlGroupButton(items)}
      ${editActions(`
        ${!pl.community ? `<button class="btn btn-ghost" id="pl-cover-btn">${pl.cover ? 'Trocar capa' : 'Adicionar capa'}</button>` : ''}
        ${!pl.community && pl.cover ? '<button class="btn btn-ghost" id="pl-cover-remove">Remover capa</button>' : ''}
        ${canEditPlaylist(pl) ? '<button class="btn btn-ghost" id="pl-rename">Renomear</button>' : ''}
        <button class="btn btn-danger" id="pl-delete">Excluir playlist</button>`, canDeletePlaylist(pl))}
    </div>
    ${editMode && items.length && canEditPlaylist(pl) ? '<p class="remove-hint">Use o ✕ para tirar uma música da playlist (ela continua na biblioteca).</p>' : ''}
    ${items.length ? tracksTable(items, true, editMode && canEditPlaylist(pl) ? 'playlist' : 'add') : '<p class="empty">Playlist vazia. Use o botão + ao lado de qualquer música para adicioná-la aqui.</p>'}`;
  $('#play-all').onclick = () => items.length && playQueue(items, 0);
  bindDlGroup(items, pl.name);
  bindEditToggle();
  if (!editMode) return bindTrackRows(items, pl);
  $('#pl-delete').onclick = async () => {
    if (!confirm(`Excluir a playlist "${pl.name}"? As músicas continuam na biblioteca.`)) return;
    if (pl.community) {
      try { await community.deletePlaylist(pl.id); } catch (e) { return toast(e.message); }
      communityPlaylists = communityPlaylists.filter((p) => p !== pl);
    } else {
      library.playlists = library.playlists.filter((p) => p !== pl);
      await persist();
    }
    location.hash = '#/playlists';
    toast('Playlist excluída');
  };
  if ($('#pl-rename')) {
    $('#pl-rename').onclick = async () => {
      const name = await askName('Renomear playlist', pl.name);
      if (!name) return;
      pl.name = name;
      route();
      await savePlaylist(pl);
    };
  }
  bindTrackRows(items, pl);
  if (pl.community) return;
  $('#pl-cover').onclick = $('#pl-cover-btn').onclick = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    pl.cover = await resizeImage(file);
    route();
    await persist();
    toast('Capa da playlist atualizada');
  };
  if (pl.cover) {
    $('#pl-cover-remove').onclick = async () => {
      delete pl.cover;
      route();
      await persist();
      toast('Capa removida');
    };
  }
}

function askName(title, value = '') {
  return new Promise((resolve) => {
    const card = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><div class="field"><label>Nome</label><input id="name-input" value="${esc(value)}" placeholder="Minha playlist" /></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="name-ok">Salvar</button></div>`);
    const input = $('#name-input', card);
    const ok = () => { const v = input.value.trim(); closeModal(); resolve(v || null); };
    $('#name-ok', card).onclick = ok;
    input.onkeydown = (e) => { if (e.key === 'Enter') ok(); }; // não retornar false: isso bloquearia a digitação
    $$('[data-close]', card).forEach((b) => b.addEventListener('click', () => resolve(null)));
    setTimeout(() => input.focus(), 50);
  });
}

async function createPlaylist() {
  const name = await askName('Criar playlist');
  if (!name) return null;
  let pl;
  if (READONLY) {
    // ouvinte: playlist pública no servidor da comunidade
    try {
      pl = { ...(await community.savePlaylist({ name, tracks: [] }, user?.displayName || '')), community: true };
    } catch (e) {
      toast(`Não foi possível criar: ${e.message}`);
      return null;
    }
    communityPlaylists.push(pl);
  } else {
    pl = { id: crypto.randomUUID(), name, tracks: [], createdAt: Date.now() };
    library.playlists.push(pl);
    persist();
  }
  renderLibraryList();
  toast(`Playlist "${name}" criada`);
  return pl;
}

function addToPlaylist({ track, album }) {
  const card = openModal(`
    <div class="modal-head"><h2>Adicionar à playlist</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body">
      <p class="empty" style="padding:0 0 12px">${esc(track.title)} • ${esc(album.artist || '')}</p>
      <div class="pl-quick">
        <button class="btn btn-ghost" data-next>${QUEUE_NEXT_SVG} Tocar a seguir</button>
        <button class="btn btn-ghost" data-queue>${QUEUE_SVG} Adicionar à fila</button>
      </div>
      <div class="pl-pick">
        <button class="pl-option" data-new>${PLUS_SVG}<span>Nova playlist</span></button>
        ${allPlaylists().filter(canEditPlaylist).map((pl) => `
          <button class="pl-option" data-pl="${esc(pl.id)}">${coverHTML(playlistCover(pl), 'cover-sm')}<span>${esc(pl.name)}</span></button>`).join('')}
      </div>
    </div>`);
  const add = async (pl) => {
    if (pl.tracks.some((r) => r.trackId === track.id)) return toast(`Já está em "${pl.name}"`);
    pl.tracks.push({ albumId: album.id, trackId: track.id });
    toast(`Adicionada a "${pl.name}"`);
    if (location.hash.startsWith('#/playlist')) route();
    await savePlaylist(pl);
  };
  $('[data-next]', card).onclick = () => { closeModal(); playNext({ track, album }); };
  $('[data-queue]', card).onclick = () => { closeModal(); addToQueue({ track, album }); };
  $('[data-new]', card).onclick = async () => {
    closeModal();
    const pl = await createPlaylist();
    if (pl) add(pl);
  };
  $$('[data-pl]', card).forEach((b) => {
    b.onclick = () => { closeModal(); add(playlistById(b.dataset.pl)); };
  });
}

// ---------- Remover músicas ----------

async function renameTrack({ track }) {
  const name = await askName('Renomear música', track.title);
  if (!name) return;
  track.title = name;
  route();
  updateNowPlaying();
  await persist();
  toast('Música renomeada');
}

function forgetTrack(trackId) {
  for (const pl of library.playlists) pl.tracks = pl.tracks.filter((r) => r.trackId !== trackId);
}

async function removeTrack({ track, album }) {
  if (!confirm(`Remover "${track.title}"?\n\nO arquivo vai para a lixeira do seu Google Drive (dá para recuperar por 30 dias).`)) return;
  try { await store.trashFile(track.id); } catch (e) { console.error(e); }
  album.tracks = album.tracks.filter((t) => t !== track);
  forgetTrack(track.id);
  if (!album.tracks.length) {
    if (album.kind !== 'single' && album.folderId) store.trashFile(album.folderId).catch(() => {});
    if (album.kind === 'single' && album.coverFileId) store.trashFile(album.coverFileId).catch(() => {});
    library.albums = library.albums.filter((a) => a !== album);
    location.hash = '#/';
  }
  refresh();
  await persist();
  toast('Música removida');
}

function renderSearch() {
  const term = $('#search').value.trim().toLowerCase();
  const view = $('#view');
  if (!term) {
    view.innerHTML = '<h1>Buscar</h1><p class="empty">Digite o nome de uma música, álbum ou artista.</p>';
    $('#search').focus();
    return;
  }
  const match = (s) => (s || '').toLowerCase().includes(term);
  const albums = library.albums.filter((a) => match(a.title) || match(a.artist));
  const items = library.albums.flatMap((album) =>
    album.tracks.filter((t) => match(t.title) || match(album.artist)).map((track) => ({ track, album })));
  view.innerHTML = `
    <h1>Resultados para “${esc(term)}”</h1>
    ${items.length ? `<h2>Músicas</h2>${tracksTable(items.slice(0, 50), true)}` : ''}
    ${albums.length ? `<h2>Álbuns</h2><div class="grid">${albums.map(albumCard).join('')}</div>` : ''}
    ${!items.length && !albums.length ? '<p class="empty">Nada encontrado.</p>' : ''}`;
  bindTrackRows(items.slice(0, 50));
}

// action: 'add' (+ playlist), 'edit' (renomear e remover) ou 'playlist' (tirar da playlist)
function tracksTable(items, showAlbum, action = 'add') {
  // ouvinte: só "+" (para as próprias playlists públicas) e "✕" nas próprias playlists
  if (READONLY && !(communityOn && (action === 'add' || action === 'playlist'))) action = 'none';
  if (!items.length) return '<p class="empty">Nenhuma música.</p>';
  const btn = {
    add: `<button class="icon-btn t-btn" data-act="add" title="Adicionar à playlist">${PLUS_SVG}</button>`,
    edit: `<button class="icon-btn t-btn" data-act="rename" title="Renomear música">${PENCIL_SVG}</button><button class="icon-btn t-btn danger" data-act="remove" title="Remover música">${TRASH_SVG}</button>`,
    playlist: `<button class="icon-btn t-btn" data-act="unlist" title="Tirar da playlist">${X_SVG}</button>`,
  }[action] || '';
  const dl = (track) => (action === 'edit' ? '' : dlRowButton(track));
  return `
    <table class="tracks ${action === 'add' ? '' : 'editing'}">
      <thead><tr><th style="text-align:center">#</th><th>Título</th>${showAlbum ? '<th>Álbum</th>' : ''}<th style="text-align:right">Duração</th><th></th></tr></thead>
      <tbody>${items.map(({ track, album }, i) => `
        <tr class="row ${offline.has(track.id) ? 'dl-ok' : ''}" data-i="${i}" data-track="${esc(track.id)}">
          <td>${i + 1}</td>
          <td class="t-main"><div class="t-cell">${showAlbum ? coverHTML(album, 'cover-sm') : ''}
            <div><div class="t-title">${esc(track.title)}</div><div class="t-sub">${esc(track.artist || album.artist || '')}</div></div></div></td>
          ${showAlbum ? `<td class="t-alb">${esc(album.title)}</td>` : ''}
          <td class="t-dur">${track.duration ? fmtTime(track.duration) : '–:––'}</td>
          <td class="t-act">${dl(track)}${btn}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function bindTrackRows(items, playlist = null) {
  $$('.tracks tr.row').forEach((row) => {
    const item = items[Number(row.dataset.i)];
    row.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') return addToPlaylist(item);
      if (act === 'dl') return toggleDownload(item.track);
      if (act === 'remove') return removeTrack(item);
      if (act === 'rename') return renameTrack(item);
      if (act === 'unlist') {
        playlist.tracks = playlist.tracks.filter((r) => r.trackId !== item.track.id);
        route();
        return savePlaylist(playlist);
      }
      if (editMode) return; // no modo edição, tocar na linha não toca a música
      playQueue(items, Number(row.dataset.i));
    };
  });
}

// ---------- Editar / excluir álbum ----------

function editAlbum(album) {
  let cover = album.cover;
  let coverFile = null; // nova capa escolhida (vai substituir a do Drive)
  const card = openModal(`
    <div class="modal-head"><h2>Editar álbum</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body">
      <div class="group">
        <div class="cover-pick" id="ed-cover">${coverHTML(album)}<div class="cover-hint">Trocar capa</div></div>
        <div class="fields">
          <div class="field full"><label>Nome do álbum</label><input id="ed-title" value="${esc(album.title)}" /></div>
          <div class="field"><label>Artista</label><input id="ed-artist" value="${esc(album.artist || '')}" /></div>
          <div class="field"><label>Ano</label><input id="ed-year" value="${esc(album.year || '')}" /></div>
        </div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="ed-save">Salvar</button></div>`);

  $('#ed-cover', card).onclick = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    cover = await resizeImage(file);
    coverFile = file;
    $('#ed-cover .cover', card).outerHTML = coverHTML({ cover });
  };
  $('#ed-save', card).onclick = async () => {
    album.title = $('#ed-title', card).value.trim() || album.title;
    album.artist = $('#ed-artist', card).value.trim();
    album.year = $('#ed-year', card).value.trim();
    album.cover = cover;
    closeModal();
    refresh();
    updateNowPlaying();
    if (coverFile) await storeCover(album, coverFile); // substitui o cover.jpg da pasta
    await persist();
    toast('Álbum atualizado');
  };
}

async function deleteAlbum(album) {
  if (!confirm(`Excluir "${album.title}"?\n\nOs arquivos vão para a lixeira do seu Google Drive (dá para recuperar por 30 dias).`)) return;
  try {
    // Singles dividem a pasta "Artista - Singles": apaga só os arquivos deles.
    if (album.kind === 'single') {
      await Promise.all([...album.tracks.map((t) => t.id), album.coverFileId].filter(Boolean).map((id) => store.trashFile(id)));
    }
    else if (album.folderId) await store.trashFile(album.folderId);
  } catch (e) {
    console.error(e);
  }
  album.tracks.forEach((t) => forgetTrack(t.id));
  library.albums = library.albums.filter((a) => a !== album);
  location.hash = '#/';
  refresh();
  await persist();
  toast('Álbum excluído');
}

// ---------- Baixar no aparelho (modo offline) ----------

const downloading = new Map(); // trackId -> Promise do download em andamento
const groupProgress = new Map(); // id da página -> { done, total }

function dlRowButton(track) {
  const on = offline.has(track.id);
  const busy = downloading.has(track.id);
  return `<button class="icon-btn t-btn dl ${on ? 'on' : ''} ${busy ? 'busy' : ''}" data-act="dl" title="${on ? 'Baixada no aparelho (tocar para remover)' : 'Baixar no aparelho'}">${on ? DOWNLOADED_SVG : DOWNLOAD_SVG}</button>`;
}

function dlGroupButton(items) {
  if (!items.length) return '';
  const done = items.filter((i) => offline.has(i.track.id)).length;
  const prog = groupProgress.get(location.hash);
  let label;
  if (prog) label = `Baixando ${prog.done} de ${prog.total}…`;
  else if (done === items.length) label = 'Baixado';
  else label = done ? `Baixar (${done}/${items.length})` : 'Baixar';
  const on = !prog && done === items.length;
  return `<button class="btn btn-ghost dl-group ${on ? 'on' : ''}" id="dl-all" ${prog ? 'disabled' : ''}
    title="${on ? 'Remover do aparelho' : 'Baixar para ouvir sem internet'}">${on ? DOWNLOADED_SVG : DOWNLOAD_SVG} ${label}</button>`;
}

function bindDlGroup(items, name) {
  const btn = $('#dl-all');
  if (!btn) return;
  btn.onclick = async () => {
    const all = items.every((i) => offline.has(i.track.id));
    if (all) {
      if (!confirm(`Remover "${name}" do aparelho?\n\nAs músicas continuam no seu Google Drive; só deixam de tocar sem internet.`)) return;
      await offline.remove(items.map((i) => i.track.id));
      return toast(`"${name}" removido do aparelho`);
    }
    downloadGroup(items, name);
  };
}

function downloadTrack(track) {
  if (offline.has(track.id)) return Promise.resolve();
  if (!downloading.has(track.id)) {
    const job = (async () => {
      const src = (await store.getAudioUrl(track.id));
      const blob = await (await fetch(src)).blob();
      await offline.save(track.id, blob);
    })().finally(() => { downloading.delete(track.id); paintDownloads(); });
    downloading.set(track.id, job);
    paintDownloads();
  }
  return downloading.get(track.id);
}

async function downloadGroup(items, name) {
  if (offlineNow()) return toast('Sem internet: conecte-se para baixar');
  const page = location.hash;
  const todo = items.filter((i) => !offline.has(i.track.id));
  const prog = { done: 0, total: todo.length };
  groupProgress.set(page, prog);
  paintDownloads();
  let failed = 0;
  for (const { track } of todo) {
    try { await downloadTrack(track); } catch (e) { failed++; console.error(e); }
    prog.done++;
    paintDownloads();
  }
  groupProgress.delete(page);
  paintDownloads();
  toast(failed ? `${failed} música${failed > 1 ? 's' : ''} não baixou. Tente de novo.` : `"${name}" pronto para ouvir sem internet`);
}

async function toggleDownload(track) {
  if (offline.has(track.id)) {
    await offline.remove(track.id);
    return toast(`"${track.title}" removida do aparelho`);
  }
  if (offlineNow()) return toast('Sem internet: conecte-se para baixar');
  try {
    await downloadTrack(track);
    toast(`"${track.title}" baixada no aparelho`);
  } catch (e) {
    console.error(e);
    toast(`Não foi possível baixar "${track.title}"`);
  }
}

// Atualiza os ícones e o botão da página sem redesenhar tudo (não perde a rolagem).
function paintDownloads() {
  $$('.tracks tr.row').forEach((row) => {
    const id = row.dataset.track;
    row.classList.toggle('dl-ok', offline.has(id));
    const btn = $('.t-btn.dl', row);
    if (!btn) return;
    const track = { id };
    const html = dlRowButton(track);
    if (btn.outerHTML !== html) btn.outerHTML = html;
  });
  const group = $('#dl-all');
  if (group) {
    const items = currentPageItems();
    const tmp = document.createElement('div');
    tmp.innerHTML = dlGroupButton(items);
    const fresh = tmp.firstElementChild;
    if (fresh && fresh.outerHTML !== group.outerHTML) {
      group.replaceWith(fresh);
      bindDlGroup(items, currentPageName());
    }
  }
  if (location.hash.startsWith('#/offline') && !downloading.size) renderOffline();
}

// Músicas e nome da página atual (álbum ou playlist), para o botão "Baixar".
function currentPageItems() {
  const [, page, param = ''] = location.hash.split('/');
  const id = decodeURIComponent(param);
  if (page === 'album') {
    const album = albumById(id);
    return album ? album.tracks.map((track) => ({ track, album })) : [];
  }
  if (page === 'playlist') return playlistById(id) ? playlistItems(playlistById(id)) : [];
  return [];
}
function currentPageName() {
  const [, page, param = ''] = location.hash.split('/');
  const id = decodeURIComponent(param);
  return page === 'album' ? albumById(id)?.title : playlistById(id)?.name;
}

function renderOffline() {
  const items = library.albums.flatMap((album) =>
    album.tracks.filter((t) => offline.has(t.id)).map((track) => ({ track, album })));
  $('#view').innerHTML = `
    <div class="page-head"><h1>Baixadas no aparelho</h1>
      ${offline.count() ? '<button class="btn btn-danger" id="dl-clear">Remover tudo</button>' : ''}</div>
    <p class="empty" style="padding-top:0">${offline.count()
      ? `${items.length} música${items.length === 1 ? '' : 's'} • ${offline.fmtSize(offline.totalSize())} usados neste aparelho. Tocam sem internet.`
      : 'Nada baixado ainda. Use o botão de baixar nos álbuns, playlists ou ao lado de cada música para ouvir sem internet.'}</p>
    ${items.length ? tracksTable(items, true) : ''}`;
  bindTrackRows(items);
  if (!$('#dl-clear')) return;
  $('#dl-clear').onclick = async () => {
    if (!confirm('Remover todas as músicas baixadas deste aparelho?\n\nElas continuam no seu Google Drive.')) return;
    await offline.remove(offline.downloadedIds());
    toast('Músicas removidas do aparelho');
  };
}

// ---------- Player ----------

const audio = $('#audio');
let queue = [];
let qi = -1;
let shuffle = false;
let repeat = 'off'; // off | all | one
let loadToken = 0;

async function playQueue(items, index) {
  if (offlineNow()) {
    // Sem internet: a fila fica só com o que está baixado.
    const wanted = items[index];
    items = items.filter((i) => offline.has(i.track.id));
    if (!items.length) return toast('Sem internet: nenhuma dessas músicas está baixada no aparelho');
    index = Math.max(0, items.indexOf(wanted));
  }
  queue = items;
  qi = index;
  await loadCurrent();
}

// Se o acesso ao Drive vencer no meio da música (ou o service worker reiniciar), o pedaço
// seguinte falha: pega um endereço novo e continua do mesmo ponto.
let streamRetries = 0;
function bindStreamRecovery() {
  audio.addEventListener('error', async () => {
    const item = queue[qi];
    if (!item || !/__stream\//.test(audio.src) || streamRetries >= 2) return;
    streamRetries++;
    const at = audio.currentTime;
    const token = loadToken;
    nativeEnsureServer();
    await new Promise((r) => setTimeout(r, 700));
    try {
      const url = await (store.getStreamUrl || store.getAudioUrl)(item.track.id);
      if (token !== loadToken) return;
      audio.src = url;
      audio.currentTime = at;
      await audio.play();
    } catch (e) {
      console.error(e);
    }
  });
}

async function loadCurrent(startAt = 0, readyUrl = null) {
  const item = queue[qi];
  if (!item) return;
  const token = ++loadToken;
  prepared = null;
  resumeAt = 0;
  updateNowPlaying();
  markPlaying();
  $('#btn-play').classList.add('loading');
  try {
    // readyUrl: já preparada antes (troca sem nenhuma espera)
    const url = readyUrl || (await offline.url(item.track.id)) || (offlineNow() ? null : await (store.getStreamUrl || store.getAudioUrl)(item.track.id));
    if (token !== loadToken) return;
    if (!url) {
      toast(offlineNow() ? `Sem internet: "${item.track.title}" não está baixada no aparelho` : `Não foi possível tocar "${item.track.title}"`);
      return;
    }
    audio.src = url;
    streamRetries = 0;
    stats.trackStarted(item);
    if (pendingFadeIn) fadeIn(pendingFadeIn);
    pendingFadeIn = 0;
    if (startAt) {
      // Antes dos metadados o navegador guarda isto como ponto de partida; se não guardar, repete depois.
      audio.currentTime = startAt;
      audio.addEventListener('loadedmetadata', () => {
        if (token === loadToken && Math.abs(audio.currentTime - startAt) > 1) audio.currentTime = startAt;
      }, { once: true });
    }
    await audio.play();
    savePlayback(true);
    pushRecent(item.album.id);
  } catch (e) {
    if (token === loadToken && e?.name !== 'AbortError') {
      console.warn(e);
      // às vezes o primeiro play() falha e a música começa logo depois: só avisa se não começou
      setTimeout(async () => {
        if (token !== loadToken || (!audio.paused && audio.currentTime > 0)) return;
        try {
          nativeEnsureServer();
          const again = (await offline.url(item.track.id)) || (await (store.getAudioUrl || store.getStreamUrl)(item.track.id));
          if (token !== loadToken) return;
          audio.src = again;
          await audio.play();
        } catch (err) {
          if (token === loadToken && err?.name !== 'AbortError' && audio.paused) toast(`Não foi possível tocar "${item.track.title}"`);
        }
      }, 1500);
    }
  } finally {
    if (token === loadToken) $('#btn-play').classList.remove('loading');
  }
  // Pré-carrega a próxima faixa para a troca ser instantânea.
  const next = queue[nextIndex()];
  if (next && token === loadToken && !offline.has(next.track.id) && !offlineNow() && store.hasValidToken?.() !== false) {
    setTimeout(() => { if (token === loadToken) store.getAudioUrl(next.track.id).catch(() => {}); }, 4000); // depois que a atual começou
  }
}

function nextIndex() {
  if (!queue.length) return -1;
  if (shuffle) return Math.floor(Math.random() * queue.length);
  if (qi + 1 < queue.length) return qi + 1;
  return repeat === 'all' ? 0 : -1;
}

function next() {
  const ready = takePrepared();
  if (ready) {
    // troca na hora, sem esperar nada: com a tela bloqueada o iPhone não deixa o app
    // "acordar" para buscar a próxima se o som parar.
    if (ready.album) { playedAlbums.push(ready.album.id); queue = ready.album.tracks.map((track) => ({ track, album: ready.album })); qi = 0; }
    else qi = ready.qi;
    return loadCurrent(0, ready.url);
  }
  const ni = nextIndex();
  if (ni < 0) return playRandomAlbum(); // acabou: continua com outro álbum, sem parar
  qi = ni;
  loadCurrent();
}

// Prepara a próxima música antes do fim da atual (25 s; no app do iPhone/iPad, 90 s).
function nativeEnsureServer() {
  try { if (drive.NATIVE && IS_IOS) window.webkit.messageHandlers.rytmo.postMessage({ type: 'ensureServer' }); } catch {}
}
let prepared = null;
let preparing = false;
async function prepareNext() {
  const ahead = drive.NATIVE && IS_IOS ? 90 : 25;
  if (preparing || repeat === 'one' || !audio.duration || audio.duration - audio.currentTime > ahead) return;
  const key = `${loadToken}`;
  if (prepared?.key === key) return;
  preparing = true;
  try {
    let ni = nextIndex();
    let album = null;
    let item = queue[ni];
    if (ni < 0) { album = pickRandomAlbum(); item = album && { track: album.tracks[0], album }; }
    if (!item) return;
    // App do iPhone/iPad: baixa a próxima inteira direto do Google. Com a tela bloqueada (ou no
    // CarPlay) o servidor local pode estar fora do ar, e a troca de álbum parava a música.
    const fetchNext = drive.NATIVE && IS_IOS && store.getAudioUrl ? store.getAudioUrl : (store.getStreamUrl || store.getAudioUrl);
    let url = await offline.url(item.track.id);
    if (!url && !offlineNow()) url = await fetchNext(item.track.id).catch(() => (store.getStreamUrl || store.getAudioUrl)(item.track.id));
    if (url && key === `${loadToken}`) prepared = { key, qi: ni, album, url, trackId: item.track.id };
  } catch {} finally { preparing = false; }
}
function takePrepared() {
  const p = prepared;
  prepared = null;
  if (!p || p.key !== `${loadToken}`) return null;
  if (p.album) return nextIndex() < 0 ? p : null; // a fila ainda acaba aqui
  return queue[p.qi]?.track.id === p.trackId ? p : null; // a fila não mudou
}

// ---------- Rádio: tocar parecidas ----------
// Monta uma fila com o mesmo artista, a mesma época e o que você mais ouve, misturando para
// não repetir o mesmo artista em sequência.
function radioItems(seed, exclude = new Set()) {
  const artist = (seed.artist || '').toLowerCase();
  const year = Number(seed.year) || 0;
  const loved = stats.summary('all');
  const lovedArtists = new Set(loved.artists.map(([name]) => name.toLowerCase()));
  const lovedTracks = new Set(loved.tracks.map(([id]) => id));
  const scored = library.albums.flatMap((album) => album.tracks.map((track) => {
    const a = (track.artist || album.artist || '').toLowerCase();
    const y = Number(album.year) || 0;
    let score = Math.random() * 1.5;
    if (artist && a === artist) score += 3;
    if (year && y && Math.abs(y - year) <= 3) score += 1.5;
    else if (year && y && Math.floor(y / 10) === Math.floor(year / 10)) score += 0.8;
    if (lovedArtists.has(a)) score += 0.7;
    if (lovedTracks.has(track.id)) score += 0.7;
    return { item: { track, album }, score, artist: a };
  })).filter((x) => !exclude.has(x.item.track.id));
  scored.sort((a, b) => b.score - a.score);
  const pool = scored.slice(0, 60);
  // no máximo 2 do mesmo artista seguidas
  const out = [];
  while (pool.length && out.length < 50) {
    const lastTwo = out.slice(-2).map((x) => x.artist);
    const i = pool.findIndex((x) => !(lastTwo.length === 2 && lastTwo.every((a) => a === x.artist)));
    out.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out.map((x) => x.item);
}

// Começa a rádio. Se uma música já está tocando, ela continua e a rádio vem depois.
function startRadio(seed, current = null) {
  const items = radioItems(seed, new Set(current ? [current.track.id] : []));
  if (!items.length) return toast('Ainda não há músicas parecidas na sua biblioteca');
  toast(`Rádio ${seed.artist || seed.title}: ${items.length} músicas parecidas`);
  if (current && queue[qi] === current) {
    queue = [...queue.slice(0, qi + 1), ...items];
    savePlayback();
    return renderNowPanel();
  }
  playQueue(items, 0);
}

// Quando a fila acaba: outro álbum sorteado da biblioteca inteira, do começo.
// Sem "parecidas": qualquer álbum pode vir, evitando só os que tocaram por último.
const playedAlbums = [];
function pickRandomAlbum() {
  const current = queue[qi]?.album;
  const all = library.albums.filter((a) => a.tracks.length);
  const recent = new Set(playedAlbums.slice(-Math.floor(all.length / 2)));
  let pool = all.filter((a) => a !== current && !recent.has(a.id));
  if (!pool.length) pool = all.length > 1 ? all.filter((a) => a !== current) : all;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}
function playRandomAlbum(pick = pickRandomAlbum()) {
  return playRandomAlbumOnly(pick);
}

function playRandomAlbumOnly(pick = pickRandomAlbum()) {
  if (!pick) return;
  playedAlbums.push(pick.id);
  toast(`Tocando agora: ${pick.title}${pick.artist ? ` — ${pick.artist}` : ''}`);
  playQueue(pick.tracks.map((track) => ({ track, album: pick })), 0);
}

function prev() {
  if (audio.currentTime > 3 || qi <= 0) {
    audio.currentTime = 0;
    return;
  }
  qi -= 1;
  loadCurrent();
}

// ---------- Onde parou: continua a última música no segundo exato, em qualquer aparelho ----------
// Fica no localStorage (este aparelho) e no playback.json do Drive (os outros aparelhos).
// Vale o mais recente. O modo ouvinte e o demo guardam só neste aparelho.

const PLAYBACK_KEY = `rytmo.playback${LISTEN_ID ? `.${LISTEN_ID}` : DEMO ? '.demo' : ''}`;
let resumeAt = 0; // segundo onde continuar quando a pessoa tocar play (música restaurada, ainda não carregada)
let knownUpdatedAt = 0; // estado mais recente que este aparelho gravou ou aplicou
let lastLocalSave = 0;
let lastRemoteSave = 0;

const hasAudio = () => !!audio.src && !audio.src.startsWith('data:');
const currentPos = () => (hasAudio() ? audio.currentTime : resumeAt);

function savePlayback(remote = false) {
  if (!queue[qi]) return;
  const start = Math.max(0, qi - 250); // filas enormes: guarda só em volta da música atual
  const state = {
    queue: queue.slice(start, start + 500).map((i) => ({ albumId: i.album.id, trackId: i.track.id })),
    qi: qi - start,
    position: Math.round(currentPos() * 10) / 10,
    updatedAt: Date.now(),
  };
  knownUpdatedAt = state.updatedAt;
  lastLocalSave = state.updatedAt;
  try { localStorage.setItem(PLAYBACK_KEY, JSON.stringify(state)); } catch {}
  if (remote && store.savePlayback) {
    lastRemoteSave = state.updatedAt;
    store.savePlayback(state).catch(() => {});
  }
}

async function restorePlayback() {
  let local = null;
  let remote = null;
  try { local = JSON.parse(localStorage.getItem(PLAYBACK_KEY) || 'null'); } catch {}
  if (!offlineMode) try { remote = await store.loadPlayback?.(); } catch {}
  const newest = [local, remote].filter((s) => s?.queue).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (newest) applyPlayback(newest);
}

// Monta a fila salva (pulando o que não existe mais) e deixa a música pausada no segundo salvo.
function applyPlayback(state) {
  if (!audio.paused || state.updatedAt <= knownUpdatedAt) return;
  const items = state.queue.map((r) => {
    const album = library.albums.find((a) => a.id === r.albumId);
    const track = album?.tracks.find((t) => t.id === r.trackId);
    return track ? { track, album } : null;
  });
  const current = items[state.qi];
  if (!current) return;
  loadToken++;
  queue = items.filter(Boolean);
  qi = queue.indexOf(current);
  resumeAt = state.position || 0;
  knownUpdatedAt = state.updatedAt;
  if (hasAudio()) { audio.removeAttribute('src'); audio.load(); }
  updateNowPlaying();
  markPlaying();
  paintResumePosition();
}

function paintResumePosition() {
  const dur = queue[qi]?.track.duration || 0;
  $('#time-cur').textContent = fmtTime(resumeAt);
  $('#time-dur').textContent = fmtTime(dur);
  setRange($('#seek'), dur ? resumeAt / dur : 0);
  paintNpProgress();
}

function bindPlaybackSync() {
  audio.addEventListener('timeupdate', () => {
    if (!hasAudio() || audio.paused) return;
    const now = Date.now();
    if (now - lastLocalSave > 1000) savePlayback(now - lastRemoteSave > 15000);
  });
  audio.addEventListener('pause', () => { if (hasAudio()) savePlayback(true); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      if (hasAudio()) savePlayback(true);
      stats.flush();
      return;
    }
    if (offlineMode && navigator.onLine && drive.NATIVE) return askDrive(true);
    // Voltou para o app: se outro aparelho tocou depois, continua de onde ele parou.
    if (!audio.paused || !store.loadPlayback || offlineNow()) return;
    try {
      const remote = await store.loadPlayback();
      if (remote?.queue) applyPlayback(remote);
    } catch {}
  });
  window.addEventListener('pagehide', () => { if (hasAudio()) savePlayback(true); stats.flush(); });
}

// ---------- Transição entre músicas ----------
// Sem pausa: a próxima música já fica baixada (pré-carregamento) e entra na hora.
// Mixagem (Mac, computador e Android): nos últimos segundos a música atual continua num
// segundo player, abaixando, enquanto a próxima começa subindo. No iPhone/iPad o site não
// controla o volume, então lá vale só o "sem pausa".
const MIX_KEY = 'rytmo.crossfade';
const canMix = () => !IS_IOS;
let crossfade = 0;
try { crossfade = canMix() ? Number(localStorage.getItem(MIX_KEY)) || 0 : 0; } catch {}
let pendingFadeIn = 0;
let mixing = false;
let tail = null; // player que termina a música anterior durante a mixagem

function ramp(el, from, to, seconds, done) {
  const steps = Math.max(1, Math.round(seconds * 20));
  let i = 0;
  el.volume = from;
  const t = setInterval(() => {
    i++;
    el.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)));
    if (i >= steps) { clearInterval(t); done?.(); }
  }, 50);
  return t;
}

function fadeIn(seconds) {
  const target = audio.muted ? 0 : Number($('#volume').value);
  ramp(audio, 0, target, seconds);
}

function stopTail() {
  if (!tail) return;
  tail.pause();
  tail.removeAttribute('src');
  tail = null;
}

// Chamado a cada timeupdate: perto do fim, começa a mixagem.
function maybeCrossfade() {
  if (!crossfade || mixing || !canMix() || audio.paused || !audio.duration) return;
  if (repeat === 'one' || sleep?.endOfTrack) return;
  const left = audio.duration - audio.currentTime;
  if (left > crossfade || left < 0.5 || audio.duration < crossfade * 3) return;
  mixing = true;
  stopTail();
  tail = new Audio();
  tail.src = audio.src;
  tail.currentTime = audio.currentTime;
  tail.volume = audio.volume;
  tail.play().then(() => {
    const t = tail;
    ramp(t, t.volume, 0, left, () => { if (tail === t) stopTail(); });
    pendingFadeIn = Math.min(crossfade, left);
    next();
  }).catch(() => stopTail()).finally(() => { mixing = false; });
}

function openTransition() {
  const options = [[0, 'Sem pausa'], [3, 'Mixar 3 s'], [6, 'Mixar 6 s'], [10, 'Mixar 10 s']];
  const card = openModal(`
    <div class="modal-head"><h2>Transição entre músicas</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body timer-list">
      <p class="empty" style="padding:0 0 8px">${canMix()
        ? 'Sem pausa: uma música emenda na outra. Mixar: a próxima entra subindo enquanto a atual abaixa.'
        : 'No iPhone e no iPad as músicas emendam sem pausa. A mixagem (uma abaixando e outra subindo) funciona no app de Mac e no computador.'}</p>
      <div class="timer-grid">
        ${options.map(([v, label]) => `<button class="btn ${crossfade === v ? 'btn-primary' : 'btn-ghost'}" data-mix="${v}" ${v && !canMix() ? 'disabled' : ''}>${label}</button>`).join('')}
      </div>
    </div>`);
  card.onclick = (e) => {
    const b = e.target.closest('[data-mix]');
    if (!b || b.disabled) return;
    crossfade = Number(b.dataset.mix);
    try { localStorage.setItem(MIX_KEY, String(crossfade)); } catch {}
    closeModal();
    paintMix();
    toast(crossfade ? `Mixagem de ${crossfade} segundos ligada` : 'Sem pausa entre as músicas');
  };
}

function paintMix() {
  const btn = $('#nowpanel [data-np="mix"]');
  if (!btn) return;
  btn.classList.toggle('on', crossfade > 0);
  $('.np-timer-label', btn).textContent = crossfade ? `${crossfade}s` : '';
}

// Avança ou volta segundos dentro da música (botões de 10 s).
function seekBy(seconds) {
  const dur = audio.duration || queue[qi]?.track.duration || 0;
  if (!queue[qi]) return;
  const clamp = (t) => Math.max(0, dur ? Math.min(dur - 0.5, t) : t);
  if (hasAudio()) audio.currentTime = clamp(audio.currentTime + seconds);
  else {
    resumeAt = clamp(resumeAt + seconds);
    paintResumePosition();
  }
}

function toggleShuffle() {
  shuffle = !shuffle;
  syncModeButtons();
}

function cycleRepeat() {
  repeat = { off: 'all', all: 'one', one: 'off' }[repeat];
  syncModeButtons();
}

// Os botões de aleatório/repetir existem no player de baixo e no painel "Tocando agora".
function syncModeButtons() {
  [$('#btn-shuffle'), ...$$('[data-mode="shuffle"]')].forEach((b) => b.classList.toggle('active', shuffle));
  [$('#btn-repeat'), ...$$('[data-mode="repeat"]')].forEach((b) => {
    b.classList.toggle('active', repeat !== 'off');
    b.classList.toggle('one', repeat === 'one');
    b.title = { off: 'Repetir', all: 'Repetir tudo', one: 'Repetir uma' }[repeat];
  });
}

function togglePlay() {
  if (!audio.src || audio.src.startsWith('data:')) {
    if (queue.length) return loadCurrent(resumeAt);
    const first = library.albums[0];
    if (first) playQueue(first.tracks.map((track) => ({ track, album: first })), 0);
    return;
  }
  audio.paused ? audio.play() : audio.pause();
}

function updateNowPlaying() {
  renderNowPanel();
  const item = queue[qi];
  if (!item) return;
  const { track, album } = item;
  $('#np-title').textContent = track.title;
  $('#np-artist').textContent = track.artist || album.artist || '';
  $('#np-cover').innerHTML = album.cover ? `<img src="${album.cover}" alt="" />` : '';
  $('.np').classList.remove('np-pop');
  void $('.np').offsetWidth; // reinicia a animação
  $('.np').classList.add('np-pop');
  document.title = `${track.title} • rytmo.`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || album.artist || '',
      album: album.title,
      artwork: album.cover ? [{ src: artworkUrl(album.cover), sizes: '400x400', type: 'image/jpeg' }] : [],
    });
  }
  sendNowPlaying();
}

// A capa fica guardada como data:; o sistema lê melhor um endereço blob:.
const artworkCache = new Map();
function artworkUrl(cover) {
  if (!cover?.startsWith('data:')) return cover;
  if (!artworkCache.has(cover)) {
    try {
      const [head, b64] = cover.split(',');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      artworkCache.set(cover, URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] || 'image/jpeg' })));
    } catch { return cover; }
  }
  return artworkCache.get(cover);
}

// App de iPhone/iPad: nome, artista e capa vão para a tela bloqueada e para a TV (AirPlay).
function sendNowPlaying() {
  const item = queue[qi];
  if (!item || !drive.NATIVE || !IS_IOS) return;
  const { track, album } = item;
  try {
    window.webkit.messageHandlers.rytmo.postMessage({
      type: 'nowPlaying', title: track.title, artist: track.artist || album.artist || '', album: album.title || '',
      artwork: album.cover || '', duration: audio.duration || track.duration || 0, position: audio.currentTime || 0, playing: !audio.paused,
    });
  } catch {}
}
['play', 'pause', 'seeked'].forEach((t) => audio.addEventListener(t, () => setTimeout(sendNowPlaying, 300)));

function markPlaying() {
  const id = queue[qi]?.track.id;
  $$('.tracks tr.row').forEach((r) => r.classList.toggle('playing', r.dataset.track === id));
}

function setRange(el, ratio) {
  el.style.setProperty('--p', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
}

// Faixas sem duração (ex.: o navegador não conseguiu ler na importação) ganham a duração
// real quando tocam; o dono salva no library.json.
let durationSave;
function fillDuration(track, seconds) {
  if (!track || track.duration || !isFinite(seconds) || !seconds) return;
  track.duration = seconds;
  $$(`.tracks tr.row[data-track="${CSS.escape(track.id)}"] .t-dur`).forEach((td) => { td.textContent = fmtTime(seconds); });
  renderNowPanel();
  if (READONLY || DEMO) return;
  clearTimeout(durationSave);
  durationSave = setTimeout(persist, 5000);
}

// ---------- Painel "Tocando agora" (lateral direita no Mac; tela cheia no celular) ----------

// Título e, abaixo dele, "Voltar" à esquerda (no canto direito ficava sob a câmera do iPhone).
// Topo do player: no toque, o botão redondo com a seta mostra que dá para arrastar para
// baixo (e tocar nele também fecha).
const npHead = (album) => `<button class="np-grab np-close" aria-label="Arraste para baixo ou toque para fechar" title="Arraste para baixo para fechar">
    <svg viewBox="0 0 24 24"><path d="M5.6 9.2 12 15.6l6.4-6.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <div class="np-head">
  <button class="np-close np-back" title="Fechar o Tocando agora">
    <svg class="ico-sheet" viewBox="0 0 24 24"><path d="M5.4 8.6 4 10l8 8 8-8-1.4-1.4L12 15.2z"/></svg><span class="lbl-sheet">Minimizar</span>
    <svg class="ico-split" viewBox="0 0 24 24"><path d="m8.6 18.6 1.4 1.4 8-8-8-8-1.4 1.4 6.6 6.6z"/></svg>
  </button></div>`;

// ---------- Abrir e fechar o Tocando agora (o mesmo player, só muda de forma) ----------
const PANEL_PREF = 'rytmo.npOpen';
// Lado a lado só com largura e altura: iPhone deitado abre o player na tela toda (capa à esquerda).
const splitLayout = () => matchMedia('(min-width: 861px) and (min-height: 561px), (min-width: 861px) and (pointer: fine)').matches;
const touchUI = () => matchMedia('(pointer: coarse)').matches;
const npOpen = () => document.documentElement.classList.contains('np-open');

function setNowPanel(open) {
  if (open === npOpen()) return;
  const from = open && !splitLayout() ? $('#np-cover')?.getBoundingClientRect() : null;
  document.documentElement.classList.toggle('np-open', open);
  $('#nowpanel').classList.toggle('open', open);
  if (open) $('#nowpanel').style.transform = '';
  if (splitLayout()) try { localStorage.setItem(PANEL_PREF, open ? '1' : '0'); } catch {}
  if (from?.width) flyCover(from);
}

// iPhone: a capa sai do mini player e cresce até o lugar dela no Tocando agora.
function flyCover(from) {
  const art = $('#nowpanel .np-art .cover');
  if (!art?.animate) return;
  const to = art.getBoundingClientRect();
  if (!to.width) return;
  art.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`, borderRadius: '8px', transformOrigin: 'top left' },
    { transform: 'none', transformOrigin: 'top left' },
  ], { duration: 460, easing: 'cubic-bezier(.22, .9, .24, 1)' });
}

function renderNowPanel() {
  const panel = $('#nowpanel');
  if (!panel) return;
  const item = queue[qi];
  if (!item) {
    panel.innerHTML = `${npHead()}
      <p class="empty">Escolha uma música para ver a capa e as informações aqui.</p>`;
    return;
  }
  const { track, album } = item;
  const n = album.tracks.indexOf(track) + 1;
  const artist = track.artist || album.artist || 'Artista desconhecido';
  panel.innerHTML = `
    ${npHead(album)}
    <div class="np-art np-enter">${coverHTML(album)}</div>
    <div class="np-info">
      <div class="np-name">${esc(track.title)}</div>
      <a class="np-line" href="#/artist/${encodeURIComponent(album.artist || 'Artista desconhecido')}">${esc(artist)}</a>
      <a class="np-line muted" href="#/album/${encodeURIComponent(album.id)}">${kindLabel(album)}: ${esc(album.title)}${album.year ? ` (${esc(album.year)})` : ''}</a>
      <div class="np-line muted">Faixa ${n} de ${album.tracks.length}</div>
    </div>
    <div class="np-actions">
      <button class="icon-btn" data-np="radio" title="Rádio: tocar parecidas">${RADIO_SVG}</button>
      ${canCreatePlaylist() ? `<button class="icon-btn" data-np="add" title="Adicionar à playlist">${PLUS_SVG}</button>` : ''}
      <button class="icon-btn" data-np="queue" title="A seguir">${QUEUE_SVG}</button>
      <button class="icon-btn ${crossfade ? 'on' : ''}" data-np="mix" title="Transição entre músicas">${MIX_SVG}<span class="np-timer-label">${crossfade ? `${crossfade}s` : ''}</span></button>
      <button class="icon-btn np-timer ${sleep ? 'on' : ''}" data-np="timer" title="Timer para parar">${MOON_SVG}<span class="np-timer-label">${sleepLabel()}</span></button>
      ${canAirPlay() ? `<button class="icon-btn" data-np="airplay" title="AirPlay">${AIRPLAY_SVG}</button>` : ''}
    </div>
    <div class="np-progress">
      <div class="np-seek" title="Arraste para avançar ou voltar"><i></i></div>
      <div class="np-times"><span id="np-cur">0:00</span><span id="np-dur">${fmtTime(audio.duration || track.duration || 0)}</span></div>
    </div>
    <div class="np-controls">
      <button class="icon-btn" data-np="shuffle" data-mode="shuffle" title="Aleatório">${SHUFFLE_SVG}</button>
      <button class="icon-btn" data-np="prev" title="Anterior"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zm3.5 7L19 5v14z"/></svg></button>
      <button class="icon-btn np-seekbtn" data-np="back10" title="Voltar 10 segundos">${BACK10_SVG}</button>
      <button class="play-btn" data-np="play" title="Tocar / Pausar"><svg viewBox="0 0 24 24"><path d="${audio.paused ? PLAY_PATH : PAUSE_PATH}"/></svg></button>
      <button class="icon-btn np-seekbtn" data-np="fwd10" title="Avançar 10 segundos">${FWD10_SVG}</button>
      <button class="icon-btn" data-np="next" title="Próxima"><svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5 5l9.5 7L5 19z"/></svg></button>
      <button class="icon-btn" data-np="repeat" data-mode="repeat" title="Repetir">${REPEAT_SVG}</button>
    </div>
`;
  syncModeButtons();
  paintNpProgress();
  paintNowPanelState();
  paintTint(album);
}

// Tocando/pausado sem redesenhar o painel (a capa encolhe ao pausar, com animação).
function paintNowPanelState() {
  const playing = !audio.paused && hasAudio();
  $('#nowpanel').classList.toggle('paused', !playing);
  document.documentElement.classList.toggle('is-playing', playing);
  $('#nowpanel [data-np="play"] path')?.setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
}

// Cor da capa no fundo do painel (média das cores, escurecida para o texto continuar legível).
const tintCache = new Map();
function paintTint(album) {
  const panel = $('#nowpanel');
  const src = album?.cover;
  const set = (color) => (color ? panel.style.setProperty('--np-tint', color) : panel.style.removeProperty('--np-tint'));
  if (!src) return set('');
  if (tintCache.has(src)) return set(tintCache.get(src));
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 12, 12);
      const d = ctx.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      [r, g, b] = [r / n, g / n, b / n];
      const k = Math.min(1, 95 / Math.max(r, g, b, 1)); // nunca claro demais
      const color = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
      tintCache.set(src, color);
      if (queue[qi]?.album.cover === src) set(color);
    } catch { set(''); }
  };
  img.src = src;
}

const BACK10_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16" font-size="7" font-weight="700" text-anchor="middle">10</text></svg>';
const FWD10_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16" font-size="7" font-weight="700" text-anchor="middle">10</text></svg>';
const SHUFFLE_SVG = '<svg viewBox="0 0 24 24"><path d="M17 3l4 4-4 4V8h-2.6l-8 9H3v-2h2.6l8-9H17zm0 10 4 4-4 4v-3h-3.4l-2.3-2.6 1.4-1.5 1.8 2.1H17zM3 7h3.4l2.3 2.6-1.4 1.5L5.6 9H3z"/></svg>';
const REPEAT_SVG = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>';

// Barra de tempo do painel. Enquanto o dedo arrasta, npDrag guarda a posição (0–1)
// e a música só pula quando o dedo solta.
let npDrag = null;

function paintNpProgress() {
  const bar = $('#nowpanel .np-seek');
  if (!bar) return;
  const dur = audio.duration || queue[qi]?.track.duration || 0;
  const ratio = npDrag ?? (dur ? currentPos() / dur : 0);
  setRange(bar, ratio);
  $('#np-cur').textContent = fmtTime(ratio * dur);
  if (dur) $('#np-dur').textContent = `-${fmtTime(Math.max(0, dur - ratio * dur))}`;
}

function bindNowPanel() {
  const panel = $('#nowpanel');
  panel.addEventListener('click', (e) => {
    const ctl = e.target.closest('[data-np]')?.dataset.np;
    if (ctl === 'prev') return prev();
    if (ctl === 'next') return next();
    if (ctl === 'play') return togglePlay();
    if (ctl === 'back10') return seekBy(-10);
    if (ctl === 'fwd10') return seekBy(10);
    if (ctl === 'shuffle') return toggleShuffle();
    if (ctl === 'add') return queue[qi] && addToPlaylist(queue[qi]);
    if (ctl === 'radio') return queue[qi] && startRadio(queue[qi].album, queue[qi]);
    if (ctl === 'mix') return openTransition();
    if (ctl === 'queue') return openQueue();
    if (ctl === 'timer') return openTimer();
    if (ctl === 'airplay') return openAirPlay();
    if (ctl === 'repeat') return cycleRepeat();
    // no iPhone, abrir artista/álbum fecha o player; no iPad/Mac ele fica ao lado
    if (e.target.closest('.np-close') || (e.target.closest('a') && !splitLayout())) setNowPanel(false);
  });

  // Barra de tempo: tocar em qualquer ponto ou arrastar (área de toque alta, boa para o dedo).
  const ratioAt = (e, bar) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  panel.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.np-seek');
    if (!bar || !(audio.duration || queue[qi]?.track.duration)) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    npDrag = ratioAt(e, bar);
    paintNpProgress();
  });
  panel.addEventListener('pointermove', (e) => {
    const bar = e.target.closest('.np-seek');
    if (npDrag === null || !bar) return;
    npDrag = ratioAt(e, bar);
    paintNpProgress();
  });
  const endDrag = (e) => {
    const bar = e.target.closest('.np-seek');
    if (npDrag === null || !bar) return;
    if (e.type === 'pointerup') {
      if (hasAudio() && audio.duration) audio.currentTime = npDrag * audio.duration;
      else { resumeAt = npDrag * (queue[qi]?.track.duration || 0); npDrag = null; paintResumePosition(); }
    }
    npDrag = null;
    bar.classList.remove('dragging');
    paintNpProgress();
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);

  // Gestos (toque): arrastar a capa para o lado troca de música (esquerda = próxima,
  // direita = anterior); arrastar o painel para baixo, de qualquer ponto que não seja
  // botão ou barra de tempo, fecha — como no Spotify. A direção é decidida no começo.
  let gesture = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!npOpen() || e.target.closest('button:not(.np-grab), a, input, .np-seek')) return;
    const art = e.target.closest('.np-art');
    if (!touchUI() && !art) return;
    gesture = { x: e.clientX, y: e.clientY, art, dir: null, id: e.pointerId, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  });
  panel.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.dir && Math.hypot(dx, dy) > 8) {
      gesture.dir = Math.abs(dx) > Math.abs(dy) ? (gesture.art && queue[qi] ? 'x' : 'none') : (dy > 0 && touchUI() ? 'down' : 'none');
      if (gesture.dir !== 'none') panel.setPointerCapture?.(e.pointerId);
    }
    if (gesture.dir === 'x') gesture.art.style.transform = `translateX(${dx * 0.6}px)`;
    else if (gesture.dir === 'down') {
      const dt = Math.max(1, e.timeStamp - gesture.lastT);
      gesture.v = (e.clientY - gesture.lastY) / dt; // px/ms, para fechar com um "peteleco"
      gesture.lastY = e.clientY;
      gesture.lastT = e.timeStamp;
      panel.classList.add('dragging');
      // iPad (painel ao lado): desce só o conteúdo, o fundo do painel fica — sem buraco preto.
      // iPhone (tela cheia): o painel inteiro desce mostrando o app por baixo.
      if (splitLayout()) { panel.style.setProperty('--dy', `${Math.max(0, dy)}px`); panel.style.setProperty('--dyn', Math.min(0.6, Math.max(0, dy) / 400)); }
      else panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
    }
  });
  const endGesture = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const { dir, art, v } = gesture;
    const dx = e.type === 'pointerup' ? e.clientX - gesture.x : 0;
    const dy = e.type === 'pointerup' ? e.clientY - gesture.y : 0;
    gesture = null;
    if (art) art.style.transform = '';
    panel.classList.remove('dragging');
    if (dir === 'down') return settleDrag(dy > 90 || (dy > 20 && v > 0.35));
    panel.style.transform = '';
    if (dir === 'x' && dx < -60) next();
    else if (dir === 'x' && dx > 60) prev();
  };
  panel.addEventListener('pointerup', endGesture);
  panel.addEventListener('pointercancel', endGesture);

  // Termina o arrasto: desce até sair da tela e fecha, ou volta macio para o lugar.
  function settleDrag(close) {
    if (splitLayout()) {
      // o conteúdo volta (ou some junto com a coluna, que fecha na hora)
      panel.style.removeProperty('--dy');
      panel.style.removeProperty('--dyn');
      if (close) setNowPanel(false);
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      panel.removeEventListener('transitionend', done);
      panel.classList.remove('settling');
      panel.style.transition = '';
      if (!close) return;
      setNowPanel(false);
      // volta para o lugar só depois que o painel já sumiu (sem piscar)
      setTimeout(() => {
        if (npOpen()) return;
        panel.style.transition = 'none';
        panel.style.transform = '';
        requestAnimationFrame(() => { panel.style.transition = ''; });
      }, 600);
    };
    panel.classList.add('settling');
    panel.style.transition = `transform ${close ? 0.2 : 0.3}s cubic-bezier(.22, .9, .24, 1)`;
    panel.addEventListener('transitionend', done);
    setTimeout(done, 350); // garantia, se o transitionend não vier
    panel.style.transform = close ? `translateY(${panel.offsetHeight}px)` : 'translateY(0px)';
  }

  // Tocar no mini player abre o Tocando agora; no iPad/Mac, tocar de novo fecha.
  $('.np').addEventListener('click', () => {
    if (!queue[qi] && !splitLayout()) return;
    setNowPanel(splitLayout() ? !npOpen() : true);
  });
  // Mac (mouse): o painel começa aberto, como antes, a não ser que a pessoa tenha fechado.
  let pref = null;
  try { pref = localStorage.getItem(PANEL_PREF); } catch {}
  if (matchMedia('(min-width: 861px) and (pointer: fine)').matches && pref !== '0') setNowPanel(true);
  else if (pref === '1' && splitLayout()) setNowPanel(true);
  audio.addEventListener('play', paintNowPanelState);
  audio.addEventListener('pause', paintNowPanelState);
  renderNowPanel();
}

// ---------- Ouvintes (só o dono) ----------

async function renderListeners() {
  const view = $('#view');
  view.innerHTML = '<h1>Ouvintes</h1><p class="empty">Carregando…</p>';
  try {
    const { listeners, sheetUrl } = await community.listeners();
    const fmtDate = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
    const sorted = [...listeners].sort((a, b) => b.last - a.last);
    view.innerHTML = `
      <div class="page-head"><h1>Ouvintes</h1>
        <div class="row-actions">
          <a class="btn btn-ghost" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Abrir planilha</a>
          <button class="btn btn-primary" id="csv">Exportar CSV</button>
        </div></div>
      <p class="empty" style="padding-top:0">${sorted.length} pessoa${sorted.length === 1 ? '' : 's'} entraram pelo link de ouvinte •
        ${sorted.filter((l) => l.optIn).length} aceitaram receber novidades.</p>
      <table class="tracks listeners">
        <thead><tr><th>E-mail</th><th>Nome</th><th>Último acesso</th><th>Acessos</th><th>Novidades</th></tr></thead>
        <tbody>${sorted.map((l) => `<tr><td class="t-title">${esc(l.email)}</td><td>${esc(l.name || '')}</td><td>${fmtDate(l.last)}</td><td>${l.visits}</td><td>${l.optIn ? '✓ sim' : 'não'}</td></tr>`).join('')}</tbody>
      </table>`;
    $('#csv').onclick = () => {
      const lines = [['email', 'nome', 'primeiro_acesso', 'ultimo_acesso', 'acessos', 'aceita_novidades'],
        ...sorted.map((l) => [l.email, l.name || '', fmtDate(l.first), fmtDate(l.last), l.visits, l.optIn ? 'sim' : 'nao'])];
      const csv = lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'rytmo-ouvintes.csv';
      a.click();
    };
  } catch (e) {
    view.innerHTML = `<h1>Ouvintes</h1><p class="empty">Não foi possível carregar: ${esc(e.message)}</p>`;
  }
}

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zm8 0h4v14h-4z';

// No iPhone/iPad o áudio só pode começar dentro de um toque. Como a música é baixada
// do Drive antes de tocar, "destravamos" o player no primeiro toque com um som mudo.
function unlockAudioOnIOS() {
  if (!IS_IOS) return;
  const SILENT = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
  const unlock = () => {
    document.removeEventListener('touchend', unlock, true);
    if (audio.src) return;
    audio.src = SILENT;
    audio.play().then(() => audio.pause()).catch(() => {});
  };
  document.addEventListener('touchend', unlock, true);
}

// ---------- Tela bloqueada, fones e carro ----------
// Faixa anterior/próxima em vez dos botões de ±10 s que o iOS mostra por padrão: o iOS só
// mostra os de faixa se NÃO houver os de pular segundos, e costuma esquecer os comandos
// quando o áudio troca, então eles são registrados de novo a cada música.

// O comando pode chegar duas vezes (pela página e pelo app nativo): vale um por vez.
let lastRemote = 0;
function remoteOnce(fn) {
  if (Date.now() - lastRemote < 500) return;
  lastRemote = Date.now();
  fn();
}
window.rytmoRemote = {
  next: () => remoteOnce(next),
  prev: () => remoteOnce(prev),
  toggle: () => remoteOnce(togglePlay),
  // depois de uma ligação ou outro app de som: volta a tocar se estava tocando
  resume: () => { if (queue[qi] && audio.src && audio.paused && wasPlaying) audio.play().catch(() => {}); },
};
let wasPlaying = false;
audio.addEventListener('play', () => { wasPlaying = true; });
audio.addEventListener('pause', () => { if (!audio.ended && document.visibilityState === 'visible') wasPlaying = false; });

function registerLockScreen() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  set('play', () => audio.play());
  set('pause', () => audio.pause());
  set('nexttrack', window.rytmoRemote.next);
  set('previoustrack', window.rytmoRemote.prev);
  set('seekbackward', null);
  set('seekforward', null);
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

function paintLockScreenPosition() {
  if (!navigator.mediaSession?.setPositionState || !audio.duration || !Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) });
  } catch {}
}

function bindLockScreen() {
  registerLockScreen();
  audio.addEventListener('playing', () => { registerLockScreen(); paintLockScreenPosition(); });
  audio.addEventListener('loadedmetadata', paintLockScreenPosition);
  audio.addEventListener('seeked', paintLockScreenPosition);
}

function bindPlayer() {
  unlockAudioOnIOS();
  bindStreamRecovery();
  bindPlaybackSync();
  const seek = $('#seek');
  const vol = $('#volume');
  let seeking = false;

  bindVolume();

  audio.addEventListener('play', () => { if (hasAudio()) $('#play-icon').innerHTML = `<path d="${PAUSE_PATH}"/>`; });
  audio.addEventListener('pause', () => { $('#play-icon').innerHTML = `<path d="${PLAY_PATH}"/>`; stopTail(); });
  audio.addEventListener('loadedmetadata', () => {
    $('#time-dur').textContent = fmtTime(audio.duration);
    fillDuration(queue[qi]?.track, audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    $('#time-cur').textContent = fmtTime(audio.currentTime);
    paintNpProgress();
    stats.tick(audio.currentTime, !audio.paused && hasAudio());
    countListening();
    prepareNext();
    maybeCrossfade();
    if (!seeking && audio.duration) {
      seek.value = (audio.currentTime / audio.duration) * 1000;
      setRange(seek, audio.currentTime / audio.duration);
    }
  });
  audio.addEventListener('ended', () => {
    if (sleep?.endOfTrack) {
      clearSleep();
      return toast('Timer: parou no fim da música');
    }
    if (repeat === 'one') {
      audio.currentTime = 0;
      audio.play();
    } else next();
  });

  seek.addEventListener('input', () => { seeking = true; setRange(seek, seek.value / 1000); });
  seek.addEventListener('change', () => {
    if (hasAudio() && audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
    else if (queue[qi]?.track.duration) resumeAt = (seek.value / 1000) * queue[qi].track.duration;
    seeking = false;
  });

  $('#btn-play').onclick = togglePlay;
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#btn-back10').onclick = () => seekBy(-10);
  $('#btn-fwd10').onclick = () => seekBy(10);
  $('#btn-shuffle').onclick = toggleShuffle;
  $('#btn-repeat').onclick = cycleRepeat;

  bindLockScreen();
  bindSwipeBack();
  bindSideRail();
  bindLangButton($('#btn-lang'));

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') seekBy(-10);
    else if (e.code === 'ArrowRight') seekBy(10);
    else if (e.code === 'ArrowUp') { e.preventDefault(); setVolume(audio.volume + 0.05); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); setVolume(audio.volume - 0.05); }
  });
}

// ---------- Volume ----------
// No iPhone/iPad o volume é dos botões do aparelho (o iOS não deixa o site mudar), então lá
// aparece o AirPlay no lugar. No Mac e no navegador: arrastar, rolar o mouse, ↑/↓ ou tocar no
// alto-falante para silenciar. O volume fica guardado.

const VOL_KEY = 'rytmo.volume';
const VOL_PATHS = {
  mute: 'M3 9v6h4l5 5V4L7 9zm12.6 3-2.3-2.3 1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4z',
  low: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z',
  high: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
};
let lastAudible = 0.8;

function setVolume(v, remember = true) {
  v = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  audio.volume = v;
  audio.muted = v === 0;
  const vol = $('#volume');
  vol.value = v;
  setRange(vol, v);
  vol.title = `Volume ${Math.round(v * 100)}%`;
  $('#vol-path').setAttribute('d', v === 0 ? VOL_PATHS.mute : v < 0.5 ? VOL_PATHS.low : VOL_PATHS.high);
  $('#btn-mute').title = v === 0 ? 'Ativar som' : 'Silenciar';
  if (v > 0) lastAudible = v;
  if (remember) try { localStorage.setItem(VOL_KEY, String(v)); } catch {}
}

const canAirPlay = () => drive.NATIVE || typeof audio.webkitShowPlaybackTargetPicker === 'function';
// iPhone/iPad (app): a lista de TVs e caixas do próprio iOS (o som sai do aparelho).
// Mac (app): o som vai pela saída escolhida no Mac. Navegador: o AirPlay do Safari.
function openAirPlay() {
  if (drive.NATIVE && IS_IOS) return window.webkit.messageHandlers.rytmo.postMessage({ type: 'airplay' });
  if (drive.NATIVE) return toast('Para tocar na TV: abra a Central de Controle do Mac › Som e escolha a Apple TV ou a caixa');
  audio.webkitShowPlaybackTargetPicker?.();
}

function bindVolume() {
  const extra = $('.extra');
  extra.classList.toggle('ios-volume', IS_IOS);
  $('#btn-airplay').hidden = !canAirPlay();
  $('#btn-airplay').onclick = openAirPlay;
  let saved = 0.8;
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY));
    if (!Number.isNaN(v)) saved = v;
  } catch {}
  setVolume(saved, false);
  if (saved > 0) lastAudible = saved;
  $('#volume').addEventListener('input', (e) => setVolume(Number(e.target.value)));
  $('#btn-mute').onclick = () => setVolume(audio.volume > 0 ? 0 : lastAudible || 0.8);
  const wheel = (e) => {
    e.preventDefault();
    setVolume(audio.volume - Math.sign(e.deltaY) * 0.05);
  };
  $('#volume').addEventListener('wheel', wheel, { passive: false });
  $('#btn-mute').addEventListener('wheel', wheel, { passive: false });
}

// ---------- Fila ----------

function playNext(item) {
  if (!queue[qi]) return playQueue([item], 0);
  queue.splice(qi + 1, 0, item);
  savePlayback();
  toast(`"${item.track.title}" toca a seguir`);
}

function addToQueue(item) {
  if (!queue[qi]) return playQueue([item], 0);
  queue.push(item);
  savePlayback();
  toast(`"${item.track.title}" entrou na fila`);
}

function openQueue() {
  const upcoming = queue.slice(qi + 1, qi + 51).map((item, k) => ({ item, index: qi + 1 + k }));
  const card = openModal(`
    <div class="modal-head"><h2>A seguir</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body queue-list">
      ${shuffle ? '<p class="empty" style="padding:0 0 8px">Aleatório ligado: a próxima é sorteada.</p>' : ''}
      ${upcoming.length ? upcoming.map(({ item, index }) => `
        <div class="queue-row" data-q="${index}">
          ${coverHTML(item.album, 'cover-sm')}
          <div class="queue-text"><b>${esc(item.track.title)}</b><span>${esc(item.track.artist || item.album.artist || '')}</span></div>
          <button class="icon-btn" data-q-remove="${index}" title="Tirar da fila">${X_SVG}</button>
        </div>`).join('') : '<p class="empty">Nada na fila. Quando acabar, o rytmo continua com outro álbum.</p>'}
    </div>`);
  card.onclick = (e) => {
    const remove = e.target.closest('[data-q-remove]');
    if (remove) {
      queue.splice(Number(remove.dataset.qRemove), 1);
      savePlayback();
      return openQueue();
    }
    const row = e.target.closest('[data-q]');
    if (!row) return;
    qi = Number(row.dataset.q);
    closeModal();
    loadCurrent();
  };
}

// ---------- Timer para parar ----------

let sleep = null; // { end, timer } ou { endOfTrack: true }
let sleepTick = null;

function sleepLabel() {
  if (!sleep) return '';
  if (sleep.endOfTrack) return 'fim';
  return `${Math.max(1, Math.ceil((sleep.end - Date.now()) / 60000))} min`;
}

function paintSleep() {
  const btn = $('#nowpanel .np-timer');
  if (btn) {
    btn.classList.toggle('on', !!sleep);
    $('.np-timer-label', btn).textContent = sleepLabel();
  }
}

function setSleep(minutes) {
  clearSleep(false);
  if (minutes === 'track') sleep = { endOfTrack: true };
  else sleep = { end: Date.now() + minutes * 60000, timer: setTimeout(sleepNow, minutes * 60000) };
  sleepTick = setInterval(paintSleep, 20000);
  paintSleep();
  toast(minutes === 'track' ? 'Timer: para no fim desta música' : `Timer: para em ${minutes} minutos`);
}

function clearSleep(paint = true) {
  if (sleep?.timer) clearTimeout(sleep.timer);
  clearInterval(sleepTick);
  sleep = null;
  if (paint) paintSleep();
}

// Abaixa o volume aos poucos antes de pausar (no iOS só pausa: lá o volume é do aparelho).
function sleepNow() {
  clearSleep();
  const start = audio.volume;
  let step = 0;
  const fade = setInterval(() => {
    step++;
    audio.volume = Math.max(0, start * (1 - step / 20));
    if (step < 20) return;
    clearInterval(fade);
    audio.pause();
    audio.volume = start;
    toast('Timer: música pausada. Boa noite!');
  }, 200);
}

function openTimer() {
  const options = [15, 30, 45, 60, 90];
  const card = openModal(`
    <div class="modal-head"><h2>Timer para parar</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body timer-list">
      ${sleep ? `<p class="empty" style="padding:0 0 8px">Ligado: ${sleep.endOfTrack ? 'para no fim desta música' : `para em ${sleepLabel()}`}.</p>` : ''}
      <div class="timer-grid">
        ${options.map((m) => `<button class="btn btn-ghost" data-sleep="${m}">${m} min</button>`).join('')}
        <button class="btn btn-ghost" data-sleep="track">Fim da música</button>
      </div>
      ${sleep ? '<button class="btn btn-danger" data-sleep="off">Desligar timer</button>' : ''}
    </div>`);
  card.onclick = (e) => {
    const b = e.target.closest('[data-sleep]');
    if (!b) return;
    closeModal();
    if (b.dataset.sleep === 'off') {
      clearSleep();
      return toast('Timer desligado');
    }
    setSleep(b.dataset.sleep === 'track' ? 'track' : Number(b.dataset.sleep));
  };
}

// ---------- Tocadas recentemente ----------

const RECENT_KEY = `rytmo.recent${LISTEN_ID ? `.${LISTEN_ID}` : DEMO ? '.demo' : ''}`;
function pushRecent(albumId) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
  list = [albumId, ...list.filter((id) => id !== albumId)].slice(0, 12);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}
function recentAlbums() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').map(albumById).filter(Boolean); } catch { return []; }
}

// ---------- Seu rytmo: um mini site dentro do app ----------
// Abas: Mural (recados, pedidos e trilhas), Resumo (o que você mais ouve), Notícias
// (sobrefunk.com) e, só para o dono, Visitantes. O Mural fica no servidor da comunidade
// (apps-script/Code.gs, aba "Mural").
let ryTab = 'mural';
let muralPosts = null; // null = ainda não carregou
let muralError = '';
let muralAttach = true;
let muralMode = 'recado';
let muralFilter = 'all';
let replyOpen = null;
let trilhaDraft = [null, null, null];
let nowListening = [];
const TRILHA_LABELS = ['A da infância', 'A da festa', 'A que me acalma'];
const MURAL_PROMPTS = ['Minha favorita daqui é ', 'Essa música me lembra ', 'Descobri aqui e não paro de ouvir: ', 'Pra ouvir no carro: '];
const isOwnerView = () => !READONLY;
const RY_TABS = () => [['mural', 'Mural'], ['placar', 'Placar'], ['resumo', 'Resumo'], ...(isOwnerView() ? [['visitantes', 'Visitantes']] : [])];
const muralAvailable = () => DEMO || (community.enabled() && !offlineMode);

const demoRef = (ai, ti) => { const a = library.albums[ai]; const t = a?.tracks[ti]; return t ? { albumId: a.id, trackId: t.id } : null; };
const demoPosts = () => [
  { id: 'd3', kind: 'pedido', name: 'Bruno', text: 'Coloca o Furacão 2000 Tornado Muito Nervoso!', likes: 4, liked: false, at: Date.now() - 7200e3, replies: [], status: '' },
  { id: 'd2', kind: 'recado', name: 'Ana', text: 'Essa me lembra as festas de 1991, que saudade! 🔥', track: demoRef(0, 1), likes: 5, liked: true, at: Date.now() - 3600e3,
    replies: [{ name: 'Você', owner: true, mine: true, text: 'Clássico demais!', at: Date.now() - 1800e3 }] },
  { id: 'd4', kind: 'trilha', name: 'Carla', text: '', tracks: [demoRef(0, 0), demoRef(1, 0), demoRef(0, 2)].filter(Boolean).map((r, i) => ({ ...r, label: TRILHA_LABELS[i] })), likes: 2, liked: false, at: Date.now() - 5400e3, replies: [] },
  { id: 'd1', kind: 'recado', name: 'Você', owner: true, mine: true, text: 'Bem-vindo ao meu rytmo! Deixa aqui sua favorita e o que você achou.', likes: 3, liked: false, at: Date.now() - 864e5, replies: [] },
];

function trackFor(ref) {
  const album = ref && albumById(ref.albumId);
  const track = album?.tracks.find((t) => t.id === ref.trackId);
  return track ? { track, album } : null;
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 43200) return `${Math.round(m / 1440)} d`;
  return new Date(t).toLocaleDateString('pt-BR');
};
const fmtDur = (s) => {
  const m = Math.round((s || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

// Cartão da tela Início
function muralCardHTML() {
  if (!muralAvailable()) return stats.hasStats() ? rytmoCardHTML() : '';
  const last = muralPosts?.find((p) => p.text);
  return `
    <a class="rytmo-card mural-card" href="#/rytmo">
      <div><b>Seu rytmo</b><span>${last ? `${esc(last.name)}: “${esc(last.text.slice(0, 70))}${last.text.length > 70 ? '…' : ''}”` : 'Mural, placar e o seu resumo de escuta'}</span></div>
      ${STATS_SVG}
    </a>`;
}

function renderRytmoSite(tab) {
  ryTab = RY_TABS().some(([k]) => k === tab) ? tab : 'mural';
  const s = stats.summary('month');
  $('#view').innerHTML = `
    <div class="ry-site">
      <header class="ry-hero">
        <div class="ry-hero-top">
          <svg class="ry-mark" viewBox="0 0 64 48" aria-hidden="true"><use href="#mark" /></svg>
          <div><h1>Seu rytmo</h1><p>O ponto de encontro de quem ouve esta biblioteca</p></div>
        </div>
        <div class="ry-stats">
          <div><b>${s.minutes.toLocaleString('pt-BR')}</b><span>min este mês</span></div>
          <div><b id="ry-posts-n">${muralPosts ? muralPosts.length : '–'}</b><span>recados</span></div>
          <div><b id="ry-now-n">${nowListening.length}</b><span>ouvindo agora</span></div>
        </div>
        <div class="ry-now" id="ry-now"></div>
      </header>
      <nav class="ry-tabs">${RY_TABS().map(([k, label]) => `<a href="#/rytmo/${k}" class="${k === ryTab ? 'on' : ''}">${label}</a>`).join('')}</nav>
      <div class="ry-body" id="ry-body"></div>
      <footer class="ry-foot">rytmo. • o seu ritmo, junto com quem ouve</footer>
    </div>`;
  paintNow();
  loadNow();
  if (muralPosts === null && ryTab !== 'mural') loadMural().then(() => { if ($('#ry-posts-n')) $('#ry-posts-n').textContent = muralPosts.length; });
  ({ mural: renderMuralTab, placar: renderPlacarTab, resumo: renderResumoTab, visitantes: renderVisitorsTab })[ryTab]();
}
const ryBody = (tab) => (location.hash.startsWith('#/rytmo') && ryTab === tab ? $('#ry-body') : null);

// ----- Ouvindo agora -----
async function loadNow() {
  if (DEMO) nowListening = [{ name: 'Ana', track: demoRef(0, 1), at: Date.now() }, { name: 'Bruno', track: demoRef(1, 2), at: Date.now() }].filter((n) => n.track);
  else if (communityOn) { try { nowListening = await community.nowPlaying(); } catch { nowListening = []; } }
  paintNow();
}
function paintNow() {
  const el = $('#ry-now');
  if (!el) return;
  const list = nowListening.map((n) => ({ ...n, item: trackFor(n.track) })).filter((n) => n.item);
  if ($('#ry-now-n')) $('#ry-now-n').textContent = list.length;
  el.innerHTML = list.length ? `<span class="ry-live"><i></i>Ouvindo agora</span>${list.map((n, i) => `
    <button class="ry-now-item" data-now="${i}">${coverHTML(n.item.album, 'cover-sm')}
      <span><b>${esc(n.mine ? 'Você' : n.name)}</b><small>${esc(n.item.track.title)}</small></span><em>Ouvir junto</em></button>`).join('')}` : '';
  $$('[data-now]', el).forEach((b) => { b.onclick = () => playQueue([list[b.dataset.now].item], 0); });
}

// ----- Mural -----
async function loadMural() {
  if (DEMO) { muralPosts ??= demoPosts(); return; }
  try { muralPosts = await community.listPosts(); muralError = ''; }
  catch (e) {
    muralError = /desconhecida/i.test(e.message)
      ? 'O mural ainda não está ligado nesta biblioteca.'
      : e.message;
    muralPosts ??= [];
  }
}

async function renderMuralTab() {
  paintMural();
  await loadMural();
  paintMural();
}

// Música da semana: a mais anexada e curtida nos recados dos últimos 7 dias.
function songOfWeek(posts) {
  const since = Date.now() - 7 * 864e5;
  const score = new Map();
  for (const p of posts) {
    if (p.at < since) continue;
    for (const r of p.tracks || (p.track ? [p.track] : [])) {
      const k = `${r.albumId}|${r.trackId}`;
      score.set(k, (score.get(k) || 0) + 1 + (p.likes || 0));
    }
  }
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const [albumId, trackId] = best[0].split('|');
  const item = trackFor({ albumId, trackId });
  return item && { item, votes: best[1] };
}

function postHTML(p) {
  const item = trackFor(p.track);
  const trilha = (p.tracks || []).map((r) => ({ r, item: trackFor(r) })).filter((x) => x.item);
  const isReq = p.kind === 'pedido';
  const badge = isReq ? `<span class="post-kind req">Pedido${p.status === 'atendido' ? ' • atendido ✓' : ''}</span>`
    : p.kind === 'trilha' ? '<span class="post-kind">Trilha da vida</span>' : '';
  return `
    <article class="post ${p.owner ? 'by-owner' : ''} ${isReq && p.status === 'atendido' ? 'done' : ''}" data-post="${esc(p.id)}">
      <div class="post-av">${esc((p.name || '?').trim()[0]?.toUpperCase() || '?')}</div>
      <div class="post-body">
        <div class="post-head"><b>${esc(p.name || 'Ouvinte')}</b>${p.owner ? '<span class="post-badge">dono</span>' : ''}${badge}<small>${ago(p.at)}</small></div>
        ${p.text ? `<p>${esc(p.text)}</p>` : ''}
        ${item ? `<button class="post-track" data-post-play="${esc(p.id)}">${coverHTML(item.album, 'cover-sm')}
          <span><b>${esc(item.track.title)}</b><small>${esc(item.track.artist || item.album.artist || '')}</small></span>${PLAY_SMALL_SVG}</button>` : ''}
        ${trilha.length ? `<div class="post-trilha">${trilha.map(({ r, item: it }, i) => `
          <button class="post-track" data-trilha-play="${esc(p.id)}" data-i="${i}">${coverHTML(it.album, 'cover-sm')}
            <span><em>${esc(r.label || TRILHA_LABELS[i] || '')}</em><b>${esc(it.track.title)}</b><small>${esc(it.track.artist || it.album.artist || '')}</small></span>${PLAY_SMALL_SVG}</button>`).join('')}</div>` : ''}
        <div class="post-actions">
          <button class="post-like ${p.liked ? 'on' : ''}" data-like="${esc(p.id)}">${HEART_SVG}<span>${isReq ? 'Apoiar ' : ''}${p.likes || ''}</span></button>
          <button class="post-act" data-reply="${esc(p.id)}">Responder${p.replies?.length ? ` (${p.replies.length})` : ''}</button>
          ${trilha.length && p.mine ? `<button class="post-act" data-trilha-share="${esc(p.id)}">Compartilhar</button>` : ''}
          ${isReq && isOwnerView() ? `<button class="post-act" data-status="${esc(p.id)}">${p.status === 'atendido' ? 'Desmarcar' : 'Marcar atendido'}</button>` : ''}
          ${p.mine || isOwnerView() ? `<button class="post-del" data-del="${esc(p.id)}">Apagar</button>` : ''}
        </div>
        ${p.replies?.length || replyOpen === p.id ? `<div class="post-replies">${(p.replies || []).map((r) => `
          <div class="reply"><b>${esc(r.name || 'Ouvinte')}</b>${r.owner ? '<span class="post-badge">dono</span>' : ''}<span>${esc(r.text)}</span><small>${ago(r.at)}</small></div>`).join('')}
          ${replyOpen === p.id ? `<form class="reply-form" data-reply-form="${esc(p.id)}"><input maxlength="300" placeholder="Escreva uma resposta…" /><button class="btn btn-primary btn-sm">Enviar</button></form>` : ''}</div>` : ''}
      </div>
    </article>`;
}

function composerHTML() {
  const now = queue[qi];
  const modes = [['recado', 'Recado'], ['pedido', 'Pedido de música'], ['trilha', 'Minha trilha']];
  let body = '';
  if (muralMode === 'recado') {
    body = `
      <textarea id="mural-text" maxlength="500" rows="3" placeholder="Conte o que está achando ou a sua favorita daqui…"></textarea>
      <div class="mural-prompts">${MURAL_PROMPTS.map((t, i) => `<button type="button" data-prompt="${i}">${esc(t.trim().replace(/:$/, ''))}…</button>`).join('')}</div>
      <div class="mural-bar">
        ${now ? `<label class="mural-attach"><input type="checkbox" id="mural-attach" ${muralAttach ? 'checked' : ''}/>${coverHTML(now.album, 'cover-sm')}<span>Anexar <b>${esc(now.track.title)}</b></span></label>`
          : '<span class="mural-hint">Toque uma música para anexá-la ao recado</span>'}
        <button class="btn btn-primary btn-sm" type="submit">Publicar</button>
      </div>`;
  } else if (muralMode === 'pedido') {
    body = `
      <textarea id="mural-text" maxlength="300" rows="2" placeholder="Qual álbum ou artista você quer ouvir aqui?"></textarea>
      <div class="mural-bar"><span class="mural-hint">Os outros podem apoiar o seu pedido. Quando entrar na biblioteca, ele aparece como atendido.</span>
        <button class="btn btn-primary btn-sm" type="submit">Pedir</button></div>`;
  } else {
    body = `
      <div class="trilha-slots">${trilhaDraft.map((it, i) => `
        <div class="trilha-slot">
          <input data-trilha-label="${i}" maxlength="40" value="${esc(it?.label ?? TRILHA_LABELS[i])}" />
          <button type="button" class="trilha-pick" data-trilha-pick="${i}">${it ? `${coverHTML(it.album, 'cover-sm')}<span>${esc(it.track.title)}</span>` : '<span>+ Escolher música</span>'}</button>
        </div>`).join('')}</div>
      <textarea id="mural-text" maxlength="300" rows="2" placeholder="Quer contar a história? (opcional)"></textarea>
      <div class="mural-bar"><span class="mural-hint">3 músicas que marcaram fases da sua vida</span>
        <button class="btn btn-primary btn-sm" type="submit">Publicar trilha</button></div>`;
  }
  return `
    <form class="mural-form" id="mural-form">
      <div class="mural-modes">${modes.map(([k, l]) => `<button type="button" class="${k === muralMode ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
      ${body}
    </form>`;
}

function paintMural() {
  const el = ryBody('mural');
  if (!el) return;
  const posts = muralPosts || [];
  const filters = [['all', 'Tudo'], ['recado', 'Recados'], ['pedido', 'Pedidos'], ['trilha', 'Trilhas']];
  const shown = posts.filter((p) => muralFilter === 'all' || (p.kind || 'recado') === muralFilter);
  const week = songOfWeek(posts);
  const draftText = $('#mural-text')?.value || '';
  if ($('#ry-posts-n')) $('#ry-posts-n').textContent = posts.length;
  el.innerHTML = `
    ${week ? `<button class="ry-week" id="ry-week">${coverHTML(week.item.album)}
      <span><small>Música da semana • escolhida por quem ouve</small><b>${esc(week.item.track.title)}</b><em>${esc(week.item.track.artist || week.item.album.artist || '')}</em></span>${PLAY_SMALL_SVG}</button>` : ''}
    ${composerHTML()}
    ${muralError ? `<p class="empty">${esc(muralError)}</p>` : ''}
    <div class="mural-filters">${filters.map(([k, l]) => `<button class="${k === muralFilter ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
    <div class="posts">${muralPosts === null ? '<p class="empty">Carregando recados…</p>'
      : shown.length ? shown.map(postHTML).join('') : (muralError ? '' : '<p class="empty">Nada por aqui ainda. Seja o primeiro!</p>')}</div>`;
  if ($('#mural-text') && draftText) $('#mural-text').value = draftText;
  bindMural(el, posts);
}

function bindMural(el, posts) {
  const now = queue[qi];
  const text = $('#mural-text');
  const byId = (id) => posts.find((p) => p.id === id);
  if ($('#ry-week')) $('#ry-week').onclick = () => { const w = songOfWeek(posts); if (w) playQueue([w.item], 0); };
  $$('[data-mode]', el).forEach((b) => { b.onclick = () => { muralMode = b.dataset.mode; paintMural(); }; });
  $$('[data-filter]', el).forEach((b) => { b.onclick = () => { muralFilter = b.dataset.filter; paintMural(); }; });
  $$('[data-prompt]', el).forEach((b) => { b.onclick = () => { text.value = MURAL_PROMPTS[b.dataset.prompt]; text.focus(); }; });
  if ($('#mural-attach')) $('#mural-attach').onchange = (e) => { muralAttach = e.target.checked; };
  $$('[data-trilha-label]', el).forEach((inp) => {
    inp.oninput = () => { const i = inp.dataset.trilhaLabel; if (trilhaDraft[i]) trilhaDraft[i].label = inp.value; else trilhaDraft[i] = null; TRILHA_LABELS_DRAFT[i] = inp.value; };
  });
  $$('[data-trilha-pick]', el).forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.trilhaPick);
      const picked = await pickTrack();
      if (!picked) return;
      trilhaDraft[i] = { ...picked, label: TRILHA_LABELS_DRAFT[i] || TRILHA_LABELS[i] };
      paintMural();
    };
  });
  $('#mural-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = (text?.value || '').trim();
    let post;
    if (muralMode === 'trilha') {
      const chosen = trilhaDraft.map((it, i) => it && { albumId: it.album.id, trackId: it.track.id, label: it.label || TRILHA_LABELS[i] }).filter(Boolean);
      if (!chosen.length) return toast('Escolha as músicas da sua trilha.');
      post = { kind: 'trilha', text: body, tracks: chosen };
    } else if (muralMode === 'pedido') {
      if (!body) return toast('Escreva o que você quer ouvir.');
      post = { kind: 'pedido', text: body };
    } else {
      const track = now && muralAttach ? { albumId: now.album.id, trackId: now.track.id } : null;
      if (!body && !track) return toast('Escreva um recado.');
      post = { kind: 'recado', text: body, track };
    }
    const btn = $('#mural-form [type=submit]');
    btn.disabled = true;
    try {
      if (DEMO) muralPosts = [{ id: `d${Date.now()}`, name: user?.displayName || 'Você', mine: true, owner: isOwnerView(), likes: 0, liked: false, at: Date.now(), replies: [], status: '', ...post }, ...muralPosts];
      else muralPosts = await community.addPost(post, user?.displayName || '');
      if (text) text.value = '';
      if (muralMode === 'trilha') trilhaDraft = [null, null, null];
      toast(muralMode === 'pedido' ? 'Pedido enviado' : 'Publicado no mural');
      paintMural();
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
  const act = async (fn) => { try { muralPosts = await fn(); paintMural(); } catch (err) { toast(err.message); } };
  const demoMap = (id, fn) => muralPosts.map((p) => (p.id === id ? fn(p) : p));
  $$('[data-like]', el).forEach((b) => {
    b.onclick = () => act(async () => (DEMO ? demoMap(b.dataset.like, (p) => ({ ...p, liked: !p.liked, likes: p.likes + (p.liked ? -1 : 1) })) : community.likePost(b.dataset.like)));
  });
  $$('[data-del]', el).forEach((b) => {
    b.onclick = () => act(async () => (DEMO ? muralPosts.filter((p) => p.id !== b.dataset.del) : community.deletePost(b.dataset.del)));
  });
  $$('[data-status]', el).forEach((b) => {
    b.onclick = () => act(async () => {
      const next = byId(b.dataset.status)?.status === 'atendido' ? '' : 'atendido';
      return DEMO ? demoMap(b.dataset.status, (p) => ({ ...p, status: next })) : community.setStatus(b.dataset.status, next);
    });
  });
  $$('[data-reply]', el).forEach((b) => {
    b.onclick = () => { replyOpen = replyOpen === b.dataset.reply ? null : b.dataset.reply; paintMural(); $(`[data-reply-form="${CSS.escape(b.dataset.reply)}"] input`)?.focus(); };
  });
  $$('[data-reply-form]', el).forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = f.querySelector('input').value.trim();
      if (!v) return;
      const id = f.dataset.replyForm;
      replyOpen = null;
      act(async () => (DEMO
        ? demoMap(id, (p) => ({ ...p, replies: [...(p.replies || []), { name: user?.displayName || 'Você', text: v, at: Date.now(), mine: true, owner: isOwnerView() }] }))
        : community.replyPost(id, v, user?.displayName || '')));
    };
  });
  $$('[data-post-play]', el).forEach((b) => {
    b.onclick = () => { const item = trackFor(byId(b.dataset.postPlay)?.track); if (item) playQueue([item], 0); };
  });
  $$('[data-trilha-play]', el).forEach((b) => {
    b.onclick = () => {
      const items = (byId(b.dataset.trilhaPlay)?.tracks || []).map(trackFor).filter(Boolean);
      if (items.length) playQueue(items, Math.min(Number(b.dataset.i), items.length - 1));
    };
  });
  $$('[data-trilha-share]', el).forEach((b) => {
    b.onclick = async () => {
      const p = byId(b.dataset.trilhaShare);
      const items = (p?.tracks || []).map((r, i) => ({ r, it: trackFor(r), i })).filter((x) => x.it).map(({ r, it, i }) => ({
        label: r.label || TRILHA_LABELS[i], title: it.track.title, artist: it.track.artist || it.album.artist || '', cover: it.album.cover || '',
      }));
      toast('Preparando o cartão…');
      shareImageBlob(await stats.drawTrilha({ name: p.name, items }), 'minha-trilha-rytmo.png');
    };
  });
}
const TRILHA_LABELS_DRAFT = [...TRILHA_LABELS];

// Escolher uma música da biblioteca (para a trilha)
function pickTrack() {
  return new Promise((resolve) => {
    const all = library.albums.flatMap((album) => album.tracks.map((track) => ({ track, album })));
    const card = openModal(`
      <div class="modal-head"><h2>Escolha a música</h2><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><div class="field"><input id="pick-q" placeholder="Buscar por música, artista ou álbum" /></div><div class="pick-list" id="pick-list"></div></div>`);
    let list = [];
    const paint = (q) => {
      const n = q.trim().toLowerCase();
      list = (n ? all.filter(({ track, album }) => `${track.title} ${track.artist || ''} ${album.artist || ''} ${album.title}`.toLowerCase().includes(n)) : all).slice(0, 50);
      $('#pick-list', card).innerHTML = list.length ? list.map(({ track, album }, i) => `
        <button class="pick-item" data-pick-i="${i}">${coverHTML(album, 'cover-sm')}<span><b>${esc(track.title)}</b><small>${esc(track.artist || album.artist || '')} • ${esc(album.title)}</small></span></button>`).join('')
        : '<p class="empty">Nada encontrado.</p>';
      $$('[data-pick-i]', card).forEach((b) => { b.onclick = () => { closeModal(); resolve(list[b.dataset.pickI]); }; });
    };
    $('#pick-q', card).oninput = (e) => paint(e.target.value);
    $$('[data-close]', card).forEach((b) => b.addEventListener('click', () => resolve(null)));
    paint('');
    setTimeout(() => $('#pick-q', card)?.focus(), 50);
  });
}

// ----- Resumo de escuta -----
let rytmoPeriod = 'month';
const PERIODS = { month: 'Este mês', year: 'Este ano', all: 'Desde sempre' };
const periodLabel = (p) => {
  const now = new Date();
  if (p === 'month') return now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  if (p === 'year') return String(now.getFullYear());
  return 'desde sempre';
};

function rytmoCardHTML() {
  const s = stats.summary('month');
  return `
    <a class="rytmo-card" href="#/rytmo/resumo">
      <div><b>Seu rytmo</b><span>${s.minutes ? `${s.minutes.toLocaleString('pt-BR')} min ouvidos este mês` : 'Veja o que você mais ouve'}</span></div>
      ${STATS_SVG}
    </a>`;
}

function rytmoData(period) {
  const s = stats.summary(period);
  const trackItem = (id) => library.albums.flatMap((album) => album.tracks.filter((t) => t.id === id).map((track) => ({ track, album })))[0];
  return {
    ...s,
    trackItems: s.tracks.map(([id, n]) => ({ item: trackItem(id), n })).filter((x) => x.item),
    albumItems: s.albums.map(([id, n]) => ({ album: albumById(id), n })).filter((x) => x.album),
  };
}

function renderResumoTab() {
  const el = ryBody('resumo');
  if (!el) return;
  const d = rytmoData(rytmoPeriod);
  const plays = (n) => `${n} ${n === 1 ? 'vez' : 'vezes'}`;
  el.innerHTML = `
    <div class="ry-row">
      <div class="rytmo-tabs">${Object.entries(PERIODS).map(([k, label]) => `<button class="${k === rytmoPeriod ? 'on' : ''}" data-period="${k}">${label}</button>`).join('')}</div>
      ${d.plays ? `<button class="btn btn-primary btn-sm" id="rytmo-share">${SHARE_SVG}<span class="lbl">Compartilhar</span></button>` : ''}
    </div>
    ${d.plays ? `
      <div class="rytmo-big">
        <div><b>${d.minutes.toLocaleString('pt-BR')}</b><span>minutos ouvidos</span></div>
        <div><b>${d.plays.toLocaleString('pt-BR')}</b><span>músicas tocadas</span></div>
      </div>
      <h2>Artistas mais ouvidos</h2>
      <ol class="rytmo-list">${d.artists.map(([name, n], i) => `
        <li><span class="rytmo-n">${i + 1}</span><a href="#/artist/${encodeURIComponent(name)}">${esc(name)}</a><small>${plays(n)}</small></li>`).join('')}</ol>
      <h2>Músicas mais tocadas</h2>
      <ol class="rytmo-list">${d.trackItems.map(({ item, n }, i) => `
        <li data-rytmo-track="${i}"><span class="rytmo-n">${i + 1}</span>${coverHTML(item.album, 'cover-sm')}
          <div class="rytmo-text"><b>${esc(item.track.title)}</b><span>${esc(item.track.artist || item.album.artist || '')}</span></div><small>${plays(n)}</small></li>`).join('')}</ol>
      <h2>Álbuns mais tocados</h2>
      <div class="grid">${d.albumItems.map(({ album }) => albumCard(album)).join('')}</div>`
    : '<p class="empty">Ainda não há nada contado neste período. As músicas entram aqui depois de 30 segundos tocando.</p>'}`;
  $$('[data-period]', el).forEach((b) => { b.onclick = () => { rytmoPeriod = b.dataset.period; renderResumoTab(); }; });
  $$('[data-rytmo-track]', el).forEach((row) => {
    row.onclick = () => playQueue(d.trackItems.map((x) => x.item), Number(row.dataset.rytmoTrack));
  });
  if ($('#rytmo-share')) $('#rytmo-share').onclick = () => shareRytmo(d);
}

async function shareRytmo(d) {
  toast('Preparando o cartão…');
  const blob = await stats.drawCard({
    label: periodLabel(rytmoPeriod),
    minutes: d.minutes,
    plays: d.plays,
    cover: d.albumItems[0]?.album.cover || d.trackItems[0]?.item.album.cover || '',
    artists: d.artists.map(([name]) => name),
    tracks: d.trackItems.map(({ item }) => item.track.title),
  });
  shareImageBlob(blob, `seu-rytmo-${rytmoPeriod}.png`);
}

async function shareImageBlob(blob, name) {
  const file = new File([blob], name, { type: 'image/png' });
  // Apps de Mac e iPhone/iPad: o próprio sistema mostra a janela de compartilhar/salvar.
  if (drive.NATIVE) {
    const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    return window.webkit.messageHandlers.rytmo.postMessage({ type: 'shareImage', name, dataUrl });
  }
  if (navigator.canShare?.({ files: [file] })) {
    try { return await navigator.share({ files: [file], title: 'rytmo.' }); } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ----- Placar do mês -----
// Top 10 músicas de todo mundo que ouve, quem mais ouviu, mais curtidos e mais recados.
// Só nomes aparecem; cada um pode sair do placar. Sem o servidor novo: o seu próprio top 10.
let boardCache = null;
const MEDALS = ['🥇', '🥈', '🥉'];

function demoBoard() {
  const refs = library.albums.flatMap((album) => album.tracks.slice(0, 4).map((track) => ({ albumId: album.id, trackId: track.id }))).slice(0, 10);
  return {
    month: '', hidden: false,
    tracks: refs.map((r, i) => ({ ...r, seconds: (10 - i) * 1300 + 200, listeners: 10 - i })),
    listen: [['Ana', 41000], ['Você', 32500, true], ['Bruno', 21000], ['Carla', 9000]].map(([name, seconds, mine]) => ({ name, seconds, mine: !!mine })),
    likes: [{ name: 'Ana', n: 12 }, { name: 'Carla', n: 7 }, { name: 'Você', n: 3, mine: true }],
    posts: [{ name: 'Bruno', n: 6 }, { name: 'Ana', n: 4 }, { name: 'Você', n: 2, mine: true }],
  };
}

async function loadBoard() {
  if (DEMO) return (boardCache ??= demoBoard());
  if (!communityOn) return null;
  try { boardCache = await community.leaderboard(); } catch { boardCache = null; }
  return boardCache;
}

async function renderPlacarTab() {
  let el = ryBody('placar');
  if (!el) return;
  if (!boardCache) el.innerHTML = '<p class="empty">Carregando o placar…</p>';
  else paintPlacar(el, boardCache);
  const data = await loadBoard();
  el = ryBody('placar');
  if (el) paintPlacar(el, data);
}

function paintPlacar(el, data) {
  const monthName = new Date().toLocaleDateString('pt-BR', { month: 'long' });
  // top 10 músicas: de todo mundo (servidor) ou, sem ele, o seu próprio
  let tracks = (data?.tracks || []).map((t) => ({ item: trackFor(t), seconds: t.seconds, listeners: t.listeners })).filter((t) => t.item);
  const mineOnly = !tracks.length;
  if (mineOnly) {
    const d = rytmoData('month');
    tracks = d.trackItems.slice(0, 10).map(({ item, n }) => ({ item, plays: n }));
  }
  const people = (list, fmt) => (list?.length ? `<ol class="board-people">${list.map((p, i) => `
    <li class="${p.mine ? 'me' : ''}"><span class="board-pos">${MEDALS[i] || i + 1}</span><b>${esc(p.mine ? `${p.name} (você)` : p.name)}</b><small>${fmt(p)}</small></li>`).join('')}</ol>`
    : '<p class="empty">Ninguém por aqui ainda neste mês.</p>');
  const [first, ...rest] = tracks;
  el.innerHTML = `
    <div class="ry-row"><h2 class="ry-h2">Top 10 músicas de ${esc(monthName)}</h2>
      ${tracks.length ? `<button class="btn btn-primary btn-sm" id="board-play">${PLAY_SMALL_SVG}<span class="lbl">Tocar o top 10</span></button>` : ''}</div>
    ${mineOnly && tracks.length ? '<p class="board-note">O seu top 10. O placar de todo mundo aparece quando o servidor da comunidade estiver atualizado.</p>' : ''}
    ${first ? `
      <button class="board-first" data-board="0">${coverHTML(first.item.album)}
        <span><small>🏆 Nº 1 do mês</small><b>${esc(first.item.track.title)}</b><em>${esc(first.item.track.artist || first.item.album.artist || '')}</em>
        <i>${first.seconds ? `${fmtDur(first.seconds)} ouvidos${first.listeners ? ` • ${first.listeners} ${first.listeners === 1 ? 'pessoa' : 'pessoas'}` : ''}` : `${first.plays} ${first.plays === 1 ? 'vez' : 'vezes'}`}</i></span>${PLAY_SMALL_SVG}</button>
      <ol class="board-tracks" start="2">${rest.map((t, i) => `
        <li data-board="${i + 1}"><span class="board-pos">${i + 2}</span>${coverHTML(t.item.album, 'cover-sm')}
          <div class="rytmo-text"><b>${esc(t.item.track.title)}</b><span>${esc(t.item.track.artist || t.item.album.artist || '')}</span></div>
          <small>${t.seconds ? fmtDur(t.seconds) : `${t.plays}×`}</small></li>`).join('')}</ol>`
    : '<p class="empty">Ainda não há músicas contadas neste mês. Elas entram aqui enquanto todo mundo ouve.</p>'}
    ${data ? `
      <div class="board-grid">
        <section class="board-card"><h3>🎧 Quem mais ouviu</h3>${people(data.listen, (p) => fmtDur(p.seconds))}</section>
        <section class="board-card"><h3>❤️ Mais curtidos no Mural</h3>${people(data.likes, (p) => `${p.n} curtida${p.n === 1 ? '' : 's'}`)}</section>
        <section class="board-card"><h3>💬 Mais recados</h3>${people(data.posts, (p) => `${p.n} recado${p.n === 1 ? '' : 's'}`)}</section>
      </div>
      <label class="board-opt"><input type="checkbox" id="board-show" ${data.hidden ? '' : 'checked'} /> Mostrar meu nome no placar</label>` : ''}`;
  const items = tracks.map((t) => t.item);
  $$('[data-board]', el).forEach((b) => { b.onclick = () => playQueue(items, Number(b.dataset.board)); });
  if ($('#board-play')) $('#board-play').onclick = () => playQueue(items, 0);
  if ($('#board-show')) {
    $('#board-show').onchange = async (e) => {
      const show = e.target.checked;
      try {
        boardCache = DEMO ? { ...boardCache, hidden: !show } : await community.setBoard(show, user?.displayName || '');
        toast(show ? 'Seu nome aparece no placar' : 'Seu nome saiu do placar');
        const cur = ryBody('placar');
        if (cur) paintPlacar(cur, boardCache);
      } catch (err) { toast(err.message); e.target.checked = !show; }
    };
  }
}

// ----- Visitantes (só o dono) -----
async function renderVisitorsTab() {
  let el = ryBody('visitantes');
  if (!el) return;
  el.innerHTML = '<p class="empty">Carregando visitantes…</p>';
  let data;
  try {
    data = DEMO ? { sheetUrl: '', listeners: [
      { email: 'ana@exemplo.com', name: 'Ana', first: Date.now() - 20 * 864e5, last: Date.now() - 3600e3, visits: 14, seconds: 5 * 3600 + 1200, listenAt: Date.now() - 120e3, lastTrack: 'Vinheta A Bolha Nervosa — A Bolha', optIn: true },
      { email: 'bruno@exemplo.com', name: 'Bruno', first: Date.now() - 4 * 864e5, last: Date.now() - 864e5, visits: 3, seconds: 2400, listenAt: Date.now() - 864e5, lastTrack: 'LP O Kkrecão 1 — ZZ Club', optIn: false },
    ] } : await community.listeners();
  } catch (e) {
    el = ryBody('visitantes');
    if (el) el.innerHTML = `<p class="empty">Não foi possível carregar: ${esc(e.message)}</p>`;
    return;
  }
  el = ryBody('visitantes');
  if (!el) return;
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const list = [...data.listeners].sort((a, b) => (b.listenAt || b.last) - (a.listenAt || a.last));
  const total = list.reduce((s, l) => s + (l.seconds || 0), 0);
  const week = list.filter((l) => Date.now() - (l.listenAt || l.last) < 7 * 864e5).length;
  el.innerHTML = `
    <div class="ry-row"><h2 class="ry-h2">Visitantes</h2>
      <div class="row-actions">
        ${data.sheetUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(data.sheetUrl)}" target="_blank" rel="noopener">Planilha</a>` : ''}
        <button class="btn btn-primary btn-sm" id="csv">Exportar CSV</button>
      </div></div>
    <div class="rytmo-big ry-mini">
      <div><b>${list.length}</b><span>pessoas</span></div>
      <div><b>${fmtDur(total)}</b><span>ouvidas no total</span></div>
      <div><b>${week}</b><span>ativas nesta semana</span></div>
    </div>
    <div class="visitors">${list.length ? list.map((l) => `
      <div class="visitor">
        <div class="post-av">${esc((l.name || l.email || '?')[0].toUpperCase())}</div>
        <div class="visitor-body">
          <b>${esc(l.email)}</b><span>${esc(l.name || '')}</span>
          <dl>
            <div><dt>Estava ouvindo</dt><dd>${l.listenAt ? `${fmtDate(l.listenAt)}${l.lastTrack ? ` • ${esc(l.lastTrack)}` : ''}` : 'ainda não tocou nada'}</dd></div>
            <div><dt>Tempo ouvindo</dt><dd>${fmtDur(l.seconds)}</dd></div>
            <div><dt>Acessos</dt><dd>${l.visits || 0} • último em ${fmtDate(l.last)}</dd></div>
          </dl>
        </div>
      </div>`).join('') : '<p class="empty">Ninguém entrou pelo link de ouvinte ainda.</p>'}</div>`;
  $('#csv').onclick = () => {
    const lines = [['email', 'nome', 'primeiro_acesso', 'ultimo_acesso', 'acessos', 'ouvindo_em', 'ultima_musica', 'minutos_ouvidos', 'aceita_novidades'],
      ...list.map((l) => [l.email, l.name || '', fmtDate(l.first), fmtDate(l.last), l.visits, fmtDate(l.listenAt), l.lastTrack || '', Math.round((l.seconds || 0) / 60), l.optIn ? 'sim' : 'nao'])];
    const csv = lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'rytmo-visitantes.csv';
    a.click();
  };
}

// ----- Tempo ouvido: avisa o servidor a cada minuto tocando -----
let pingSecs = 0;
let pingLastT = 0;
let pingOff = false;
function countListening() {
  const t = performance.now();
  if (!audio.paused && pingLastT) pingSecs += Math.min(2, (t - pingLastT) / 1000);
  pingLastT = audio.paused ? 0 : t;
}
async function sendPing() {
  if (pingOff || DEMO || !communityOn || pingSecs < 5 || !queue[qi]) return;
  const secs = Math.round(pingSecs);
  pingSecs = 0;
  const { track, album } = queue[qi];
  try {
    await community.ping(secs, { albumId: album.id, trackId: track.id }, `${track.title} — ${track.artist || album.artist || ''}`, user?.displayName || '');
  } catch (e) { if (/desconhecida/i.test(e.message)) pingOff = true; }
}
setInterval(sendPing, 60000);
document.addEventListener('visibilitychange', () => { if (document.hidden) sendPing(); });

// ---------- iPhone deitado: menu na faixa da direita ----------
// No iPhone deitado sobra uma faixa preta do lado (relógio, bateria e câmera). O menu de
// ícones vai para lá e a tela principal ganha o espaço da esquerda.
// Navegador no iPhone comum (lado menor < 500 pt; não no iPad, no iPhone duo/dobrável nem nos apps): só em pé. O Safari não deixa travar a
// rotação, então com o celular deitado aparece um aviso por cima (a música segue tocando).
function bindWebPhonePortrait() {
  const html = document.documentElement;
  const check = () => html.classList.toggle('web-phone', !drive.NATIVE && Math.min(screen.width, screen.height) < 500 && matchMedia('(pointer: coarse)').matches);
  check();
  addEventListener('resize', check);
}

function bindSideRail() {
  const html = document.documentElement;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)';
  document.body.append(probe);
  const check = () => {
    const cs = getComputedStyle(probe);
    const side = Math.max(parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0);
    const on = side >= 20 && matchMedia('(pointer: coarse) and (orientation: landscape) and (min-width: 700px)').matches;
    // iPhone: a câmera fica de um dos lados; o menu vai para o lado livre (direita, se der)
    const phone = matchMedia('(max-height: 560px)').matches;
    const angle = screen.orientation?.angle ?? window.orientation ?? 90;
    // a câmera só atrapalha no app (no navegador o menu fica sempre à direita, como no app no iPad)
    const cameraRight = drive.NATIVE && phone && (angle === 270 || angle === -90);
    // Toque em tela larga (iPad, iPhone deitado): player à esquerda e menu de vidro flutuando
    const glass = matchMedia('(pointer: coarse) and (min-width: 861px)').matches;
    html.classList.toggle('glass-nav', glass);
    // altura real do mini player (no navegador ele é mais alto): o menu fica sempre acima dele
    const player = $('.player');
    const below = player && player.offsetHeight ? Math.max(0, innerHeight - player.getBoundingClientRect().top) : 0;
    if (below) html.style.setProperty('--below-player', `${Math.round(below)}px`);
    html.classList.toggle('glass-left', glass && cameraRight);
    // sem faixa lateral larga (iPad): o vidro flutua sobre o conteúdo, que ganha uma margem
    const free = cameraRight ? parseFloat(cs.paddingLeft) || 0 : parseFloat(cs.paddingRight) || 0;
    html.classList.toggle('glass-over', glass && free < 70);
    html.style.setProperty('--side-r', `${Math.round(parseFloat(cs.paddingRight) || 0)}px`);
    html.style.setProperty('--side-l', `${Math.round(parseFloat(cs.paddingLeft) || 0)}px`);
    html.classList.toggle('rail-side', on && !glass);
    html.classList.toggle('rail-right', on && !glass && !cameraRight);
    html.classList.toggle('rail-left', on && !glass && cameraRight);
    if (on) html.style.setProperty('--rail-w', `${Math.round(Math.max(56, side))}px`);
  };
  check();
  // a faixa do lado só tem medida depois que a página termina de se ajustar à tela
  [150, 600, 1500].forEach((ms) => setTimeout(check, ms));
  addEventListener('load', check);
  addEventListener('resize', check);
  addEventListener('orientationchange', () => setTimeout(check, 250));
  screen.orientation?.addEventListener?.('change', () => setTimeout(check, 250));
  bindGlassNav();
}

// Menu de vidro: só ícones; ao tocar (ou passar o dedo por cima) ele se abre e mostra o
// nome de cada um. Deslizando o dedo pelos ícones e soltando em um, vai para ele.
function bindGlassNav() {
  const html = document.documentElement;
  const bar = $('.sidebar');
  let timer = 0;
  let over = null;
  let skipClick = false;
  const open = () => { if (!html.classList.contains('glass-nav')) return; clearTimeout(timer); html.classList.add('nav-open'); };
  const closeSoon = (ms = 1800) => { clearTimeout(timer); timer = setTimeout(() => html.classList.remove('nav-open'), ms); };
  const mark = (a) => { over = a; $$('.nav a', bar).forEach((x) => x.classList.toggle('hover', x === a)); };
  bar.addEventListener('pointerdown', (e) => { open(); mark(e.target.closest('.nav a')); });
  bar.addEventListener('contextmenu', (e) => e.preventDefault()); // sem menu de link ao segurar
  const mouse = () => matchMedia('(hover: hover) and (pointer: fine)').matches; // o iPad simula "mouse" depois do toque
  bar.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && mouse()) open(); });
  bar.addEventListener('pointermove', (e) => {
    if (!html.classList.contains('nav-open')) return;
    mark(document.elementFromPoint(e.clientX, e.clientY)?.closest('.sidebar .nav a') || null);
  });
  bar.addEventListener('pointerup', (e) => {
    const start = e.target.closest('.nav a');
    if (e.pointerType === 'touch' && over && over !== start) { skipClick = true; location.hash = over.getAttribute('href'); }
    mark(null);
    closeSoon();
  });
  bar.addEventListener('click', (e) => { if (skipClick) { skipClick = false; e.preventDefault(); } }, true);
  bar.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && mouse()) { mark(null); closeSoon(500); } });
  bar.addEventListener('pointercancel', () => { mark(null); closeSoon(); });
  document.addEventListener('pointerdown', (e) => { if (!bar.contains(e.target)) html.classList.remove('nav-open'); });
}

// ---------- Arrastar para voltar ----------
// Só em páginas de detalhe (álbum, artista, playlist…), como no iPhone: a página anterior
// aparece por baixo enquanto o dedo arrasta, e soltar longe (ou rápido) volta para ela.
let swipeUnder = null;
function endSwipe() {
  const main = $('#main');
  main.classList.remove('swiping', 'swipe-out', 'swipe-cancel');
  main.style.removeProperty('--sx');
  main.style.removeProperty('--sp');
  swipeUnder?.remove();
  swipeUnder = null;
}

function bindSwipeBack() {
  const main = $('#main');
  const view = $('#view');
  let g = null;
  const canSwipe = () => {
    const page = location.hash.split('/')[1] || '';
    return !TOP_PAGES.has(page) && pageStack.length && pageStack[pageStack.length - 1].hash !== location.hash;
  };
  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || npOpen() || swipeUnder || !canSwipe()) return;
    if (e.target.closest('input, textarea, select, .np-seek, [data-noswipe]')) return;
    g = { x: e.clientX, y: e.clientY, id: e.pointerId, dir: null, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
  });
  main.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.dir && Math.hypot(dx, dy) > 10) {
      g.dir = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3 ? 'back' : 'none';
      if (g.dir === 'back') {
        // monta a página anterior por baixo, no mesmo ponto da rolagem em que ficou
        const top = pageStack[pageStack.length - 1];
        swipeUnder = document.createElement('div');
        swipeUnder.className = 'swipe-under';
        swipeUnder.style.top = `${main.scrollTop}px`;
        swipeUnder.style.height = `${main.clientHeight}px`;
        top.el.className = 'view';
        top.el.style.transform = `translateY(${view.offsetTop - top.scroll}px)`;
        swipeUnder.append(top.el);
        main.append(swipeUnder);
        main.classList.add('swiping');
      }
    }
    if (g.dir !== 'back') return;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.v = (e.clientX - g.lastX) / dt;
    g.lastX = e.clientX;
    g.lastT = e.timeStamp;
    const x = Math.max(0, dx);
    main.style.setProperty('--sx', `${x}px`);
    main.style.setProperty('--sp', Math.min(1, x / main.clientWidth).toFixed(3));
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.type === 'pointerup' ? e.clientX - g.x : 0;
    const back = g.dir === 'back';
    const go = back && (dx > main.clientWidth * 0.33 || (dx > 40 && g.v > 0.4));
    g = null;
    if (!back) return;
    main.classList.remove('swiping');
    if (go) {
      main.classList.add('swipe-out');
      setTimeout(() => history.back(), 200); // a rota coloca a página guardada no lugar
      setTimeout(() => { if (swipeUnder) endSwipe(); }, 1200); // garantia
    } else {
      main.classList.add('swipe-cancel');
      setTimeout(() => { if (!main.classList.contains('swiping')) endSwipe(); }, 240);
    }
  };
  main.addEventListener('pointerup', end);
  main.addEventListener('pointercancel', end);
}

// ---------- Sobre ----------

function openAbout() {
  const where = drive.NATIVE ? (IS_IOS ? 'App para iPhone e iPad' : 'App para Mac') : isInstalled() ? 'App da tela inicial' : 'Versão web';
  openModal(`
    <div class="modal-head"><h2>Sobre</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body about">
      <svg class="about-mark" viewBox="0 0 64 48" aria-hidden="true"><use href="#mark" /></svg>
      <div class="about-name">rytmo<b>.</b></div>
      <p class="about-tag">Sua música, no seu Google Drive.</p>
      <p class="about-version">Versão ${esc(CONFIG.APP_VERSION)} • ${where}</p>
      <p class="about-copy">Copyright © 2027 KBT Productions MuitoKRUEL. Ltd.</p>
      <a class="about-link" href="https://kbtlab.net/rytmo/privacidade.html" target="_blank" rel="noopener">Política de Privacidade</a>
    </div>`);
}
window.rytmoAbout = openAbout; // menu "Sobre o rytmo." do app de Mac

const RADIO_SVG = '<svg viewBox="0 0 24 24"><path d="M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7.8 7.8l1.4 1.4a4 4 0 0 0 0 5.6l-1.4 1.4a6 6 0 0 1 0-8.4zm8.4 0a6 6 0 0 1 0 8.4l-1.4-1.4a4 4 0 0 0 0-5.6zM5 5l1.4 1.4a8 8 0 0 0 0 11.2L5 19A10 10 0 0 1 5 5zm14 0a10 10 0 0 1 0 14l-1.4-1.4a8 8 0 0 0 0-11.2z"/></svg>';
const MIX_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7h3.5l7 10H17v-3l4 4-4 4v-3h-4.5l-7-10H3zm14-4 4 4-4 4V8h-3.5l-1.8 2.6-1.2-1.7L12.5 6H17zM3 15h3.5l1.8-2.6 1.2 1.7L7.5 17H3z"/></svg>';
const CHAT_SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2zm3 5v2h10V9zm0 4v2h7v-2z"/></svg>';
const HEART_SVG = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';
const PLAY_SMALL_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const STATS_SVG = '<svg viewBox="0 0 24 24"><path d="M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2.6 7.8 6.8l1.4 1.4L11 6.4V15h2V6.4l1.8 1.8 1.4-1.4zM5 11v10h14V11h-3v2h1v6H7v-6h1v-2z"/></svg>';
const QUEUE_SVG = '<svg viewBox="0 0 24 24"><path d="M3 5h13v2H3zm0 5h13v2H3zm0 5h8v2H3zm12 0 6 3.5-6 3.5z"/></svg>';
const QUEUE_NEXT_SVG = '<svg viewBox="0 0 24 24"><path d="M3 10h12v2H3zm0-5h12v2H3zm0 10h8v2H3zm13-1v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24"><path d="M12.3 2a8 8 0 0 0 8.7 10.6A9 9 0 1 1 11.4 2z"/></svg>';
const AIRPLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1l-1.6-2H20V5H4v10h2.6zm7-3 6 7H6z"/></svg>';

// ---------- Eventos gerais ----------

function bindChrome() {
  bindPlayer();
  bindNowPanel();

  offline.onChange(paintDownloads);
  const paintOnline = () => {
    document.documentElement.classList.toggle('is-offline', offlineNow());
    paintMode();
  };
  const backOnline = () => {
    paintOnline();
    if (offlineMode && drive.NATIVE && !READONLY) askDrive(true);
    else if (offlineMode && drive.hasValidToken()) reconnect();
  };
  window.addEventListener('online', backOnline);
  window.addEventListener('offline', paintOnline);
  paintOnline();

  // Cliques em cards / botões renderizados dinamicamente.
  $('#view').addEventListener('click', (e) => {
    const playBtn = e.target.closest('[data-play-album]');
    if (playBtn) {
      e.stopPropagation();
      const album = albumById(playBtn.dataset.playAlbum);
      if (album?.tracks.length) playQueue(album.tracks.map((track) => ({ track, album })), 0);
      return;
    }
    const plPlay = e.target.closest('[data-play-playlist]');
    if (plPlay) {
      e.stopPropagation();
      const items = playlistItems(playlistById(plPlay.dataset.playPlaylist));
      if (items.length) playQueue(items, 0);
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) return pick.dataset.pick === 'single' ? pickAndImport('files', { kind: 'single' }) : pickAndImport(PICK);
    const card = e.target.closest('[data-open]');
    if (card) location.hash = card.dataset.open;
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });

  $('#btn-share').onclick = openShare;
  $('#btn-share').classList.toggle('hidden', DEMO || READONLY);
  $('#btn-import').onclick = () => pickAndImport(PICK);
  $('#dropzone-mini').onclick = () => pickAndImport(PICK);

  $('#search').addEventListener('input', () => {
    if (!location.hash.startsWith('#/search')) location.hash = '#/search';
    else renderSearch();
  });

  $('#btn-logout').onclick = () => {
    if (!DEMO) drive.signOut();
    try { localStorage.removeItem(USER_KEY); } catch {}
    location.href = location.pathname + (LISTEN_ID ? location.search : '');
  };
}

// ---------- Compartilhar (link de ouvinte) ----------

// Mostra o motivo que o Google devolveu (ex.: "Drive 403: {error:{message:...}}").
function driveErrorMessage(e) {
  const text = String(e?.message || e);
  try { return JSON.parse(text.slice(text.indexOf('{'))).error.message; } catch { return text.slice(0, 160); }
}

// Arquivos que o ouvinte precisa ler: o library.json e todas as músicas.
function sharedFileIds() {
  return [drive.libraryId(), ...library.albums.flatMap((a) => a.tracks.map((t) => t.id))].filter(Boolean);
}

function listenLink() {
  return `${CONFIG.PUBLIC_URL}?ouvir=${encodeURIComponent(drive.libraryId() || '')}`;
}

function openShare() {
  const on = !!library.sharing;
  const card = openModal(`
    <div class="modal-head"><h2>Compartilhar para ouvir</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="modal-body">
      <p class="share-text">Quem abrir o link entra com a própria conta Google e pode <b>apenas ouvir</b> seus álbuns,
        singles e playlists. Ninguém consegue editar, apagar ou enviar músicas.</p>
      ${on ? `
        <div class="field"><label>Link de ouvinte</label>
          <div class="share-row"><input id="share-link" readonly value="${esc(listenLink())}" />
          <button class="btn btn-primary" id="share-copy">Copiar</button></div></div>
        <p class="share-text small">As músicas que você adicionar depois também ficam disponíveis no link.</p>`
      : `<p class="share-text small">Ao gerar o link, suas músicas e a biblioteca no Google Drive passam a poder ser lidas
          por quem tiver o link. Você pode desligar quando quiser.</p>`}
    </div>
    <div class="modal-foot">
      ${on ? '<button class="btn btn-danger" id="share-off">Parar de compartilhar</button>' : ''}
      <button class="btn btn-ghost" data-close>Fechar</button>
      ${on ? '' : '<button class="btn btn-primary" id="share-on">Gerar link de ouvinte</button>'}
    </div>`);

  if (on) {
    $('#share-copy', card).onclick = async () => {
      const input = $('#share-link', card);
      input.select();
      try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
      toast('Link copiado');
    };
    $('#share-off', card).onclick = async () => {
      if (!confirm('Parar de compartilhar? O link deixa de funcionar para todos.')) return;
      const btn = $('#share-off', card);
      btn.disabled = true;
      try {
        library.sharing = false;
        await persist();
        await drive.setSharing(sharedFileIds(), false, (d, n) => { btn.textContent = `Desligando ${d}/${n}…`; });
        toast('Compartilhamento desligado');
        openShare();
      } catch (e) {
        console.error(e);
        toast('Não foi possível desligar o compartilhamento');
      }
    };
  } else {
    $('#share-on', card).onclick = async () => {
      const btn = $('#share-on', card);
      btn.disabled = true;
      try {
        library.sharing = true;
        library.ownerName = user?.displayName || '';
        await persist(); // garante que o library.json exista (o link aponta para ele)
        const failed = await drive.setSharing(sharedFileIds(), true, (d, n) => { btn.textContent = `Compartilhando ${d}/${n}…`; });
        if (failed.length) toast(`${failed.length} arquivo(s) não puderam ser compartilhados`, 6000);
        openShare();
      } catch (e) {
        console.error(e);
        library.sharing = false;
        toast(`Não foi possível compartilhar: ${driveErrorMessage(e)}`, 10000);
        btn.disabled = false;
        btn.textContent = 'Gerar link de ouvinte';
      }
    };
  }
}

boot();
