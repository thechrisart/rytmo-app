// Modo ouvinte: lê a biblioteca e as músicas compartilhadas pelo dono com a chave de API.
// Nada é gravado: o visitante só ouve.
import { CONFIG } from './config.js';
import { getProfile } from './drive.js';

const API = 'https://www.googleapis.com/drive/v3';

export function listenStore(libraryId) {
  const cache = new Map(); // fileId -> objectURL (LRU pequeno)

  async function get(id) {
    const res = await fetch(`${API}/files/${id}?alt=media&key=${CONFIG.API_KEY}`);
    if (!res.ok) throw new Error(res.status === 404 || res.status === 403
      ? 'Este link não está mais compartilhado.' : `Drive ${res.status}`);
    return res;
  }

  return {
    async loadLibrary() { return (await get(libraryId)).json(); },
    async getAudioUrl(id) {
      if (cache.has(id)) return cache.get(id);
      const url = URL.createObjectURL(await (await get(id)).blob());
      cache.set(id, url);
      if (cache.size > 6) {
        const [oldId, oldUrl] = cache.entries().next().value;
        URL.revokeObjectURL(oldUrl);
        cache.delete(oldId);
      }
      return url;
    },
    getUser: getProfile,
  };
}
