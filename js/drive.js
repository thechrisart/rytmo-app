// Camada do Google Drive: login (Google Identity Services) + chamadas à Drive API v3.
// Tudo roda no navegador — não existe servidor do Rytmo no meio.
import { CONFIG } from './config.js';
import { IS_IOS } from './ui.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// .v2: o login do dono passou a pedir também o e-mail (comunidade); tokens antigos são ignorados.
let TOKEN_KEY = 'rytmo.token.v2';
let SCOPES = CONFIG.SCOPES;
const ACCOUNT_KEY = 'rytmo.account'; // última conta usada (para renovar o login sem perguntar)

let tokenClient = null;
let token = null;
let expiresAt = 0;
let pending = null; // { resolve, reject, state } da solicitação de token em andamento
let rootFolderId = null;
let libraryFileId = null;
let playbackFileId = null;

// Modo ouvinte (link ?ouvir=): o visitante entra com o Google só para se identificar.
// Não pede acesso ao Drive dele; as músicas do dono são lidas com a chave de API.
export function configureListener() {
  SCOPES = 'openid email profile';
  TOKEN_KEY = 'rytmo.token.listen';
}

// ---------- Autenticação ----------
// No navegador: popup do Google Identity Services.
// Nos apps de Mac e iPhone/iPad com CONFIG.NATIVE_CLIENT_ID: o app faz o login em Swift
// (GoogleAuth.swift) e guarda um refresh token, então fica logado até tocar em "Sair".
// Sem NATIVE_CLIENT_ID, o app de Mac usa o jeito antigo: navegador padrão → oauth-callback.html
// → servidor local → window.rytmoNativeToken (o login dura 1 hora).
// No iPhone/iPad pela Tela de Início: a página vai até o Google e volta (sem popup, que o iOS
// bloqueia); oauth-callback.html guarda o token. Ao abrir, renova sozinho se o Google deixar.

export const NATIVE = !!window.webkit?.messageHandlers?.rytmo;
const NATIVE_AUTH = NATIVE && !!CONFIG.NATIVE_CLIENT_ID;
const REDIRECT = !NATIVE && IS_IOS;
const storage = NATIVE || REDIRECT ? localStorage : sessionStorage;
const REDIRECT_URI = new URL('oauth-callback.html', location.href.split(/[?#]/)[0]).href;

export function isConfigured() {
  return CONFIG.CLIENT_ID && !CONFIG.CLIENT_ID.startsWith('COLE_');
}

function waitForGoogle() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > 10000) return reject(new Error('Não foi possível carregar o login do Google.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// A pessoa entrou e não tocou em "Sair": vale mesmo com o token vencido. Assim o app abre
// com a biblioteca guardada em vez de voltar para a tela de login.
const sessionKey = () => `${TOKEN_KEY}.session`;
export function hasSession() {
  try { return localStorage.getItem(sessionKey()) === '1'; } catch { return false; }
}
function markSession() {
  try { localStorage.setItem(sessionKey(), '1'); } catch {}
}

let onToken = null;
export function onTokenRenewed(fn) { onToken = fn; }

function acceptToken(accessToken, expiresIn) {
  token = accessToken;
  expiresAt = Date.now() + (Number(expiresIn) - 60) * 1000;
  try { storage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt })); } catch {}
  markSession();
  onToken?.();
}

export async function initAuth() {
  if (NATIVE) {
    window.rytmoNativeToken = (query) => {
      const p = new URLSearchParams(query);
      if (!pending || p.get('state') !== pending.state) return;
      const errors = { access_denied: 'login cancelado.', drive_permission: 'na tela do Google, marque a opção do Google Drive para o rytmo ver suas músicas.' };
      if (p.get('error')) return pending.reject(new Error(errors[p.get('error')] || p.get('error')));
      acceptToken(p.get('access_token'), p.get('expires_in'));
      pending.resolve();
    };
  } else if (!REDIRECT) {
    await waitForGoogle();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) return pending?.reject(new Error(resp.error_description || resp.error));
        acceptToken(resp.access_token, resp.expires_in);
        pending?.resolve();
      },
      error_callback: (err) => pending?.reject(new Error(err.message || err.type || 'Login cancelado')),
    });
  }

  // Reaproveita o token salvo (evita pedir login a cada F5 / abertura do app).
  try {
    const saved = JSON.parse(storage.getItem(TOKEN_KEY) || 'null');
    if (saved) markSession();
    if (saved && saved.expiresAt > Date.now()) ({ token, expiresAt } = saved);
  } catch {}
  if (hasValidToken()) return true;

  // App instalado: renova em silêncio com o refresh token guardado no aparelho.
  if (NATIVE_AUTH) {
    try {
      await Promise.race([signIn('none'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 15000))]);
    } catch {}
    return hasValidToken();
  }
  // iPhone/iPad pela Tela de Início: se já entrou antes, volta ao Google sem perguntar nada
  // (prompt=none). Se o Google pedir a senha, volta com erro e mostra a tela de login.
  if (REDIRECT && loginHint() && navigator.onLine) {
    let tried = false;
    try { tried = sessionStorage.getItem('rytmo.silentTried') === '1'; sessionStorage.setItem('rytmo.silentTried', '1'); } catch {}
    if (!tried) {
      signIn('none');
      return new Promise(() => {}); // a página vai para o Google e volta
    }
  }
  return false;
}

export function hasValidToken() {
  return !!token && Date.now() < expiresAt;
}

export function signIn(prompt = '') {
  return new Promise((resolve, reject) => {
    if (!NATIVE && !REDIRECT) {
      pending = { resolve, reject };
      return tokenClient.requestAccessToken({ prompt, login_hint: loginHint() });
    }
    // "web:" diz à oauth-callback.html para guardar o token e voltar ao app.
    const state = (REDIRECT ? 'web:' : '') + crypto.randomUUID();
    pending = { resolve, reject, state };
    if (NATIVE_AUTH) {
      return window.webkit.messageHandlers.rytmo.postMessage({
        type: 'auth', clientId: CONFIG.NATIVE_CLIENT_ID, scope: SCOPES, state, loginHint: loginHint(), prompt, key: TOKEN_KEY,
      });
    }
    if (REDIRECT) {
      // a página de retorno precisa saber onde guardar o token e para onde voltar
      localStorage.setItem('rytmo.oauthState', state);
      localStorage.setItem('rytmo.oauthKey', TOKEN_KEY);
      localStorage.setItem('rytmo.oauthReturn', location.href.split('#')[0]);
    }
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state,
    });
    if (loginHint()) url.searchParams.set('login_hint', loginHint());
    if (prompt) url.searchParams.set('prompt', prompt);
    if (REDIRECT) location.assign(url.toString());
    else window.webkit.messageHandlers.rytmo.postMessage({ type: 'openURL', url: url.toString() });
  });
}

export function signOut() {
  if (NATIVE_AUTH) window.webkit.messageHandlers.rytmo.postMessage({ type: 'signOut', key: TOKEN_KEY });
  if (token) {
    if (NATIVE || REDIRECT) fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' }).catch(() => {});
    else google.accounts.oauth2.revoke(token, () => {});
  }
  token = null;
  expiresAt = 0;
  try {
    storage.removeItem(TOKEN_KEY);
    localStorage.removeItem(sessionKey());
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {}
}

// Qualquer conta Google pode entrar; a renovação do login usa a última conta.
function loginHint() {
  try { return localStorage.getItem(ACCOUNT_KEY) || CONFIG.GOOGLE_ACCOUNT || ''; } catch { return CONFIG.GOOGLE_ACCOUNT || ''; }
}

// Perfil do visitante (modo ouvinte), no mesmo formato de getUser().
export async function getProfile() {
  const res = await authed('https://www.googleapis.com/oauth2/v3/userinfo');
  const p = await res.json();
  try { localStorage.setItem(ACCOUNT_KEY, p.email); } catch {}
  return { displayName: p.name, emailAddress: p.email, photoLink: p.picture };
}

// Liga/desliga "qualquer pessoa com o link pode ver" em um arquivo.
// (A pasta inteira não pode ser compartilhada: com a permissão drive.file o Google
// só deixa o app compartilhar os arquivos que ele mesmo criou.)
export async function shareFile(id, on) {
  if (on) {
    await authed(`${API}/files/${id}/permissions?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  } else {
    await authed(`${API}/files/${id}/permissions/anyoneWithLink`, { method: 'DELETE' }).catch(() => {});
  }
}

// Compartilha vários arquivos (4 por vez), avisando o progresso.
export async function setSharing(ids, on, onProgress) {
  const queue = [...ids];
  let done = 0;
  const failed = [];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await shareFile(id, on); } catch (e) { console.error(e); failed.push(id); }
      onProgress?.(++done, ids.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return failed;
}

export const libraryId = () => libraryFileId;

export async function getUser() {
  const res = await authed(`${API}/about?fields=user(displayName,emailAddress,photoLink)`);
  const { user } = await res.json();
  try { localStorage.setItem(ACCOUNT_KEY, user.emailAddress); } catch {}
  return user;
}

// Token válido para chamar outros serviços (ex.: o servidor da comunidade).
export async function getToken() {
  if (!hasValidToken()) await signIn('');
  return token;
}

async function authed(url, opts = {}, retry = true) {
  if (!hasValidToken()) await signIn('');
  const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) {
    token = null;
    return authed(url, opts, false);
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`);
  return res;
}

// ---------- Pastas ----------

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findOrCreateFolder(name, parentId) {
  let query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const res = await authed(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`);
  const { files } = await res.json();
  if (files.length) return files[0].id;

  const created = await authed(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined }),
  });
  return (await created.json()).id;
}

async function getRoot() {
  if (!rootFolderId) rootFolderId = await findOrCreateFolder(CONFIG.ROOT_FOLDER_NAME);
  return rootFolderId;
}

export async function createAlbumFolder(name) {
  return findOrCreateFolder(name, await getRoot());
}

// ---------- Biblioteca (library.json dentro da pasta Rytmo) ----------

export async function loadLibrary() {
  const root = await getRoot();
  const query = `name='library.json' and '${root}' in parents and trashed=false`;
  const res = await authed(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)`);
  const { files } = await res.json();
  if (!files.length) return { version: 1, albums: [] };
  libraryFileId = files[0].id;
  const data = await authed(`${API}/files/${libraryFileId}?alt=media`);
  return data.json();
}

export async function saveLibrary(library) {
  const body = new Blob([JSON.stringify(library)], { type: 'application/json' });
  const form = new FormData();
  if (libraryFileId) {
    form.append('metadata', new Blob(['{}'], { type: 'application/json' }));
    form.append('file', body);
    await authed(`${UPLOAD}/files/${libraryFileId}?uploadType=multipart`, { method: 'PATCH', body: form });
  } else {
    const meta = { name: 'library.json', parents: [await getRoot()], mimeType: 'application/json' };
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', body);
    const res = await authed(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', body: form });
    libraryFileId = (await res.json()).id;
  }
}

// ---------- Onde parou (playback.json dentro da pasta Rytmo) ----------
// Música e segundo em que a pessoa parou, para continuar em qualquer aparelho.
// Fica num arquivo separado do library.json: é gravado com frequência e é pequeno.

export async function loadPlayback() {
  if (!hasValidToken() && !NATIVE_AUTH) return null; // nunca abre o login só para isso
  const root = await getRoot();
  const query = `name='playback.json' and '${root}' in parents and trashed=false`;
  const res = await authed(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)`);
  const { files } = await res.json();
  if (!files.length) return null;
  playbackFileId = files[0].id;
  return (await authed(`${API}/files/${playbackFileId}?alt=media`)).json();
}

export async function savePlayback(state) {
  if (!hasValidToken()) return; // nunca abre o login só para isso
  const body = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const form = new FormData();
  if (playbackFileId) {
    form.append('metadata', new Blob(['{}'], { type: 'application/json' }));
    form.append('file', body);
    await authed(`${UPLOAD}/files/${playbackFileId}?uploadType=multipart`, { method: 'PATCH', body: form, keepalive: true });
  } else {
    const meta = { name: 'playback.json', parents: [await getRoot()], mimeType: 'application/json' };
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', body);
    const res = await authed(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', body: form });
    playbackFileId = (await res.json()).id;
  }
}

// ---------- Upload de arquivos (resumable, com progresso) ----------

export async function uploadFile(file, parentId, onProgress) {
  const init = await authed(`${UPLOAD}/files?uploadType=resumable&fields=id,size,mimeType`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.type || 'application/octet-stream',
    },
    body: JSON.stringify({ name: file.name, parents: [parentId] }),
  });
  const location = init.headers.get('Location');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText)));
    xhr.onerror = () => reject(new Error('Falha de rede no upload'));
    xhr.send(file);
  });
}

// ---------- Reprodução: baixa direto do Drive ----------

const blobCache = new Map(); // fileId -> objectURL (cache pequeno, LRU simples)
const CACHE_MAX = 6;

export async function getAudioUrl(fileId) {
  if (blobCache.has(fileId)) {
    const url = blobCache.get(fileId);
    blobCache.delete(fileId);
    blobCache.set(fileId, url);
    return url;
  }
  const res = await authed(`${API}/files/${fileId}?alt=media`);
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(fileId, url);
  if (blobCache.size > CACHE_MAX) {
    const [oldId, oldUrl] = blobCache.entries().next().value;
    URL.revokeObjectURL(oldUrl);
    blobCache.delete(oldId);
  }
  return url;
}

// Capa do álbum na pasta do álbum. Se já existe (fileId), o mesmo arquivo é
// substituído — assim a pasta nunca acumula capas antigas.
export async function saveCover(blob, folderId, name, fileId) {
  const send = (meta, url, method) => {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);
    return authed(url, { method, body: form });
  };
  if (fileId) {
    try {
      await send({ name, trashed: false }, `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id`, 'PATCH');
      return fileId;
    } catch (e) {
      console.warn('Capa anterior não encontrada, criando outra', e);
    }
  }
  const res = await send({ name, parents: [folderId], mimeType: 'image/jpeg' }, `${UPLOAD}/files?uploadType=multipart&fields=id`, 'POST');
  return (await res.json()).id;
}

// Move para a lixeira do Drive (recuperável por 30 dias).
export async function trashFile(fileId) {
  await authed(`${API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
