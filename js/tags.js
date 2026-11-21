// Lê as informações gravadas dentro dos arquivos de música: nome, artista, álbum, ano,
// número da faixa/disco e a capa embutida. Formatos: MP3 (ID3v2 e ID3v1), FLAC e M4A/MP4.
// Lê só os pedaços do arquivo que precisa, então funciona rápido mesmo com álbuns grandes.
// Retorna { title, artist, albumArtist, album, year, track, disc, picture } (campos ausentes = undefined).

export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const tag4 = String.fromCharCode(...head.slice(0, 4));
    if (tag4.startsWith('ID3')) return { ...(await readId3v1(file)), ...clean(await readId3v2(file)) };
    if (tag4 === 'fLaC') return clean(await readFlac(file));
    if (String.fromCharCode(...head.slice(4, 8)) === 'ftyp') return clean(await readMp4(file));
    if (/\.mp3$/i.test(file.name)) return clean(await readId3v1(file));
  } catch (e) {
    console.warn('Não foi possível ler as informações de', file.name, e);
  }
  return {};
}

function clean(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {})) {
    if (v == null) continue;
    if (typeof v === 'string') {
      const s = v.replace(/\0+$/, '').trim();
      if (s) out[k] = s;
    } else out[k] = v;
  }
  if (out.year) out.year = (String(out.year).match(/\d{4}/) || [])[0];
  return out;
}

const bytes = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
const latin1 = (b) => String.fromCharCode(...b);
const num = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };

// ---------- MP3: ID3v2 (2.2, 2.3, 2.4) ----------

function decodeText(enc, b) {
  if (!b.length) return '';
  try {
    if (enc === 1) return new TextDecoder('utf-16').decode(b); // com BOM
    if (enc === 2) return new TextDecoder('utf-16be').decode(b);
    if (enc === 3) return new TextDecoder('utf-8').decode(b);
    // latin1 declarado, mas muito programa grava UTF-8 ("barÃ© dj"): tenta UTF-8 primeiro
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch {}
    return new TextDecoder('latin1').decode(b);
  } catch { return ''; }
}

// Fim de um texto terminado em zero (1 byte em latin1/utf-8, 2 bytes em utf-16).
function textEnd(enc, b, from) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}

async function readId3v2(file) {
  const h = await bytes(file, 0, 10);
  const ver = h[3];
  const size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
  const tag = await bytes(file, 10, 10 + size);
  const out = {};
  const v22 = ver === 2;
  const idLen = v22 ? 3 : 4;
  const headLen = v22 ? 6 : 10;
  let pos = 0;
  // cabeçalho estendido (v2.3/2.4)
  if (!v22 && h[5] & 0x40) {
    const ext = ver === 4
      ? ((tag[0] & 0x7f) << 21) | ((tag[1] & 0x7f) << 14) | ((tag[2] & 0x7f) << 7) | (tag[3] & 0x7f)
      : ((tag[0] << 24) | (tag[1] << 16) | (tag[2] << 8) | tag[3]) + 4;
    pos = ext;
  }
  const map = v22
    ? { TT2: 'title', TP1: 'artist', TP2: 'albumArtist', TAL: 'album', TYE: 'year', TRK: 'track', TPA: 'disc' }
    : { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TYER: 'year', TDRC: 'year', TRCK: 'track', TPOS: 'disc' };
  while (pos + headLen <= tag.length) {
    const id = latin1(tag.slice(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // chegou no preenchimento
    let len;
    if (v22) len = (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5];
    else if (ver === 4) len = ((tag[pos + 4] & 0x7f) << 21) | ((tag[pos + 5] & 0x7f) << 14) | ((tag[pos + 6] & 0x7f) << 7) | (tag[pos + 7] & 0x7f);
    else len = ((tag[pos + 4] << 24) | (tag[pos + 5] << 16) | (tag[pos + 6] << 8) | tag[pos + 7]) >>> 0;
    const body = tag.slice(pos + headLen, pos + headLen + len);
    pos += headLen + len;
    if (!len) continue;
    if (map[id]) {
      const text = decodeText(body[0], body.slice(1)).split('\0')[0];
      if (map[id] === 'track' || map[id] === 'disc') out[map[id]] = num(text.split('/')[0]);
      else out[map[id]] ??= text;
    } else if ((id === 'APIC' || id === 'PIC') && !out.picture) {
      const enc = body[0];
      let i = 1;
      let mime;
      if (id === 'PIC') { mime = `image/${latin1(body.slice(1, 4)).toLowerCase().replace('jpg', 'jpeg')}`; i = 4; }
      else { const e = body.indexOf(0, 1); mime = latin1(body.slice(1, e)) || 'image/jpeg'; i = e + 1; }
      i += 1; // tipo da imagem
      i = textEnd(enc, body, i) + (enc === 1 || enc === 2 ? 2 : 1); // descrição
      out.picture = new Blob([body.slice(i)], { type: mime.includes('/') ? mime : `image/${mime}` });
    }
  }
  return out;
}

// ---------- MP3: ID3v1 (últimos 128 bytes) ----------

async function readId3v1(file) {
  if (file.size < 128) return {};
  const b = await bytes(file, file.size - 128, file.size);
  if (latin1(b.slice(0, 3)) !== 'TAG') return {};
  const txt = (s, e) => new TextDecoder('latin1').decode(b.slice(s, e)).replace(/\0.*$/, '').trim();
  return clean({
    title: txt(3, 33), artist: txt(33, 63), album: txt(63, 93), year: txt(93, 97),
    track: b[125] === 0 && b[126] ? b[126] : undefined,
  });
}

// ---------- FLAC: comentários Vorbis e imagem ----------

async function readFlac(file) {
  const out = {};
  let pos = 4;
  for (let n = 0; n < 64; n++) {
    const h = await bytes(file, pos, pos + 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || (type === 6 && !out.picture)) {
      const b = await bytes(file, pos + 4, pos + 4 + len);
      if (type === 4) Object.assign(out, vorbisComments(b));
      else out.picture = flacPicture(b);
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

function vorbisComments(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = {};
  let p = 4 + dv.getUint32(0, true); // fornecedor
  const count = dv.getUint32(p, true);
  p += 4;
  const map = { TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', ALBUM: 'album', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track', DISCNUMBER: 'disc' };
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = dv.getUint32(p, true);
    const s = new TextDecoder('utf-8').decode(b.slice(p + 4, p + 4 + len));
    p += 4 + len;
    const eq = s.indexOf('=');
    const key = map[s.slice(0, eq).toUpperCase()];
    if (!key || out[key] != null) continue;
    const value = s.slice(eq + 1);
    out[key] = key === 'track' || key === 'disc' ? num(value.split('/')[0]) : value;
  }
  return out;
}

function flacPicture(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 4;
  const mimeLen = dv.getUint32(p);
  const mime = latin1(b.slice(p + 4, p + 4 + mimeLen)) || 'image/jpeg';
  p += 4 + mimeLen;
  p += 4 + dv.getUint32(p); // descrição
  p += 16; // largura, altura, profundidade, cores
  const len = dv.getUint32(p);
  return new Blob([b.slice(p + 4, p + 4 + len)], { type: mime });
}

// ---------- M4A/MP4: átomos moov > udta > meta > ilst ----------

async function readMp4(file) {
  // acha o moov entre os átomos do topo (ele pode estar no fim do arquivo)
  let pos = 0;
  let moov = null;
  while (pos + 8 <= file.size) {
    const h = await bytes(file, pos, pos + 16);
    let size = new DataView(h.buffer).getUint32(0);
    const type = latin1(h.slice(4, 8));
    let headLen = 8;
    if (size === 1) { size = Number(new DataView(h.buffer).getBigUint64(8)); headLen = 16; }
    if (size === 0) size = file.size - pos;
    if (size < headLen) break;
    if (type === 'moov') { moov = await bytes(file, pos + headLen, pos + size); break; }
    pos += size;
  }
  if (!moov) return {};
  const ilst = findAtom(moov, ['udta', 'meta', 'ilst']) || findAtom(moov, ['meta', 'ilst']);
  if (!ilst) return {};
  const out = {};
  const map = { '©nam': 'title', '©ART': 'artist', aART: 'albumArtist', '©alb': 'album', '©day': 'year' };
  forEachAtom(ilst, (type, body) => {
    const data = findAtom(body, ['data']);
    if (!data) return;
    const kind = (data[1] << 16) | (data[2] << 8) | data[3];
    const payload = data.slice(8);
    if (map[type]) out[map[type]] ??= new TextDecoder('utf-8').decode(payload);
    else if (type === 'trkn' && payload.length >= 4) out.track = ((payload[2] << 8) | payload[3]) || undefined;
    else if (type === 'disk' && payload.length >= 4) out.disc = ((payload[2] << 8) | payload[3]) || undefined;
    else if (type === 'covr' && !out.picture) out.picture = new Blob([payload], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
  });
  return out;
}

function forEachAtom(b, fn) {
  let p = 0;
  while (p + 8 <= b.length) {
    const size = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0);
    if (size < 8 || p + size > b.length) break;
    fn(new TextDecoder('latin1').decode(b.slice(p + 4, p + 8)), b.slice(p + 8, p + size));
    p += size;
  }
}

function findAtom(b, path) {
  let cur = b;
  for (const name of path) {
    let found = null;
    // "meta" tem 4 bytes de versão/flags antes dos filhos
    forEachAtom(cur, (type, body) => { if (!found && type === name) found = name === 'meta' ? body.slice(4) : body; });
    if (!found) return null;
    cur = found;
  }
  return cur;
}
