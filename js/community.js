// Comunidade: conversa com o servidor do dono (no VPS: server/community.py, em kbtlab.net/rytmo/api).
// Antes era o Google Apps Script (apps-script/Code.gs); os dados de lá são copiados na primeira vez.
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
export const status = () => call('status');
export const claim = () => call('claim');
export const listPosts = async () => (await call('listPosts')).posts;
export const addPost = async (post, name) => (await call('post', { ...post, name })).posts;
export const replyPost = async (id, text, name) => (await call('reply', { id, text, name })).posts;
export const setStatus = async (id, status) => (await call('setStatus', { id, status })).posts;
export const ping = (seconds, track, label, name) => call('ping', { seconds, track, label, name });
export const nowPlaying = async () => (await call('nowPlaying')).now;
export const leaderboard = () => call('leaderboard');
export const setBoard = (show, name) => call('setBoard', { show, name });
export const deletePost = async (id) => (await call('deletePost', { id })).posts;
export const likePost = async (id) => (await call('likePost', { id })).posts;
