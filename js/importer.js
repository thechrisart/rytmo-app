// Importação: arrastar pastas/arquivos → revisar álbum (capa, nome, artista) → enviar ao Google Drive.
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from './config.js';
import { $, $$, esc, fmtTime, coverHTML, toast, openModal, closeModal, resizeImage, imageToJpeg, pickFile } from './ui.js';

let ctx; // { store, getLibrary, persist, onChange }
let uploading = 0;

const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', alac: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma',
};

const ext = (name) => name.split('.').pop().toLowerCase();
const isAudio = (name) => AUDIO_EXTENSIONS.includes(ext(name));
const isImage = (name) => IMAGE_EXTENSIONS.includes(ext(name));

export function initImporter(context) {
  ctx = context;
  bindDragAndDrop();
  $('#file-input').onchange = (e) => handleInputFiles(e.target);
  $('#folder-input').onchange = (e) => handleInputFiles(e.target);
  window.addEventListener('beforeunload', (e) => {
    if (uploading > 0) e.preventDefault();
  });
}

let presetForNextPick = null;

export function pickAndImport(kind, preset = null) {
  presetForNextPick = preset;
  $(kind === 'files' ? '#file-input' : '#folder-input').click();
}

function handleInputFiles(input) {
  const list = [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  input.value = '';
  openImporter(list, presetForNextPick);
  presetForNextPick = null;
}

// ---------- Arrastar e soltar ----------

function bindDragAndDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const list = await filesFromDataTransfer(e.dataTransfer);
    openImporter(list);
  });
}

async function filesFromDataTransfer(dt) {
  // As entries precisam ser lidas antes de qualquer await.
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const out = [];

  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }

  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  for (const entry of entries) await walk(entry, '');
  return out;
}

// ---------- Agrupar arquivos em álbuns ----------

function cleanTitle(fileName, artist) {
  let t = fileName.replace(/\.[^.]+$/, '');
  t = t.replace(/^\s*(?:\d{1,2}[-.])?\d{1,3}(?:\s*[-._)]\s*|\s+)/, ''); // "01 - ", "1-02 ", "07. "
  if (artist && t.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) t = t.slice(artist.length + 3);
  return t.replace(/_/g, ' ').trim() || fileName;
}

function guessFromFolder(dir) {
  const parts = dir.split('/').filter(Boolean);
  const folder = parts.at(-1) || '';
  // "Artista - Álbum (2020)"
  const m = folder.match(/^(.+?)\s+-\s+(.+?)(?:\s*[([](\d{4})[)\]])?$/);
  if (m) return { artist: m[1], title: m[2], year: m[3] || '' };
  const y = folder.match(/^(.*?)\s*[([](\d{4})[)\]]$/);
  return { artist: parts.length > 1 ? parts.at(-2) : '', title: y ? y[1] : folder, year: y ? y[2] : '' };
}

function pickCoverFile(images) {
  const pref = /(cover|folder|front|capa|album)/i;
  return images.find((f) => pref.test(f.name)) || images[0] || null;
}

function getDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    a.src = url;
  });
}

async function buildGroups(list, preset) {
  const byDir = new Map();
  for (const { file, path } of list) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!byDir.has(dir)) byDir.set(dir, { audio: [], images: [] });
    if (isAudio(file.name)) byDir.get(dir).audio.push(file);
    else if (isImage(file.name)) byDir.get(dir).images.push(file);
  }

  const groups = [];
  for (const [dir, { audio, images }] of byDir) {
    if (!audio.length) continue;
    audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Pasta = álbum; músicas soltas = faixas solo (singles), a não ser que o preset diga outra coisa.
    const base = dir ? guessFromFolder(dir) : { title: 'Músicas avulsas', artist: '', year: '' };
    const guess = { ...base, ...(preset || {}) };
    const kind = guess.kind || (dir ? 'album' : 'single');
    const coverFile = pickCoverFile(images);
    const cover = preset?.cover || (coverFile ? await resizeImage(coverFile).catch(() => null) : null);
    const tracks = await Promise.all(audio.map(async (file) => ({
      file,
      title: cleanTitle(file.name, guess.artist),
      duration: await getDuration(file),
    })));
    groups.push({ kind, title: guess.title, artist: guess.artist, year: guess.year || '', cover, coverSource: coverFile, tracks });
  }
  return groups;
}

// ---------- Modal de revisão ----------

export async function openImporter(list, preset = null) {
  const audioCount = list.filter(({ file }) => isAudio(file.name)).length;
  if (!audioCount) {
    toast('Nenhum arquivo de áudio encontrado (MP3, WAV, FLAC, M4A, OGG…)');
    return;
  }
  openModal(`<div class="modal-body"><p class="empty">Lendo ${audioCount} músicas…</p></div>`);
  const groups = await buildGroups(list, preset);
  renderImporter(groups);
}

function renderImporter(groups) {
  const total = groups.reduce((s, g) => s + g.tracks.length, 0);
  const card = openModal(`
    <div class="modal-head">
      <h2>Adicionar ${total} música${total > 1 ? 's' : ''}</h2>
      <button class="icon-btn" data-close>✕</button>
    </div>
    <div class="modal-body">
      ${groups.map((g, gi) => `
        <div class="group" data-g="${gi}">
          <div class="cover-pick" data-cover="${gi}">${coverHTML(g)}<div class="cover-hint">Escolher<br/>capa</div></div>
          <div class="fields">
            <div class="field full"><label>Cadastrar como</label>
              <select data-f="kind">
                <option value="album" ${g.kind === 'album' ? 'selected' : ''}>Álbum (todas as faixas juntas)</option>
                <option value="single" ${g.kind === 'single' ? 'selected' : ''}>Faixas solo (cada música vira um single)</option>
              </select></div>
            <div class="field full" data-title-field ${g.kind === 'single' ? 'hidden' : ''}><label>Nome do álbum</label><input data-f="title" value="${esc(g.title)}" /></div>
            <div class="field"><label>Artista</label><input data-f="artist" value="${esc(g.artist)}" placeholder="Artista" /></div>
            <div class="field"><label>Ano</label><input data-f="year" value="${esc(g.year)}" placeholder="—" /></div>
          </div>
          <div class="group-tracks">
            ${g.tracks.map((t, ti) => `
              <div class="gt"><span>${ti + 1}</span>
                <input data-t="${ti}" value="${esc(t.title)}" />
                <span class="gt-ext">${esc(ext(t.file.name))}</span>
                <span>${fmtTime(t.duration)}</span></div>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="imp-go">${ctx.demo ? 'Adicionar (demo)' : 'Enviar para o Google Drive'}</button>
    </div>`);

  $$('[data-cover]', card).forEach((el) => {
    el.onclick = async () => {
      const file = await pickFile('image/*');
      if (!file) return;
      const g = groups[Number(el.dataset.cover)];
      g.cover = await resizeImage(file);
      g.coverSource = file;
      $('.cover', el).outerHTML = coverHTML(g);
    };
  });

  $$('[data-f=kind]', card).forEach((sel) => {
    sel.onchange = () => { sel.closest('.group').querySelector('[data-title-field]').hidden = sel.value === 'single'; };
  });

  $('#imp-go', card).onclick = () => {
    $$('.group', card).forEach((el) => {
      const g = groups[Number(el.dataset.g)];
      g.title = $('[data-f=title]', el).value.trim() || 'Sem título';
      g.artist = $('[data-f=artist]', el).value.trim();
      g.year = $('[data-f=year]', el).value.trim();
      g.kind = $('[data-f=kind]', el).value;
      $$('[data-t]', el).forEach((inp) => { g.tracks[Number(inp.dataset.t)].title = inp.value.trim() || g.tracks[Number(inp.dataset.t)].file.name; });
    });
    closeModal();
    uploadGroups(groups);
  };
}

// ---------- Capa no Google Drive ----------

// Nome do arquivo da capa: "cover.jpg" na pasta do álbum; singles dividem a pasta
// "Artista - Singles", então cada um tem o próprio arquivo.
const coverName = (album) => (album.kind === 'single' ? `cover - ${album.title}.jpg` : 'cover.jpg');

// Envia (ou substitui) a capa na pasta do álbum. Não interrompe nada se falhar.
export async function storeCover(album, source) {
  if (!album.folderId || !ctx.store.saveCover) return;
  try {
    const blob = await imageToJpeg(source);
    album.coverFileId = await ctx.store.saveCover(blob, album.folderId, coverName(album), album.coverFileId);
  } catch (e) {
    console.error('Falha ao salvar a capa no Drive', e);
  }
}

// ---------- Upload ----------

const panel = () => $('#uploads');

async function uploadGroups(groups) {
  const all = groups.flatMap((g) => g.tracks);
  let done = 0;
  uploading++;
  panel().classList.remove('hidden');
  panel().innerHTML = `<h4><span>Enviando para o Drive</span><span id="up-count">0/${all.length}</span></h4><div id="up-list"></div>`;
  const list = $('#up-list');

  for (const g of groups) {
    const library = ctx.getLibrary();
    const single = g.kind === 'single';
    const folderName = single ? `${g.artist || 'Sem artista'} - Singles` : g.artist ? `${g.artist} - ${g.title}` : g.title;
    let album;
    try {
      const folderId = await ctx.store.createAlbumFolder(folderName);
      album = single ? null : library.albums.find((a) => a.kind !== 'single' && a.title.toLowerCase() === g.title.toLowerCase() && (a.artist || '').toLowerCase() === g.artist.toLowerCase());
      if (single) {
        // cada faixa vira um lançamento próprio (criado depois do envio)
      } else if (!album) {
        album = { id: crypto.randomUUID(), title: g.title, artist: g.artist, year: g.year, cover: g.cover, folderId, createdAt: Date.now(), tracks: [] };
        library.albums.push(album);
      } else if (g.cover && !album.cover) {
        album.cover = g.cover;
      } else {
        g.coverSource = null; // álbum existente já tem capa: não troca
      }
      if (!single && g.coverSource) await storeCover(album, g.coverSource);

      const results = new Array(g.tracks.length);
      const queue = g.tracks.map((t, i) => [t, i]);
      const worker = async () => {
        while (queue.length) {
          const [t, i] = queue.shift();
          const row = document.createElement('div');
          row.className = 'up-item';
          row.innerHTML = `<div class="up-name">${esc(t.title)}</div><div class="up-bar"><i></i></div>`;
          list.prepend(row);
          try {
            const type = t.file.type || MIME[ext(t.file.name)] || 'application/octet-stream';
            const file = new File([t.file], t.file.name, { type });
            const res = await ctx.store.uploadFile(file, folderId, (p) => ($('i', row).style.width = `${p * 100}%`));
            results[i] = { id: res.id, title: t.title, duration: t.duration, fileName: t.file.name, mimeType: type, size: t.file.size };
            // link de ouvinte ligado: a música nova também fica disponível para quem ouve
            if (library.sharing) await ctx.store.shareFile?.(res.id, true).catch((e) => console.error(e));
            row.classList.add('done');
          } catch (e) {
            console.error(e);
            row.classList.add('error');
            $('.up-name', row).textContent = `Falhou: ${t.title}`;
          }
          $('#up-count').textContent = `${++done}/${all.length}`;
        }
      };
      await Promise.all([worker(), worker(), worker()]); // 3 envios em paralelo

      if (single) {
        for (const r of results.filter(Boolean)) {
          const s = { id: crypto.randomUUID(), kind: 'single', title: r.title, artist: g.artist, year: g.year, cover: g.cover, folderId, createdAt: Date.now(), tracks: [r] };
          library.albums.push(s);
          if (g.coverSource) await storeCover(s, g.coverSource);
        }
      } else {
        album.tracks.push(...results.filter(Boolean));
        if (!album.tracks.length) library.albums = library.albums.filter((a) => a !== album);
      }
      ctx.onChange();
      await ctx.persist();
    } catch (e) {
      console.error(e);
      toast(`Erro ao enviar "${g.title}"`);
    }
  }

  uploading--;
  toast(`${done} música${done > 1 ? 's' : ''} adicionada${done > 1 ? 's' : ''} à sua biblioteca`);
  setTimeout(() => uploading || panel().classList.add('hidden'), 4000);
}
