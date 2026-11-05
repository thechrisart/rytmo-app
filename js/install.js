// Instalar o site como app (PWA): atalho na tela inicial, em tela cheia e abrindo sem internet.
// Android e Chrome/Edge: o navegador abre o próprio pedido de instalação (beforeinstallprompt).
// iPhone/iPad: a Apple não deixa o site instalar sozinho, então um balão aponta o caminho no Safari.
// Nos apps de Mac e iPhone/iPad (já instalados) nada disto aparece.
import { IS_IOS, toast } from './ui.js';

const NATIVE = !!window.webkit?.messageHandlers?.rytmo;
const DISMISS_KEY = 'rytmo.installDismissed';
const DISMISS_DAYS = 30;
const SHARE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2.6 7.8 6.8l1.4 1.4L11 6.4V15h2V6.4l1.8 1.8 1.4-1.4zM5 11v10h14V11h-3v2h1v6H7v-6h1v-2z"/></svg>';
const PLUS_BOX_SVG = '<svg viewBox="0 0 24 24"><path d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zm5 3h2v3h3v2h-3v3h-2v-3H8v-2h3z"/></svg>';

let deferredPrompt = null;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

export const isInstalled = () => NATIVE || navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
export const canInstall = () => !isInstalled() && (IS_IOS || !!deferredPrompt);
export const onInstallChange = (fn) => listeners.add(fn);

// O cartão do início pode ser dispensado; o botão da Biblioteca continua lá.
export function shouldSuggest() {
  if (!canInstall()) return false;
  try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) > DISMISS_DAYS * 864e5; } catch { return true; }
}
export function dismissSuggestion() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
  changed();
}

export async function install() {
  if (!deferredPrompt) return showIosHint();
  const prompt = deferredPrompt;
  deferredPrompt = null; // o navegador só deixa usar uma vez
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome !== 'accepted') dismissSuggestion();
  changed();
}

// Balão com seta apontando para onde está o botão em cada navegador. O site não tem como saber
// se a pessoa tocou em Compartilhar, então o balão mostra os dois toques de uma vez.
export function showIosHint() {
  closeIosHint();
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|WhatsApp|TikTok|GSA\//.test(ua);
  const isChrome = /CriOS/.test(ua);
  const safariMajor = Number((ua.match(/Version\/(\d+)/) || [])[1] || 0);
  // Safari 26 no iPhone: o Compartilhar fica dentro do menu ••• no canto de baixo.
  const moreMenu = !isIPad && !isChrome && safariMajor >= 26;
  let place = 'bottom-center';
  if (isIPad || isChrome) place = 'top-right';
  else if (moreMenu) place = 'bottom-right';

  const hint = document.createElement('div');
  hint.id = 'install-hint';
  hint.className = `install-hint ${place}`;
  hint.innerHTML = inAppBrowser
    ? `<div class="hint-box"><p class="hint-only">Abra este link no <b>Safari</b> para instalar o rytmo.</p>
        <button class="hint-close" aria-label="Fechar">✕</button></div>`
    : `<div class="hint-box">
        <img src="assets/icon-180.png" alt="" />
        <ol>
          <li>Toque em ${moreMenu ? '<b>•••</b> e em ' : ''}<span class="hint-icon">${SHARE_SVG}</span> <b>Compartilhar</b></li>
          <li>Escolha <span class="hint-icon">${PLUS_BOX_SVG}</span> <b>Adicionar à Tela de Início</b></li>
        </ol>
        <button class="hint-close" aria-label="Fechar">✕</button>
      </div>
      <i class="hint-arrow"></i>`;
  hint.addEventListener('click', closeIosHint); // tocar em qualquer lugar fecha
  document.body.append(hint);
}

function closeIosHint() {
  document.getElementById('install-hint')?.remove();
}

// HTML e cliques do cartão e dos botões (data-install / data-install-dismiss), em qualquer tela.
export function installCardHTML() {
  return `
    <section class="install-card">
      <img src="assets/icon-180.png" alt="" />
      <div class="install-text"><b>Tenha o rytmo na tela inicial</b><span>Abre mais rápido, em tela cheia e toca o que você baixou mesmo sem internet.</span></div>
      <div class="install-actions">
        <button class="btn btn-primary" data-install>Instalar</button>
        <button class="btn btn-ghost" data-install-dismiss>Agora não</button>
      </div>
    </section>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-install]')) install();
  else if (e.target.closest('[data-install-dismiss]')) dismissSuggestion();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // quem decide a hora de oferecer é o app, sem aviso genérico do navegador
  deferredPrompt = e;
  changed();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  toast('rytmo instalado! Abra pelo ícone na tela inicial.', 5000);
  changed();
});

if (!NATIVE && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('PWA indisponível', e)));
}
