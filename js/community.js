// Comunidade: conversa com o servidor do dono (Google Apps Script, ver apps-script/Code.gs).
// Guarda a lista de ouvintes e as playlists públicas dos convidados.
import { CONFIG } from './config.js';
import { getToken } from './drive.js';

export const enabled = () => !!CONFIG.COMMUNITY_URL;

async function call(action, payload = {}) {
  // text/plain evita a verificação prévia de CORS (o Apps Script não responde a ela)
  const res = await fetch(CONFIG.COMMUNITY_URL, {
    method: 'POST',
    body: JSON.stringify({ action, token: await getToken(), ...payload }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export const hello = (name, optIn) => call('hello', { name, optIn });
export const listPlaylists = async () => (await call('listPlaylists')).playlists;
export const savePlaylist = async (playlist, name) => (await call('savePlaylist', { playlist, name })).playlist;
export const deletePlaylist = (id) => call('deletePlaylist', { id });
export const listeners = () => call('listeners');
