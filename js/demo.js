// Modo demo (?demo): mesma interface do drive.js, mas tudo fica só na memória do navegador.
// Útil para testar a interface sem configurar o Google Cloud.
const files = new Map();
let n = 0;

export const demoStore = {
  async loadLibrary() {
    // Para testes: uma biblioteca de exemplo pode ser posta em sessionStorage['rytmo.demoLibrary'].
    try { return JSON.parse(sessionStorage.getItem('rytmo.demoLibrary')) || { version: 1, albums: [] }; } catch { return { version: 1, albums: [] }; }
  },
  async saveLibrary() {},
  async createAlbumFolder(name) { return `demo-folder:${name}`; },
  async uploadFile(file, _parentId, onProgress) {
    for (let p = 0.25; p <= 1; p += 0.25) {
      await new Promise((r) => setTimeout(r, 120));
      onProgress?.(p);
    }
    const id = `demo-${++n}`;
    files.set(id, URL.createObjectURL(file));
    return { id };
  },
  async getAudioUrl(id) { return files.get(id); },
  async trashFile() {},
  async shareFile() {},
  async saveCover(_blob, _folderId, _name, fileId) { return fileId || `demo-cover-${++n}`; },
  async getUser() { return { displayName: 'Visitante', emailAddress: 'modo demo' }; },
  async getToken() { return 'demo'; },
};
