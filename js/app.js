import * as drive from './drive.js';
import { demoStore } from './demo.js';
import { listenStore } from './listen.js';
import { CONFIG } from './config.js';
import * as community from './community.js';
import * as offline from './offline.js';
import { canInstall, shouldSuggest, installCardHTML, onInstallChange } from './install.js';
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

// O app abriu com a biblioteca guardada e o acesso ao Drive voltou: atualiza tudo.
function reconnect() {
  if (!offlineMode) return Promise.resolve();
  reconnect.job ||= doReconnect().finally(() => { reconnect.job = null; });
  return reconnect.job;
}

async function doReconnect() {
  try {
    const fresh = await store.loadLibrary();
    library = fresh;
    library.albums ||= [];
    library.playlists ||= [];
    library.artists ||= {};
    offlineMode = false;
    offline.saveLibrary(library, LIBRARY_CACHE_KEY);
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
  try {
    if (offlineMode) throw new Error('offline');
    library = await store.loadLibrary();
    if (!DEMO) offline.saveLibrary(library, LIBRARY_CACHE_KEY);
  } catch (e) {
    const cached = DEMO ? null : await offline.loadLibrary(LIBRARY_CACHE_KEY);
    if (cached) {
      library = cached;
      offlineMode = true;
      paintMode();
      if (!navigator.onLine) toast('Sem internet: tocando só as músicas baixadas no aparelho', 5000);
    } else {
      toast(LISTEN_ID ? e.message : 'Erro ao carregar a biblioteca do Drive');
      console.error(e);
    }
  }
  library.albums ||= [];
  library.playlists ||= [];
  library.artists ||= {};

  // Quem entrou: as músicas vão para o Google Drive desta conta.
  if (offlineMode) {
    try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch {}
    paintUser();
  } else await loadUser();
  if (!DEMO) drive.onTokenRenewed(reconnect);

  if (!READONLY) {
    initImporter({ store, demo: DEMO, getLibrary: () => library, persist, onChange: refresh });
    if (!offlineMode) backfillCovers();
  }
  bindChrome();
  refresh();
  loadCommunity();
  restorePlayback();
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
  if (!DEMO) offline.saveLibrary(library, LIBRARY_CACHE_KEY);
  saving = saving.then(() => store.saveLibrary(library)).catch((e) => {
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
      albums: [...library.albums].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(albumInfo),
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

function route() {
  if ($('#app').classList.contains('hidden')) return;
  const [, page = '', param = ''] = location.hash.split('/');
  const id = decodeURIComponent(param);
  if (location.hash !== route.last) editMode = false; // sai do modo edição ao mudar de página
  route.last = location.hash;

  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'home')));
  $$('#library-list a').forEach((a) => a.classList.toggle('active', page === 'album' && a.dataset.id === id));

  if (page === 'album') renderAlbum(id);
  else if (page === 'library') renderLibrary();
  else if (page === 'playlists') renderPlaylists();
  else if (page === 'playlist') renderPlaylist(id);
  else if (page === 'artists') renderArtists();
  else if (page === 'artist') renderArtist(id);
  else if (page === 'search') renderSearch();
  else if (page === 'ouvintes') renderListeners();
  else if (page === 'offline') renderOffline();
  else renderHome();

  $('#main').scrollTop = 0;
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
  const ul = $('#library-list');
  if (!library.albums.length) {
    ul.innerHTML = '<li class="library-empty">Sua biblioteca está vazia.<br/>Arraste uma pasta de músicas aqui.</li>';
    return;
  }
  const sorted = [...library.albums].sort((a, b) => a.title.localeCompare(b.title));
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
    ${allPlaylists().length ? `<h2>Playlists</h2><div class="grid">${allPlaylists().slice(0, 6).map(playlistCard).join('')}</div>` : ''}
    <h2>Adicionados recentemente</h2>
    <div class="grid">${recent.slice(0, 12).map(albumCard).join('')}</div>
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

function renderLibrary() {
  const albums = [...library.albums].sort((a, b) => a.title.localeCompare(b.title));
  $('#view').innerHTML = `
    <div class="page-head"><h1>Sua biblioteca</h1>
      <div class="row-actions">
        ${canInstall() ? `<button class="btn btn-ghost" data-install>${PLUS_SVG} Instalar app</button>` : ''}
        <a class="btn btn-ghost" href="#/offline">${DOWNLOAD_SVG} Baixadas${offline.count() ? ` (${offline.count()})` : ''}</a>
      </div></div>
    ${albums.length ? `<div class="grid">${albums.map(albumCard).join('')}</div>` : dropHero()}
    ${albums.length ? `<h2>Artistas</h2><div class="grid">${[...artistsMap().entries()].map(([n, a]) => artistCard(n, a)).join('')}</div>` : ''}`;
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
      ${editActions(`<button class="btn btn-ghost" id="artist-cover-btn">Trocar capa</button>
        ${library.artists[name]?.cover ? '<button class="btn btn-ghost" id="artist-cover-remove">Remover capa</button>' : ''}`)}
    </div>
    <h2>Álbuns e singles</h2>
    <div class="grid">${albums.map(albumCard).join('')}</div>
    <h2>Todas as músicas</h2>
    ${tracksTable(items, true)}`;
  $('#play-all').onclick = () => items.length && playQueue(items, 0);
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
      ${editActions(`
        <button class="btn btn-ghost" id="edit-album">Editar informações</button>
        <button class="btn btn-ghost" id="add-to-album">Adicionar músicas</button>
        <button class="btn btn-danger" id="delete-album">Excluir ${album.kind === 'single' ? 'single' : 'álbum'}</button>`)}
    </div>
    ${editMode ? '<p class="remove-hint">Use o lápis para renomear uma música e a lixeira para removê-la (vai para a lixeira do Google Drive).</p>' : ''}
    ${tracksTable(items, false, editMode ? 'edit' : 'add')}`;

  $('#play-all').onclick = () => items.length && playQueue(items, 0);
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

function renderPlaylists() {
  $('#view').innerHTML = `
    <div class="page-head"><h1>Playlists</h1>${canCreatePlaylist() ? `<button class="btn btn-primary" id="new-playlist">${PLUS_SVG} Criar playlist</button>` : ''}</div>
    ${READONLY && library.playlists.length ? `<h2>Playlists${library.ownerName ? ` de ${esc(library.ownerName)}` : ''}</h2>` : ''}
    ${library.playlists.length
      ? `<div class="grid">${library.playlists.map(playlistCard).join('')}</div>`
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
          <td><div class="t-cell">${showAlbum ? coverHTML(album, 'cover-sm') : ''}
            <div><div class="t-title">${esc(track.title)}</div><div class="t-sub">${esc(track.artist || album.artist || '')}</div></div></div></td>
          ${showAlbum ? `<td>${esc(album.title)}</td>` : ''}
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

async function loadCurrent(startAt = 0) {
  const item = queue[qi];
  if (!item) return;
  const token = ++loadToken;
  resumeAt = 0;
  updateNowPlaying();
  markPlaying();
  $('#btn-play').classList.add('loading');
  try {
    const url = (await offline.url(item.track.id)) || (offlineNow() ? null : await store.getAudioUrl(item.track.id));
    if (token !== loadToken) return;
    if (!url) {
      toast(`Sem internet: "${item.track.title}" não está baixada no aparelho`);
      return;
    }
    audio.src = url;
    if (startAt) {
      // Antes dos metadados o navegador guarda isto como ponto de partida; se não guardar, repete depois.
      audio.currentTime = startAt;
      audio.addEventListener('loadedmetadata', () => {
        if (token === loadToken && Math.abs(audio.currentTime - startAt) > 1) audio.currentTime = startAt;
      }, { once: true });
    }
    await audio.play();
    savePlayback(true);
  } catch (e) {
    if (token === loadToken) {
      console.error(e);
      toast(`Não foi possível tocar "${item.track.title}"`);
    }
  } finally {
    if (token === loadToken) $('#btn-play').classList.remove('loading');
  }
  // Pré-carrega a próxima faixa para a troca ser instantânea.
  const next = queue[nextIndex()];
  if (next && token === loadToken && !offline.has(next.track.id) && !offlineNow() && store.hasValidToken?.() !== false) store.getAudioUrl(next.track.id).catch(() => {});
}

function nextIndex() {
  if (!queue.length) return -1;
  if (shuffle) return Math.floor(Math.random() * queue.length);
  if (qi + 1 < queue.length) return qi + 1;
  return repeat === 'all' ? 0 : -1;
}

function next() {
  const ni = nextIndex();
  if (ni < 0) return playRandomAlbum(); // acabou: continua com outro álbum, sem parar
  qi = ni;
  loadCurrent();
}

// Escolhe um álbum ou single aleatório (diferente do atual) e toca do começo.
function playRandomAlbum() {
  const current = queue[qi]?.album;
  const all = library.albums.filter((a) => a.tracks.length);
  const pool = all.length > 1 ? all.filter((a) => a !== current) : all;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) return;
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
  window.addEventListener('pagehide', () => { if (hasAudio()) savePlayback(true); });
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
  document.title = `${track.title} • rytmo.`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || album.artist || '',
      album: album.title,
      artwork: album.cover ? [{ src: album.cover, sizes: '400x400', type: 'image/jpeg' }] : [],
    });
  }
}

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
const NP_HEAD = `<div class="np-head"><span>Tocando agora</span>
  <button class="np-close np-back" title="Voltar"><svg viewBox="0 0 24 24"><path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>Voltar</button></div>`;

function renderNowPanel() {
  const panel = $('#nowpanel');
  if (!panel) return;
  const item = queue[qi];
  if (!item) {
    panel.innerHTML = `${NP_HEAD}
      <p class="empty">Escolha uma música para ver a capa e as informações aqui.</p>`;
    return;
  }
  const { track, album } = item;
  const n = album.tracks.indexOf(track) + 1;
  const artist = track.artist || album.artist || 'Artista desconhecido';
  panel.innerHTML = `
    ${NP_HEAD}
    <div class="np-art">${coverHTML(album)}</div>
    <div class="np-info">
      <div class="np-name">${esc(track.title)}</div>
      <a class="np-line" href="#/artist/${encodeURIComponent(album.artist || 'Artista desconhecido')}">${esc(artist)}</a>
      <a class="np-line muted" href="#/album/${encodeURIComponent(album.id)}">${kindLabel(album)}: ${esc(album.title)}${album.year ? ` (${esc(album.year)})` : ''}</a>
      <div class="np-line muted">Faixa ${n} de ${album.tracks.length}</div>
      ${canCreatePlaylist() ? `<button class="btn btn-ghost np-add" data-np="add">${PLUS_SVG} Adicionar à playlist</button>` : ''}
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
    if (ctl === 'repeat') return cycleRepeat();
    if (e.target.closest('.np-close') || e.target.closest('a')) panel.classList.remove('open');
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

  // Arrastar a capa para o lado: esquerda = próxima, direita = anterior.
  let swipe = null;
  panel.addEventListener('pointerdown', (e) => {
    const art = e.target.closest('.np-art');
    if (art && queue[qi]) swipe = { x: e.clientX, y: e.clientY, art };
  });
  panel.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    if (Math.abs(dx) > Math.abs(e.clientY - swipe.y)) swipe.art.style.transform = `translateX(${dx * 0.6}px)`;
  });
  const endSwipe = (e) => {
    if (!swipe) return;
    const dx = e.type === 'pointerup' ? e.clientX - swipe.x : 0;
    swipe.art.style.transform = '';
    swipe = null;
    if (dx < -60) next();
    else if (dx > 60) prev();
  };
  panel.addEventListener('pointerup', endSwipe);
  panel.addEventListener('pointercancel', endSwipe);
  // Tocar na capa/nome do mini player abre o painel (celular e janelas estreitas).
  $('.np').addEventListener('click', () => { if (queue[qi]) panel.classList.add('open'); });
  audio.addEventListener('play', renderNowPanel);
  audio.addEventListener('pause', renderNowPanel);
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
};

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
  bindPlaybackSync();
  const seek = $('#seek');
  const vol = $('#volume');
  let seeking = false;

  audio.volume = Number(vol.value);
  setRange(vol, audio.volume);

  audio.addEventListener('play', () => { if (hasAudio()) $('#play-icon').innerHTML = `<path d="${PAUSE_PATH}"/>`; });
  audio.addEventListener('pause', () => $('#play-icon').innerHTML = `<path d="${PLAY_PATH}"/>`);
  audio.addEventListener('loadedmetadata', () => {
    $('#time-dur').textContent = fmtTime(audio.duration);
    fillDuration(queue[qi]?.track, audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    $('#time-cur').textContent = fmtTime(audio.currentTime);
    paintNpProgress();
    if (!seeking && audio.duration) {
      seek.value = (audio.currentTime / audio.duration) * 1000;
      setRange(seek, audio.currentTime / audio.duration);
    }
  });
  audio.addEventListener('ended', () => {
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
  vol.addEventListener('input', () => { audio.volume = Number(vol.value); setRange(vol, audio.volume); });

  $('#btn-play').onclick = togglePlay;
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#btn-back10').onclick = () => seekBy(-10);
  $('#btn-fwd10').onclick = () => seekBy(10);
  $('#btn-shuffle').onclick = toggleShuffle;
  $('#btn-repeat').onclick = cycleRepeat;

  bindLockScreen();

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') seekBy(-10);
    else if (e.code === 'ArrowRight') seekBy(10);
  });
}

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
  $('#tab-add').onclick = () => pickAndImport(PICK);

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
