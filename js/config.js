// Configuração do Rytmo.
// Cole aqui o "ID do cliente OAuth" criado no Google Cloud Console (veja o README.md).
export const CONFIG = {
  CLIENT_ID: '709563122067-sutek35lmddq6gamad19ukse50p985bn.apps.googleusercontent.com',

  // ID do cliente OAuth do tipo "iOS" (bundle com.thechrisart.rytmo), usado pelos apps de Mac
  // e iPhone/iPad para ficarem logados até a pessoa tocar em "Sair". Veja o README.
  // Vazio: os apps usam o login antigo, que precisa entrar de novo a cada hora.
  NATIVE_CLIENT_ID: '709563122067-r4jbquke5nctue6r1bicf13gublpmoh1.apps.googleusercontent.com',

  // Qualquer conta Google pode entrar: as músicas vão para o Drive de quem fez login.
  // Opcional: um e-mail aqui vem sugerido na primeira vez que alguém entra.
  GOOGLE_ACCOUNT: '',

  // Pasta raiz criada no seu Google Drive. Tudo do Rytmo fica dentro dela.
  ROOT_FOLDER_NAME: 'Rytmo',

  // Chave de API (Google Cloud → Credenciais) usada pelo modo ouvinte para tocar
  // as músicas compartilhadas. Restrinja-a ao site e à Google Drive API.
  API_KEY: 'AIzaSyCbMrylPBrbYXJqPKj05iQTYgume1pxTJY',

  // Endereço público do app (usado no link de ouvinte).
  PUBLIC_URL: 'https://thechrisart.github.io/rytmo-app/',

  // Endereço do servidor da comunidade (Google Apps Script → Implantar → App da Web).
  // Guarda a lista de ouvintes, as playlists públicas e as avaliações. Veja o README.
  COMMUNITY_URL: 'https://script.google.com/macros/s/AKfycbw_8igMe1IcyiOgrP3Lau33Fp9pyrmBlWP8_jdzLw8cdss4ukoKOdP00MJ1ld-Yu7c/exec',

  // drive.file = o app só enxerga os arquivos que ele mesmo criou no seu Drive.
  // email/profile = identificar o dono no servidor da comunidade.
  SCOPES: 'https://www.googleapis.com/auth/drive.file openid email profile',
};

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'alac'];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
