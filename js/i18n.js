// Idiomas: português (original), inglês e espanhol.
// O app é escrito em português; aqui os textos da tela são trocados na hora em que aparecem
// (um observador olha cada pedaço novo da página). Trocar o idioma recarrega o app.
const KEY = 'rytmo.lang';
export const LANGS = { pt: 'Português', en: 'English', es: 'Español' };
export const lang = (() => { try { const l = localStorage.getItem(KEY); return LANGS[l] ? l : 'pt'; } catch { return 'pt'; } })();

// português: [inglês, espanhol]
const D = {
  'Início': ['Home', 'Inicio'], 'Buscar': ['Search', 'Buscar'], 'Biblioteca': ['Library', 'Biblioteca'], 'Artistas': ['Artists', 'Artistas'],
  'Playlists': ['Playlists', 'Playlists'], 'Baixadas': ['Downloads', 'Descargas'], 'Seu rytmo': ['Your rytmo', 'Tu rytmo'],
  'Sua biblioteca': ['Your library', 'Tu biblioteca'], 'Sair': ['Sign out', 'Salir'], 'Sobre': ['About', 'Acerca de'],
  'Compartilhar': ['Share', 'Compartir'], 'O que você quer ouvir?': ['What do you want to listen to?', '¿Qué quieres escuchar?'],
  'Bom dia': ['Good morning', 'Buenos días'], 'Boa tarde': ['Good afternoon', 'Buenas tardes'], 'Boa noite': ['Good evening', 'Buenas noches'],
  'Adicionados recentemente': ['Recently added', 'Añadidos recientemente'], 'Tocadas recentemente': ['Recently played', 'Escuchadas recientemente'],
  'Seus artistas': ['Your artists', 'Tus artistas'], 'Álbuns': ['Albums', 'Álbumes'], 'Álbum': ['Album', 'Álbum'], 'ÁLBUM': ['ALBUM', 'ÁLBUM'],
  'Músicas': ['Songs', 'Canciones'], 'Título': ['Title', 'Título'], 'Duração': ['Duration', 'Duración'], 'Artista': ['Artist', 'Artista'],
  'Baixar': ['Download', 'Descargar'], 'Rádio': ['Radio', 'Radio'], 'Editar': ['Edit', 'Editar'], 'Salvar': ['Save', 'Guardar'],
  'Cancelar': ['Cancel', 'Cancelar'], 'Excluir': ['Delete', 'Eliminar'], 'Apagar': ['Delete', 'Borrar'], 'Fechar': ['Close', 'Cerrar'],
  'Nova playlist': ['New playlist', 'Nueva playlist'], 'Criar playlist': ['Create playlist', 'Crear playlist'], 'Nome': ['Name', 'Nombre'],
  'Tocando agora': ['Now playing', 'Sonando ahora'], 'Fila': ['Queue', 'Cola'], 'A seguir': ['Up next', 'A continuación'],
  'Timer para parar': ['Sleep timer', 'Temporizador'], 'Transição entre músicas': ['Crossfade', 'Transición entre canciones'],
  'Adicionar à playlist': ['Add to playlist', 'Añadir a playlist'], 'Aleatório': ['Shuffle', 'Aleatorio'], 'Repetir': ['Repeat', 'Repetir'],
  'Tenha o rytmo na tela inicial': ['Get rytmo on your home screen', 'Ten rytmo en tu pantalla de inicio'],
  'Abre mais rápido, em tela cheia e toca o que você baixou mesmo sem internet.': ['Opens faster, full screen, and plays your downloads even offline.', 'Abre más rápido, a pantalla completa y reproduce tus descargas incluso sin internet.'],
  'Instalar': ['Install', 'Instalar'], 'Agora não': ['Not now', 'Ahora no'],
  'Mural': ['Wall', 'Muro'], 'Resumo': ['Summary', 'Resumen'], 'Notícias': ['News', 'Noticias'], 'Visitantes': ['Visitors', 'Visitantes'],
  'O ponto de encontro de quem ouve esta biblioteca': ['Where everyone who listens to this library meets', 'El punto de encuentro de quienes escuchan esta biblioteca'],
  'min este mês': ['min this month', 'min este mes'], 'recados': ['posts', 'mensajes'], 'ouvindo agora': ['listening now', 'escuchando ahora'],
  'Ouvindo agora': ['Listening now', 'Escuchando ahora'], 'Ouvir junto': ['Listen along', 'Escuchar juntos'],
  'Recado': ['Post', 'Mensaje'], 'Pedido de música': ['Song request', 'Pedido de canción'], 'Minha trilha': ['My soundtrack', 'Mi banda sonora'],
  'Publicar': ['Post', 'Publicar'], 'Pedir': ['Request', 'Pedir'], 'Publicar trilha': ['Post soundtrack', 'Publicar banda sonora'],
  'Tudo': ['All', 'Todo'], 'Recados': ['Posts', 'Mensajes'], 'Pedidos': ['Requests', 'Pedidos'], 'Trilhas': ['Soundtracks', 'Bandas sonoras'],
  'Responder': ['Reply', 'Responder'], 'Enviar': ['Send', 'Enviar'], 'Marcar atendido': ['Mark as done', 'Marcar como atendido'], 'Desmarcar': ['Undo', 'Desmarcar'],
  'Pedido': ['Request', 'Pedido'], 'Trilha da vida': ['Life soundtrack', 'Banda sonora de la vida'], 'dono': ['owner', 'dueño'],
  'Música da semana • escolhida por quem ouve': ['Song of the week • picked by listeners', 'Canción de la semana • elegida por quienes escuchan'],
  'Toque uma música para anexá-la ao recado': ['Play a song to attach it to your post', 'Reproduce una canción para adjuntarla'],
  '3 músicas que marcaram fases da sua vida': ['3 songs that marked chapters of your life', '3 canciones que marcaron etapas de tu vida'],
  'A da infância': ['The childhood one', 'La de la infancia'], 'A da festa': ['The party one', 'La de la fiesta'], 'A que me acalma': ['The one that calms me', 'La que me calma'],
  '+ Escolher música': ['+ Pick a song', '+ Elegir canción'], 'Escolha a música': ['Pick a song', 'Elige la canción'],
  'Nada por aqui ainda. Seja o primeiro!': ['Nothing here yet. Be the first!', 'Nada por aquí todavía. ¡Sé el primero!'],
  'Carregando recados…': ['Loading posts…', 'Cargando mensajes…'], 'Carregando notícias…': ['Loading news…', 'Cargando noticias…'],
  'Últimas do funk': ['Latest funk news', 'Lo último del funk'], 'Ver no site': ['Open site', 'Ver en el sitio'],
  'Este mês': ['This month', 'Este mes'], 'Este ano': ['This year', 'Este año'], 'Desde sempre': ['All time', 'Desde siempre'],
  'minutos ouvidos': ['minutes listened', 'minutos escuchados'], 'músicas tocadas': ['songs played', 'canciones reproducidas'],
  'Artistas mais ouvidos': ['Top artists', 'Artistas más escuchados'], 'Músicas mais tocadas': ['Top songs', 'Canciones más escuchadas'],
  'Álbuns mais tocados': ['Top albums', 'Álbumes más escuchados'], 'Exportar CSV': ['Export CSV', 'Exportar CSV'], 'Planilha': ['Spreadsheet', 'Hoja de cálculo'],
  'pessoas': ['people', 'personas'], 'ouvidas no total': ['listened in total', 'escuchadas en total'], 'ativas nesta semana': ['active this week', 'activas esta semana'],
  'Estava ouvindo': ['Was listening', 'Estaba escuchando'], 'Tempo ouvindo': ['Listening time', 'Tiempo escuchando'], 'Acessos': ['Visits', 'Accesos'],
  'Idioma': ['Language', 'Idioma'], 'modo demo': ['demo mode', 'modo demo'], 'Visitante': ['Visitor', 'Visitante'],
  'Ver tudo': ['See all', 'Ver todo'], 'Singles': ['Singles', 'Sencillos'], 'Playlist': ['Playlist', 'Playlist'],
  'Sem internet': ['Offline', 'Sin internet'], 'Publicado no mural': ['Posted to the wall', 'Publicado en el muro'], 'Pedido enviado': ['Request sent', 'Pedido enviado'],
  'Recado publicado': ['Posted', 'Publicado'], 'Preparando o cartão…': ['Preparing the card…', 'Preparando la tarjeta…'],
  'Conte o que está achando ou a sua favorita daqui…': ['Tell us what you think or your favorite song here…', 'Cuenta qué te parece o tu favorita de aquí…'],
  'Minha favorita daqui é…': ['My favorite here is…', 'Mi favorita de aquí es…'], 'Essa música me lembra…': ['This song reminds me of…', 'Esta canción me recuerda…'],
  'Descobri aqui e não paro de ouvir…': ['Found it here and can’t stop listening…', 'La descubrí aquí y no paro de escucharla…'], 'Pra ouvir no carro…': ['For the car…', 'Para el coche…'],
  'Qual álbum ou artista você quer ouvir aqui?': ['Which album or artist do you want here?', '¿Qué álbum o artista quieres escuchar aquí?'],
  'Quer contar a história? (opcional)': ['Want to tell the story? (optional)', '¿Quieres contar la historia? (opcional)'],
  'Escreva uma resposta…': ['Write a reply…', 'Escribe una respuesta…'], 'Buscar por música, artista ou álbum': ['Search by song, artist or album', 'Buscar por canción, artista o álbum'],
  'Os outros podem apoiar o seu pedido. Quando entrar na biblioteca, ele aparece como atendido.': ['Others can support your request. When it is added, it shows as done.', 'Los demás pueden apoyar tu pedido. Cuando se añada, aparecerá como atendido.'],
  'Seu resumo de escuta': ['Your listening summary', 'Tu resumen de escucha'], 'Mural, seu resumo de escuta e notícias do funk': ['Wall, listening summary and funk news', 'Muro, tu resumen de escucha y noticias del funk'],
  'Adicionar': ['Add', 'Añadir'], 'Placar': ['Leaderboard', 'Ranking'], 'Tocar o top 10': ['Play the top 10', 'Reproducir el top 10'],
  '🎧 Quem mais ouviu': ['🎧 Top listeners', '🎧 Quién más escuchó'], '❤️ Mais curtidos no Mural': ['❤️ Most liked on the Wall', '❤️ Más gustados en el Muro'],
  '💬 Mais recados': ['💬 Most posts', '💬 Más mensajes'], 'Mostrar meu nome no placar': ['Show my name on the leaderboard', 'Mostrar mi nombre en el ranking'],
  '🏆 Nº 1 do mês': ['🏆 #1 this month', '🏆 Nº 1 del mes'], 'Ninguém por aqui ainda neste mês.': ['Nobody here yet this month.', 'Nadie por aquí este mes.'],
  'Carregando o placar…': ['Loading the leaderboard…', 'Cargando el ranking…'], 'Escreva um recado…': ['Write a post…', 'Escribe un mensaje…'],
};
// Começos de frases que mudam (ex.: "Tocando agora: Nome do álbum")
const PREFIX = [
  ['Tocando agora: ', ['Now playing: ', 'Sonando ahora: ']],
  ['Faixa ', ['Track ', 'Pista ']],
  ['Álbum: ', ['Album: ', 'Álbum: ']],
  ['Anexar ', ['Attach ', 'Adjuntar ']],
  ['Tocando do ', ['Playing from the ', 'Sonando del ']],
  ['Top 10 músicas de ', ['Top 10 songs of ', 'Top 10 canciones de ']],
  ['Apoiar ', ['Support ', 'Apoyar ']],
  ['Responder (', ['Reply (', 'Responder (']],
  ['Não foi possível tocar ', ['Could not play ', 'No se pudo reproducir ']],
];

const idx = lang === 'en' ? 0 : 1;
function tr(s) {
  const t = s.trim();
  if (!t) return null;
  const e = D[t];
  if (e) return s.replace(t, e[idx]);
  for (const [pt, out] of PREFIX) if (t.startsWith(pt)) return s.replace(pt, out[idx]);
  return null;
}
function fixText(node) {
  const v = tr(node.nodeValue);
  if (v !== null && v !== node.nodeValue) node.nodeValue = v;
}
function fixEl(el) {
  for (const a of ['placeholder', 'title', 'aria-label']) {
    const v = el.getAttribute?.(a);
    if (v) { const t = tr(v); if (t !== null && t !== v) el.setAttribute(a, t); }
  }
}
function walk(root) {
  if (root.nodeType === 3) return fixText(root);
  if (root.nodeType !== 1 || root.closest?.('script, style, textarea')) return;
  fixEl(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) { if (!n.parentElement?.closest('script, style, textarea')) fixText(n); } else fixEl(n);
  }
}

export function startI18n() {
  if (lang === 'pt') return;
  document.documentElement.lang = lang;
  walk(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixEl(m.target);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
}

// Bolinha antes do "Sair": mostra o idioma atual e abre a escolha.
export function bindLangButton(btn) {
  if (!btn) return;
  btn.textContent = lang.toUpperCase();
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = document.querySelector('.lang-menu');
    if (open) return open.remove();
    const r = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'lang-menu';
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    menu.innerHTML = Object.entries(LANGS).map(([k, label]) => `<button data-lang="${k}" class="${k === lang ? 'on' : ''}"><b>${k.toUpperCase()}</b>${label}</button>`).join('');
    document.body.append(menu);
    menu.onclick = (ev) => {
      const b = ev.target.closest('[data-lang]');
      if (!b) return;
      try { localStorage.setItem(KEY, b.dataset.lang); } catch {}
      location.reload();
    };
    // fecha só com um toque fora (no iPhone/iPad o próprio toque que abriu não pode fechar)
    const away = (ev) => {
      if (menu.contains(ev.target) || btn.contains(ev.target)) return;
      menu.remove();
      document.removeEventListener('pointerdown', away, true);
    };
    document.addEventListener('pointerdown', away, true);
  };
}
