// js/translate.js - RBX Infinity internationalization (i18n)
//
// The old version of this file only stored a language preference and had
// an unused translateText()/translatePage() pair that called the public
// Google Translate endpoint — nothing in the app ever called
// translatePage() or marked any element with data-translate, so switching
// "language" only changed a button label and never touched the UI. This
// rewrite ships an actual dictionary for the 22 supported languages and
// wires it up to real elements via data-i18n.

export const SUPPORTED_LANGUAGES = [
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh', name: '中文' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'sv', name: 'Svenska' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'th', name: 'ไทย' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'uk', name: 'Українська' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'ro', name: 'Română' },
];

// UI dictionary. Keys are stable identifiers (not source text), matched
// against elements via data-i18n="key". Add more keys here as more of the
// UI gets wired up — the rest of the app keeps working untranslated in the
// meantime, it just won't have that specific string flipped yet.
const DICT = {
  nav_home:        { es:'Inicio', en:'Home', fr:'Accueil', it:'Home', pt:'Início', de:'Start', ja:'ホーム', ko:'홈', zh:'首页', ru:'Главная', ar:'الرئيسية', hi:'होम', nl:'Home', pl:'Start', tr:'Ana Sayfa', sv:'Hem', id:'Beranda', th:'หน้าแรก', vi:'Trang chủ', uk:'Головна', el:'Αρχική', ro:'Acasă' },
  nav_series:       { es:'Series', en:'Shows', fr:'Séries', it:'Serie', pt:'Séries', de:'Serien', ja:'シリーズ', ko:'시리즈', zh:'剧集', ru:'Сериалы', ar:'المسلسلات', hi:'सीरीज़', nl:'Series', pl:'Seriale', tr:'Diziler', sv:'Serier', id:'Serial', th:'ซีรีส์', vi:'Chương trình', uk:'Серіали', el:'Σειρές', ro:'Seriale' },
  nav_movies:       { es:'Películas', en:'Movies', fr:'Films', it:'Film', pt:'Filmes', de:'Filme', ja:'映画', ko:'영화', zh:'电影', ru:'Фильмы', ar:'الأفلام', hi:'फ़िल्में', nl:'Films', pl:'Filmy', tr:'Filmler', sv:'Filmer', id:'Film', th:'ภาพยนตร์', vi:'Phim', uk:'Фільми', el:'Ταινίες', ro:'Filme' },
  nav_upcoming:     { es:'Próximamente', en:'Coming Soon', fr:'Bientôt', it:'Prossimamente', pt:'Em breve', de:'Demnächst', ja:'近日公開', ko:'출시 예정', zh:'即将上线', ru:'Скоро', ar:'قريباً', hi:'जल्द आ रहा है', nl:'Binnenkort', pl:'Wkrótce', tr:'Yakında', sv:'Kommer snart', id:'Segera Hadir', th:'เร็วๆ นี้', vi:'Sắp ra mắt', uk:'Скоро', el:'Σύντομα', ro:'În curând' },
  nav_partywatch:   { es:'PartyWatch', en:'PartyWatch', fr:'PartyWatch', it:'PartyWatch', pt:'PartyWatch', de:'PartyWatch', ja:'パーティーウォッチ', ko:'파티워치', zh:'派对观影', ru:'PartyWatch', ar:'مشاهدة جماعية', hi:'पार्टीवॉच', nl:'PartyWatch', pl:'PartyWatch', tr:'PartyWatch', sv:'PartyWatch', id:'PartyWatch', th:'PartyWatch', vi:'PartyWatch', uk:'PartyWatch', el:'PartyWatch', ro:'PartyWatch' },
  nav_mylist:       { es:'Mi RBX', en:'My RBX', fr:'Mon RBX', it:'Il mio RBX', pt:'Meu RBX', de:'Mein RBX', ja:'マイRBX', ko:'내 RBX', zh:'我的RBX', ru:'Мой RBX', ar:'RBX الخاص بي', hi:'मेरा RBX', nl:'Mijn RBX', pl:'Moje RBX', tr:'RBX\'im', sv:'Mitt RBX', id:'RBX Saya', th:'RBX ของฉัน', vi:'RBX của tôi', uk:'Мій RBX', el:'Το RBX μου', ro:'RBX-ul meu' },
  nav_download:     { es:'Descargar', en:'Download', fr:'Télécharger', it:'Scarica', pt:'Baixar', de:'Herunterladen', ja:'ダウンロード', ko:'다운로드', zh:'下载', ru:'Скачать', ar:'تحميل', hi:'डाउनलोड करें', nl:'Downloaden', pl:'Pobierz', tr:'İndir', sv:'Ladda ner', id:'Unduh', th:'ดาวน์โหลด', vi:'Tải xuống', uk:'Завантажити', el:'Λήψη', ro:'Descarcă' },
  pd_switch_profile:{ es:'Cambiar perfil', en:'Switch profile', fr:'Changer de profil', it:'Cambia profilo', pt:'Trocar perfil', de:'Profil wechseln', ja:'プロフィールを切り替え', ko:'프로필 전환', zh:'切换资料', ru:'Сменить профиль', ar:'تبديل الملف الشخصي', hi:'प्रोफ़ाइल बदलें', nl:'Profiel wisselen', pl:'Zmień profil', tr:'Profil değiştir', sv:'Byt profil', id:'Ganti profil', th:'สลับโปรไฟล์', vi:'Chuyển hồ sơ', uk:'Змінити профіль', el:'Αλλαγή προφίλ', ro:'Schimbă profilul' },
  pd_logout:        { es:'Cerrar sesión', en:'Log out', fr:'Déconnexion', it:'Disconnetti', pt:'Sair', de:'Abmelden', ja:'ログアウト', ko:'로그아웃', zh:'退出登录', ru:'Выйти', ar:'تسجيل الخروج', hi:'लॉग आउट', nl:'Uitloggen', pl:'Wyloguj się', tr:'Çıkış yap', sv:'Logga ut', id:'Keluar', th:'ออกจากระบบ', vi:'Đăng xuất', uk:'Вийти', el:'Αποσύνδεση', ro:'Deconectare' },
  auth_login:       { es:'Iniciar sesión', en:'Log in', fr:'Se connecter', it:'Accedi', pt:'Entrar', de:'Anmelden', ja:'ログイン', ko:'로그인', zh:'登录', ru:'Войти', ar:'تسجيل الدخول', hi:'लॉग इन करें', nl:'Inloggen', pl:'Zaloguj się', tr:'Giriş yap', sv:'Logga in', id:'Masuk', th:'เข้าสู่ระบบ', vi:'Đăng nhập', uk:'Увійти', el:'Σύνδεση', ro:'Autentificare' },
  auth_register:    { es:'Registrarse', en:'Sign up', fr:'S\'inscrire', it:'Registrati', pt:'Cadastrar-se', de:'Registrieren', ja:'登録', ko:'회원가입', zh:'注册', ru:'Зарегистрироваться', ar:'إنشاء حساب', hi:'साइन अप करें', nl:'Registreren', pl:'Zarejestruj się', tr:'Kayıt ol', sv:'Registrera dig', id:'Daftar', th:'สมัครสมาชิก', vi:'Đăng ký', uk:'Зареєструватися', el:'Εγγραφή', ro:'Înregistrare' },
  search_placeholder:{ es:'Buscar títulos, géneros...', en:'Search titles, genres...', fr:'Rechercher des titres, genres...', it:'Cerca titoli, generi...', pt:'Buscar títulos, gêneros...', de:'Titel, Genres suchen...', ja:'タイトル、ジャンルを検索...', ko:'제목, 장르 검색...', zh:'搜索标题、类型...', ru:'Поиск названий, жанров...', ar:'ابحث عن العناوين والأنواع...', hi:'शीर्षक, शैलियाँ खोजें...', nl:'Titels, genres zoeken...', pl:'Szukaj tytułów, gatunków...', tr:'Başlık, tür ara...', sv:'Sök titlar, genrer...', id:'Cari judul, genre...', th:'ค้นหาชื่อเรื่อง, แนว...', vi:'Tìm kiếm tiêu đề, thể loại...', uk:'Пошук назв, жанрів...', el:'Αναζήτηση τίτλων, ειδών...', ro:'Caută titluri, genuri...' },
};

let currentLanguage = localStorage.getItem('rbx_lang') || 'es';

export function getCurrentLanguage() {
  return currentLanguage;
}

export function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.some(l => l.code === lang)) return;
  currentLanguage = lang;
  localStorage.setItem('rbx_lang', lang);
  applyTranslations();
}

export function t(key) {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[currentLanguage] || entry.es || key;
}

// Applies the dictionary to every element in the DOM marked with
// data-i18n="key". Safe to call repeatedly (e.g. after re-rendering a
// page) — it only ever sets textContent for elements that opt in.
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });
  document.documentElement.lang = currentLanguage;
}

// Kept for any future use with dynamic/user-generated content (not UI
// chrome) — separate on purpose from the UI dictionary above, since
// machine-translating interface labels in real time is unreliable and was
// exactly what silently didn't work before.
export async function translateText(text, targetLang = currentLanguage) {
  if (targetLang === 'es' || !text || text.trim() === '') return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(seg => seg[0]).join('');
  } catch {
    return text;
  }
}
