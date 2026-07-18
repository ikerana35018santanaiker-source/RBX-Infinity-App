// js/app.js - Main application logic

import { loginWithGoogle, registerUser, loginWithEmail, resetPassword, logout, onAuth, getUserData, ensureUserProfile } from './auth.js';
import { getProfiles, setActiveProfile, createProfile, addToMyList, removeFromMyList, getMyList, updateWatching, getWatching, removeFromWatching, getAvailableAvatars, updateProfile, isContentAllowed, filterAllowedContent } from './profiles.js';
import {
  loadCatalog,
  getAllContent as _rawGetAllContent,
  getAllContentIncludingUpcoming as _rawGetAllContentIncludingUpcoming,
  searchContent, getContentById as _rawGetContentById, getContentBySlug as _rawGetContentBySlug,
  titleToSlug, getUpcoming, getUpcomingSeries, getUpcomingMovies,
  getBanners as _rawGetBanners, getMovies as _rawGetMovies, getSeries as _rawGetSeries,
  getFeatured as _rawGetFeatured, getNewContent as _rawGetNewContent, getTop10 as _rawGetTop10,
  getNewThisWeek as _rawGetNewThisWeek,
  getRecommendations as _rawGetRecommendations, getSeriesGenres, getMoviesGenres, getAnuncios, normalise,
  getInteractivoById as _rawGetInteractivoById, getInteractivos
} from './catalog.js';
import { getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGES, applyTranslations, t } from './translate.js';
import { initLobbiesUI, hookPlayerForLobbySync, initPartyWatchPanel } from './lobby-ui.js';
import { createPartyWatch, joinLobby, leaveLobby as leavePartyWatch, syncVideoAction } from './lobby.js';
import { db, ref as fbRef, push as fbPush, get as fbGet, set as fbSet, update as fbUpdate } from './firebase.js';
import { openXPlayer, closeXPlayer, setPlayerUser } from './player.js';
import { openInteractivePlayer, closeInteractivePlayer } from './interactive-player.js';
import {
  initDownloads, isDesktop, renderDownloadButton, refreshDownloadButton,
  getOfflinePlaybackUrl, listDownloads, deleteDownload
} from './downloads-ui.js';
import {
  smartSearch, addToSearchHistory, getSearchHistory, clearSearchHistory,
  getRatings, setRating, loadAndDisplayRatings, renderRatingSection,
  getBecauseYouWatched, renderBecauseRow,
  generateAutoCategories,
  shareMyList, getSharedList, renderShareModal,
  renderAvatarEditor,
  renderWatchHistoryRow,
  getGenreRecommendations, renderGenreRecommendationRows,
  bumpTrendScore, getTrendingIds, renderTrendingRow
} from './features.js';
import {
  initNotifications, notificationsSupported, notificationsEnabled,
  requestNotificationPermission, disableNotifications, enableNotifications,
  checkNewEpisodes, watchForLiveStreams, seedKnownLiveStreams
} from './notifications.js';

let currentUser = null;
let currentProfile = null;
let myListIds = [];
let watchingData = {};
let remindedIds = JSON.parse(localStorage.getItem('cp_reminded') || '[]');

// ─── PARENTAL-FILTERED CATALOG WRAPPERS ────────────────────────────────────
// Every content-listing function in this file goes through these wrappers
// instead of calling catalog.js directly, so a restricted profile's max
// rating is enforced everywhere at once (home rows, search, recs, detail
// pages) instead of needing every call site updated individually.
function getAllContent() {
  return filterAllowedContent(_rawGetAllContent(), currentProfile);
}
function getAllContentIncludingUpcoming() {
  return filterAllowedContent(_rawGetAllContentIncludingUpcoming(), currentProfile);
}
function getMovies() {
  return filterAllowedContent(_rawGetMovies(), currentProfile);
}
function getSeries() {
  return filterAllowedContent(_rawGetSeries(), currentProfile);
}
function getFeatured() {
  return filterAllowedContent(_rawGetFeatured(), currentProfile);
}
function getNewContent() {
  return filterAllowedContent(_rawGetNewContent(), currentProfile);
}
function getNewThisWeek() {
  return filterAllowedContent(_rawGetNewThisWeek(), currentProfile);
}
function getTop10() {
  return filterAllowedContent(_rawGetTop10(), currentProfile);
}
function getRecommendations(currentId, watchedIds) {
  return filterAllowedContent(_rawGetRecommendations(currentId, watchedIds), currentProfile);
}
// Detail pages, deep links, and "play" need a hard block rather than a
// silent filter — return null so callers can show a locked/blocked message
// instead of just omitting the item from a list.
function getContentById(id) {
  const item = _rawGetContentById(id);
  if (!item) return null;
  return isContentAllowed(item, currentProfile) ? item : null;
}
function getContentBySlug(slug) {
  const item = _rawGetContentBySlug(slug);
  if (!item) return null;
  return isContentAllowed(item, currentProfile) ? item : null;
}
function getInteractivoById(id) {
  const item = _rawGetInteractivoById(id);
  if (!item) return null;
  return isContentAllowed(item, currentProfile) ? item : null;
}
function getBanners() {
  return filterAllowedContent(_rawGetBanners(), currentProfile);
}

// ─── EARLY i18n ───────────────────────────────────────────────────────────────
// Applied as soon as the DOM exists, independent of Firebase's auth check —
// onAuth()'s callback can take a moment to resolve, and the auth screen
// (login/register) is the very first thing an unauthenticated visitor
// sees, so it shouldn't have to wait on that round trip to be translated.
document.addEventListener('DOMContentLoaded', () => applyTranslations());

// ─── ADMIN: defined early so onAuth can call it ───────────────────────────────
// TO DISABLE ADMIN BACKDOOR: delete the line in onAuth that calls this function
async function grantAdminByUsername(uid) {
  try {
    await fbUpdate(fbRef(db, `users/${uid}`), { isAdmin: true });
    window._userIsAdmin = true;
  } catch(e) { console.warn('Admin grant failed', e); }
}

// ─── AUTH STATE ───────────────────────────────────────────────────────────────
onAuth(async (user) => {
  if (user) {
    currentUser = user;

    // registerUser() sets window._registrationInProgress right after
    // createUserWithEmailAndPassword resolves, but Firebase fires this
    // onAuthStateChanged callback immediately at that same point — before
    // registerUser() has gone on to actually write the default profile.
    // Without waiting here, getUserData() below can read the account
    // mid-creation with zero profiles, which is what let people create a
    // second "default"-equivalent profile by hand and end up with two.
    let waited = 0;
    while (window._registrationInProgress && waited < 3000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }

    // Safety net regardless of the flag above: never show the profile
    // selector for an account that doesn't have its default profile yet.
    await ensureUserProfile(user);

    const userData = await getUserData(user.uid);

    window._userIsAdmin = userData?.isAdmin === true;
    window._userIsRbxPlus = userData?.rbxPlus === true;

    // Helper global: devuelve el badge HTML de RBX+ si el usuario lo tiene
    window.rbxPlusBadge = () => window._userIsRbxPlus
      ? `<img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" class="rbxplus-badge-icon" alt="RBX+" title="RBX+">`
      : '';

    if (userData?.banned === true) {
      await logout();
      showToast('Tu cuenta ha sido suspendida. Contacta con el soporte.', 'error');
      return;
    }


    await loadCatalog();
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('profileSelectScreen').style.display = 'flex';
    await loadProfileSelector();
  } else {
    currentUser = null;
    currentProfile = null;
    window._userIsAdmin = false;
    window._userIsRbxPlus = false;
    await loadCatalog();
    const hash = window.location.hash;
    if (hash && hash.startsWith('#/') && hash.length > 2) {
      const page = hash.slice(2);
      if (!['home','shows','movies','upcoming','mynetflix','descarga'].includes(page)) {
        showPublicContent(page);
        return;
      }
    }
    showAuthScreen();
  }
});

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('profileSelectScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'none';
  // Show login tab by default
  switchAuthTab('tabLogin');
}

// ─── AUTH HANDLERS ────────────────────────────────────────────────────────────
window.handleGoogleLogin = async () => {
  try {
    showLoading(true);
    await loginWithGoogle();
  } catch(e) {
    showToast('Error al iniciar con Google: ' + e.message, 'error');
  } finally { showLoading(false); }
};

window.handleLogin = async () => {
  const email = document.getElementById('loginEmail')?.value.trim();
  const password = document.getElementById('loginPassword')?.value;
  if (!email || !password) { showToast('Completa todos los campos', 'error'); return; }
  try {
    showLoading(true);
    await loginWithEmail(email, password);
  } catch(e) {
    const msg = e.code === 'auth/user-not-found' ? 'Usuario no encontrado'
      : e.code === 'auth/wrong-password' ? 'Contraseña incorrecta'
      : e.code === 'auth/invalid-credential' ? 'Correo o contraseña incorrectos'
      : 'Error al iniciar sesión: ' + e.message;
    showToast(msg, 'error');
  } finally { showLoading(false); }
};

window.handleRegister = async () => {
  const username = document.getElementById('regUsername')?.value.trim();
  const email    = document.getElementById('regEmail')?.value.trim();
  const password = document.getElementById('regPassword')?.value;
  const confirm  = document.getElementById('regConfirm')?.value;

  if (!username || username.length < 2)
    { showToast('El nombre debe tener al menos 2 caracteres', 'error'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    { showToast('Ingresa un correo válido', 'error'); return; }
  if (!password || password.length < 6)
    { showToast('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
  if (password !== confirm)
    { showToast('Las contraseñas no coinciden', 'error'); return; }

  try {
    showLoading(true);
    await registerUser(username, email, password);
    showToast('¡Cuenta creada! Bienvenido a RBX Infinity 🎉', 'success');
  } catch(e) {
    const msg = e.code === 'auth/email-already-in-use'
      ? 'Este correo ya está registrado. ¿Quieres iniciar sesión?'
      : e.code === 'auth/weak-password'
      ? 'Contraseña muy débil. Usa al menos 6 caracteres.'
      : (e.message || 'Error al registrarse');
    showToast(msg, 'error');
  } finally { showLoading(false); }
};




window.handleResetPassword = async () => {
  const email = document.getElementById('resetEmail')?.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Ingresa un correo válido', 'error'); return; }
  try {
    showLoading(true);
    await resetPassword(email);
    showToast('📧 Enlace de restablecimiento enviado. Revisa tu correo.', 'success');
    switchAuthTab('tabLogin');
  } catch(e) {
    const msg = e.code === 'auth/user-not-found' ? 'No existe una cuenta con ese correo'
      : 'Error: ' + e.message;
    showToast(msg, 'error');
  } finally { showLoading(false); }
};

window.handleLogout = async () => { await logout(); window.location.reload(); };

// ─── ADMIN SYSTEM ─────────────────────────────────────────────────────────────

// ─── ADMIN PANEL ─────────────────────────────────────────────────────────────
async function adminLoadUsers() {
  try {
    const snap = await fbGet(fbRef(db, 'users'));
    if (!snap.exists()) return [];
    return Object.entries(snap.val()).map(([uid, data]) => ({ uid, ...data }));
  } catch { return []; }
}

window.adminGrantAdmin = async (uid) => {
  if (!confirm('¿Dar permisos de administrador?')) return;
  try {
    await fbSet(fbRef(db, `users/${uid}/isAdmin`), true);
    showToast('Admin concedido ✓', 'success');
    adminRefreshRow(uid);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminRevokeAdmin = async (uid) => {
  if (!confirm('¿Quitar permisos de admin?')) return;
  try {
    await fbSet(fbRef(db, `users/${uid}/isAdmin`), false);
    showToast('Admin revocado', 'success');
    adminRefreshRow(uid);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminBanUser = async (uid) => {
  if (!confirm('¿Banear a este usuario?')) return;
  try {
    await fbSet(fbRef(db, `users/${uid}/banned`), true);
    showToast('Usuario baneado', 'success');
    adminRefreshRow(uid);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminUnbanUser = async (uid) => {
  try {
    await fbSet(fbRef(db, `users/${uid}/banned`), false);
    showToast('Baneo retirado ✓', 'success');
    adminRefreshRow(uid);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminDeleteUser = async (uid, name) => {
  if (!confirm(`¿Eliminar datos de "${name}"? No se puede deshacer.`)) return;
  try {
    await fbSet(fbRef(db, `users/${uid}`), null);
    showToast('Usuario eliminado', 'success');
    document.getElementById(`adminRow_${uid}`)?.remove();
    window._adminAllUsers = (window._adminAllUsers||[]).filter(u => u.uid !== uid);
    _adminUpdateStats(window._adminAllUsers);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminNote = (uid, current) => {
  const note = prompt('Nota interna (solo visible para admins):', current || '');
  if (note === null) return;
  fbSet(fbRef(db, `users/${uid}/adminNote`), note)
    .then(() => showToast('Nota guardada ✓', 'success'))
    .catch(e => showToast('Error: ' + e.message, 'error'));
};

async function adminRefreshRow(uid) {
  const snap = await fbGet(fbRef(db, `users/${uid}`));
  if (!snap.exists()) return;
  const row = document.getElementById(`adminRow_${uid}`);
  if (row) row.outerHTML = _adminRenderRow(uid, snap.val());
  const idx = (window._adminAllUsers||[]).findIndex(u => u.uid === uid);
  if (idx !== -1) { window._adminAllUsers[idx] = { uid, ...snap.val() }; _adminUpdateStats(window._adminAllUsers); }
}

function _adminRenderRow(uid, u) {
  const isAdm = u.isAdmin === true;
  const isBan = u.banned  === true;
  const isSelf = uid === currentUser?.uid;
  const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString('es-ES') : '—';
  const profs  = Object.keys(u.profiles || {}).length;
  const badges = [
    isAdm ? `<span class="ab ab-admin">👑 Admin</span>` : '',
    isBan ? `<span class="ab ab-ban">🚫 Baneado</span>` : '',
    isSelf? `<span class="ab ab-self">Tú</span>` : '',
  ].filter(Boolean).join('');

  return `<tr id="adminRow_${uid}" class="${isBan?'row-banned':''}">
    <td class="atd">
      <div class="aui"><b>${escapeHtml(u.displayName||u.username||'—')}</b>
      <span>${escapeHtml(u.email||'—')}</span>
      <small>📅 ${joined} · 👤 ${profs} perfil${profs!==1?'es':''}</small>
      <code style="font-size:.6rem;opacity:.3">${uid}</code></div>
    </td>
    <td class="atd">${badges||'<span class="ab ab-none">Usuario</span>'}</td>
    <td class="atd aact">
      ${!isAdm ? `<button class="ab-btn ab-admin" onclick="adminGrantAdmin('${uid}')">👑 Admin</button>`
               : (!isSelf ? `<button class="ab-btn ab-rev" onclick="adminRevokeAdmin('${uid}')">↩ Quitar admin</button>` : '')}
      ${!isSelf ? (isBan
        ? `<button class="ab-btn ab-ok" onclick="adminUnbanUser('${uid}')">✅ Desbanear</button>`
        : `<button class="ab-btn ab-ban" onclick="adminBanUser('${uid}')">🚫 Banear</button>`) : ''}
      <button class="ab-btn ab-note" onclick="adminNote('${uid}','${escapeHtml(u.adminNote||'')}')">📝 Nota</button>
      ${!isSelf ? `<button class="ab-btn ab-del" onclick="adminDeleteUser('${uid}','${escapeHtml(u.displayName||uid)}')">🗑️</button>` : ''}
    </td>
  </tr>`;
}

function _adminUpdateStats(users) {
  const set = (id,n) => { const e=document.getElementById(id); if(e) e.textContent=n; };
  set('aStatTotal',  users.length);
  set('aStatAdmins', users.filter(u=>u.isAdmin).length);
  set('aStatBanned', users.filter(u=>u.banned).length);
  set('aStatNew',    users.filter(u=>u.createdAt && Date.now()-u.createdAt < 7*86400000).length);
}

async function renderAdminPage() {
  if (!window._userIsAdmin) { showToast('Acceso denegado', 'error'); navigateTo('home'); return; }
  const content = document.getElementById('appContent');
  _injectAdminCSS();

  content.innerHTML = `
    <div class="admin-page">
      <!-- Header -->
      <div class="admin-header">
        <div class="admin-header-left">
          <div class="admin-shield-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
          </div>
          <div>
            <h1 class="admin-title">Panel de Administración</h1>
            <p class="admin-sub">RBX Infinity · Control total de la plataforma</p>
          </div>
        </div>
        <button class="admin-refresh-btn" onclick="refreshAdminTab()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          Actualizar
        </button>
      </div>

      <!-- Stats -->
      <div class="admin-stats-row">
        <div class="asc"><span class="asc-n" id="aStatTotal">—</span><span class="asc-l">Usuarios totales</span></div>
        <div class="asc"><span class="asc-n" id="aStatNew">—</span><span class="asc-l">Nuevos (7d)</span></div>
        <div class="asc"><span class="asc-n" id="aStatAdmins">—</span><span class="asc-l">Admins</span></div>
        <div class="asc asc-warn"><span class="asc-n" id="aStatBanned">—</span><span class="asc-l">Baneados</span></div>
        <div class="asc asc-blue"><span class="asc-n" id="aStatStreams">—</span><span class="asc-l">Streams</span></div>
        <div class="asc asc-green"><span class="asc-n" id="aStatContent">—</span><span class="asc-l">Contenido</span></div>
      </div>

      <!-- Tabs -->
      <div class="admin-tabs">
        <button class="admin-tab active" onclick="switchAdminTab('users',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          Usuarios
        </button>
        <button class="admin-tab" onclick="switchAdminTab('streams',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          Streams
        </button>
        <button class="admin-tab" onclick="switchAdminTab('content',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
          Contenido
        </button>
        <button class="admin-tab" onclick="switchAdminTab('plans',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
          Planes
        </button>
        <button class="admin-tab" onclick="switchAdminTab('reports',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 9h-2V5h2v6zm0 4h-2v-2h2v2z"/></svg>
          Reportes
        </button>
        <button class="admin-tab" onclick="switchAdminTab('soundtracks',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
          Soundtracks
        </button>
        <button class="admin-tab" onclick="switchAdminTab('rbxplus',this)">
          <img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" style="width:15px;height:15px;object-fit:contain;vertical-align:middle">
          RBX+
        </button>
      </div>

      <!-- Tab: USERS -->
      <div id="adminTabUsers" class="admin-tab-panel">
        <div class="admin-toolbar">
          <input id="adminSearch" placeholder="Buscar nombre, email o UID..." oninput="adminFilter(this.value)">
          <select id="adminUserFilter" onchange="adminFilterByRole(this.value)" class="admin-select">
            <option value="all">Todos</option>
            <option value="admin">Solo admins</option>
            <option value="banned">Solo baneados</option>
            <option value="new">Nuevos (7d)</option>
          </select>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Usuario</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody id="adminTbody"><tr><td colspan="3" class="atd-empty">Cargando...</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Tab: STREAMS -->
      <div id="adminTabStreams" class="admin-tab-panel" style="display:none">
        <div class="admin-streams-actions">
          <button class="stream-new-btn" onclick="openCreateStreamModal()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
            Nuevo stream
          </button>
        </div>
        <div id="adminStreamsList" class="admin-streams-list">Cargando streams...</div>
      </div>

      <!-- Tab: CONTENT -->
      <div id="adminTabContent" class="admin-tab-panel" style="display:none">
        <div class="admin-content-grid" id="adminContentGrid">
          <div class="atd-empty">Cargando catálogo...</div>
        </div>
      </div>

      <!-- Tab: PLANS -->
      <div id="adminTabPlans" class="admin-tab-panel" style="display:none">
        <div class="admin-plans-search">
          <input id="adminPlansSearch" placeholder="Email o UID del usuario..." style="width:100%;max-width:400px">
          <button class="stream-create-btn" onclick="adminGrantPlan()">Dar plan</button>
          <button class="ab-btn ab-rev" onclick="adminRevokePlan()" style="padding:8px 14px">Revocar plan</button>
        </div>
        <div id="adminPlansList" class="admin-table-wrap" style="margin-top:16px">
          <table class="admin-table">
            <thead><tr><th>Usuario</th><th>Plan</th><th>Desde</th><th>Acciones</th></tr></thead>
            <tbody id="adminPlansTbody"><tr><td colspan="4" class="atd-empty">Cargando...</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Tab: REPORTS -->
      <div id="adminTabReports" class="admin-tab-panel" style="display:none">
        <div id="adminReportsList" class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Tipo</th><th>Detalles</th><th>Fecha</th><th>Acciones</th></tr></thead>
            <tbody id="adminReportsTbody"><tr><td colspan="4" class="atd-empty">Sin reportes pendientes</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Tab: SOUNDTRACKS -->
      <div id="adminTabSoundtracks" class="admin-tab-panel" style="display:none">

      <!-- Tab: RBX+ -->
      <div id="adminTabRbxplus" class="admin-tab-panel" style="display:none">
        <div class="admin-plans-search">
          <input id="rbxplusSearchInput" placeholder="Email o UID del usuario...">
          <button class="stream-create-btn" onclick="adminGrantRbxPlus()">
            <img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px" alt="RBX+">
            Dar RBX+
          </button>
          <button class="ab-btn ab-rev" style="padding:8px 14px" onclick="adminRevokeRbxPlusSearch()">Revocar RBX+</button>
        </div>
        <div class="admin-table-wrap" style="margin-top:16px">
          <table class="admin-table">
            <thead><tr><th>Usuario</th><th>Estado</th><th>Desde</th><th>Acciones</th></tr></thead>
            <tbody id="adminRbxPlusTbody"><tr><td colspan="4" class="atd-empty">Cargando...</td></tr></tbody>
          </table>
        </div>
      </div>
        <div class="ost-form-card">
          <h3 class="ost-form-title">Nuevo álbum de banda sonora</h3>

          <div class="ost-field">
            <label>Título del álbum <span class="csm-req">*</span></label>
            <input id="ostTitulo" class="csm-input" type="text" placeholder="Ej: Sombras del Abismo (Banda Sonora Original)" maxlength="100">
          </div>

          <div class="ost-row2">
            <div class="ost-field">
              <label>Portada (URL) <span class="csm-req">*</span></label>
              <input id="ostPortada" class="csm-input" type="url" placeholder="https://...">
            </div>
            <div class="ost-field">
              <label>Película o serie asociada <span class="csm-req">*</span></label>
              <select id="ostContentSelect" class="csm-input">
                <option value="">Selecciona contenido...</option>
              </select>
            </div>
          </div>

          <div class="ost-field">
            <label>Canciones <span class="csm-req">*</span></label>
            <div class="ost-songs-list" id="ostSongsList"></div>
            <button type="button" class="ost-add-song-btn" onclick="ostAddSongRow()">+ Añadir canción</button>
            <small>Cada canción se sube directamente como audio (se codifica y se guarda en Firebase) — sin límite de formato, pero por tamaño se recomienda MP3 comprimido.</small>
          </div>

          <button class="csm-submit-btn" onclick="ostSubmitAlbum()" id="ostSubmitBtn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
            Publicar álbum
          </button>
          <div id="ostUploadProgress" style="display:none"></div>
        </div>

        <h3 class="ost-list-title">Álbumes publicados</h3>
        <div id="adminSoundtracksList" class="ost-albums-grid">
          <div class="atd-empty">Cargando álbumes...</div>
        </div>
      </div>
    </div>`;

  loadAdminPanel();
  _loadAdminStats();
}

window.switchAdminTab = (tab, btn) => {
  document.querySelectorAll('.admin-tab-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('adminTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (panel) panel.style.display = 'block';
  if (btn) btn.classList.add('active');

  if (tab === 'streams') _loadAdminStreams();
  if (tab === 'content') _loadAdminContent();
  if (tab === 'plans')   _loadAdminPlans();
  if (tab === 'reports') _loadAdminReports();
  if (tab === 'soundtracks') _loadAdminSoundtracks();
  if (tab === 'rbxplus')     _loadAdminRbxPlus();
};

window.refreshAdminTab = () => {
  const activeTab = document.querySelector('.admin-tab.active');
  if (activeTab) activeTab.click();
  else loadAdminPanel();
};

async function _loadAdminStats() {
  try {
    const users = window._adminAllUsers || [];
    const now = Date.now();
    const week = 7 * 86400000;
    document.getElementById('aStatTotal').textContent   = users.length || '—';
    document.getElementById('aStatNew').textContent     = users.filter(u => (now - (u.createdAt||0)) < week).length || '0';
    document.getElementById('aStatAdmins').textContent  = users.filter(u => u.isAdmin).length || '0';
    document.getElementById('aStatBanned').textContent  = users.filter(u => u.banned).length || '0';
    // Content stats
    const movies = getAllContent().filter(i => i.tipo === 'pelicula').length;
    const series = getAllContent().filter(i => i.tipo === 'serie').length;
    document.getElementById('aStatContent').textContent = movies + series || '—';
  } catch(e) { console.warn('_loadAdminStats', e); }
}

async function _loadAdminStreams() {
  const list = document.getElementById('adminStreamsList');
  if (!list) return;
  list.innerHTML = '<div class="atd-empty">Cargando...</div>';
  try {
    const { get: g, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    const snap = await g(r(db, 'streams'));
    if (!snap.exists()) { list.innerHTML = '<div class="atd-empty">No hay streams</div>'; return; }
    const streams = Object.entries(snap.val()).map(([id,s]) => ({id,...s}));
    document.getElementById('aStatStreams').textContent = streams.filter(s=>s.status==='live').length || '0';
    list.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Stream</th><th>Estado</th><th>Tipo</th><th>Espectadores</th><th>Acciones</th></tr></thead>
          <tbody>${streams.map(s => `
            <tr>
              <td class="atd">
                <div class="aui">
                  <b>${s.titulo||'Sin título'}</b>
                  <span>${s.ownerName||'—'}</span>
                </div>
              </td>
              <td class="atd">
                <span class="ab ${s.status==='live'?'ab-admin':s.status==='scheduled'?'ab-self':'ab-none'}">
                  ${s.status==='live'?'EN VIVO':s.status==='scheduled'?'Programado':'Terminado'}
                </span>
              </td>
              <td class="atd"><span class="ab ab-self">${s.tipo||'—'}</span></td>
              <td class="atd">${s.viewerCount||0}</td>
              <td class="atd">
                <div class="aact">
                  ${s.status==='live'?`<button class="ab-btn ab-ban" onclick="adminEndStream('${s.id}')">Terminar</button>`:''}
                  <button class="ab-btn ab-del" onclick="adminDeleteStream('${s.id}')">Borrar</button>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch(e) { list.innerHTML = `<div class="atd-empty">Error: ${e.message}</div>`; }
}

window.adminEndStream = async (id) => {
  try {
    const { update: u, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    await u(r(db, `streams/${id}`), { status: 'ended', endedAt: Date.now() });
    showToast('Stream terminado', 'success');
    _loadAdminStreams();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminDeleteStream = async (id) => {
  if (!confirm('¿Borrar este stream permanentemente?')) return;
  try {
    const { remove: rm, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    await rm(r(db, `streams/${id}`));
    showToast('Stream borrado', 'success');
    _loadAdminStreams();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

function _loadAdminContent() {
  const grid = document.getElementById('adminContentGrid');
  if (!grid) return;
  const all = getAllContent();
  if (!all.length) { grid.innerHTML = '<div class="atd-empty">No hay contenido en el catálogo</div>'; return; }
  grid.innerHTML = `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Título</th><th>Tipo</th><th>Género</th><th>Top10</th><th>Destacado</th></tr></thead>
        <tbody>${all.map(item => `
          <tr>
            <td class="atd">
              <div style="display:flex;align-items:center;gap:10px">
                <img src="${item.poster||item.banner||''}" alt="" style="width:36px;height:50px;object-fit:cover;border-radius:4px;flex-shrink:0"
                  onerror="this.style.display='none'">
                <span style="font-size:.85rem;font-weight:600">${item.titulo}</span>
              </div>
            </td>
            <td class="atd"><span class="ab ${item.tipo==='serie'?'ab-self':'ab-admin'}">${item.tipo==='serie'?'Serie':'Película'}</span></td>
            <td class="atd" style="font-size:.8rem;color:rgba(232,234,240,.5)">${item.genero||'—'}</td>
            <td class="atd" style="text-align:center">${item.top10!=null?'#'+item.top10:'—'}</td>
            <td class="atd" style="text-align:center">${item.destacado?'<span class="ab ab-admin">Sí</span>':'—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function _loadAdminPlans() {
  const tbody = document.getElementById('adminPlansTbody');
  if (!tbody) return;
  try {
    const { get: g, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    const snap = await g(r(db, 'users'));
    if (!snap.exists()) { tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Sin usuarios</td></tr>'; return; }
    const users = Object.entries(snap.val())
      .map(([uid,u]) => ({uid,...u}))
      .filter(u => u.plan && u.plan !== 'free');
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Nadie tiene plan activo todavía</td></tr>'; return; }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td class="atd"><div class="aui"><b>${u.displayName||u.username||'—'}</b><span>${u.email||''}</span></div></td>
        <td class="atd"><span class="ab ab-admin">${u.plan||'—'}</span></td>
        <td class="atd" style="font-size:.78rem;color:rgba(232,234,240,.4)">${u.planGrantedAt ? new Date(u.planGrantedAt).toLocaleDateString('es-ES') : '—'}</td>
        <td class="atd"><div class="aact">
          <button class="ab-btn ab-rev" onclick="adminRevokePlanFor('${u.uid}')">Revocar</button>
        </div></td>
      </tr>`).join('');
  } catch(e) { tbody.innerHTML = `<tr><td colspan="4" class="atd-empty">Error: ${e.message}</td></tr>`; }
}

window.adminGrantPlan = async () => {
  const q = document.getElementById('adminPlansSearch')?.value.trim();
  if (!q) { showToast('Introduce email o UID', 'error'); return; }
  try {
    const users = window._adminAllUsers || [];
    const u = users.find(u => u.email===q || u.uid===q);
    if (!u) { showToast('Usuario no encontrado', 'error'); return; }
    const plan = prompt('Nombre del plan (ej: plus, basic):', 'plus');
    if (!plan) return;
    const { update: upd, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    await upd(r(db, `users/${u.uid}`), { plan, planGrantedAt: Date.now(), planGrantedBy: currentUser.uid });
    showToast(`Plan "${plan}" dado a ${u.displayName||u.email}`, 'success');
    _loadAdminPlans();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminRevokePlanFor = async (uid) => {
  if (!confirm('¿Revocar plan de este usuario?')) return;
  try {
    const { update: upd, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    await upd(r(db, `users/${uid}`), { plan: 'free', planRevokedAt: Date.now() });
    showToast('Plan revocado', 'success');
    _loadAdminPlans();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

async function _loadAdminReports() {
  const tbody = document.getElementById('adminReportsTbody');
  if (!tbody) return;
  try {
    const { get: g, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    const snap = await g(r(db, 'reports'));
    if (!snap.exists()) { tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Sin reportes pendientes</td></tr>'; return; }
    const reports = Object.entries(snap.val()).map(([id,rp]) => ({id,...rp})).filter(rp => rp.status !== 'resolved');
    if (!reports.length) { tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Sin reportes pendientes</td></tr>'; return; }
    tbody.innerHTML = reports.map(rp => `
      <tr>
        <td class="atd"><span class="ab ab-ban">${rp.tipo||'General'}</span></td>
        <td class="atd">
          <div class="aui">
            <b>${rp.motivo||'Sin motivo'}</b>
            <span>Por: ${rp.reporterName||'—'}</span>
            ${rp.targetName?`<small>Sobre: ${rp.targetName}</small>`:''}
          </div>
        </td>
        <td class="atd" style="font-size:.75rem;color:rgba(232,234,240,.4)">${rp.ts ? new Date(rp.ts).toLocaleDateString('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</td>
        <td class="atd"><div class="aact">
          <button class="ab-btn ab-ok" onclick="adminResolveReport('${rp.id}')">Resolver</button>
          ${rp.targetUid?`<button class="ab-btn ab-ban" onclick="adminBanUser('${rp.targetUid}')">Banear</button>`:''}
        </div></td>
      </tr>`).join('');
  } catch(e) { tbody.innerHTML = `<tr><td colspan="4" class="atd-empty">Error: ${e.message}</td></tr>`; }
}

window.adminResolveReport = async (reportId) => {
  try {
    const { update: upd, ref: r } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    await upd(r(db, `reports/${reportId}`), { status: 'resolved', resolvedAt: Date.now(), resolvedBy: currentUser.uid });
    showToast('Reporte resuelto', 'success');
    _loadAdminReports();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminFilterByRole = (role) => {
  const users = window._adminAllUsers || [];
  const now = Date.now(); const week = 7*86400000;
  const filtered = role === 'all' ? users
    : role === 'admin'  ? users.filter(u => u.isAdmin)
    : role === 'banned' ? users.filter(u => u.banned)
    : role === 'new'    ? users.filter(u => (now-(u.createdAt||0)) < week)
    : users;
  const tbody = document.getElementById('adminTbody');
  if (tbody) tbody.innerHTML = filtered.map(u => _adminRenderRow(u.uid, u)).join('') || '<tr><td colspan="3" class="atd-empty">Sin resultados</td></tr>';
};

// ─── SOUNDTRACKS (admin only) ─────────────────────────────────────────────────
let _ostSongRowCount = 0;

async function _loadAdminSoundtracks() {
  // Populate the movie/series picker
  const select = document.getElementById('ostContentSelect');
  if (select) {
    const all = getAllContent();
    select.innerHTML = '<option value="">Selecciona contenido...</option>' +
      all.map(item => `<option value="${item.id}">${item.tipo === 'serie' ? '📺' : '🎬'} ${item.titulo}</option>`).join('');
  }

  // Start with one empty song row if the list is empty
  const songsList = document.getElementById('ostSongsList');
  if (songsList && !songsList.children.length) ostAddSongRow();

  // Load existing albums from Firebase
  const grid = document.getElementById('adminSoundtracksList');
  if (!grid) return;
  grid.innerHTML = '<div class="atd-empty">Cargando álbumes...</div>';
  try {
    const snap = await fbGet(fbRef(db, 'soundtracks'));
    if (!snap.exists()) { grid.innerHTML = '<div class="atd-empty">No hay álbumes publicados todavía.</div>'; return; }
    const albums = Object.entries(snap.val()).map(([id, a]) => ({ id, ...a }));
    grid.innerHTML = albums.map(a => {
      const content = getContentById(a.contentId);
      const songCount = a.canciones ? Object.keys(a.canciones).length : 0;
      return `
        <div class="ost-album-card">
          <img src="${a.portada}" alt="${escapeHtml(a.titulo)}" class="ost-album-cover" onerror="this.style.opacity=.2">
          <div class="ost-album-info">
            <h4>${escapeHtml(a.titulo)}</h4>
            <p>${content ? escapeHtml(content.titulo) : 'Contenido no encontrado'}</p>
            <span class="ost-song-count">${songCount} canción${songCount !== 1 ? 'es' : ''}</span>
          </div>
          <button class="ost-delete-btn" onclick="adminDeleteAlbum('${a.id}')" title="Eliminar álbum">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>`;
    }).join('');
  } catch(e) {
    grid.innerHTML = `<div class="atd-empty">Error al cargar álbumes: ${e.message}</div>`;
  }
}

window.ostAddSongRow = () => {
  const list = document.getElementById('ostSongsList');
  if (!list) return;
  const rowId = 'ostSong_' + (_ostSongRowCount++);
  const row = document.createElement('div');
  row.className = 'ost-song-row';
  row.id = rowId;
  row.innerHTML = `
    <input type="text" class="csm-input ost-song-title" placeholder="Título de la canción" maxlength="100">
    <input type="file" class="ost-song-file" accept="audio/*" onchange="ostHandleFileSelect(this,'${rowId}')">
    <span class="ost-song-status" id="${rowId}_status"></span>
    <button type="button" class="ost-remove-song-btn" onclick="document.getElementById('${rowId}').remove()">✕</button>`;
  list.appendChild(row);
};

window.ostHandleFileSelect = (input, rowId) => {
  const status = document.getElementById(`${rowId}_status`);
  const file = input.files?.[0];
  if (!file) return;
  // 5MB sanity cap — base64 inflates size ~33%, and Firebase RTDB nodes
  // get unwieldy well before that, so we warn early instead of letting a
  // huge upload silently hang.
  if (file.size > 5 * 1024 * 1024) {
    if (status) status.innerHTML = '<span class="ost-status-err">Demasiado grande (máx. 5MB)</span>';
    input.value = '';
    return;
  }
  if (status) status.innerHTML = `<span class="ost-status-ok">${(file.size/1024/1024).toFixed(1)} MB ✓</span>`;
};

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // already a data: URL
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.ostSubmitAlbum = async () => {
  if (!window._userIsAdmin) { showToast('Acceso denegado', 'error'); return; }

  const titulo   = document.getElementById('ostTitulo')?.value.trim();
  const portada  = document.getElementById('ostPortada')?.value.trim();
  const contentId = document.getElementById('ostContentSelect')?.value;
  const rows = Array.from(document.querySelectorAll('.ost-song-row'));

  if (!titulo)    { showToast('El título del álbum es obligatorio', 'error'); return; }
  if (!portada)   { showToast('La portada es obligatoria', 'error'); return; }
  if (!contentId) { showToast('Selecciona la película o serie', 'error'); return; }
  if (!rows.length) { showToast('Añade al menos una canción', 'error'); return; }

  const songs = [];
  for (const row of rows) {
    const titleInput = row.querySelector('.ost-song-title');
    const fileInput  = row.querySelector('.ost-song-file');
    const songTitle = titleInput?.value.trim();
    const file = fileInput?.files?.[0];
    if (!songTitle || !file) {
      showToast('Cada canción necesita título y archivo de audio', 'error');
      return;
    }
    songs.push({ titulo: songTitle, file });
  }

  const btn = document.getElementById('ostSubmitBtn');
  const progress = document.getElementById('ostUploadProgress');
  if (btn) { btn.disabled = true; btn.textContent = 'Subiendo...'; }
  if (progress) progress.style.display = 'block';

  try {
    const cancionesData = {};
    for (let i = 0; i < songs.length; i++) {
      if (progress) progress.textContent = `Codificando canción ${i + 1} de ${songs.length}...`;
      const base64 = await _fileToBase64(songs[i].file);
      const songId = 'song_' + Date.now() + '_' + i;
      cancionesData[songId] = {
        titulo: songs[i].titulo,
        audioBase64: base64,
        orden: i,
        duracionAprox: null
      };
    }

    if (progress) progress.textContent = 'Guardando álbum en Firebase...';
    const albumId = 'album_' + Date.now();
    await fbSet(fbRef(db, `soundtracks/${albumId}`), {
      titulo, portada, contentId,
      canciones: cancionesData,
      createdAt: Date.now(),
      createdBy: currentUser.uid
    });

    showToast('Álbum publicado correctamente ✓', 'success');
    document.getElementById('ostTitulo').value = '';
    document.getElementById('ostPortada').value = '';
    document.getElementById('ostContentSelect').value = '';
    document.getElementById('ostSongsList').innerHTML = '';
    ostAddSongRow();
    _loadAdminSoundtracks();
  } catch(e) {
    showToast('Error al publicar: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Publicar álbum'; }
    if (progress) { progress.style.display = 'none'; progress.textContent = ''; }
  }
};

window.adminDeleteAlbum = async (albumId) => {
  if (!confirm('¿Eliminar este álbum permanentemente?')) return;
  try {
    await fbSet(fbRef(db, `soundtracks/${albumId}`), null);
    showToast('Álbum eliminado', 'success');
    _loadAdminSoundtracks();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window._adminAllUsers = [];
async function loadAdminPanel() {
  const tbody = document.getElementById('adminTbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3" class="atd-empty">Cargando...</td></tr>';
  const users = await adminLoadUsers();
  window._adminAllUsers = users;
  _adminUpdateStats(users);
  _loadAdminStats();
  const sorted = [...users].sort((a,b) => {
    if (a.isAdmin && !b.isAdmin) return -1;
    if (!a.isAdmin && b.isAdmin) return 1;
    return (b.createdAt||0)-(a.createdAt||0);
  });
  tbody.innerHTML = sorted.length ? sorted.map(u => _adminRenderRow(u.uid, u)).join('') : '<tr><td colspan="3" class="atd-empty">No hay usuarios</td></tr>';
}

window.adminFilter = (q) => {
  if (!q.trim()) { loadAdminPanel(); return; }
  const lq = q.toLowerCase();
  const filtered = (window._adminAllUsers||[]).filter(u =>
    (u.displayName||'').toLowerCase().includes(lq) ||
    (u.email||'').toLowerCase().includes(lq) ||
    (u.uid||'').toLowerCase().includes(lq)
  );
  const tbody = document.getElementById('adminTbody');
  if (tbody) tbody.innerHTML = filtered.map(u => _adminRenderRow(u.uid, u)).join('') || '<tr><td colspan="3" class="atd-empty">Sin resultados</td></tr>';
};

function _injectAdminCSS() {
  if (document.getElementById('admin-css')) return;
  const s = document.createElement('style'); s.id = 'admin-css';
  s.textContent = `
    .admin-page{padding:28px 20px;max-width:1000px;margin:0 auto}
    .admin-stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px}
    .asc{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 18px;text-align:center}
    .asc-warn{border-color:rgba(255,100,100,.2);background:rgba(255,60,60,.05)}
    .asc-n{display:block;font-size:1.8rem;font-weight:800;color:#1a7fff}
    .asc-warn .asc-n{color:#ff6b6b}
    .asc-l{font-size:.72rem;color:rgba(232,234,240,.4);text-transform:uppercase;letter-spacing:.05em}
    .admin-toolbar{display:flex;gap:8px;margin-bottom:14px}
    .admin-toolbar input{flex:1;padding:8px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e8eaf0;font-size:.87rem;outline:none}
    .admin-toolbar input:focus{border-color:rgba(26,127,255,.4)}
    .admin-table-wrap{overflow-x:auto;border-radius:12px;border:1px solid rgba(255,255,255,.08)}
    .admin-table{width:100%;border-collapse:collapse}
    .admin-table thead tr{background:rgba(255,255,255,.05)}
    .admin-table th{padding:11px 14px;text-align:left;font-size:.73rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(232,234,240,.45)}
    .atd{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:middle}
    .atd-empty{text-align:center;padding:36px;color:rgba(255,255,255,.25)}
    .aui{display:flex;flex-direction:column;gap:1px}
    .aui b{font-size:.87rem;color:#e8eaf0}
    .aui span{font-size:.77rem;color:rgba(232,234,240,.4)}
    .aui small{font-size:.7rem;color:rgba(232,234,240,.3)}
    .aact{display:flex;flex-wrap:wrap;gap:4px}
    .row-banned{opacity:.6}
    .ab{display:inline-block;font-size:.67rem;font-weight:700;padding:2px 7px;border-radius:16px;margin-right:3px}
    .ab-admin{background:rgba(255,215,0,.14);color:#ffd700;border:1px solid rgba(255,215,0,.25)}
    .ab-ban{background:rgba(255,60,60,.14);color:#ff6b6b;border:1px solid rgba(255,60,60,.25)}
    .ab-self{background:rgba(26,127,255,.14);color:#7ab9ff;border:1px solid rgba(26,127,255,.25)}
    .ab-none{background:rgba(255,255,255,.06);color:rgba(232,234,240,.35);border:1px solid rgba(255,255,255,.09)}
    .ab-btn{padding:4px 10px;border-radius:7px;border:none;cursor:pointer;font-size:.73rem;font-weight:600;white-space:nowrap;transition:background .15s}
    .ab-admin{background:rgba(255,215,0,.13);color:#ffd700} .ab-admin:hover{background:rgba(255,215,0,.22)}
    .ab-rev{background:rgba(255,100,100,.1);color:#ff6b6b} .ab-rev:hover{background:rgba(255,100,100,.2)}
    .ab-ban{background:rgba(255,60,60,.1);color:#ff6b6b} .ab-ban:hover{background:rgba(255,60,60,.2)}
    .ab-ok{background:rgba(76,175,80,.1);color:#4caf50} .ab-ok:hover{background:rgba(76,175,80,.2)}
    .ab-note{background:rgba(255,255,255,.07);color:rgba(232,234,240,.6)} .ab-note:hover{background:rgba(255,255,255,.13)}
    .ab-del{background:rgba(200,0,0,.1);color:#ff4444} .ab-del:hover{background:rgba(200,0,0,.2)}
    .ab-ok{background:rgba(76,175,80,.1);color:#4caf50;border:1px solid rgba(76,175,80,.25);border-radius:7px;padding:5px 11px;font-size:.78rem;font-weight:700;cursor:pointer}
    .ab-ok:hover{background:rgba(76,175,80,.2)}
    .ab-rev{background:rgba(255,152,0,.1);color:#ff9800;border:1px solid rgba(255,152,0,.25);border-radius:8px;padding:6px 12px;font-size:.78rem;font-weight:700;cursor:pointer}
    .ab-rev:hover{background:rgba(255,152,0,.2)}
    .admin-page .stream-create-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;
      background:rgba(26,127,255,.15);border:1px solid rgba(26,127,255,.3);border-radius:9px;
      color:#7ab9ff;font-size:.82rem;font-weight:700;cursor:pointer;transition:all .18s}
    .admin-page .stream-create-btn:hover{background:rgba(26,127,255,.28);border-color:#1a7fff;color:#fff}
    /* New admin styles */
    .admin-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
    .admin-header-left{display:flex;align-items:center;gap:14px}
    .admin-shield-icon{width:44px;height:44px;border-radius:12px;background:rgba(26,127,255,.15);
      border:1px solid rgba(26,127,255,.25);display:flex;align-items:center;justify-content:center;color:#1a7fff}
    .admin-title{font-size:1.3rem;font-weight:800;margin-bottom:2px}
    .admin-sub{font-size:.78rem;color:rgba(232,234,240,.4)}
    .admin-refresh-btn{display:flex;align-items:center;gap:6px;padding:8px 14px;background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.1);border-radius:9px;color:rgba(232,234,240,.7);font-size:.8rem;
      cursor:pointer;transition:background .15s}
    .admin-refresh-btn:hover{background:rgba(255,255,255,.1)}
    .asc-blue{border-color:rgba(26,127,255,.2);background:rgba(26,127,255,.06)}
    .asc-blue .asc-n{color:#7ab9ff}
    .asc-green{border-color:rgba(76,175,80,.2);background:rgba(76,175,80,.05)}
    .asc-green .asc-n{color:#4caf50}
    .admin-tabs{display:flex;gap:4px;margin-bottom:18px;padding:4px;
      background:rgba(255,255,255,.04);border-radius:12px;width:fit-content;flex-wrap:wrap}
    .admin-tab{display:flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:9px;
      background:transparent;color:rgba(232,234,240,.5);font-size:.83rem;font-weight:600;cursor:pointer;transition:all .15s}
    .admin-tab:hover{background:rgba(255,255,255,.06);color:rgba(232,234,240,.8)}
    .admin-tab.active{background:rgba(26,127,255,.15);color:#7ab9ff;border:1px solid rgba(26,127,255,.2)}
    .admin-tab-panel{animation:fadeInPanel .2s ease}
    @keyframes fadeInPanel{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .admin-select{padding:8px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
      border-radius:9px;color:#e8eaf0;font-size:.85rem;outline:none;cursor:pointer}
    .admin-select option{background:#001030}
    .admin-streams-actions{margin-bottom:14px}
    .admin-streams-list{min-height:200px}
    .admin-content-grid{min-height:200px}
    .admin-plans-search{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
    .admin-plans-search input{flex:1;min-width:200px;padding:8px 12px;background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e8eaf0;font-size:.87rem;outline:none}
    /* Soundtracks admin */
    .ost-form-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
      border-radius:14px;padding:24px;margin-bottom:28px}
    .ost-form-title{font-size:1.05rem;font-weight:700;margin-bottom:18px;color:#e8eaf0}
    .ost-field{margin-bottom:16px}
    .ost-field label{display:block;font-size:.8rem;color:rgba(232,234,240,.6);margin-bottom:5px;font-weight:600}
    .ost-field small{display:block;font-size:.74rem;color:rgba(232,234,240,.35);margin-top:8px;line-height:1.4}
    .ost-row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
    .ost-songs-list{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
    .ost-song-row{display:flex;gap:8px;align-items:center;background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px}
    .ost-song-row .ost-song-title{flex:1.3}
    .ost-song-row .ost-song-file{flex:1;color:#e8eaf0;font-size:.78rem;max-width:220px}
    .ost-song-status{font-size:.72rem;white-space:nowrap;min-width:64px}
    .ost-status-ok{color:#4caf50}
    .ost-status-err{color:#ff6b6b}
    .ost-remove-song-btn{background:rgba(255,68,102,.1);border:1px solid rgba(255,68,102,.25);
      border-radius:6px;width:26px;height:26px;color:#ff6b6b;cursor:pointer;font-size:.8rem;flex-shrink:0}
    .ost-add-song-btn{background:rgba(26,127,255,.12);border:1px solid rgba(26,127,255,.28);
      border-radius:8px;padding:8px 16px;color:#7ab9ff;font-size:.82rem;font-weight:700;cursor:pointer}
    .ost-add-song-btn:hover{background:rgba(26,127,255,.22)}
    #ostUploadProgress{margin-top:12px;font-size:.82rem;color:#7ab9ff;text-align:center}
    .ost-list-title{font-size:1rem;font-weight:700;margin-bottom:14px;color:#e8eaf0}
    .ost-albums-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
    .ost-album-card{display:flex;gap:12px;align-items:center;background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px;position:relative}
    .ost-album-cover{width:52px;height:52px;border-radius:7px;object-fit:cover;flex-shrink:0}
    .ost-album-info{flex:1;min-width:0}
    .ost-album-info h4{font-size:.86rem;font-weight:700;color:#e8eaf0;margin-bottom:2px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ost-album-info p{font-size:.76rem;color:rgba(232,234,240,.45);margin-bottom:3px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ost-song-count{font-size:.7rem;color:#7ab9ff;font-weight:600}
    .ost-delete-btn{background:rgba(255,68,102,.1);border:1px solid rgba(255,68,102,.25);
      border-radius:7px;width:30px;height:30px;color:#ff6b6b;cursor:pointer;flex-shrink:0;
      display:flex;align-items:center;justify-content:center}
    .ost-delete-btn:hover{background:rgba(255,68,102,.22)}
  `;
  document.head.appendChild(s);
}

window.renderAdminPage = renderAdminPage;

// ─── RBX+ ADMIN FUNCTIONS ─────────────────────────────────────────────────────
window.adminGrantRbxPlus = async () => {
  const q = document.getElementById('rbxplusSearchInput')?.value.trim();
  if (!q) { showToast('Introduce email o UID', 'error'); return; }
  const users = window._adminAllUsers || [];
  const u = users.find(u => u.email === q || u.uid === q);
  if (!u) { showToast('Usuario no encontrado. Carga la lista de usuarios primero (pestaña Usuarios).', 'error'); return; }
  try {
    await fbUpdate(fbRef(db, `users/${u.uid}`), { rbxPlus: true, rbxPlusGrantedAt: Date.now(), rbxPlusGrantedBy: currentUser.uid });
    showToast(`✦ RBX+ concedido a ${escapeHtml(u.displayName || u.email)} ✓`, 'success');
    _loadAdminRbxPlus();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminRevokeRbxPlusSearch = async () => {
  const q = document.getElementById('rbxplusSearchInput')?.value.trim();
  if (!q) { showToast('Introduce email o UID', 'error'); return; }
  const users = window._adminAllUsers || [];
  const u = users.find(u => u.email === q || u.uid === q);
  if (!u) { showToast('Usuario no encontrado', 'error'); return; }
  if (!confirm(`¿Revocar RBX+ a ${u.displayName || u.email}?`)) return;
  try {
    await fbUpdate(fbRef(db, `users/${u.uid}`), { rbxPlus: false, rbxPlusRevokedAt: Date.now() });
    showToast('RBX+ revocado', 'success');
    _loadAdminRbxPlus();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.adminRevokeRbxPlusFor = async (uid) => {
  if (!confirm('¿Revocar RBX+ a este usuario?')) return;
  try {
    await fbUpdate(fbRef(db, `users/${uid}`), { rbxPlus: false, rbxPlusRevokedAt: Date.now() });
    showToast('RBX+ revocado', 'success');
    _loadAdminRbxPlus();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

async function _loadAdminRbxPlus() {
  const tbody = document.getElementById('adminRbxPlusTbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Cargando...</td></tr>';
  try {
    const snap = await fbGet(fbRef(db, 'users'));
    if (!snap.exists()) { tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Sin usuarios</td></tr>'; return; }
    const rbxUsers = Object.entries(snap.val())
      .map(([uid, u]) => ({ uid, ...u }))
      .filter(u => u.rbxPlus === true);
    if (!rbxUsers.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="atd-empty">Nadie tiene RBX+ todavía</td></tr>';
      return;
    }
    tbody.innerHTML = rbxUsers.map(u => `
      <tr>
        <td class="atd">
          <div class="aui">
            <b>${escapeHtml(u.displayName || u.username || '—')}
              <img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" style="width:14px;height:14px;object-fit:contain;vertical-align:-2px;margin-left:4px">
            </b>
            <span>${escapeHtml(u.email || '—')}</span>
          </div>
        </td>
        <td class="atd"><span class="ab ab-admin">✦ RBX+</span></td>
        <td class="atd" style="font-size:.78rem;color:rgba(232,234,240,.4)">
          ${u.rbxPlusGrantedAt ? new Date(u.rbxPlusGrantedAt).toLocaleDateString('es-ES') : '—'}
        </td>
        <td class="atd">
          <button class="ab-btn ab-rev" onclick="adminRevokeRbxPlusFor('${u.uid}')">Revocar RBX+</button>
        </td>
      </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" class="atd-empty">Error: ${e.message}</td></tr>`;
  }
}

// ─── RBX+ PAGE (solo para usuarios con rbxPlus===true) ───────────────────────
async function renderRbxPlusPage() {
  const content = document.getElementById('appContent');

  if (!window._userIsRbxPlus) {
    content.innerHTML = `
      <div class="rbxplus-locked">
        <img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" class="rbxplus-locked-logo" alt="RBX+">
        <h2>Contenido exclusivo RBX+</h2>
        <p>Solo los miembros RBX+ tienen acceso a este apartado.</p>
        <p class="rbxplus-locked-sub">Contacta con el soporte en Discord para obtener RBX+.</p>
        <a class="rbxplus-discord-btn" href="https://discord.gg/K4bj6XBHeq" target="_blank" rel="noopener">
          Ir al Discord →
        </a>
      </div>`;
    return;
  }

  // Contenido exclusivo: filtra por rbxplus===true en peliculas.json e interactivos.json
  const exclusivo = getAllContent().filter(i => i.rbxplus === true);
  const proximoExclusivo = getUpcoming().filter(i => i.rbxplus === true);

  content.innerHTML = `
    <div class="rbxplus-page">
      <div class="rbxplus-hero">
        <img src="https://static.vecteezy.com/system/resources/thumbnails/038/598/430/small/3d-plus-icon-gold-3d-illustration-png.png" class="rbxplus-hero-logo" alt="RBX+">
        <h1>RBX<span>+</span></h1>
        <p>Contenido exclusivo solo para ti</p>
      </div>
      <div class="home-rows">
        ${exclusivo.length
          ? renderRow('🌟 Exclusivo RBX+', exclusivo)
          : `<div style="text-align:center;padding:60px 20px;color:rgba(232,234,240,.3);font-size:.95rem">
               Pronto habrá contenido exclusivo aquí. ¡Mantente al tanto!
             </div>`}
        ${proximoExclusivo.length ? renderRow('🔒 Próximamente en RBX+', proximoExclusivo) : ''}
      </div>
    </div>`;
}

// ─── SETTINGS MODAL ──────────────────────────────────────────────────────────

window.openSettingsModal = async () => {
  if (!currentUser) return;

  // Remove existing
  document.getElementById('settingsModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.className = 'settings-modal-wrap';
  modal.innerHTML = `
    <div class="settings-backdrop" onclick="closeSettingsModal()"></div>
    <div class="settings-card">
      <div class="settings-header">
        <h2>⚙️ Ajustes</h2>
        <button class="settings-close" onclick="closeSettingsModal()">✕</button>
      </div>

      <!-- TABS -->
      <div class="settings-tabs">
        <button class="stab active" onclick="switchSettingsTab('account',this)">Cuenta</button>
        <button class="stab" onclick="switchSettingsTab('parental',this)">Control parental</button>
        <button class="stab" onclick="switchSettingsTab('sessions',this)">Dispositivos</button>
        <button class="stab" onclick="switchSettingsTab('activity',this)">Actividad</button>
        <button class="stab" onclick="switchSettingsTab('privacy',this)">Privacidad</button>
      </div>

      <!-- ACCOUNT TAB -->
      <div class="settings-tab-content" id="stab-account">
        <div class="settings-section">
          <div class="settings-user-card">
            <div class="suc-avatar" id="sucAvatar">
              ${currentProfile?.avatarIcon || '🎬'}
            </div>
            <div class="suc-info">
              <div class="suc-name">${escapeHtml(currentUser.displayName || currentProfile?.name || 'Usuario')} ${window.rbxPlusBadge ? window.rbxPlusBadge() : ''}</div>
              <div class="suc-email">${currentUser.email || ''}</div>
              <div class="suc-plan" style="color:${window._userIsRbxPlus?'#ffd700':'#4caf50'}">${window._userIsRbxPlus?'✦ RBX+ Activo':'✅ RBX Infinity — Acceso completo'}</div>
            </div>
            <button class="settings-btn-sm" onclick="closeSettingsModal();openAvatarEditor()">Editar avatar</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Idioma</div>
          <p class="settings-note">Elige el idioma de la interfaz de RBX Infinity.</p>
          <select id="langSelect" class="settings-lang-select" onchange="changeAppLanguage(this.value)">
            ${SUPPORTED_LANGUAGES.map(l => `<option value="${l.code}" ${getCurrentLanguage()===l.code?'selected':''}>${l.name}</option>`).join('')}
          </select>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Notificaciones</div>
          <p class="settings-note">Recibe un aviso cuando salga un nuevo episodio de algo que sigues, o cuando empiece un stream en directo.</p>
          <div id="notifToggleRow" class="notif-toggle-row"></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Acciones de cuenta</div>
          <button class="settings-btn danger-btn" onclick="closeSettingsModal();handleLogout()">
            Cerrar sesión en este dispositivo
          </button>
        </div>
      </div>

      <!-- PARENTAL CONTROL TAB -->
      <div class="settings-tab-content" id="stab-parental" style="display:none">
        <div class="settings-section">
          <div class="settings-section-title">PIN parental</div>
          <p class="settings-note">Protege los perfiles con un PIN de 4 dígitos para que solo un adulto pueda crear perfiles, quitar restricciones o cambiar la clasificación de edad.</p>
          <div id="parentalPinStatus" class="settings-note">Cargando...</div>
          <div class="pin-input-row">
            <input type="password" id="parentalPinInput" maxlength="4" inputmode="numeric" placeholder="Nuevo PIN (4 dígitos)">
            <button class="settings-btn-sm" onclick="saveParentalPin()">Guardar PIN</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Restricción por perfil</div>
          <p class="settings-note">Define qué clasificación máxima puede ver cada perfil.</p>
          <div id="parentalProfilesList"><div class="settings-loading">Cargando perfiles...</div></div>
        </div>
      </div>

      <!-- SESSIONS TAB -->
      <div class="settings-tab-content" id="stab-sessions" style="display:none">
        <div class="settings-section">
          <div class="settings-section-title">Sesiones activas por dispositivo</div>
          <p class="settings-note">Estos son los dispositivos donde has iniciado sesión recientemente.</p>
          <div id="settingsSessionsList">
            <div class="settings-loading">Cargando dispositivos...</div>
          </div>
        </div>
        <div class="settings-section">
          <button class="settings-btn danger-btn" onclick="closeAllOtherSessions()">
            Cerrar sesión en todos los demás dispositivos
          </button>
        </div>
      </div>

      <!-- ACTIVITY TAB -->
      <div class="settings-tab-content" id="stab-activity" style="display:none">
        <div class="settings-section">
          <div class="settings-section-title">Historial de actividad reciente</div>
          <p class="settings-note">Registro de acciones importantes en tu cuenta.</p>
          <div id="settingsActivityList">
            <div class="settings-loading">Cargando actividad...</div>
          </div>
        </div>
      </div>

      <!-- PRIVACY TAB -->
      <div class="settings-tab-content" id="stab-privacy" style="display:none">
        <div class="settings-section">
          <div class="settings-section-title">Política de privacidad</div>
          <p class="settings-note">Consulta cómo recopilamos, usamos y protegemos tu información personal.</p>
          <a class="settings-btn settings-btn-link" href="politicadeprivacidad.html" target="_blank" rel="noopener">
            📄 Leer Política de Privacidad →
          </a>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Términos y Condiciones</div>
          <p class="settings-note">Consulta cómo recopilamos, usamos y protegemos tu información personal.</p>
          <a class="settings-btn settings-btn-link" href="terminosycondiciones.html" target="_blank" rel="noopener">
            📄 Leer Términos y Condiciones →
          </a>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Tus datos</div>
          <div class="settings-info-row"><span>Correo registrado</span><strong>${currentUser.email || '—'}</strong></div>
          <div class="settings-info-row"><span>Cuenta creada</span><strong id="settingsJoinDate">—</strong></div>
          <div class="settings-info-row"><span>Perfiles</span><strong id="settingsProfileCount">—</strong></div>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Control de datos</div>
          <button class="settings-btn" onclick="requestDataExport()">📦 Solicitar exportación de mis datos</button>
          <button class="settings-btn danger-btn" onclick="requestAccountDeletion()">🗑 Solicitar eliminación de cuenta</button>
          <p class="settings-note" style="margin-top:8px">Las solicitudes de datos se gestionan por Discord en un plazo máximo de 30 días.</p>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Documentos legales</div>
          <a class="settings-btn settings-btn-link" href="politicadeprivacidad.html" target="_blank">📄 Política de Privacidad</a>
          <a class="settings-btn settings-btn-link" href="collabwithus.html" target="_blank">🤝 Colaborar con nosotros</a>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('sm-visible'));
  renderNotifToggle();

  // Load account meta
  const userData = await getUserData(currentUser.uid);
  if (userData) {
    const joinEl = document.getElementById('settingsJoinDate');
    if (joinEl && userData.createdAt) joinEl.textContent = new Date(userData.createdAt).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'});
    const profEl = document.getElementById('settingsProfileCount');
    if (profEl && userData.profiles) profEl.textContent = Object.keys(userData.profiles).length;
  }
};

window.closeSettingsModal = () => {
  const m = document.getElementById('settingsModal');
  if (m) { m.classList.remove('sm-visible'); setTimeout(() => m.remove(), 300); }
};

// ─── NOTIFICATIONS TOGGLE ───────────────────────────────────────────────────
function renderNotifToggle() {
  const row = document.getElementById('notifToggleRow');
  if (!row) return;

  if (!notificationsSupported()) {
    row.innerHTML = `<p class="settings-note">Tu navegador no soporta notificaciones.</p>`;
    return;
  }
  if (Notification.permission === 'denied') {
    row.innerHTML = `<p class="settings-note">Bloqueaste las notificaciones para este sitio. Actívalas desde los ajustes de tu navegador para recibir avisos.</p>`;
    return;
  }

  const on = notificationsEnabled();
  row.innerHTML = `
    <button class="settings-btn ${on ? '' : 'settings-btn-link'}" onclick="toggleNotifications()">
      ${on ? '🔔 Notificaciones activadas — Desactivar' : '🔕 Activar notificaciones'}
    </button>`;
}

// ─── LANGUAGE ─────────────────────────────────────────────────────────────────
window.changeAppLanguage = (langCode) => {
  setLanguage(langCode); // also calls applyTranslations() internally
  const langName = SUPPORTED_LANGUAGES.find(l => l.code === langCode)?.name || langCode;
  showToast(`✓ ${langName}`, 'success');
};

window.toggleNotifications = async () => {
  try {
    if (notificationsEnabled()) {
      disableNotifications();
      showToast('Notificaciones desactivadas', 'info');
    } else {
      const result = await requestNotificationPermission();
      if (result === 'granted') {
        enableNotifications();
        showToast('Notificaciones activadas ✓', 'success');
        await seedKnownLiveStreams();
        watchForLiveStreams();
      } else if (result === 'denied') {
        showToast('Permiso denegado. Puedes activarlo desde los ajustes del navegador.', 'error');
      }
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
  renderNotifToggle();
};

// ─── PARENTAL CONTROL TAB ──────────────────────────────────────────────────
const RATING_OPTIONS = [
  { label: 'Todos los públicos', value: 0 },
  { label: '+7 años', value: 7 },
  { label: '+13 años', value: 13 },
  { label: '+15 años', value: 15 },
  { label: '+18 años', value: 18 },
  { label: 'Sin restricción', value: '' }
];

async function renderParentalTab() {
  const statusEl = document.getElementById('parentalPinStatus');
  const listEl = document.getElementById('parentalProfilesList');
  if (!statusEl || !listEl) return;

  const { hasParentalPin } = await import('./auth.js');
  const has = await hasParentalPin(currentUser.uid);
  statusEl.textContent = has ? '🔒 PIN activo — se pedirá para quitar restricciones' : '🔓 Sin PIN configurado';

  const profiles = await getProfiles(currentUser.uid);
  listEl.innerHTML = Object.values(profiles).map(p => `
    <div class="parental-profile-row">
      <img src="${p.avatar}" class="parental-profile-avatar" onerror="this.src='resources/avatars/avatar1.png'">
      <span class="parental-profile-name">${escapeHtml(p.name)}</span>
      <select onchange="setProfileMaxRating('${p.id}', this.value)">
        ${RATING_OPTIONS.map(o => `<option value="${o.value}" ${(p.maxRating ?? '') == o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>`).join('');
}

window.saveParentalPin = async () => {
  const input = document.getElementById('parentalPinInput');
  const pin = input?.value.trim();
  if (!pin || !/^\d{4}$/.test(pin)) { showToast('El PIN debe tener 4 dígitos', 'error'); return; }
  try {
    const { setParentalPin } = await import('./auth.js');
    await setParentalPin(currentUser.uid, pin);
    input.value = '';
    showToast('PIN parental guardado ✓', 'success');
    await renderParentalTab();
  } catch (e) { showToast('Error al guardar el PIN: ' + e.message, 'error'); }
};

window.setProfileMaxRating = async (profileId, value) => {
  // Loosening/removing a restriction requires the parental PIN, if one is set.
  const { hasParentalPin, checkParentalPin } = await import('./auth.js');
  if (await hasParentalPin(currentUser.uid)) {
    const pin = prompt('Introduce el PIN parental para confirmar este cambio:');
    if (pin === null) { await renderParentalTab(); return; }
    const ok = await checkParentalPin(currentUser.uid, pin.trim());
    if (!ok) { showToast('PIN incorrecto', 'error'); await renderParentalTab(); return; }
  }
  const maxRating = value === '' ? null : parseInt(value, 10);
  try {
    await updateProfile(currentUser.uid, profileId, { maxRating, isKids: maxRating != null && maxRating <= 13 });
    if (currentProfile?.id === profileId) { currentProfile.maxRating = maxRating; }
    showToast('Restricción actualizada ✓', 'success');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
};

window.switchSettingsTab = async (tab, btn) => {
  document.querySelectorAll('.settings-tab-content').forEach(t => t.style.display = 'none');
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('stab-' + tab);
  if (el) el.style.display = 'block';
  if (btn) btn.classList.add('active');

  if (tab === 'sessions') {
    const list = document.getElementById('settingsSessionsList');
    if (!list) return;
    const sessions = await loadDeviceSessions(currentUser.uid);
    if (!sessions.length) {
      list.innerHTML = '<p class="settings-note">No hay sesiones registradas.</p>';
      return;
    }
    list.innerHTML = sessions.map(s => `
      <div class="session-row ${s.id === window._currentSessionId ? 'session-current' : ''}">
        <div class="session-icon">${s.platform==='Android'?'📱':s.platform==='iOS'?'🍎':s.platform==='Windows'?'🪟':s.platform==='macOS'?'🍏':'🖥️'}</div>
        <div class="session-info">
          <span class="session-device">${s.platform} · ${s.browser}</span>
          <span class="session-time">Último acceso: ${s.loginAt ? new Date(s.loginAt).toLocaleDateString('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</span>
          ${s.id === window._currentSessionId ? '<span class="session-badge-current">Este dispositivo</span>' : ''}
        </div>
        ${s.id !== window._currentSessionId ? `<button class="settings-btn-sm danger-btn-sm" onclick="closeSession('${s.id}')">Cerrar</button>` : ''}
      </div>`).join('');
  }

  if (tab === 'parental') {
    await renderParentalTab();
  }

  if (tab === 'activity') {
    const list = document.getElementById('settingsActivityList');
    if (!list) return;
    const activity = await loadSessions(currentUser.uid);
    console.log(activity);
    if (!activity.length) {
      list.innerHTML = '<p class="settings-note">No hay actividad registrada todavía.</p>';
      return;
    }
    const icons = { login:'🔐', logout:'🚪', plan_grant:'💳', plan_revoke:'❌', password_reset:'🔑', comment:'💬', rating:'⭐', list_add:'➕', list_remove:'➖' };
    list.innerHTML = activity.map(a => `
      <div class="activity-row">
        <span class="activity-icon">${icons[a.action] || '📋'}</span>
        <div class="activity-info">
          <span class="activity-action">${a.action.replace(/_/g,' ')}</span>
          ${a.detail ? `<span class="activity-detail">${a.detail}</span>` : ''}
        </div>
        <span class="activity-time">${a.ts ? new Date(a.ts).toLocaleDateString('es-ES',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</span>
      </div>`).join('');
  }
};

window.closeSession = async (sessionId) => {
  if (!confirm('¿Cerrar esta sesión?')) return;
  try {
    await fbSet(fbRef(db, `users/${currentUser.uid}/sessions/${sessionId}`), null);
    showToast('Sesión cerrada ✓', 'success');
    switchSettingsTab('sessions', null);
  } catch { showToast('Error al cerrar sesión', 'error'); }
};

window.closeAllOtherSessions = async () => {
  if (!confirm('¿Cerrar sesión en todos los demás dispositivos?')) return;
  try {
    const sessions = await loadDeviceSessions(currentUser.uid);
    const others = sessions.filter(s => s.id !== window._currentSessionId);
    await Promise.all(others.map(s => fbSet(fbRef(db, `users/${currentUser.uid}/sessions/${s.id}`), null)));
    showToast(`${others.length} sesiones cerradas ✓`, 'success');
    switchSettingsTab('sessions', null);
  } catch { showToast('Error', 'error'); }
};

window.requestDataExport = () => {
  window.open('https://discord.gg/K4bj6XBHeq', '_blank');
  showToast('Contacta con soporte en Discord para solicitar tus datos', 'info');
};

window.requestAccountDeletion = () => {
  if (!confirm('¿Solicitar eliminación de tu cuenta?\n\nSerás redirigido al Discord de soporte para completar el proceso.')) return;
  window.open('https://discord.gg/K4bj6XBHeq', '_blank');
  showToast('Contacta con soporte para eliminar tu cuenta', 'info');
};

function switchAuthTab(tabId) {
  document.querySelectorAll('.auth-tab').forEach(t => { t.style.display = 'none'; });
  const el = document.getElementById(tabId);
  if (el) { el.style.display = 'block'; }
}
window.switchAuthTab = switchAuthTab;

// Public view
async function showPublicContent(slug) {
  await loadCatalog();
  const item = getContentBySlug(slug);
  if (!item) { showAuthScreen(); return; }
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('profileAvatarNav').style.display = 'none';
  document.getElementById('profileNameNav').style.display = 'none';
  const navRight = document.querySelector('.nav-right');
  if (navRight && !document.getElementById('publicLoginBtn')) {
    const btn = document.createElement('button');
    btn.id = 'publicLoginBtn';
    btn.className = 'btn-primary';
    btn.style = 'padding:8px 18px;font-size:.85rem;';
    btn.textContent = 'Iniciar sesión';
    btn.onclick = () => { window.location.hash = '#/home'; window.location.reload(); };
    navRight.prepend(btn);
  }
  renderHomePage(true);
  setTimeout(() => openContentPublic(item.id), 300);
}

window.openContentPublic = (id) => {
  const item = getContentById(id);
  if (!item) return;
  const modal = document.getElementById('contentModal');
  const isSerie = item.tipo === 'serie';
  const seasons = isSerie && Array.isArray(item.temporadas) ? item.temporadas : [];
  const bg = item.banner || item.poster;
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()"></div>
    <div class="modal-box" id="modalBox">
      <button class="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-banner" style="background-image:linear-gradient(to bottom,transparent 40%,#000d1f 100%),url('${bg}')">
        <div class="modal-banner-actions">
          <button class="btn-play" onclick="showToast('Inicia sesión para ver este contenido','info')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            ${isSerie && seasons.length ? 'Ver T1 E1' : 'Reproducir'}
          </button>
          ${renderTrailerButtons(item)}
        </div>
      </div>
      <div class="modal-content">
        <div class="modal-header">
          ${item.logo ? `<img src="${item.logo}" class="modal-logo" alt="${item.titulo}">` : `<h2 class="modal-title">${item.titulo}</h2>`}
          <div class="modal-meta">
            ${item.año ? `<span>${item.año}</span>` : ''}
            ${item.duracion ? `<span>${item.duracion}</span>` : ''}
            ${item.rating ? `<span class="modal-rating">${item.rating}</span>` : ''}
            ${item.genero ? `<span class="tag">${item.genero}</span>` : ''}
          </div>
        </div>
        <p class="modal-desc">${item.descripcion || ''}</p>
        <div class="public-login-cta">
          <p>🔐 Inicia sesión para ver este contenido completo</p>
          <button class="btn-primary" onclick="window.location.hash='#/home'; window.location.reload()">Iniciar sesión</button>
        </div>
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

// ─── PROFILES ────────────────────────────────────────────────────────────────
async function loadProfileSelector() {
  const profiles = await getProfiles(currentUser.uid);
  const container = document.getElementById('profilesGrid');
  container.innerHTML = '';
  Object.values(profiles).forEach(profile => {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.innerHTML = `
      <div class="profile-avatar-wrap">
        <img src="${profile.avatar}" alt="${profile.name}" onerror="this.src='resources/avatars/avatar1.png'">
        ${profile.isKids ? '<span class="kids-profile-badge" title="Perfil infantil">🧒</span>' : ''}
        <button class="profile-edit-btn" title="Editar perfil"
          onclick="event.stopPropagation(); openEditProfileModal('${profile.id}')">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
      </div>
      <span>${escapeHtml(profile.name)} ${window.rbxPlusBadge ? window.rbxPlusBadge() : ''}</span>`;
    card.addEventListener('click', () => selectProfile(profile));
    container.appendChild(card);
  });
  // Always show add profile — no limit
  const addCard = document.createElement('div');
  addCard.className = 'profile-card add-profile';
  addCard.innerHTML = `<div class="profile-avatar-wrap"><span class="plus-icon">+</span></div><span>Añadir perfil</span>`;
  addCard.addEventListener('click', showAddProfileModal);
  container.appendChild(addCard);
}

async function selectProfile(profile) {
  currentProfile = profile;
  await setActiveProfile(currentUser.uid, profile.id);
  myListIds = await getMyList(currentUser.uid, profile.id);
  watchingData = await getWatching(currentUser.uid, profile.id);
  document.getElementById('profileSelectScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('profileAvatarNav').src = profile.avatar;
  const nameNav = document.getElementById('profileNameNav');
  nameNav.innerHTML = escapeHtml(profile.name) + ' ' + window.rbxPlusBadge();
  // Mostrar/ocultar pestaña RBX+ en navbar
  const rbxLi = document.getElementById('navRbxPlusLi');
  if (rbxLi) rbxLi.style.display = window._userIsRbxPlus ? 'list-item' : 'none';
  // Show admin link if user is admin
  if (window._userIsAdmin) {
    const pdMenu = document.querySelector('.profile-dropdown');
    if (pdMenu && !document.getElementById('adminNavLink')) {
      const adminItem = document.createElement('div');
      adminItem.id = 'adminNavLink';
      adminItem.className = 'pd-item pd-item-admin';
      adminItem.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>Panel Admin`;
      adminItem.onclick = () => navigateTo('admin');
      pdMenu.insertBefore(adminItem, pdMenu.querySelector('.pd-divider') || pdMenu.firstChild);
    }
  }
  // Register device session asynchronously (non-blocking)
  registerDeviceSession(currentUser.uid).catch(() => {});
  await initMainApp();
}

window.showProfileSelector = () => {
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('profileSelectScreen').style.display = 'flex';
  loadProfileSelector();
};

function showAddProfileModal() {
  document.getElementById('addProfileModal').style.display = 'flex';
  renderAvatarPicker();
}
window.closeAddProfileModal = () => { document.getElementById('addProfileModal').style.display = 'none'; };

let selectedAvatar = getAvailableAvatars()[0];

function renderAvatarPicker() {
  const container = document.getElementById('avatarPickerGrid');
  container.innerHTML = '';
  getAvailableAvatars().forEach(avatarPath => {
    const img = document.createElement('img');
    img.src = avatarPath;
    img.className = 'avatar-option' + (avatarPath === selectedAvatar ? ' selected' : '');
    img.onerror = () => img.style.display = 'none';
    img.addEventListener('click', () => {
      selectedAvatar = avatarPath;
      container.querySelectorAll('.avatar-option').forEach(i => i.classList.remove('selected'));
      img.classList.add('selected');
    });
    container.appendChild(img);
  });
}

window.saveNewProfile = async () => {
  const name = document.getElementById('newProfileName').value.trim();
  if (!name) { showToast('Escribe un nombre', 'error'); return; }
  const isKids = document.getElementById('newProfileIsKids')?.checked || false;
  try {
    await createProfile(currentUser.uid, { name, avatar: selectedAvatar, isKids });
    document.getElementById('newProfileIsKids').checked = false;
    closeAddProfileModal();
    await loadProfileSelector();
    showToast('Perfil creado correctamente', 'success');
  } catch(e) { showToast('Error al crear perfil', 'error'); }
};

// ─── MAIN APP ────────────────────────────────────────────────────────────────
async function initMainApp() {
  await loadCatalog();
  renderAdsModal();
  setupNavigation();
  setupSearch();
  applyTranslations();
  renderUpcomingBadges();
  // Init lobby system — pass current user + helpers
  initLobbiesUI(currentUser, getContentById, (id) => openContent(id, false), showToast, getAllContent, getUpcoming);
  // Offline downloads (desktop app only — no-op in a browser tab)
  initDownloads(currentUser);
  window.getContentById = getContentById; // downloads-ui.js needs this to resolve items by id
  // Notifications: new episodes for followed series + live stream alerts
  initNotifications().then(async () => {
    if (notificationsEnabled()) {
      const followedIds = Array.from(new Set([...myListIds, ...Object.keys(watchingData)]));
      checkNewEpisodes(getSeries(), followedIds);
      await seedKnownLiveStreams();
      watchForLiveStreams();
    }
  });
  // streams init — called after DOM ready, functions defined at bottom of file
  setTimeout(async () => {
    _injectStreamStyles();
    _streamsCurrentUser = currentUser;
    try { const _ud = currentUser ? await getUserData(currentUser.uid) : null; _streamsIsAdmin = !!(_ud?.isAdmin); } catch(e) {}
  }, 0);
  handleRoute();
  window.addEventListener('popstate', handleRoute);
}

function handleRoute() {
  const hash = window.location.hash;
  const slug = hash.startsWith('#/') ? hash.slice(2) : null;
  if (!slug || slug === 'home') { navigateTo('home', false); return; }
  if (['shows','movies','upcoming','mynetflix','planes','descarga','admin','streams','soundtracks','rbxplus'].includes(slug)) { navigateTo(slug, false); return; }
  if (slug.startsWith('studio/')) { openStudioPage(slug.slice(7)); return; }
  if (slug.startsWith('soundtracks/')) {
    const albumId = slug.slice(12);
    navigateTo('soundtracks', false);
    setTimeout(() => openSoundtrackAlbum(albumId), 400);
    return;
  }
  if (slug.startsWith('foros/')) {
    const parts = slug.slice(6).split('/');
    const contentSlug = parts[0];
    const postId = parts[1] || null;
    navigateTo('home', false);
    setTimeout(() => openForum(contentSlug, postId, false), 100);
    return;
  }
  const item = getContentBySlug(slug);
  if (item) { navigateTo('home', false); setTimeout(() => openContent(item.id, false), 100); return; }
  navigateTo('home', false);
}

// ─── SOUNDTRACKS (public page) ────────────────────────────────────────────────
async function renderSoundtracksPage() {
  const content = document.getElementById('appContent');
  content.innerHTML = `
    <div class="soundtracks-page">
      <h1 class="page-title">🎵 Soundtracks</h1>
      <p class="soundtracks-sub">Escucha las bandas sonoras originales de tus películas y series favoritas.</p>
      <div class="soundtracks-grid" id="soundtracksGrid">
        <div class="atd-empty">Cargando álbumes...</div>
      </div>
    </div>`;

  try {
    const snap = await fbGet(fbRef(db, 'soundtracks'));
    const grid = document.getElementById('soundtracksGrid');
    if (!snap.exists()) { grid.innerHTML = '<div class="empty-msg">Aún no hay bandas sonoras disponibles.</div>'; return; }
    const albums = Object.entries(snap.val()).map(([id, a]) => ({ id, ...a }));
    grid.innerHTML = albums.map(a => {
      const item = getContentById(a.contentId);
      const songCount = a.canciones ? Object.keys(a.canciones).length : 0;
      return `
        <div class="soundtrack-card" onclick="openSoundtrackAlbum('${a.id}')">
          <img src="${a.portada}" alt="${escapeHtml(a.titulo)}" class="soundtrack-cover"
            onerror="this.src='https://via.placeholder.com/300x300/001030/4488ff?text=%E2%99%AB'">
          <div class="soundtrack-play-overlay">▶</div>
          <div class="soundtrack-info">
            <h3>${escapeHtml(a.titulo)}</h3>
            <p>${item ? escapeHtml(item.titulo) : ''}</p>
            <span>${songCount} pista${songCount !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    const grid = document.getElementById('soundtracksGrid');
    if (grid) grid.innerHTML = `<div class="empty-msg">Error al cargar: ${e.message}</div>`;
  }
}

let _stCurrentAudio = null;
let _stCurrentAlbum = null;
let _stCurrentSongId = null;

window.openSoundtrackAlbum = async (albumId) => {
  // Push hash URL so this album is shareable/bookmarkable
  history.pushState(null, '', '#/soundtracks/' + albumId);
  try {
    const snap = await fbGet(fbRef(db, `soundtracks/${albumId}`));
    if (!snap.exists()) { showToast('Álbum no encontrado', 'error'); return; }
    const album = { id: albumId, ...snap.val() };
    _stCurrentAlbum = album;
    const item = getContentById(album.contentId);
    const songs = album.canciones
      ? Object.entries(album.canciones).map(([id, s]) => ({ id, ...s })).sort((a,b) => (a.orden||0) - (b.orden||0))
      : [];

    const modal = document.getElementById('contentModal');
    modal.innerHTML = `
      <div class="fullscreen-modal soundtrack-fullscreen" id="modalBox">
        <button class="fs-floating-close" onclick="closeSoundtrackAlbum()">✕</button>
        <div class="soundtrack-modal-header" style="background-image:linear-gradient(to bottom, rgba(0,13,31,.4), #000d1f 90%), url('${album.portada}')">
          <img src="${album.portada}" class="soundtrack-modal-cover" alt="${escapeHtml(album.titulo)}">
          <div class="soundtrack-modal-meta">
            <span class="tag">Banda sonora original</span>
            <h2>${escapeHtml(album.titulo)}</h2>
            <p>${item ? escapeHtml(item.titulo) : ''}</p>
          </div>
        </div>
        <div class="soundtrack-tracklist" id="soundtrackTracklist">
          ${songs.map((s, i) => `
            <div class="soundtrack-track" id="stTrack_${s.id}" onclick="playSoundtrack('${s.id}')">
              <span class="st-track-num">${i + 1}</span>
              <span class="st-track-icon">▶</span>
              <span class="st-track-title">${escapeHtml(s.titulo)}</span>
            </div>`).join('')}
        </div>
      </div>`;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  } catch(e) {
    showToast('Error al abrir álbum: ' + e.message, 'error');
  }
};

window.playSoundtrack = (songId) => {
  if (!_stCurrentAlbum?.canciones?.[songId]) return;
  const song = _stCurrentAlbum.canciones[songId];

  document.querySelectorAll('.soundtrack-track').forEach(el => el.classList.remove('st-playing'));
  document.getElementById(`stTrack_${songId}`)?.classList.add('st-playing');

  if (_stCurrentAudio) { _stCurrentAudio.pause(); _stCurrentAudio = null; }
  if (_stCurrentSongId === songId) { _stCurrentSongId = null; return; } // toggle off if clicking the same track twice

  _stCurrentSongId = songId;
  _stCurrentAudio = new Audio(song.audioBase64);
  _stCurrentAudio.play().catch(() => showToast('No se pudo reproducir la pista', 'error'));
  _stCurrentAudio.addEventListener('ended', () => {
    document.getElementById(`stTrack_${songId}`)?.classList.remove('st-playing');
    _stCurrentSongId = null;
  });
};

window.closeSoundtrackAlbum = () => {
  if (_stCurrentAudio) { _stCurrentAudio.pause(); _stCurrentAudio = null; }
  _stCurrentSongId = null;
  history.pushState(null, '', '#/soundtracks');
  closeModal();
};

// ─── ADS MODAL ─────────────────────────────────────────────────────────────
let adInterval = null;
let currentAdIdx = 0;

function renderAdsModal() {
  const strip = document.getElementById('adsStrip');
  if (strip) strip.style.display = 'none';
  const ads = getAnuncios();
  if (!ads.length) return;
  currentAdIdx = 0;
  window._adsData = ads;
  setTimeout(() => {
    const modal = document.createElement('div');
    modal.id = 'adModal';
    modal.innerHTML = `
      <div class="ad-modal-backdrop" onclick="closeAdModal()"></div>
      <div class="ad-modal-box">
        <div class="ad-modal-header">
          <span class="ad-modal-label">Patrocinado</span>
          <button class="ad-modal-close" onclick="closeAdModal()">✕</button>
        </div>
        <div class="ad-modal-slide" id="adModalSlide"></div>
        <div class="ad-modal-controls">
          ${ads.length > 1 ? `<button class="ad-arrow" onclick="prevAdModal()">‹</button>` : ''}
          <span class="ad-counter" id="adModalCounter">1 / ${ads.length}</span>
          ${ads.length > 1 ? `<button class="ad-arrow" onclick="nextAdModal()">›</button>` : ''}
          <button class="ad-modal-skip" onclick="closeAdModal()">Cerrar ×</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    renderAdModalSlide();
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('visible')));
    if (ads.length > 1) {
      adInterval = setInterval(() => {
        currentAdIdx = (currentAdIdx + 1) % ads.length;
        renderAdModalSlide();
      }, 6000);
    }
  }, 800);
}

function renderAdModalSlide() {
  const ads = window._adsData || [];
  if (!ads.length) return;
  const ad = ads[currentAdIdx];
  const slide = document.getElementById('adModalSlide');
  const counter = document.getElementById('adModalCounter');
  if (!slide) return;

  // Pause any previous video
  const prevVideo = slide.querySelector('video');
  if (prevVideo) { prevVideo.pause(); prevVideo.src = ''; }

  const mediaHtml = ad.video
    ? `<video class="ad-modal-video" src="${ad.video}" autoplay muted loop playsinline
         onclick="window.open('${ad.url||'#'}','_blank')"
         style="cursor:${ad.url?'pointer':'default'}"></video>`
    : `<img src="${ad.imagen}" alt="${ad.titulo || 'Anuncio'}">`;

  slide.innerHTML = ad.video
    ? `<div class="ad-modal-link ad-modal-video-wrap">
        ${mediaHtml}
        ${ad.titulo ? `<div class="ad-modal-info"><span class="ad-modal-title">${ad.titulo}</span>${ad.url?`<a href="${ad.url}" target="_blank" rel="noopener" class="ad-modal-cta">Ver más →</a>`:''}</div>` : ''}
      </div>`
    : `<a href="${ad.url || '#'}" target="_blank" rel="noopener" class="ad-modal-link">
        ${mediaHtml}
        ${ad.titulo ? `<div class="ad-modal-info"><span class="ad-modal-title">${ad.titulo}</span><span class="ad-modal-cta">Ver más →</span></div>` : ''}
      </a>`;

  if (counter) counter.textContent = `${currentAdIdx + 1} / ${ads.length}`;
}

// Stop autoplay when modal closes or ad changes
function pauseCurrentAd() {
  const v = document.querySelector('#adModalSlide video');
  if (v) { v.pause(); v.src = ''; }
}

window.nextAdModal = () => { const ads = window._adsData||[]; if(adInterval)clearInterval(adInterval); pauseCurrentAd(); currentAdIdx=(currentAdIdx+1)%ads.length; renderAdModalSlide(); };
window.prevAdModal = () => { const ads = window._adsData||[]; if(adInterval)clearInterval(adInterval); pauseCurrentAd(); currentAdIdx=(currentAdIdx-1+ads.length)%ads.length; renderAdModalSlide(); };
window.closeAdModal = () => {
  if (adInterval) clearInterval(adInterval);
  pauseCurrentAd();
  const m = document.getElementById('adModal');
  if (m) { m.classList.remove('visible'); setTimeout(() => m.remove(), 300); }
};


// ─── DEVICE SESSIONS ──────────────────────────────────────────────────────────
// Registers this device when the user logs in and enables remote sign-out

function getDeviceInfo() {
  const ua = navigator.userAgent;
  let device = 'Dispositivo desconocido';
  let tipo   = 'web';

  if (/iPad/i.test(ua))         { device = 'iPad'; tipo = 'tablet'; }
  else if (/iPhone/i.test(ua))  { device = 'iPhone'; tipo = 'mobile'; }
  else if (/Android/i.test(ua) && /Mobile/i.test(ua)) { device = 'Android Mobile'; tipo = 'mobile'; }
  else if (/Android/i.test(ua)) { device = 'Android Tablet'; tipo = 'tablet'; }
  else if (/Windows/i.test(ua)) { device = 'Windows PC'; tipo = 'desktop'; }
  else if (/Macintosh/i.test(ua)) { device = 'Mac'; tipo = 'desktop'; }
  else if (/Linux/i.test(ua))   { device = 'Linux PC'; tipo = 'desktop'; }

  // Browser
  let browser = 'Navegador';
  if (/Edg\//i.test(ua))       browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return { device, tipo, browser };
}

async function registerDeviceSession(uid) {
  try {
    const { device, tipo, browser } = getDeviceInfo();
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    // Try to get rough location via ipapi (free, no key needed, CORS-friendly)
    let location = 'Ubicación desconocida';
    try {
      const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const geo = await r.json();
        if (geo.city && geo.country_name) location = `${geo.city}, ${geo.country_name}`;
        else if (geo.country_name) location = geo.country_name;
      }
    } catch { /* location unavailable */ }

    await fbSet(fbRef(db, `users/${uid}/sessions/${sessionId}`), {
      sessionId,
      device,
      tipo,
      browser,
      location,
      loginAt: Date.now(),
      lastActive: Date.now(),
      isCurrent: true,
      userAgent: navigator.userAgent.substring(0, 200),
    });

    // Save current session ID in memory so we can mark it as current
    window._currentSessionId = sessionId;
    window._currentSessionUid = uid;

    // Update lastActive every 5 minutes
    setInterval(async () => {
      try {
        await fbSet(fbRef(db, `users/${uid}/sessions/${sessionId}/lastActive`), Date.now());
      } catch {}
    }, 5 * 60 * 1000);

  } catch(e) { console.warn('Session register error', e); }
}

async function loadSessions(uid) {
  try {
    const snap = await fbGet(fbRef(db, `users/${uid}/sessions`));
    if (!snap.exists()) return [];
    return Object.values(snap.val())
      .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  } catch { return []; }
}

window.renderSessionsPanel = async () => {
  const container = document.getElementById('sessionsPanel');
  if (!container || !currentUser) return;
  container.innerHTML = '<div style="color:rgba(232,234,240,.4);font-size:.82rem;padding:10px 0">Cargando sesiones...</div>';
  const sessions = await loadSessions(currentUser.uid);

  if (!sessions.length) {
    container.innerHTML = '<div style="color:rgba(232,234,240,.4);font-size:.82rem;padding:10px 0">No hay sesiones registradas.</div>';
    return;
  }

  const deviceIcons = { mobile:'📱', tablet:'💊', desktop:'🖥️', web:'🌐' };

  container.innerHTML = sessions.map(s => {
    const isCurr = s.sessionId === window._currentSessionId;
    const date = s.loginAt ? new Date(s.loginAt).toLocaleString('es-ES', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const lastA = s.lastActive ? new Date(s.lastActive).toLocaleString('es-ES', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
    return `
      <div class="session-item ${isCurr ? 'session-current' : ''}">
        <div class="session-icon">${deviceIcons[s.tipo] || '🌐'}</div>
        <div class="session-info">
          <div class="session-device">${s.device} · ${s.browser}${isCurr ? ' <span class="session-badge">Este dispositivo</span>' : ''}</div>
          <div class="session-meta">
            <span>📍 ${s.location || 'Desconocida'}</span>
            <span>Inicio: ${date}</span>
            <span>Último acceso: ${lastA}</span>
          </div>
        </div>
        ${!isCurr ? `<button class="session-close-btn" onclick="revokeSession('${currentUser.uid}','${s.sessionId}',this)">Cerrar sesión</button>` : ''}
      </div>`;
  }).join('');

  // Close all others button
  const hasOthers = sessions.some(s => s.sessionId !== window._currentSessionId);
  if (hasOthers) {
    container.insertAdjacentHTML('beforeend', `
      <button class="session-close-all-btn" onclick="revokeAllSessions('${currentUser.uid}')">
        Cerrar todas las demás sesiones
      </button>`);
  }
};

window.revokeSession = async (uid, sessionId, btn) => {
  if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
  try {
    btn.disabled = true; btn.textContent = 'Cerrando...';
    await fbSet(fbRef(db, `users/${uid}/sessions/${sessionId}`), null);
    btn.closest('.session-item').remove();
    showToast('Sesión cerrada', 'success');
  } catch { showToast('Error al cerrar sesión', 'error'); btn.disabled = false; }
};

window.revokeAllSessions = async (uid) => {
  if (!confirm('¿Cerrar sesión en todos los demás dispositivos?')) return;
  const sessions = await loadSessions(uid);
  const others = sessions.filter(s => s.sessionId !== window._currentSessionId);
  for (const s of others) {
    await fbSet(fbRef(db, `users/${uid}/sessions/${s.sessionId}`), null).catch(() => {});
  }
  showToast(`${others.length} sesión(es) cerrada(s)`, 'success');
  renderSessionsPanel();
};


// ─── PROFILE EDITOR ───────────────────────────────────────────────────────────
let _editingProfileId = null;

window.openEditProfileModal = async (profileId) => {
  _editingProfileId = profileId;
  const profiles = await getProfiles(currentUser.uid);
  const p = profiles[profileId];
  if (!p) return;

  // Remove any existing modal
  document.getElementById('editProfileModal')?.remove();

  const canDelete = Object.keys(profiles).length > 1;
  const avatars = getAvailableAvatars();
  const avatarGrid = avatars.map(a =>
    `<img src="${a}" class="ep-avatar-opt ${a === p.avatar ? 'ep-avatar-sel' : ''}"
      onclick="selectEditAvatar('${a}', this)"
      onerror="this.style.display='none'">`
  ).join('');

  const modal = document.createElement('div');
  modal.id = 'editProfileModal';
  modal.innerHTML = `
    <div class="ep-backdrop" onclick="closeEditProfileModal()"></div>
    <div class="ep-card">
      <div class="ep-header">
        <h3>Editar perfil</h3>
        <button class="ep-close" onclick="closeEditProfileModal()">✕</button>
      </div>

      <div class="ep-avatar-preview">
        <img id="epAvatarPreview" src="${p.avatar}" alt="" onerror="this.src='resources/avatars/avatar1.png'">
      </div>

      <div class="ep-field">
        <label>Nombre del perfil</label>
        <input type="text" id="epName" value="${p.name}" maxlength="20" placeholder="Nombre">
      </div>

      <div class="ep-field">
        <label>Avatar</label>
        <div class="ep-avatar-grid" id="epAvatarGrid">${avatarGrid}</div>
      </div>

      <div class="ep-field">
        <label>Idioma</label>
        <select id="epLanguage">
          <option value="es" ${(p.language||'es')==='es'?'selected':''}>Español</option>
          <option value="en" ${p.language==='en'?'selected':''}>English</option>
        </select>
      </div>

      <div class="ep-actions">
        <button class="ep-btn-save" onclick="saveEditProfile()">Guardar cambios</button>
        ${canDelete ? `<button class="ep-btn-delete" onclick="confirmDeleteProfile('${profileId}')">Eliminar perfil</button>` : ''}
      </div>
    </div>`;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('ep-visible'));
  // Store current avatar
  modal._avatar = p.avatar;
};

window.selectEditAvatar = (path, el) => {
  const modal = document.getElementById('editProfileModal');
  if (!modal) return;
  modal._avatar = path;
  // Update grid selection
  document.querySelectorAll('.ep-avatar-opt').forEach(i => i.classList.remove('ep-avatar-sel'));
  el.classList.add('ep-avatar-sel');
  // Update preview
  const preview = document.getElementById('epAvatarPreview');
  if (preview) preview.src = path;
};

window.saveEditProfile = async () => {
  const name = document.getElementById('epName')?.value.trim();
  if (!name) { showToast('El nombre no puede estar vacío', 'error'); return; }
  const modal = document.getElementById('editProfileModal');
  const avatar = modal?._avatar || getAvailableAvatars()[0];
  const language = document.getElementById('epLanguage')?.value || 'es';

  try {
    await updateProfile(currentUser.uid, _editingProfileId, { name, avatar, language });
    // Update nav if it's the active profile
    if (currentProfile?.id === _editingProfileId) {
      currentProfile.name = name;
      currentProfile.avatar = avatar;
      currentProfile.language = language;
      document.getElementById('profileAvatarNav').src = avatar;
      document.getElementById('profileNameNav').textContent = name;
    }
    closeEditProfileModal();
    await loadProfileSelector();
    showToast('Perfil actualizado ✓', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.confirmDeleteProfile = async (profileId) => {
  if (!confirm('¿Eliminar este perfil? Se perderán su lista y progreso. Esta acción no se puede deshacer.')) return;
  try {
    const { deleteProfile: delProf } = await import('./profiles.js');
    await delProf(currentUser.uid, profileId);
    closeEditProfileModal();
    // If deleted current profile, go back to selector
    if (currentProfile?.id === profileId) {
      document.getElementById('mainApp').style.display = 'none';
      document.getElementById('profileSelectScreen').style.display = 'flex';
    }
    await loadProfileSelector();
    showToast('Perfil eliminado', 'success');
  } catch(e) { showToast(e.message || 'Error al eliminar', 'error'); }
};

window.closeEditProfileModal = () => {
  const modal = document.getElementById('editProfileModal');
  if (!modal) return;
  modal.classList.remove('ep-visible');
  setTimeout(() => modal.remove(), 300);
  _editingProfileId = null;
};

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = e.currentTarget.dataset.page;
      if (page) navigateTo(page);
    });
  });
}

window.navigateTo = function(page, pushState = true) {
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  if (pushState) history.pushState(null, '', '#/' + page);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const content = document.getElementById('appContent');
  if (content) { content.style.opacity = '0'; content.style.transform = 'translateY(12px)'; }
  setTimeout(async () => {
    switch(page) {
      case 'home':      await renderHomePageFull(); break;
      case 'shows':     renderShowsPage(); break;
      case 'movies':    renderMoviesPage(); break;
      case 'upcoming':  renderUpcomingPage('all'); break;
      case 'mynetflix': await renderMyNetflixPage(); break;
      case 'search':    renderAdvancedSearchPage(); break;
      case 'downloads': await renderDownloadsManagerPage(); break;
      case 'planes':    renderPlanesPage(); break;
      case 'descarga':  await renderDownloadPage(); break;
      case 'admin':     await renderAdminPage(); break;
      case 'streams':   _renderStreamsPage(); break;
      case 'soundtracks': await renderSoundtracksPage(); break;
      case 'rbxplus':    await renderRbxPlusPage(); break;
      default: await renderHomePageFull();
    }
    applyTranslations();
    if (content) {
      requestAnimationFrame(() => {
        content.style.opacity = '1';
        content.style.transition = 'opacity .25s ease, transform .25s ease';
        content.style.transform = 'translateY(0)';
      });
    }
  }, 80);
};

function renderHomePage(publicMode = false) { return renderHomePageFull(publicMode); }

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
async function renderHomePage_base(publicMode = false) {
  const content = document.getElementById('appContent');
  const banners = getBanners();
  const heroItem = banners[0] || getAllContent()[0];
  const top10 = getTop10();
  const featured = getFeatured();
  const newContent = getNewContent();
  const allMovies = getMovies();
  const allSeries = getSeries();
  const watchingIds = Object.keys(watchingData).sort((a,b) =>
    (watchingData[b]?.updatedAt||0) - (watchingData[a]?.updatedAt||0));
  const watchingContent = watchingIds.map(id => getContentById(id)).filter(Boolean);
  content.innerHTML = `
    ${renderHero(heroItem, banners)}
    <div class="home-rows">
      ${!publicMode && watchingContent.length > 0 ? renderRow('Seguir viendo', watchingContent, true) : ''}
      ${newContent.length > 0 ? renderRowWithBadge('🆕 Nuevo en RBX Infinity', newContent) : ''}
      ${top10.length > 0 ? renderTop10Row(top10) : ''}
      ${featured.filter(i=>i.tipo==='serie').length ? renderRow('Series Destacadas', featured.filter(i=>i.tipo==='serie').slice(0,10)) : ''}
      ${allMovies.length ? renderRow('Películas', allMovies.slice(0,10)) : ''}
      ${allSeries.length ? renderRow('Series', allSeries.slice(0,10)) : ''}
      ${renderUpcomingRowHome()}
      ${!publicMode && myListIds.length > 0 ? renderRow('Mi lista', myListIds.map(id=>getContentById(id)).filter(Boolean)) : ''}
    </div>`;
  initBannerAutoplay(banners);
}

// ─── SHOWS PAGE ───────────────────────────────────────────────────────────────
function renderShowsPage() {
  const series = getSeries();
  const genres = getSeriesGenres();
  const content = document.getElementById('appContent');
  content.innerHTML = `
    <div class="browse-page">
      <div class="browse-header">
        <h1 class="page-title">Series</h1>
        <div class="genre-filters" id="seriesGenreFilters">
          <button class="genre-btn active" data-genre="all" onclick="filterShows('all')">Todas</button>
          ${genres.slice(0,8).map(g=>`<button class="genre-btn" data-genre="${g}" onclick="filterShows('${g}')">${g}</button>`).join('')}
        </div>
      </div>
      <div class="browse-grid" id="seriesGrid">
        ${series.length ? series.map(item => renderCardWide(item)).join('') : '<div class="empty-msg">No hay series disponibles todavía.</div>'}
      </div>
    </div>`;
}

window.filterShows = (genre) => {
  const series = getSeries();
  const filtered = genre === 'all' ? series : series.filter(s => s.genero===genre||(s.categorias||[]).includes(genre));
  document.getElementById('seriesGrid').innerHTML = filtered.length
    ? filtered.map(item => renderCardWide(item)).join('')
    : '<div class="empty-msg">No hay series en este género.</div>';
  document.querySelectorAll('#seriesGenreFilters .genre-btn').forEach(b => b.classList.toggle('active', b.dataset.genre===genre));
};

// ─── MOVIES PAGE ──────────────────────────────────────────────────────────────
function renderMoviesPage() {
  const movies = getMovies();
  const genres = getMoviesGenres();
  const content = document.getElementById('appContent');
  content.innerHTML = `
    <div class="browse-page">
      <div class="browse-header">
        <h1 class="page-title">Películas</h1>
        <div class="genre-filters" id="moviesGenreFilters">
          <button class="genre-btn active" data-genre="all" onclick="filterMovies('all')">Todas</button>
          ${genres.slice(0,8).map(g=>`<button class="genre-btn" data-genre="${g}" onclick="filterMovies('${g}')">${g}</button>`).join('')}
        </div>
      </div>
      <div class="browse-grid" id="moviesGrid">
        ${movies.length ? movies.map(item => renderCardWide(item)).join('') : '<div class="empty-msg">No hay películas disponibles todavía.</div>'}
      </div>
    </div>`;
}

window.filterMovies = (genre) => {
  const movies = getMovies();
  const filtered = genre === 'all' ? movies : movies.filter(m => m.genero===genre||(m.categorias||[]).includes(genre));
  document.getElementById('moviesGrid').innerHTML = filtered.length
    ? filtered.map(item => renderCardWide(item)).join('')
    : '<div class="empty-msg">No hay películas en este género.</div>';
  document.querySelectorAll('#moviesGenreFilters .genre-btn').forEach(b => b.classList.toggle('active', b.dataset.genre===genre));
};

// ─── UPCOMING PAGE ────────────────────────────────────────────────────────────
function renderUpcomingPage(filter = 'all') {
  const content = document.getElementById('appContent');
  const allUpcoming = getUpcoming();
  const tabs = [
    { id: 'all', label: 'Todo', items: allUpcoming },
    { id: 'series', label: 'Series', items: getUpcomingSeries() },
    { id: 'movies', label: 'Películas', items: getUpcomingMovies() },
    { id: 'interactivos', label: 'Interactivos', items: allUpcoming.filter(i => i.tipo === 'interactivo') },
  ];
  const activeItems = tabs.find(t=>t.id===filter)?.items || allUpcoming;
  const now = new Date();
  content.innerHTML = `
    <div class="upcoming-page">
      <h1 class="page-title">Próximamente</h1>
      <div class="sub-tabs">
        ${tabs.map(t=>`<button class="sub-tab ${t.id===filter?'active':''}" onclick="renderUpcomingTab('${t.id}')">${t.label}</button>`).join('')}
      </div>
      <div class="upcoming-list" id="upcomingList">
        ${renderUpcomingItems(activeItems, now)}
      </div>
    </div>`;
}

window.renderUpcomingTab = (filter) => renderUpcomingPage(filter);

// ─── ADVANCED SEARCH PAGE (género + año + duración) ──────────────────────────
const DURATION_BUCKETS = [
  { id: 'all',    label: 'Cualquier duración' },
  { id: 'short',  label: 'Menos de 30 min', test: m => m != null && m < 30 },
  { id: 'medium', label: '30 min – 1h30',   test: m => m != null && m >= 30 && m <= 90 },
  { id: 'long',   label: 'Más de 1h30',     test: m => m != null && m > 90 },
];

// "duracion" is free text in the catalog ("120 min", "1h 45m", "Desconocida").
// This best-effort parses it down to a minute count for the range filter;
// items where it can't parse just fall under "Cualquier duración".
function _parseDurationMinutes(duracion) {
  if (!duracion) return null;
  const str = String(duracion).toLowerCase();
  const hMatch = str.match(/(\d+)\s*h/);
  const mMatch = str.match(/(\d+)\s*m(?!es)/); // avoid matching "min" inside other words
  const plainMatch = str.match(/^(\d+)\s*min/);
  if (plainMatch) return parseInt(plainMatch[1], 10);
  if (hMatch || mMatch) {
    const h = hMatch ? parseInt(hMatch[1], 10) : 0;
    const m = mMatch ? parseInt(mMatch[1], 10) : 0;
    return h * 60 + m;
  }
  return null;
}

let _searchFilters = { genre: 'all', year: 'all', duration: 'all', type: 'all' };

function _getSearchFilterOptions(all) {
  const genres = new Set();
  const years = new Set();
  all.forEach(item => {
    if (item.genero) genres.add(item.genero);
    (item.categorias || []).forEach(c => genres.add(c));
    if (item.año) years.add(item.año);
  });
  return {
    genres: Array.from(genres).sort(),
    years: Array.from(years).sort((a,b) => b - a)
  };
}

function renderAdvancedSearchPage() {
  const content = document.getElementById('appContent');
  const all = getAllContent();
  const { genres, years } = _getSearchFilterOptions(all);

  content.innerHTML = `
    <div class="browse-page search-page">
      <div class="browse-header">
        <h1 class="page-title">Buscar</h1>
        <div class="search-filters-bar">
          <select id="sfType" onchange="_applySearchFilters()">
            <option value="all">Todo el contenido</option>
            <option value="pelicula">Películas</option>
            <option value="serie">Series</option>
            <option value="interactivo">Interactivos</option>
          </select>
          <select id="sfGenre" onchange="_applySearchFilters()">
            <option value="all">Todos los géneros</option>
            ${genres.map(g => `<option value="${g}">${g}</option>`).join('')}
          </select>
          <select id="sfYear" onchange="_applySearchFilters()">
            <option value="all">Todos los años</option>
            ${years.map(y => `<option value="${y}">${y}</option>`).join('')}
          </select>
          <select id="sfDuration" onchange="_applySearchFilters()">
            ${DURATION_BUCKETS.map(b => `<option value="${b.id}">${b.label}</option>`).join('')}
          </select>
          <button class="search-filters-clear" onclick="_clearSearchFilters()">Limpiar filtros</button>
        </div>
      </div>
      <div class="browse-grid" id="searchResultsGrid"></div>
    </div>`;

  _applySearchFilters();
}

window._applySearchFilters = () => {
  _searchFilters.type     = document.getElementById('sfType')?.value || 'all';
  _searchFilters.genre    = document.getElementById('sfGenre')?.value || 'all';
  _searchFilters.year     = document.getElementById('sfYear')?.value || 'all';
  _searchFilters.duration = document.getElementById('sfDuration')?.value || 'all';

  let results = getAllContent();

  if (_searchFilters.type !== 'all') {
    results = results.filter(item => item.tipo === _searchFilters.type);
  }
  if (_searchFilters.genre !== 'all') {
    results = results.filter(item =>
      item.genero === _searchFilters.genre || (item.categorias || []).includes(_searchFilters.genre));
  }
  if (_searchFilters.year !== 'all') {
    results = results.filter(item => String(item.año) === _searchFilters.year);
  }
  if (_searchFilters.duration !== 'all') {
    const bucket = DURATION_BUCKETS.find(b => b.id === _searchFilters.duration);
    if (bucket?.test) {
      results = results.filter(item => bucket.test(_parseDurationMinutes(item.duracion)));
    }
  }

  const grid = document.getElementById('searchResultsGrid');
  if (!grid) return;
  grid.innerHTML = results.length
    ? results.map(item => renderCardWide(item)).join('')
    : '<div class="empty-msg">No hay resultados con estos filtros.</div>';
};

window._clearSearchFilters = () => {
  _searchFilters = { genre: 'all', year: 'all', duration: 'all', type: 'all' };
  ['sfType','sfGenre','sfYear','sfDuration'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.id === 'sfDuration' ? 'all' : 'all';
  });
  _applySearchFilters();
};

// ─── DOWNLOADS MANAGER PAGE (desktop only) ──────────────────────────────────
async function renderDownloadsManagerPage() {
  const content = document.getElementById('appContent');
  if (!isDesktop()) {
    content.innerHTML = `
      <div class="browse-page">
        <div class="empty-msg" style="padding:80px 20px;text-align:center">
          <p style="font-size:1.1rem;margin-bottom:8px">Las descargas están disponibles en la app de escritorio</p>
          <p style="opacity:.6">Descarga RBX Infinity para Windows o macOS para ver contenido sin conexión.</p>
          <button class="btn-primary" style="margin-top:16px" onclick="navigateTo('descarga')">Descargar la app</button>
        </div>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div class="browse-page">
      <div class="browse-header">
        <h1 class="page-title">Mis descargas</h1>
      </div>
      <div id="downloadsManagerGrid" class="browse-grid">
        <div class="empty-msg">Cargando descargas...</div>
      </div>
    </div>`;

  const downloads = await listDownloads();
  const grid = document.getElementById('downloadsManagerGrid');
  if (!grid) return;

  if (!downloads.length) {
    grid.innerHTML = `<div class="empty-msg">No tienes descargas todavía. Ve al detalle de una película o episodio y pulsa "Descargar".</div>`;
    return;
  }

  grid.innerHTML = downloads.map(d => `
    <div class="card-wide download-manager-card">
      <div class="card-wide-img">
        <img src="${d.poster || 'https://via.placeholder.com/280x400/001030/4488ff?text=RBX'}" alt="${escapeHtml(d.title)}" loading="lazy">
      </div>
      <div class="card-wide-info">
        <h3>${escapeHtml(d.title)}</h3>
        <div class="card-wide-meta">
          <span class="tag">${d.quality}</span>
          <span>${_formatBytes(d.sizeBytes || 0)}</span>
        </div>
        <div class="card-wide-actions">
          <button class="btn-play-sm" onclick="playOfflineFromManager('${d.contentId}')">▶ Reproducir</button>
          <button class="card-list-btn" title="Eliminar descarga" onclick="deleteDownloadFromManager('${d.contentId}')">🗑</button>
        </div>
      </div>
    </div>`).join('');
}

function _formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

window.playOfflineFromManager = (contentId) => {
  // Episode keys look like "serieId_s1e2" — route through playEpisode so
  // series metadata (next episode, title) is still resolved correctly.
  const epMatch = contentId.match(/^(.+)_s(\d+)e(\d+)$/);
  if (epMatch) { window.playEpisode(epMatch[1], +epMatch[2], +epMatch[3]); return; }
  window.playContent(contentId);
};

window.deleteDownloadFromManager = async (contentId) => {
  if (!confirm('¿Eliminar esta descarga?')) return;
  await deleteDownload(contentId);
  showToast('Descarga eliminada', 'info');
  renderDownloadsManagerPage();
};

function upcomingTypeTag(item) {
  if (item.tipo === 'interactivo') return '🧩 Interactivo';
  if (item.tipo === 'serie') return '📺 Serie';
  return '🎬 Película';
}

function renderUpcomingItems(items, now) {
  if (!items.length) return `<div class="empty-msg">No hay contenido en esta categoría</div>`;
  return items.map(item => {
    const date = item.fecha ? new Date(item.fecha) : null;
    const isPast = date && date < now;
    const bg = item.banner || item.poster || '';
    const reminded = remindedIds.includes(item.id);
    return `
      <div class="upcoming-item">
        <div class="upcoming-banner-img" style="background-image:url('${bg}');background-size:cover;background-position:center top;" onclick="openUpcoming('${item.id}')">
          <div class="upcoming-overlay-gradient">
            <span class="upcoming-label">${item.etiqueta || 'Próximamente'}</span>
          </div>
        </div>
        <div class="upcoming-details">
          <div class="upcoming-type-tag">
            <span class="tag">${upcomingTypeTag(item)}</span>
            ${item.genero?`<span class="tag">${item.genero}</span>`:''}
            ${item.rating?`<span class="tag">${item.rating}</span>`:''}
          </div>
          <h3 onclick="openUpcoming('${item.id}')" style="cursor:pointer">${item.titulo}</h3>
          <div class="upcoming-date-row">
            <span>${date ? formatDate(item.fecha) : (item.etiqueta||'Próximamente')}</span>
            ${date && !isPast ? `<span class="countdown-badge">⏱ ${getCountdown(item.fecha)}</span>` : date ? '<span class="available-badge">✓ Disponible</span>' : ''}
          </div>
          <p>${item.descripcion||''}</p>
          <div class="upcoming-actions">
            ${renderTrailerButtons(item)}
            ${!isPast ? `<button class="btn-remind ${reminded?'reminded':''}" id="remindBtn_${item.id}" onclick="toggleRemind('${item.id}')">
              ${reminded?'🔔 Recordar':'🔕 Recuérdame'}
            </button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

window.toggleRemind = (id) => {
  if (!currentUser) { showToast('Inicia sesión para activar recordatorios','info'); return; }
  const idx = remindedIds.indexOf(id);
  if (idx >= 0) {
    remindedIds.splice(idx, 1);
    showToast('Recordatorio eliminado','info');
  } else {
    remindedIds.push(id);
    showToast('🔔 Te avisaremos cuando esté disponible','success');
  }
  localStorage.setItem('cp_reminded', JSON.stringify(remindedIds));
  const btn = document.getElementById(`remindBtn_${id}`);
  if (btn) {
    btn.classList.toggle('reminded', !btn.classList.contains('reminded'));
    btn.textContent = remindedIds.includes(id) ? '🔔 Recordar' : '🔕 Recuérdame';
  }
};

// ─── MY XCINE PAGE ───────────────────────────────────────────────────────────
function renderMyNetflixPage() {
  if (!currentUser) { showAuthScreen(); return; }
  const myItems = myListIds.map(id => getContentById(id)).filter(Boolean);
  const watchingIds = Object.keys(watchingData).sort((a,b) =>
    (watchingData[b]?.updatedAt||0) - (watchingData[a]?.updatedAt||0));
  const watchingItems = watchingIds.map(id => getContentById(id)).filter(Boolean);
  const reminded = remindedIds.map(id => getUpcoming().find(u=>u.id===id)).filter(Boolean);
  const content = document.getElementById('appContent');
  content.innerHTML = `
    <div class="mynetflix-page">
      <h1 class="page-title">My RBX</h1>
      ${watchingItems.length > 0 ? `
        <section class="my-section">
          <h2 class="section-title">Seguir viendo</h2>
          <div class="cards-track">${watchingItems.map(i=>renderCard(i,true)).join('')}</div>
        </section>` : ''}
      <section class="my-section">
        <h2 class="section-title">Mi lista</h2>
        ${myItems.length > 0
          ? `<div class="cards-track">${myItems.map(i=>renderCard(i)).join('')}</div>`
          : `<div class="empty-msg">Tu lista está vacía. ¡Añade contenido que quieras ver!</div>`}
      </section>
      ${reminded.length > 0 ? `
        <section class="my-section">
          <h2 class="section-title">🔔 Recordatorios</h2>
          <div class="cards-track">${reminded.map(item=>`
            <div class="content-card upcoming-card" onclick="openUpcoming('${item.id}')">
              <div class="card-img-wrap">
                <img src="${item.poster}" alt="${item.titulo}" loading="lazy">
                <div class="upcoming-badge">${item.etiqueta||'Pronto'}</div>
                <div class="card-overlay">
                  <div class="card-info">
                    <span class="card-title">${item.titulo}</span>
                    ${item.fecha ? `<span class="card-date">${formatDate(item.fecha)}</span>` : ''}
                  </div>
                </div>
              </div>
            </div>`).join('')}
          </div>
        </section>` : ''}
    </div>`;
}

// ─── PLANES PAGE — ROBUX PAYMENT ─────────────────────────────────────────────
const ROBLOX_PAYMENT_URL = 'https://www.roblox.com/games/90329656280364/ToPay';
const DISCORD_SUPPORT_URL = 'https://discord.gg/K4bj6XBHeq';

const FAKE_USERS = ['Marcos_T','CineFan92','PelisFanatic','NightOwl_','AnaGarcia','JoseR','LauraCine','NekoFan','DarkScreen','MiguélV'];
const FAKE_PLANS = ['RBX Infinity', 'RBX Infinity Plus'];
const FAKE_MESSAGES_CANCEL = ['Ha cancelado su suscripción', 'se ha dado de baja', 'ha cancelado su plan'];

let chatMessages = [];
let chatFakeInterval = null;

function generateFakeEvent(type = 'subscribe') {
  const user = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
  const plan = FAKE_PLANS[Math.floor(Math.random() * FAKE_PLANS.length)];
  const masked = user.slice(0, 2) + '****' + user.slice(-1);
  const ts = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (type === 'subscribe') {
    return { type: 'subscribe', user: masked, plan, ts,
      msg: `¡Se ha suscrito al plan <strong>${plan}</strong>! 🎉` };
  } else {
    const phrase = FAKE_MESSAGES_CANCEL[Math.floor(Math.random() * FAKE_MESSAGES_CANCEL.length)];
    return { type: 'cancel', user: masked, plan, ts,
      msg: `${phrase} <strong>${plan}</strong>.` };
  }
}

function renderChatMessage(evt) {
  return `
    <div class="chat-msg chat-msg-${evt.type} chat-anim">
      <div class="chat-msg-icon">${evt.type === 'subscribe' ? '🟢' : '🔴'}</div>
      <div class="chat-msg-body">
        <span class="chat-user">${evt.user}</span>
        <span class="chat-text">${evt.msg}</span>
        <span class="chat-time">${evt.ts}</span>
      </div>
    </div>`;
}

function pushChatMessage(evt) {
  chatMessages.unshift(evt);
  if (chatMessages.length > 40) chatMessages.pop();
  const list = document.getElementById('subChatList');
  if (!list) return;
  const div = document.createElement('div');
  div.innerHTML = renderChatMessage(evt);
  const node = div.firstElementChild;
  list.prepend(node);
  while (list.children.length > 30) list.removeChild(list.lastChild);
}

function startFakeChat() {
  stopFakeChat();
  for (let i = 0; i < 6; i++) {
    const type = Math.random() > 0.3 ? 'subscribe' : 'cancel';
    chatMessages.push(generateFakeEvent(type));
  }
  const randDelay = () => 4000 + Math.random() * 8000;
  const scheduleNext = () => {
    chatFakeInterval = setTimeout(() => {
      const type = Math.random() > 0.25 ? 'subscribe' : 'cancel';
      pushChatMessage(generateFakeEvent(type));
      if (document.getElementById('subChatList')) scheduleNext();
    }, randDelay());
  };
  scheduleNext();
}

function stopFakeChat() {
  if (chatFakeInterval) clearTimeout(chatFakeInterval);
  chatFakeInterval = null;
}

function renderPlanesPage() {
  navigateTo('home');
}

function renderHero(item, banners = []) {
  if (!item) return '';
  const bg = item.banner || item.poster;
  const bgImg = bg
    ? `linear-gradient(to right,rgba(0,10,30,.95) 30%,rgba(0,10,30,.3) 70%,transparent 100%),url('${bg}')`
    : 'linear-gradient(135deg,#000d1f,#001a3a)';
  return `
    <div class="hero-banner" id="heroBanner" style="background-image:${bgImg}">
      <div class="hero-content">
        ${item.logo ? `<img src="${item.logo}" class="hero-logo" alt="${item.titulo}">` : `<h1 class="hero-title">${item.titulo}</h1>`}
        <div class="hero-meta">
          ${item.subtitulo?`<span class="hero-badge">${item.subtitulo}</span>`:''}
          ${item.año?`<span>${item.año}</span>`:''}
          ${item.temporadas?`<span>${Array.isArray(item.temporadas)?item.temporadas.length:item.temporadas} temporadas</span>`:''}
          ${item.duracion?`<span>${item.duracion}</span>`:''}
          ${item.rating?`<span class="hero-rating">${item.rating}</span>`:''}
        </div>
        <p class="hero-desc">${item.descripcion||''}</p>
        <div class="hero-actions">
          <button class="btn-play" onclick="openContent('${item.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Reproducir
          </button>
          <button class="btn-info" onclick="openContent('${item.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            Más info
          </button>
          ${currentUser ? `<button class="btn-list ${myListIds.includes(item.id)?'in-list':''}" onclick="toggleMyList('${item.id}',this)" title="Mi lista">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${myListIds.includes(item.id)?'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z':'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'}"/></svg>
          </button>` : ''}
        </div>
      </div>
      ${item.bannerLogo?`<div class="hero-banner-logo-wrap"><img src="${item.bannerLogo}" class="hero-banner-logo" alt="logo"></div>`:''}
      ${banners.length>1?`<div class="hero-indicators" id="heroIndicators"></div>`:''}
    </div>`;
}

// ─── ROWS ─────────────────────────────────────────────────────────────────────
function renderRow(title, items, isContinue = false) {
  if (!items || !items.length) return '';
  return `
    <div class="content-row">
      <h2 class="row-title">${title}</h2>
      <div class="cards-track">${items.map(item => renderCard(item, isContinue)).join('')}</div>
    </div>`;
}

function renderRowWithBadge(title, items) {
  if (!items || !items.length) return '';
  return `
    <div class="content-row">
      <h2 class="row-title">${title}</h2>
      <div class="cards-track">${items.map(item => renderCard(item, false, true)).join('')}</div>
    </div>`;
}

function renderTop10Row(items) {
  if (!items.length) return '';
  return `
    <div class="content-row top10-row">
      <h2 class="row-title">🏆 Top 10 en RBX Infinity</h2>
      <div class="cards-track top10-track">
        ${items.map((item, idx) => `
          <div class="top10-card" onclick="openContent('${item.id}')">
            <span class="top10-number">${idx + 1}</span>
            <div class="content-card" data-id="${item.id}">
              <div class="card-img-wrap">
                <img src="${item.poster||item.banner}" alt="${item.titulo}" loading="lazy"
                  onerror="this.src='https://via.placeholder.com/300x450/001030/4488ff?text=RBX Infinity'">
                <div class="card-overlay">
                  <div class="card-actions">
                    <button class="card-play-btn">▶</button>
                    ${currentUser?`<button class="card-list-btn ${myListIds.includes(item.id)?'in-list':''}"
                      onclick="event.stopPropagation();toggleMyList('${item.id}',this)">${myListIds.includes(item.id)?'✓':'+'}</button>`:''}
                  </div>
                  <div class="card-info">
                    <span class="card-title">${item.titulo}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderUpcomingRowHome() {
  const upcoming = getUpcoming().slice(0, 8);
  if (!upcoming.length) return '';
  return `
    <div class="content-row">
      <h2 class="row-title">🕐 Próximamente <a href="#" onclick="navigateTo('upcoming');return false;" class="row-link">Ver todo →</a></h2>
      <div class="cards-track">
        ${upcoming.map(item => `
          <div class="content-card upcoming-card" onclick="openUpcoming('${item.id}')">
            <div class="card-img-wrap">
              <img src="${item.poster||item.banner}" alt="${item.titulo}" loading="lazy"
                onerror="this.src='https://via.placeholder.com/300x450/001030/4488ff?text=Pronto'">
              <div class="upcoming-badge">${item.etiqueta||'Pronto'}</div>
              <div class="card-overlay">
                <div class="card-info">
                  <span class="card-title">${item.titulo}</span>
                  ${item.fecha?`<span class="card-date">${formatDate(item.fecha)}</span>`:''}
                </div>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ─── CARDS ────────────────────────────────────────────────────────────────────
function renderCard(item, showProgress = false, isNew = false) {
  if (!item) return '';
  const progress = watchingData[item.id]?.progress || 0;
  const inList = myListIds.includes(item.id);
  const isSerie = item.tipo === 'serie';
  const seasonCount = isSerie && Array.isArray(item.temporadas) ? item.temporadas.length : (item.temporadas || 0);
  return `
    <div class="content-card" data-id="${item.id}" onclick="openContent('${item.id}')"
      ${item.trailer ? `onmouseenter="_scheduleCardTrailer(this,'${encodeURIComponent(item.trailer)}')" onmouseleave="_cancelCardTrailer(this)"` : ''}>
      <div class="card-img-wrap">
        <img src="${item.poster||item.banner}" alt="${item.titulo}" loading="lazy" class="card-poster-img"
          onerror="this.src='https://via.placeholder.com/300x450/001030/4488ff?text=RBX Infinity'">
        ${isNew ? '<span class="card-new-badge">NUEVO</span>' : ''}
        ${item.logo ? `<img src="${item.logo}" class="card-logo" alt="">` : ''}
        ${showProgress ? `<button class="card-remove-btn" title="Quitar de Seguir viendo"
            onclick="event.stopPropagation();removeFromContinueWatching('${item.id}',this)">✕</button>` : ''}
        <div class="card-overlay">
          <div class="card-actions">
            <button class="card-play-btn">▶</button>
            ${currentUser?`<button class="card-list-btn ${inList?'in-list':''}"
              onclick="event.stopPropagation();toggleMyList('${item.id}',this)"
              title="${inList?'Quitar de mi lista':'Añadir a mi lista'}">${inList?'✓':'+'}</button>`:''}
          </div>
          <div class="card-info">
            <span class="card-title">${item.titulo}</span>
            <div class="card-meta-small">
              ${item.año?`<span>${item.año}</span>`:''}
              ${item.rating?`<span>${item.rating}</span>`:''}
              ${seasonCount?`<span>${seasonCount}T</span>`:''}
            </div>
          </div>
        </div>
        ${showProgress && progress > 0 ? `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>` : ''}
      </div>
    </div>`;
}

// ─── HOVER TRAILER PREVIEW ─────────────────────────────────────────────────────
// Netflix-style: wait a beat before playing (avoids firing on quick mouse
// passes while scrolling a row), load the trailer lazily on first hover
// only, and always tear the <video> down on mouse-leave rather than just
// pausing it, so scrolling through a long row doesn't leave dozens of
// buffered video elements alive at once.
const _CARD_TRAILER_DELAY = 600;

window._scheduleCardTrailer = (cardEl, encodedSrc) => {
  clearTimeout(cardEl._trailerTimer);
  cardEl._trailerTimer = setTimeout(() => {
    if (!cardEl.matches(':hover')) return;
    _playCardTrailer(cardEl, decodeURIComponent(encodedSrc));
  }, _CARD_TRAILER_DELAY);
};

window._cancelCardTrailer = (cardEl) => {
  clearTimeout(cardEl._trailerTimer);
  const vid = cardEl.querySelector('.card-trailer-vid');
  if (vid) {
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.remove();
  }
  cardEl.querySelector('.card-poster-img')?.classList.remove('card-poster-hidden');
};

function _playCardTrailer(cardEl, src) {
  const wrap = cardEl.querySelector('.card-img-wrap');
  if (!wrap || cardEl.querySelector('.card-trailer-vid')) return;
  const vid = document.createElement('video');
  vid.className = 'card-trailer-vid';
  vid.src = src;
  vid.muted = true;
  vid.loop = true;
  vid.playsInline = true;
  vid.autoplay = true;
  wrap.appendChild(vid);
  vid.play().then(() => {
    cardEl.querySelector('.card-poster-img')?.classList.add('card-poster-hidden');
  }).catch(() => {
    // Autoplay blocked or trailer failed to load — just stay on the poster.
    vid.remove();
  });
}


function renderCardWide(item) {
  if (!item) return '';
  const inList = myListIds.includes(item.id);
  const isSerie = item.tipo === 'serie';
  const seasonCount = isSerie && Array.isArray(item.temporadas) ? item.temporadas.length : (item.temporadas || 0);
  const totalEps = isSerie && Array.isArray(item.temporadas)
    ? item.temporadas.reduce((acc, t) => acc + (t.episodios?.length || 0), 0) : 0;
  return `
    <div class="card-wide" onclick="openContent('${item.id}')">
      <div class="card-wide-img">
        <img src="${item.poster||item.banner}" alt="${item.titulo}" loading="lazy"
          onerror="this.src='https://via.placeholder.com/280x400/001030/4488ff?text=${encodeURIComponent(item.titulo)}'">
        <div class="card-wide-hover"><button class="card-play-btn big">▶</button></div>
      </div>
      <div class="card-wide-info">
        <h3>${item.titulo}</h3>
        <div class="card-wide-meta">
          ${item.año?`<span>${item.año}</span>`:''}
          ${item.rating?`<span class="tag">${item.rating}</span>`:''}
          ${seasonCount?`<span class="tag">${seasonCount} temp.</span>`:''}
          ${totalEps?`<span class="tag">${totalEps} ep.</span>`:''}
          ${item.duracion?`<span>${item.duracion}</span>`:''}
        </div>
        <p class="card-wide-desc">${(item.descripcion||'').substring(0,120)}${(item.descripcion?.length||0)>120?'...':''}</p>
        <div class="card-wide-actions">
          <button class="btn-play-sm" onclick="event.stopPropagation();openContent('${item.id}')">▶ Reproducir</button>
          ${currentUser?`<button class="card-list-btn ${inList?'in-list':''}"
            onclick="event.stopPropagation();toggleMyList('${item.id}',this)">${inList?'✓':'+'}</button>`:''}
        </div>
      </div>
    </div>`;
}

// ─── CONTENT MODAL ────────────────────────────────────────────────────────────
window.openContent = (id, pushState = true) => {
  const item = getContentById(id);
  if (!item) {
    if (_rawGetContentById(id) && currentProfile) {
      showToast('Este contenido no está disponible en este perfil', 'info');
    }
    return;
  }
  if (pushState) history.pushState(null, '', '#/' + titleToSlug(item.titulo));
  const modal = document.getElementById('contentModal');
  const inList = myListIds.includes(id);
  const isSerie = item.tipo === 'serie';
  const seasons = isSerie && Array.isArray(item.temporadas) ? item.temporadas : [];
  const bg = item.banner || item.poster;

  // Continue watching data
  const watchEntry = watchingData[id];
  const progress = watchEntry?.progress || 0;
  const isInteractivo = item.tipo === 'interactivo';
  const hasProgress = isInteractivo ? !!watchEntry?.lastVideoId : (progress > 0 && progress < 95);
  const playLabel = isInteractivo
    ? (hasProgress ? '▶ Continuar historia' : '▶ Empezar historia')
    : (hasProgress ? `▶ Continuar (${progress}%)` : (isSerie && seasons.length ? '▶ Ver T1 E1' : '▶ Reproducir'));

  // Similar with "because you watched" label
  const recs = getRecommendations(id, Object.keys(watchingData)).slice(0,6);
  const recsLabel = Object.keys(watchingData).length > 0 ? `Porque viste <em>${item.titulo}</em>` : 'Contenido similar';

  modal.innerHTML = `
    <div class="fullscreen-modal content-fullscreen" id="modalBox">
      <button class="fs-floating-close" onclick="closeModal()">✕</button>
      <div class="modal-banner" style="background-image:linear-gradient(to bottom,transparent 40%,#000d1f 100%),url('${bg}')">
        ${item.bannerLogo?`<img src="${item.bannerLogo}" class="hero-banner-logo" style="position:absolute;bottom:80px;left:32px;max-width:140px;" alt="logo">`:''}
        ${hasProgress && !isInteractivo ? `<div class="modal-progress-bar"><div class="modal-progress-fill" style="width:${progress}%"></div></div>` : ''}
        <div class="modal-banner-actions">
          <button class="btn-play" onclick="playContent('${id}')">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            ${playLabel}
          </button>
          ${currentUser && !isInteractivo ? `<button class="btn-partywatch" onclick="startPartyWatch('${id}')" title="PartyWatch — ver con amigos en vivo">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h5v2H7v2h10v-2h-1v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12H3V5h18v10z"/>
              <circle cx="9" cy="9.2" r="1.7"/>
              <path d="M6 13c0-1.4 1.4-2.3 3-2.3s3 .9 3 2.3v.4H6V13z"/>
              <circle cx="16" cy="9" r="1.5"/>
              <path d="M13.4 12.6c.2-1.1 1.4-1.8 2.6-1.8s2.4.7 2.6 1.8l.1.5h-5.4l.1-.5z"/>
            </svg>
          </button>`:''}
          ${currentUser?`<button class="btn-list ${inList?'in-list':''}" onclick="toggleMyList('${id}',this)">
            ${inList?'✓ En mi lista':'+ Mi lista'}
          </button>`:''}
          ${currentUser && !isInteractivo ? renderDownloadButton(item) : ''}
          ${renderTrailerButtons(item)}
          ${currentUser?`<button class="btn-share-modal" onclick="openShareModal('${id}')" title="Compartir">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>
          </button>`:''}
        </div>
      </div>
      <div class="modal-content">
        <div class="modal-header">
          ${item.logo?`<img src="${item.logo}" class="modal-logo" alt="${item.titulo}">`:`<h2 class="modal-title">${item.titulo}</h2>`}
          <div class="modal-meta">
            ${item.año?`<span>${item.año}</span>`:''}
            ${isSerie && seasons.length?`<span>${seasons.length} temporada${seasons.length>1?'s':''}</span>`:''}
            ${item.duracion?`<span>${item.duracion}</span>`:''}
            ${item.rating?`<span class="modal-rating">${item.rating}</span>`:''}
            ${item.genero?`<span class="tag">${item.genero}</span>`:''}
            ${item.studio?`<button class="studio-tag-btn" onclick="closeModal();openStudioPage('${item.studio}')">${item.studio.replace('_',' ')}</button>`:''}
          </div>
        </div>
        <p class="modal-desc">${item.descripcion||''}</p>
        ${item.categorias?.length?`<div class="modal-tags">${item.categorias.map(c=>`<span class="tag clickable-tag" onclick="filterByTag('${c}')">${c}</span>`).join('')}</div>`:''}
        ${currentUser ? renderRatingSection(id, currentUser.uid) : ''}
        ${isSerie && seasons.length ? renderSeasonsTabs(seasons, id) : ''}
        <div class="modal-more">
          <h3>${recsLabel}</h3>
          <div class="cards-track mini-track">
            ${recs.map(rec=>renderCard(rec)).join('')}
          </div>
        </div>
        ${renderForumEntryButton(id, item)}
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (isSerie && seasons.length) switchSeasonTab(0, seasons, id);
  // Load ratings asynchronously
  if (currentUser) loadAndDisplayRatings(id, currentUser.uid);
  if (currentUser && !isInteractivo) refreshDownloadButton(item);
  // Load forum average rating badge
  loadForumPosts(id).then(posts => {
    const avg = forumAvgRating(posts);
    const badge = document.getElementById('forumAvgBadge_' + id);
    if (badge && avg) { badge.textContent = `★ ${avg}`; badge.style.display = 'inline'; }
  });
};

function renderSeasonsTabs(seasons, serieId) {
  return `
    <div class="seasons-section">
      <div class="seasons-tabs" id="seasonsTabs">
        ${seasons.map((s,i)=>`
          <button class="season-tab ${i===0?'active':''}"
            onclick="switchSeasonTab(${i},null,'${serieId}')" data-season-idx="${i}">
            ${s.titulo||`Temporada ${s.numero}`}
          </button>`).join('')}
      </div>
      <div class="episodes-list" id="episodesList"></div>
    </div>`;
}

window.switchSeasonTab = (idx, seasonsArg, serieId) => {
  const item = getContentById(serieId);
  if (!item || !Array.isArray(item.temporadas)) return;
  const seasons = seasonsArg || item.temporadas;
  const season = seasons[idx];
  if (!season) return;
  document.querySelectorAll('.season-tab').forEach((t,i) => t.classList.toggle('active', i===idx));
  const list = document.getElementById('episodesList');
  if (!list) return;
  list.innerHTML = (season.episodios || []).map(ep => {
    const epKey = `${serieId}_s${season.numero}e${ep.numero}`;
    return `
    <div class="episode-item" onclick="playEpisode('${serieId}',${season.numero},${ep.numero})">
      <div class="ep-thumbnail">
        ${ep.thumbnail ? `<img src="${ep.thumbnail}" alt="">` : '<div class="ep-thumb-placeholder">▶</div>'}
      </div>
      <div class="ep-info">
        <div class="ep-header">
          <span class="ep-num">${season.numero}×${String(ep.numero).padStart(2,'0')}</span>
          <span class="ep-title">${ep.titulo}</span>
          ${ep.duracion?`<span class="ep-dur">${ep.duracion}</span>`:''}
        </div>
        ${ep.descripcion?`<p class="ep-desc">${ep.descripcion}</p>`:''}
      </div>
      ${isDesktop() ? `
        <div class="ep-download-wrap" onclick="event.stopPropagation()">
          ${renderDownloadButton({ id: epKey, titulo: `${item.titulo} T${season.numero}E${ep.numero}`, video: ep.video, poster: ep.thumbnail })}
        </div>` : ''}
    </div>`;
  }).join('') || '<div class="empty-msg">No hay episodios disponibles</div>';
  if (isDesktop()) {
    (season.episodios || []).forEach(ep => {
      const epKey = `${serieId}_s${season.numero}e${ep.numero}`;
      refreshDownloadButton({ id: epKey, titulo: '', video: ep.video });
    });
  }
};

window.openUpcoming = (id) => {
  const item = getContentById(id) || getUpcoming().find(u => u.id === id);
  if (!item) return;
  const modal = document.getElementById('contentModal');
  const date = item.fecha ? new Date(item.fecha) : null;
  const isPast = date && date < new Date();
  const bg = item.banner || item.poster;
  const reminded = remindedIds.includes(id);
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()"></div>
    <div class="modal-box" id="modalBox">
      <button class="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-banner" style="background-image:linear-gradient(to bottom,transparent 40%,#000d1f 100%),url('${bg||''}')">
        <div class="modal-banner-actions">
          ${renderTrailerButtons(item)}
        </div>
        <div class="upcoming-overlay-big">
          <span>${item.etiqueta||'Próximamente'}</span>
        </div>
      </div>
      <div class="modal-content">
        <div class="modal-header">
          <h2 class="modal-title">${item.titulo}</h2>
          <div class="modal-meta">
            <span class="tag">${item.tipo==='serie'?'📺 Serie':'🎬 Película'}</span>
            ${date?`<span>📅 ${formatDate(item.fecha)}</span>`:''}
            ${item.rating?`<span>${item.rating}</span>`:''}
            ${item.genero?`<span class="tag">${item.genero}</span>`:''}
          </div>
        </div>
        <p class="modal-desc">${item.descripcion||''}</p>
        ${date && !isPast ? `<div class="countdown-display">⏱ ${getCountdown(item.fecha)}</div>` : ''}
        ${!isPast && currentUser ? `<button class="btn-remind ${reminded?'reminded':''}" id="remindModalBtn" onclick="toggleRemindModal('${id}')">
          ${reminded?'🔔 Recordatorio activo':'🔕 Recuérdame'}
        </button>` : ''}
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.toggleRemindModal = (id) => {
  toggleRemind(id);
  const btn = document.getElementById('remindModalBtn');
  if (btn) {
    const isNow = remindedIds.includes(id);
    btn.classList.toggle('reminded', isNow);
    btn.textContent = isNow ? '🔔 Recordatorio activo' : '🔕 Recuérdame';
  }
};

// ─── PLAYER ───────────────────────────────────────────────────────────────────
function _getNextEpisode(serieId, seasonNum, epNum) {
  const item = getContentById(serieId);
  if (!item || !Array.isArray(item.temporadas)) return null;
  const season = item.temporadas.find(s => s.numero === seasonNum);
  if (!season) return null;
  const epIdx = (season.episodios||[]).findIndex(e => e.numero === epNum);
  let nextEp = null;
  let nextSeason = season;
  if (epIdx >= 0 && epIdx < season.episodios.length - 1) {
    nextEp = season.episodios[epIdx + 1];
  } else {
    // Try next season
    const sIdx = item.temporadas.findIndex(s => s.numero === seasonNum);
    if (sIdx >= 0 && sIdx < item.temporadas.length - 1) {
      nextSeason = item.temporadas[sIdx + 1];
      nextEp = nextSeason.episodios?.[0] || null;
    }
  }
  if (!nextEp) return null;
  return {
    title: `T${nextSeason.numero} E${nextEp.numero} — ${nextEp.titulo}`,
    thumbnail: nextEp.thumbnail || item.poster,
    src: nextEp.video || null,
    seasonNum: nextSeason.numero,
    epNum: nextEp.numero
  };
}

window.removeFromContinueWatching = async (contentId, btnEl) => {
  if (!currentUser || !currentProfile) return;
  // Optimistic UI: remove the card immediately, don't wait on the network.
  const card = btnEl?.closest('.content-card');
  if (card) card.remove();
  delete watchingData[contentId];
  try {
    await removeFromWatching(currentUser.uid, currentProfile.id, contentId);
  } catch (e) {
    console.warn('removeFromContinueWatching failed:', e);
    showToast('No se pudo quitar el título, inténtalo de nuevo', 'error');
  }
};

const _trendBumpedThisSession = new Set();

async function _saveProgress(contentId, pct, currentTime) {
  if (!currentUser || !currentProfile) return;
  watchingData[contentId] = { progress: pct, currentTime, updatedAt: Date.now() };
  await updateWatching(currentUser.uid, currentProfile.id, contentId, pct, currentTime);
  // Count towards "Tendencias" once per playback session, not on every 5% tick.
  if (!_trendBumpedThisSession.has(contentId)) {
    _trendBumpedThisSession.add(contentId);
    bumpTrendScore(contentId, 1);
  }
}

window.openJoinPartyWatchPrompt = () => {
  if (!currentUser) { showToast('Inicia sesión para usar PartyWatch', 'info'); return; }
  const pin = prompt('Introduce el PIN del PartyWatch:');
  if (!pin || !pin.trim()) return;
  joinPartyWatchByPin(pin.trim());
};

// ─── PARTYWATCH ────────────────────────────────────────────────────────────
// Entry point from the detail page button. Creates a lobby bound to this
// content, then opens the player directly with the PartyWatch panel
// attached — there's no separate "lobby room" screen anymore.
window.startPartyWatch = async (id) => {
  const item = getContentById(id);
  if (!item) return;
  if (!currentUser) { showToast('Inicia sesión para usar PartyWatch', 'info'); return; }

  closeModal?.();
  showToast('Creando PartyWatch...', 'info');
  try {
    const pin = await createPartyWatch({
      name: `PartyWatch: ${item.titulo}`,
      contentId: id,
      contentTitle: item.titulo
    });
    // playContent already resolves series to their first episode, plays
    // interactivos through their own player, etc. — reusing it here (via
    // partyOpts) is what makes PartyWatch actually work for series, since
    // the old separate code path always assumed a flat movie-style item.
    window.playContent(id, { isOwner: true, pin });
  } catch (e) {
    showToast('No se pudo crear el PartyWatch: ' + e.message, 'error');
  }
};

// Called by the "Unirse" flow (PIN entry) — joins the lobby and waits for
// the owner's synced 'open' event to say what to play, rather than trying
// to open something locally here. The owner is the single source of truth
// for what's playing; lobby.js's _handleVideoSync + lobby-ui.js's
// _handleSyncedVideo already resolve that event correctly (including the
// serieId_sNeM episode pattern), so duplicating that logic here would just
// risk the joiner opening something different from what the owner has.
window.joinPartyWatchByPin = async (pin) => {
  if (!currentUser) { showToast('Inicia sesión para usar PartyWatch', 'info'); return; }
  try {
    const data = await joinLobby(pin);
    if (data.contentId || data.contentTitle) {
      showToast(`Unido al PartyWatch. Cargando "${data.contentTitle || 'contenido'}"…`, 'info');
    } else {
      showToast('Unido al PartyWatch. Esperando a que el anfitrión ponga algo...', 'info');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// partyOpts (optional): { isOwner, pin } — when set, this playback is
// happening inside a PartyWatch session. Reusing playContent/playEpisode
// for this (instead of the old separate _openContentInPartyMode, which
// hardcoded isSerie:false and item.video and so silently failed for any
// series) means party playback gets the exact same series/interactivo
// resolution as normal playback, and the owner actually broadcasts an
// 'open' event so other members know what to load — which nothing did
// before, leaving joiners stuck waiting forever.
window.playContent = async (id, partyOpts = null) => {
  const item = getContentById(id);
  if (!item) {
    if (_rawGetContentById(id) && currentProfile) {
      showToast('Este contenido no está disponible en este perfil', 'info');
    }
    return;
  }
  if (!currentUser) { showToast('Inicia sesión para ver este contenido','info'); return; }
  setPlayerUser(currentUser);

  if (item.tipo === 'interactivo') {
    if (partyOpts) { showToast('PartyWatch no soporta contenido interactivo todavía', 'error'); return; }
    playInteractivoContent(id);
    return;
  }

  if (item.tipo === 'serie' && Array.isArray(item.temporadas)) {
    const firstSeason = item.temporadas[0];
    const firstEp = firstSeason?.episodios?.[0];
    if (firstEp) { window.playEpisode(id, firstSeason.numero, firstEp.numero, partyOpts); return; }
  }

  // Offline playback: PartyWatch always needs the live streaming URL to
  // stay in sync with the rest of the group, so the local copy is only
  // used for solo viewing.
  let src = item.video || null;
  if (isDesktop() && !partyOpts) {
    const offlineUrl = await getOfflinePlaybackUrl(id);
    if (offlineUrl) src = offlineUrl;
  }

  const startTime = watchingData[id]?.currentTime || 0;
  window._currentLobbyContentId = id;
  openXPlayer({
    src,
    title: item.titulo,
    contentId: id,
    isSerie: false,
    startTime,
    subtitles: item.subtitles || [],
    audioTracks: item.audioTracks || [],
    qualities: item.qualities || [],
    introStart: item.introStart ?? null,
    introEnd: item.introEnd ?? null,
    partyMode: !!partyOpts,
    isPartyOwner: !!partyOpts?.isOwner,
    partyPin: partyOpts?.pin || null,
    onProgress: (pct, ct) => _saveProgress(id, pct, ct),
    onClose: partyOpts ? () => { leavePartyWatch(); } : () => {},
    onReady: (vid) => {
      if (vid) hookPlayerForLobbySync(vid, id);
      if (partyOpts) {
        initPartyWatchPanel(vid, partyOpts.isOwner, partyOpts.pin, item);
        if (partyOpts.isOwner) syncVideoAction('open', startTime, item.video || null, id, item.titulo);
      }
    }
  });
};

// ─── INTERACTIVOS: open and track progress ────────────────────────────────────
function playInteractivoContent(id) {
  const interactivo = getInteractivoById(id);
  if (!interactivo) { showToast('Interactivo no disponible', 'error'); return; }
  if (!interactivo.videos || !interactivo.videos.length) {
    showToast('Este interactivo aún no tiene vídeos cargados', 'error'); return;
  }

  const resumeVideoId = watchingData[id]?.lastVideoId || null;

  openInteractivePlayer(interactivo, {
    userId: currentUser?.uid || null,
    resumeVideoId,
    onProgress: (interactivoId, videoId, currentTime) => {
      _saveInteractivoProgress(interactivoId, videoId, currentTime);
    },
    onExit: () => {
      // Nothing extra needed — closeInteractivePlayer already restores the UI
    }
  });
}

async function _saveInteractivoProgress(interactivoId, videoId, currentTime) {
  if (!currentUser || !currentProfile) return;
  watchingData[interactivoId] = { progress: 0, currentTime, lastVideoId: videoId, updatedAt: Date.now() };
  try { await updateWatching(currentUser.uid, currentProfile.id, interactivoId, 0, currentTime); }
  catch (e) { console.warn('_saveInteractivoProgress failed:', e); }
}

window.playEpisode = (serieId, seasonNum, epNum, partyOpts = null) => {
  const item = getContentById(serieId);
  if (!item) return;
  setPlayerUser(currentUser);
  const season = item.temporadas?.find(s => s.numero === seasonNum);
  const ep = season?.episodios?.find(e => e.numero === epNum);
  const nextEp = _getNextEpisode(serieId, seasonNum, epNum);
  const contentKey = `${serieId}_s${seasonNum}e${epNum}`;
  const startTime = watchingData[contentKey]?.currentTime || 0;

  const doPlay = async (sNum, eNum) => {
    const s2 = item.temporadas?.find(s => s.numero === sNum);
    const e2 = s2?.episodios?.find(e => e.numero === eNum);
    if (!e2) { showToast('Episodio no disponible aún','error'); return; }
    const key2 = `${serieId}_s${sNum}e${eNum}`;
    const next2 = _getNextEpisode(serieId, sNum, eNum);
    const epStartTime = watchingData[key2]?.currentTime || 0;

    // Same offline-vs-streaming choice as playContent, per episode — each
    // episode is downloaded/identified independently via key2.
    let src = e2.video || null;
    if (isDesktop() && !partyOpts) {
      const offlineUrl = await getOfflinePlaybackUrl(key2);
      if (offlineUrl) src = offlineUrl;
    }

    openXPlayer({
      src,
      title: `${item.titulo} — T${sNum} E${eNum}: ${e2.titulo}`,
      contentId: key2, serieId, seasonNum: sNum, epNum: eNum, isSerie: true,
      startTime: epStartTime,
      subtitles: e2.subtitles || item.subtitles || [],
      audioTracks: e2.audioTracks || item.audioTracks || [],
      qualities: e2.qualities || item.qualities || [],
      introStart: e2.introStart ?? item.introStart ?? null,
      introEnd: e2.introEnd ?? item.introEnd ?? null,
      nextEp: next2,
      partyMode: !!partyOpts,
      isPartyOwner: !!partyOpts?.isOwner,
      partyPin: partyOpts?.pin || null,
      onProgress: (pct, ct) => _saveProgress(key2, pct, ct),
      onNext: next2 ? () => doPlay(next2.seasonNum, next2.epNum) : null,
      onClose: partyOpts ? () => { leavePartyWatch(); } : () => {},
      onReady: (vid) => {
        if (vid) hookPlayerForLobbySync(vid, key2);
        if (partyOpts) {
          initPartyWatchPanel(vid, partyOpts.isOwner, partyOpts.pin, item);
          // key2 (e.g. "serieId_s1e2") is the exact pattern lobby-ui.js's
          // _handleSyncedVideo already parses back out for joiners — that
          // logic existed but nothing was ever calling syncVideoAction to
          // feed it, which is why series PartyWatch never worked at all.
          if (partyOpts.isOwner) syncVideoAction('open', epStartTime, e2.video || null, key2, `${item.titulo} — T${sNum} E${eNum}`);
        }
      }
    });
  };

  doPlay(seasonNum, epNum);
};

window.openTrailer = (trailerUrl) => {
  openXPlayer({
    src: trailerUrl,
    title: 'Tráiler',
    contentId: null,
    isSerie: false
  });
};


// ─── MULTI-TRAILER HELPERS ─────────────────────────────────────────────────
// Supports both legacy single string and new array format:
// "trailer": "url"                              ← legacy (still works)
// "trailers": [{"titulo":"T1","url":"..."},…]  ← new multi-trailer

function getTrailers(item) {
  if (!item) return [];
  // New format: array on "trailers" key
  if (Array.isArray(item.trailers) && item.trailers.length) {
    return item.trailers.map((t, i) => ({
      titulo: t.titulo || `Tráiler ${i + 1}`,
      url: t.url || t
    })).filter(t => t.url);
  }
  // Legacy: single string on "trailer" key
  if (item.trailer && typeof item.trailer === 'string') {
    return [{ titulo: 'Tráiler', url: item.trailer }];
  }
  return [];
}

function renderTrailerButtons(item) {
  const trailers = getTrailers(item);
  if (!trailers.length) return '';
  if (trailers.length === 1) {
    return `<button class="btn-trailer" onclick="openTrailer('${trailers[0].url}')">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
      ${trailers[0].titulo}
    </button>`;
  }
  // Multiple trailers → dropdown button
  const id = 'td_' + Math.random().toString(36).slice(2, 7);
  return `
    <div class="trailer-dropdown-wrap" id="${id}">
      <button class="btn-trailer trailer-dropdown-btn"
        onclick="toggleTrailerDropdown('${id}')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
        Tráilers (${trailers.length})
        <svg class="trailer-chevron" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg>
      </button>
      <div class="trailer-dropdown">
        ${trailers.map((t, i) => `
          <button class="trailer-drop-item" onclick="openTrailer('${t.url}');closeTrailerDropdown('${id}')">
            <span class="trailer-drop-num">${i + 1}</span>
            ${t.titulo}
          </button>`).join('')}
      </div>
    </div>`;
}

window.toggleTrailerDropdown = (id) => {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const isOpen = wrap.classList.toggle('open');
  // Close any other open dropdowns
  if (isOpen) {
    document.querySelectorAll('.trailer-dropdown-wrap.open').forEach(el => {
      if (el.id !== id) el.classList.remove('open');
    });
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!wrap.contains(e.target)) {
          wrap.classList.remove('open');
          document.removeEventListener('click', handler);
        }
      });
    }, 10);
  }
};

window.closeTrailerDropdown = (id) => {
  document.getElementById(id)?.classList.remove('open');
};

window.closePlayer = closeXPlayer;

window.closeModal = () => {
  const modal = document.getElementById('contentModal');
  modal.style.display = 'none';
  modal.innerHTML = '';
  document.body.style.overflow = '';
  stopFakeChat();
  // Reset URL back to the current page (home by default) since the
  // fullscreen modal had its own slug in the address bar
  const page = document.querySelector('.nav-link.active')?.dataset.page || 'home';
  history.replaceState(null, '', '#/' + page);
};

// ─── SHARE MODAL ──────────────────────────────────────────────────────────────
window.openShareModal = async (contentId) => {
  if (!currentUser || !currentProfile) { showToast('Inicia sesión para compartir','info'); return; }
  const shareId = await shareMyList(currentUser.uid, currentProfile.id, myListIds, currentProfile.name);
  const modal = document.getElementById('contentModal');
  const existing = modal.querySelector('.share-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'share-modal-overlay';
  overlay.innerHTML = `
    <div class="share-modal-card">
      <button class="share-modal-close" onclick="this.closest('.share-modal-overlay').remove()">✕</button>
      ${renderShareModal(shareId)}
    </div>`;
  modal.appendChild(overlay);
};

// ─── FILTER BY TAG ────────────────────────────────────────────────────────────
window.filterByTag = (tag) => {
  closeModal();
  const content = document.getElementById('appContent');
  const all = getAllContent().map(normalise).filter(item =>
    (item.categorias||[]).includes(tag) || item.genero === tag
  );
  history.pushState(null, '', `#/tag/${encodeURIComponent(tag)}`);
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  content.style.opacity = '0';
  setTimeout(() => {
    content.innerHTML = `
      <div class="browse-page">
        <div class="browse-header">
          <button class="back-btn-inline" onclick="navigateTo('home')">← Inicio</button>
          <h1 class="page-title">${tag}</h1>
          <p class="page-sub">${all.length} título${all.length!==1?'s':''}</p>
        </div>
        <div class="browse-grid">
          ${all.length ? all.map(item => renderCardWide(item)).join('') : `<div class="empty-msg">No hay contenido con esta categoría.</div>`}
        </div>
      </div>`;
    requestAnimationFrame(() => { content.style.opacity='1'; content.style.transform='translateY(0)'; });
  }, 80);
};

// ─── AVATAR EDITOR MODAL ──────────────────────────────────────────────────────
window.openAvatarEditor = () => {
  if (!currentProfile) return;
  const modal = document.getElementById('contentModal');
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal()"></div>
    <div class="modal-box modal-box-sm" id="modalBox">
      <button class="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-content" style="padding-top:32px">
        <h2 class="modal-title" style="margin-bottom:24px">Editar avatar</h2>
        ${renderAvatarEditor(currentProfile)}
        <div style="display:flex;gap:12px;margin-top:28px">
          <button class="btn-secondary" style="flex:1" onclick="closeModal()">Cancelar</button>
          <button class="btn-primary" style="flex:2" onclick="saveAvatarEdit()">Guardar avatar</button>
        </div>
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.saveAvatarEdit = async () => {
  const icon = window._pendingAvatarIcon || currentProfile.avatarIcon || '🎬';
  const color = window._pendingAvatarColor || currentProfile.avatarColor || '#1a7fff';
  // Build a data-URI avatar or store icon+color in profile
  try {
    await updateProfile(currentUser.uid, currentProfile.id, { avatarIcon: icon, avatarColor: color, avatar: currentProfile.avatar });
    currentProfile.avatarIcon = icon;
    currentProfile.avatarColor = color;
    // Update navbar avatar display
    const navAvatar = document.getElementById('profileAvatarNav');
    if (navAvatar) {
      navAvatar.style.background = color;
      navAvatar.style.fontSize = '1.1rem';
      navAvatar.textContent = icon;
      navAvatar.style.display = 'flex';
      navAvatar.style.alignItems = 'center';
      navAvatar.style.justifyContent = 'center';
    }
    closeModal();
    showToast('Avatar actualizado ✓', 'success');
  } catch(e) {
    showToast('Error al guardar avatar', 'error');
  }
};

// ─── MY LIST ─────────────────────────────────────────────────────────────────
window.toggleMyList = async (contentId, btn) => {
  if (!currentUser || !currentProfile) { showToast('Inicia sesión para usar Mi lista','info'); return; }
  const isInList = myListIds.includes(contentId);
  try {
    if (isInList) {
      await removeFromMyList(currentUser.uid, currentProfile.id, contentId);
      myListIds = myListIds.filter(id => id !== contentId);
      showToast('Eliminado de tu lista','success');
    } else {
      await addToMyList(currentUser.uid, currentProfile.id, contentId);
      myListIds.push(contentId);
      showToast('Añadido a tu lista','success');
    }
    document.querySelectorAll(`.card-list-btn[onclick*="${contentId}"]`).forEach(b => {
      b.textContent = isInList ? '+' : '✓';
      b.classList.toggle('in-list', !isInList);
    });
    if (btn?.classList.contains('btn-list')) {
      btn.innerHTML = isInList ? '+ Mi lista' : '✓ En mi lista';
      btn.classList.toggle('in-list', !isInList);
    }
  } catch(e) { showToast('Error al actualizar la lista','error'); }
};

// ─── SEARCH ───────────────────────────────────────────────────────────────────
function setupSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchContainer = document.getElementById('searchContainer');
  document.getElementById('searchIcon').addEventListener('click', () => {
    searchContainer.classList.toggle('open');
    if (searchContainer.classList.contains('open')) {
      searchInput.focus();
      renderSearchDropdownIdle();
    }
  });
  searchInput.addEventListener('focus', () => renderSearchDropdownIdle());
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) { renderSearchDropdownIdle(); return; }
    searchTimeout = setTimeout(() => {
      if (q.length >= 2) renderSearchResults(q);
    }, 220);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchContainer.classList.remove('open');
      document.getElementById('searchDropdown').innerHTML = '';
      searchInput.value = '';
    }
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (q.length >= 2) renderSearchResults(q);
    }
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target)) {
      searchContainer.classList.remove('open');
      document.getElementById('searchDropdown').innerHTML = '';
    }
  });
}

function renderSearchResults(query) {
  addToSearchHistory(query);
  const results = smartSearch(query, getAllContentIncludingUpcoming().map(normalise));
  const dropdown = document.getElementById('searchDropdown');
  if (!results.length) { dropdown.innerHTML = `<div class="search-empty">Sin resultados para "<strong>${query}</strong>"</div>`; return; }
  dropdown.innerHTML = results.slice(0,10).map(item => `
    <div class="search-result" onclick="${item._upcoming ? `closeSearchAndOpenUpcoming('${item.id}')` : `closeSearchAndOpen('${item.id}')`}">
      <img src="${item.poster||item.banner}" alt="${item.titulo}"
        onerror="this.src='https://via.placeholder.com/48x64/001030/4488ff?text=X'">
      <div>
        <span class="sr-title">${item.titulo}</span>
        <span class="sr-meta">${item._upcoming ? '🕐 Próximamente' : (item.tipo==='serie'?'📺 Serie':'🎬 Película')} · ${item.año||''} ${item.genero?'· '+item.genero:''}</span>
      </div>
    </div>`).join('');
}

function renderSearchDropdownIdle() {
  const history = getSearchHistory();
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;
  if (!history.length) { dropdown.innerHTML = ''; return; }
  dropdown.innerHTML = `
    <div class="search-history-header">
      <span>Búsquedas recientes</span>
      <button onclick="clearSearchHistory();renderSearchDropdownIdle()">Borrar</button>
    </div>
    ${history.map(h => `
      <div class="search-result search-history-item" onclick="document.getElementById('searchInput').value='${h.replace(/'/g,"\\'")}';renderSearchResultsFromInput()">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="flex-shrink:0;opacity:0.4"><path d="M13 3a9 9 0 1 0 .001 18.001A9 9 0 0 0 13 3zM11 18v-7l6 3.5-6 3.5zm0-10V5l7 3-7 3z"/></svg>
        <div><span class="sr-title">${h}</span></div>
      </div>`).join('')}`;
}

window.renderSearchResultsFromInput = () => {
  const q = document.getElementById('searchInput')?.value.trim();
  if (q && q.length >= 2) renderSearchResults(q);
};

window.closeSearchAndOpen = (id) => {
  document.getElementById('searchContainer').classList.remove('open');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchDropdown').innerHTML = '';
  openContent(id);
};

window.closeSearchAndOpenUpcoming = (id) => {
  document.getElementById('searchContainer').classList.remove('open');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchDropdown').innerHTML = '';
  openUpcoming(id);
};

// ─── BANNER AUTOPLAY ──────────────────────────────────────────────────────────
let bannerInterval = null;

function initBannerAutoplay(banners) {
  if (bannerInterval) clearInterval(bannerInterval);
  if (!banners || banners.length <= 1) return;
  let idx = 0;
  const indicators = document.getElementById('heroIndicators');
  if (!indicators) return;
  indicators.innerHTML = banners.map((_,i) =>
    `<span class="indicator ${i===0?'active':''}" onclick="switchBanner(${i})"></span>`).join('');
  window.switchBanner = (newIdx) => {
    idx = newIdx;
    const hero = document.getElementById('heroBanner');
    if (!hero) return;
    const item = banners[idx];
    const bg = item.banner || item.poster;
    hero.style.backgroundImage = bg
      ? `linear-gradient(to right,rgba(0,10,30,.95) 30%,rgba(0,10,30,.3) 70%,transparent 100%),url('${bg}')`
      : 'linear-gradient(135deg,#000d1f,#001a3a)';
    const t = hero.querySelector('.hero-title'); if (t) t.textContent = item.titulo;
    const d = hero.querySelector('.hero-desc'); if (d) d.textContent = item.descripcion||'';
    const lw = hero.querySelector('.hero-banner-logo-wrap'); if (lw) lw.remove();
    if (item.bannerLogo) {
      const wrap = document.createElement('div');
      wrap.className = 'hero-banner-logo-wrap';
      wrap.innerHTML = `<img src="${item.bannerLogo}" class="hero-banner-logo" alt="logo">`;
      hero.appendChild(wrap);
    }
    indicators.querySelectorAll('.indicator').forEach((el,i) => el.classList.toggle('active', i===idx));
  };
  bannerInterval = setInterval(() => {
    if (!document.getElementById('heroBanner')) { clearInterval(bannerInterval); return; }
    window.switchBanner((idx+1) % banners.length);
  }, 6000);
}

// ─── UPCOMING BADGES ──────────────────────────────────────────────────────────
function renderUpcomingBadges() {
  const now = new Date();
  const soon = getUpcoming().filter(item => {
    if (!item.fecha) return false;
    const d = new Date(item.fecha);
    return d > now && (d - now) < 7 * 86400000;
  }).length;
  const badge = document.getElementById('upcomingBadge');
  if (badge && soon > 0) { badge.textContent = soon; badge.style.display = 'inline-block'; }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getCountdown(dateStr) {
  if (!dateStr) return '';
  const diff = new Date(dateStr) - new Date();
  if (diff <= 0) return 'Disponible ahora';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (days > 30) return `${Math.floor(days/30)} mes${Math.floor(days/30)>1?'es':''}`;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins} minutos`;
}

function showLoading(show) {
  document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
}

// ─── WEEKLY EVENTS ────────────────────────────────────────────────────────────
const WEEKLY_EVENTS = {
  0: { titulo: '🎭 Domingo de Drama', descripcion: 'Emociones a flor de piel.', generos: ['Drama'], color: '#9b59b6', emoji: '🎭' },
  1: { titulo: '💥 Lunes de Acción', descripcion: 'Empieza la semana con adrenalina.', generos: ['Acción','Thriller'], color: '#e74c3c', emoji: '💥' },
  2: { titulo: '🚀 Martes de Ciencia Ficción', descripcion: 'El futuro es hoy.', generos: ['Ciencia Ficción'], color: '#3498db', emoji: '🚀' },
  3: { titulo: '🔍 Miércoles de Misterio', descripcion: 'Casos sin resolver y giros inesperados.', generos: ['Misterio','Thriller','Suspenso'], color: '#1abc9c', emoji: '🔍' },
  4: { titulo: '🎬 Jueves de Clásicos', descripcion: 'Las obras que definieron el cine.', generos: [], color: '#f39c12', emoji: '🎬' },
  5: { titulo: '🎃 Viernes de Terror', descripcion: 'Si te atreves a apagar la luz...', generos: ['Terror','Terror · Ciencia Ficción','Terror · Misterio'], color: '#ff4444', emoji: '🎃', featured: true },
  6: { titulo: '👨‍👩‍👧 Sábado Familiar', descripcion: 'Para ver en familia.', generos: ['Familiar','Aventura','Animación'], color: '#27ae60', emoji: '👨‍👩‍👧' }
};

function getTodayEvent() { return WEEKLY_EVENTS[new Date().getDay()] || WEEKLY_EVENTS[5]; }

function renderWeeklyEventRow() {
  const event = getTodayEvent();
  const all = getAllContent();
  let recs = event.generos.length > 0
    ? all.filter(item => event.generos.some(g => (item.genero||'').toLowerCase().includes(g.toLowerCase()) || (item.categorias||[]).some(c=>c.toLowerCase().includes(g.toLowerCase()))))
    : all.slice(0, 8);
  if (recs.length < 2) recs = all.slice(0, 8);
  if (!recs.length) return '';
  return `
    <div class="content-row weekly-event-row" style="--event-color:${event.color}">
      <div class="weekly-event-header">
        <div class="weekly-event-badge" style="background:${event.color}20;border-color:${event.color}60">
          <span class="we-emoji">${event.emoji}</span>
          <span class="we-title">${event.titulo}</span>
        </div>
        <p class="we-desc">${event.descripcion}</p>
      </div>
      <div class="cards-track">${recs.slice(0,8).map(item=>renderCard(item)).join('')}</div>
    </div>`;
}

// ─── SEASONAL ─────────────────────────────────────────────────────────────────
function getActiveSeason() {
  const now = new Date(); const month = now.getMonth()+1; const day = now.getDate();
  if (month===10||(month===9&&day>=25)) return { id:'halloween', emoji:'🎃', accent:'#ff6600', mensaje:'🎃 La temporada más oscura del año ha llegado', particles:['🎃','👻','🕷️','🦇','💀'] };
  if (month===12||(month===1&&day<=6)) return { id:'navidad', emoji:'🎄', accent:'#ff0000', mensaje:'🎄 Felices fiestas desde RBX Infinity', particles:['🎄','❄️','🎅','⭐','🎁'] };
  if (month>=6&&month<=8) return { id:'verano', emoji:'☀️', accent:'#ffcc00', mensaje:'☀️ El verano más caliente en RBX Infinity', particles:['☀️','🌊','🏖️','🍦','🎆'] };
  return null;
}

function applySeasonalTheme() {
  const season = getActiveSeason();
  document.body.classList.remove('season-halloween','season-navidad','season-verano');
  const old = document.getElementById('seasonalBanner'); if (old) old.remove();
  if (!season) return;
  document.body.classList.add('season-' + season.id);
  const banner = document.createElement('div');
  banner.id = 'seasonalBanner'; banner.className = 'seasonal-banner';
  banner.style.setProperty('--season-accent', season.accent);
  banner.innerHTML = `
    <div class="seasonal-particles">${season.particles.map(p=>`<span class="sp">${p}</span>`).join('')}</div>
    <span class="seasonal-msg">${season.mensaje}</span>
    <button class="seasonal-close" onclick="this.parentElement.remove()">✕</button>`;
  document.getElementById('appContent')?.prepend(banner);
}

// ─── STUDIOS ──────────────────────────────────────────────────────────────────
let studiosData = null;

async function loadStudios() {
  if (studiosData) return studiosData;
  try { const res = await fetch('studios.json'); studiosData = await res.json(); }
  catch { studiosData = []; }
  return studiosData;
}

window.openStudioPage = async (studioId) => {
  await loadStudios();
  const studio = (studiosData||[]).find(s=>s.id===studioId);
  if (!studio) return;
  history.pushState(null, '', '#/studio/' + studioId);
  document.querySelectorAll('.nav-link').forEach(l=>l.classList.remove('active'));
  const fromCatalog = getAllContent().filter(item => item.studio === studioId);
  // Also check banners (in case content is only in banners section)
  const fromBanners = getBanners().filter(item => item.studio === studioId && !fromCatalog.find(x => x.id === item.id));
  const allContent = [...fromCatalog, ...fromBanners];
  const movies = allContent.filter(i=>i.tipo==='pelicula');
  const series = allContent.filter(i=>i.tipo==='serie');
  const content = document.getElementById('appContent');
  content.style.opacity='0';
  content.style.transform='translateY(12px)';
  content.innerHTML = `
    <div class="studio-page">
      <div class="studio-hero" style="--studio-color:${studio.color||'#1a7fff'}">
        <div class="studio-hero-inner">
          ${studio.logo?`<img src="${studio.logo}" class="studio-logo" alt="${studio.nombre}">`:''}
          <h1 class="studio-name">${studio.nombre}</h1>
          <p class="studio-desc">${studio.descripcion||''}</p>
          <div class="studio-stats">
            <span>${movies.length} película${movies.length!==1?'s':''}</span>
            <span>${series.length} serie${series.length!==1?'s':''}</span>
          </div>
        </div>
      </div>
      <div class="studio-content">
        ${movies.length?`
          <div class="content-row">
            <h2 class="row-title">🎬 Películas</h2>
            <div class="cards-track">${movies.map(i=>renderCard(i)).join('')}</div>
          </div>`:''}
        ${series.length?`
          <div class="content-row">
            <h2 class="row-title">📺 Series</h2>
            <div class="cards-track">${series.map(i=>renderCard(i)).join('')}</div>
          </div>`:''}
        ${!allContent.length?`<div class="empty-msg" style="padding:60px 40px">Este estudio no tiene contenido todavía.</div>`:''}
      </div>
    </div>`;
  requestAnimationFrame(() => { content.style.opacity='1'; content.style.transform='translateY(0)'; });
};

async function renderStudiosRow() {
  await loadStudios();
  if (!studiosData||!studiosData.length) return '';
  return `
    <div class="content-row studios-row">
      <h2 class="row-title">🎬 Estudios</h2>
      <div class="studios-track">
        ${studiosData.map(s=>`
          <div class="studio-card" onclick="openStudioPage('${s.id}')" style="--sc:${s.color||'#1a7fff'}">
            ${s.logo?`<img src="${s.logo}" alt="${s.nombre}" class="sc-logo">`:`<div class="sc-initial">${s.nombre[0]}</div>`}
            <span class="sc-name">${s.nombre}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ─── FOROS ────────────────────────────────────────────────────────────────────
// Estructura: forums/{contentId}/{postId} = { uid, name, avatar, rating(1-10), text, ts, likes:{uid:true} }
//             forums/{contentId}/{postId}/replies/{replyId} = { uid, name, avatar, text, ts, likes:{uid:true} }
// URLs: #/foros/{slug}            -> abre el foro completo de esa peli/serie
//       #/foros/{slug}/{postId}   -> abre el foro con ese post destacado/compartido
// Las respuestas son de UN SOLO NIVEL (como YouTube): puedes responder a un
// post del foro, pero no puedes responder a una respuesta — así se evita el
// anidamiento infinito tipo "comentario dentro de comentario dentro de...".

async function loadForumPosts(contentId) {
  try {
    const snap = await fbGet(fbRef(db, `forums/${contentId}`));
    if (!snap.exists()) return [];
    return Object.entries(snap.val())
      .map(([id, p]) => ({
        id, ...p,
        replies: p.replies
          ? Object.entries(p.replies).map(([rid, r]) => ({ id: rid, ...r })).sort((a, b) => (a.ts || 0) - (b.ts || 0))
          : []
      }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch { return []; }
}

async function postForumEntry(contentId, rating, text) {
  if (!currentUser) return false;
  const name = currentProfile?.name || currentUser.displayName || 'Usuario';
  const avatar = currentProfile?.avatar || null;
  await fbPush(fbRef(db, `forums/${contentId}`), {
    uid: currentUser.uid, name, avatar,
    rating, text: text.trim(), ts: Date.now(), likes: {}
  });
  return true;
}

async function postForumReply(contentId, postId, text) {
  if (!currentUser) return false;
  const name = currentProfile?.name || currentUser.displayName || 'Usuario';
  const avatar = currentProfile?.avatar || null;
  await fbPush(fbRef(db, `forums/${contentId}/${postId}/replies`), {
    uid: currentUser.uid, name, avatar,
    text: text.trim(), ts: Date.now(), likes: {}
  });
  return true;
}

async function toggleForumLike(contentId, postId) {
  if (!currentUser) { showToast('Inicia sesión para dar like', 'info'); return null; }
  const path = `forums/${contentId}/${postId}/likes/${currentUser.uid}`;
  const snap = await fbGet(fbRef(db, path));
  if (snap.exists()) { await fbSet(fbRef(db, path), null); return false; }
  await fbSet(fbRef(db, path), true);
  return true;
}

async function toggleForumReplyLike(contentId, postId, replyId) {
  if (!currentUser) { showToast('Inicia sesión para dar like', 'info'); return null; }
  const path = `forums/${contentId}/${postId}/replies/${replyId}/likes/${currentUser.uid}`;
  const snap = await fbGet(fbRef(db, path));
  if (snap.exists()) { await fbSet(fbRef(db, path), null); return false; }
  await fbSet(fbRef(db, path), true);
  return true;
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function forumAvgRating(posts) {
  const rated = posts.filter(p => p.rating != null);
  if (!rated.length) return null;
  return (rated.reduce((s, p) => s + p.rating, 0) / rated.length).toFixed(1);
}

// Botón de acceso al foro (se inserta en el modal de contenido)
function renderForumEntryButton(contentId, item) {
  return `
    <div class="forum-entry-row">
      <button class="btn-open-forum" onclick="openForum('${item ? titleToSlug(item.titulo) : contentId}')">
        💬 Ir al foro
        <span id="forumAvgBadge_${contentId}" class="forum-avg-badge" style="display:none"></span>
      </button>
    </div>`;
}

// ─── FOROS: modal fullscreen ───────────────────────────────────────────────────
window.openForum = async (slugOrId, highlightPostId = null, pushState = true) => {
  const item = getContentBySlug(slugOrId) || getContentById(slugOrId);
  if (!item) { showToast('Contenido no encontrado', 'error'); return; }
  const slug = titleToSlug(item.titulo);
  const contentId = item.id;

  if (pushState) {
    const url = highlightPostId ? `#/foros/${slug}/${highlightPostId}` : `#/foros/${slug}`;
    history.pushState(null, '', url);
  }

  const modal = document.getElementById('contentModal');
  modal.innerHTML = `
    <div class="fullscreen-modal forum-fullscreen" id="modalBox">
      <div class="fs-modal-header">
        <button class="fs-back-btn" onclick="closeForum('${item.id}')">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Volver
        </button>
        <div class="fs-modal-title-wrap">
          <span class="fs-modal-title">Foro · ${escapeHtml(item.titulo)}</span>
        </div>
        <button class="fs-close-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="forum-body" id="forumBody">
        <div class="forum-loading">Cargando foro...</div>
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const posts = await loadForumPosts(contentId);
  renderForumBody(contentId, item, posts, highlightPostId);
};

window.closeForum = (contentId) => {
  // Vuelve al modal del contenido en lugar de cerrar todo
  history.replaceState(null, '', '#/' + titleToSlug(getContentById(contentId)?.titulo || ''));
  openContent(contentId, false);
};

function renderForumBody(contentId, item, posts, highlightPostId) {
  const body = document.getElementById('forumBody');
  if (!body) return;
  const avg = forumAvgRating(posts);

  body.innerHTML = `
    <div class="forum-summary">
      <img src="${item.poster || item.banner}" class="forum-summary-poster" alt="${escapeHtml(item.titulo)}"
        onerror="this.style.display='none'">
      <div class="forum-summary-info">
        <h2>${escapeHtml(item.titulo)}</h2>
        <div class="forum-summary-meta">
          ${avg ? `<span class="forum-score">★ ${avg}/10</span>` : '<span class="forum-score forum-score-empty">Sin puntuaciones aún</span>'}
          <span>${posts.length} mensaje${posts.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>

    ${currentUser ? `
      <div class="forum-post-form">
        <div class="forum-rating-picker" id="forumRatingPicker">
          <label>Tu puntuación</label>
          <div class="forum-stars" id="forumStars">
            ${Array.from({length:10},(_,i)=>i+1).map(n => `
              <button type="button" class="forum-star-btn" data-val="${n}" onclick="selectForumRating(${n})">${n}</button>`).join('')}
          </div>
        </div>
        <textarea id="forumTextInput" placeholder="Comparte tu opinión sobre ${escapeHtml(item.titulo)}..." maxlength="600" rows="3"></textarea>
        <button class="btn-forum-send" onclick="submitForumPost('${contentId}')">Publicar en el foro</button>
      </div>` : `
      <div class="forum-login-cta">
        <p>Inicia sesión para puntuar y comentar en el foro</p>
      </div>`}

    <div class="forum-posts-list" id="forumPostsList">
      ${posts.length ? posts.map(p => renderForumPost(contentId, p, p.id === highlightPostId)).join('')
        : '<div class="no-comments">Sé el primero en opinar 👋</div>'}
    </div>`;

  window._pendingForumRating = null;

  // Scroll to highlighted post if shared via URL
  if (highlightPostId) {
    setTimeout(() => {
      const el = document.getElementById('forumPost_' + highlightPostId);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('forum-post-highlighted'); }
    }, 150);
  }

  // Update the small avg badge back on the content modal if still mounted
  const badge = document.getElementById('forumAvgBadge_' + contentId);
  if (badge && avg) { badge.textContent = `★ ${avg}`; badge.style.display = 'inline'; }
}

function renderForumPost(contentId, p, isHighlighted) {
  const date = p.ts ? new Date(p.ts).toLocaleDateString('es-ES', { day:'numeric', month:'short', year:'numeric' }) : '';
  const likeCount = p.likes ? Object.keys(p.likes).length : 0;
  const iLiked = currentUser && p.likes && p.likes[currentUser.uid];
  const replies = p.replies || [];
  return `
    <div class="forum-post ${isHighlighted ? 'forum-post-highlighted' : ''}" id="forumPost_${p.id}">
      <img src="${p.avatar || 'resources/avatars/avatar1.png'}" class="forum-post-avatar" alt="${escapeHtml(p.name)}"
        onerror="this.src='resources/avatars/avatar1.png'">
      <div class="forum-post-body">
        <div class="forum-post-header">
          <span class="forum-post-name">${escapeHtml(p.name)}</span>
          ${p.rating != null ? `<span class="forum-post-rating">★ ${p.rating}/10</span>` : ''}
          <span class="forum-post-date">${date}</span>
        </div>
        <p class="forum-post-text">${escapeHtml(p.text)}</p>
        <div class="forum-post-actions">
          <button class="forum-like-btn ${iLiked ? 'forum-liked' : ''}" onclick="handleForumLike('${contentId}','${p.id}',this)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
            <span class="forum-like-count">${likeCount}</span>
          </button>
          <button class="forum-reply-btn" onclick="toggleForumReplyForm('${contentId}','${p.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
            Responder
          </button>
          <button class="forum-share-btn" onclick="shareForumPost('${contentId}','${p.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>
            Compartir
          </button>
          ${replies.length ? `<button class="forum-toggle-replies-btn" id="forumToggleReplies_${p.id}" onclick="toggleForumRepliesList('${p.id}')">
            ${replies.length} respuesta${replies.length !== 1 ? 's' : ''} ▾
          </button>` : ''}
        </div>

        <!-- Reply form (hidden by default) -->
        <div class="forum-reply-form" id="forumReplyForm_${p.id}" style="display:none">
          <textarea id="forumReplyInput_${p.id}" placeholder="Escribe una respuesta..." maxlength="400" rows="2"></textarea>
          <div class="forum-reply-form-actions">
            <button class="forum-reply-cancel-btn" onclick="toggleForumReplyForm('${contentId}','${p.id}')">Cancelar</button>
            <button class="btn-forum-send forum-reply-send-btn" onclick="submitForumReply('${contentId}','${p.id}')">Responder</button>
          </div>
        </div>

        <!-- Replies list (one level deep — no replying to a reply) -->
        ${replies.length ? `
          <div class="forum-replies-list" id="forumRepliesList_${p.id}">
            ${replies.map(r => renderForumReply(contentId, p.id, r)).join('')}
          </div>` : ''}
      </div>
    </div>`;
}

function renderForumReply(contentId, postId, r) {
  const date = r.ts ? new Date(r.ts).toLocaleDateString('es-ES', { day:'numeric', month:'short', year:'numeric' }) : '';
  const likeCount = r.likes ? Object.keys(r.likes).length : 0;
  const iLiked = currentUser && r.likes && r.likes[currentUser.uid];
  return `
    <div class="forum-reply" id="forumReply_${r.id}">
      <img src="${r.avatar || 'resources/avatars/avatar1.png'}" class="forum-reply-avatar" alt="${escapeHtml(r.name)}"
        onerror="this.src='resources/avatars/avatar1.png'">
      <div class="forum-reply-body">
        <div class="forum-post-header">
          <span class="forum-post-name">${escapeHtml(r.name)}</span>
          <span class="forum-post-date">${date}</span>
        </div>
        <p class="forum-post-text">${escapeHtml(r.text)}</p>
        <div class="forum-post-actions">
          <button class="forum-like-btn ${iLiked ? 'forum-liked' : ''}" onclick="handleForumReplyLike('${contentId}','${postId}','${r.id}',this)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
            <span class="forum-like-count">${likeCount}</span>
          </button>
        </div>
      </div>
    </div>`;
}

window.toggleForumRepliesList = (postId) => {
  const list = document.getElementById('forumRepliesList_' + postId);
  const btn = document.getElementById('forumToggleReplies_' + postId);
  if (!list) return;
  const isHidden = list.style.display === 'none';
  list.style.display = isHidden ? 'flex' : 'none';
  if (btn) btn.innerHTML = btn.innerHTML.replace(isHidden ? '▾' : '▴', isHidden ? '▴' : '▾');
};

window.toggleForumReplyForm = (contentId, postId) => {
  if (!currentUser) { showToast('Inicia sesión para responder', 'info'); return; }
  const form = document.getElementById('forumReplyForm_' + postId);
  if (!form) return;
  const isHidden = form.style.display === 'none';
  // Close any other open reply form first
  document.querySelectorAll('.forum-reply-form').forEach(f => { if (f !== form) f.style.display = 'none'; });
  form.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) document.getElementById('forumReplyInput_' + postId)?.focus();
};

window.submitForumReply = async (contentId, postId) => {
  const input = document.getElementById('forumReplyInput_' + postId);
  const text = input?.value.trim();
  if (!text || text.length < 2) { showToast('Escribe tu respuesta', 'error'); return; }

  input.disabled = true;
  const ok = await postForumReply(contentId, postId, text);
  input.disabled = false;
  if (!ok) { showToast('Error al publicar la respuesta', 'error'); return; }

  showToast('Respuesta publicada ✓', 'success');
  const item = getContentById(contentId);
  const posts = await loadForumPosts(contentId);
  renderForumBody(contentId, item, posts, postId);
};

window.handleForumReplyLike = async (contentId, postId, replyId, btn) => {
  const liked = await toggleForumReplyLike(contentId, postId, replyId);
  if (liked === null) return;
  btn.classList.toggle('forum-liked', liked);
  const countEl = btn.querySelector('.forum-like-count');
  if (countEl) countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + (liked ? 1 : -1);
};

window.selectForumRating = (val) => {
  window._pendingForumRating = val;
  document.querySelectorAll('#forumStars .forum-star-btn').forEach(b => {
    b.classList.toggle('forum-star-active', parseInt(b.dataset.val, 10) <= val);
  });
};

window.submitForumPost = async (contentId) => {
  const input = document.getElementById('forumTextInput');
  const text = input?.value.trim();
  const rating = window._pendingForumRating;
  if (!rating) { showToast('Elige una puntuación del 1 al 10', 'error'); return; }
  if (!text || text.length < 2) { showToast('Escribe tu opinión', 'error'); return; }

  input.disabled = true;
  const ok = await postForumEntry(contentId, rating, text);
  input.disabled = false;
  if (!ok) { showToast('Error al publicar', 'error'); return; }

  showToast('Publicado en el foro ✓', 'success');
  input.value = '';
  window._pendingForumRating = null;
  document.querySelectorAll('#forumStars .forum-star-btn').forEach(b => b.classList.remove('forum-star-active'));

  const item = getContentById(contentId);
  const posts = await loadForumPosts(contentId);
  renderForumBody(contentId, item, posts, null);
};

window.handleForumLike = async (contentId, postId, btn) => {
  const liked = await toggleForumLike(contentId, postId);
  if (liked === null) return;
  btn.classList.toggle('forum-liked', liked);
  const countEl = btn.querySelector('.forum-like-count');
  if (countEl) countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + (liked ? 1 : -1);
};

window.shareForumPost = (contentId, postId) => {
  const item = getContentById(contentId);
  const slug = item ? titleToSlug(item.titulo) : contentId;
  const url = `${window.location.origin}${window.location.pathname}#/foros/${slug}/${postId}`;
  if (navigator.share) {
    navigator.share({ title: 'Mira este mensaje en el foro de RBX Infinity', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => showToast('Enlace copiado ✓', 'success'));
  }
};


// ─── VANTA CINEWORKS — Chat con IA (Puter.js) ─────────────────────────────────
// Usa puter.ai.chat() (https://js.puter.com/v2/, ya cargado en index.html).
// El usuario puede elegir una peli/serie del catálogo, o no elegir ninguna y
// pedir recomendaciones generales. El contexto que se manda a la IA incluye
// la descripción del contenido y un resumen de su foro (rating medio +
// fragmentos de los comentarios más relevantes), para que pueda responder
// preguntas como "de qué trata", "qué dicen los comentarios", etc.

let _vantaSelectedContentId = null;
let _vantaHistory = []; // [{role:'user'|'assistant', text}]
let _vantaSending = false;

window.openVantaChat = () => {
  document.getElementById('navbar')?.querySelector('.profile-dropdown')?.classList.remove('open');
  _vantaSelectedContentId = null;
  _vantaHistory = [];

  const modal = document.getElementById('contentModal');
  modal.innerHTML = `
    <div class="fullscreen-modal vanta-fullscreen" id="modalBox">
      <div class="fs-modal-header">
        <button class="fs-back-btn" onclick="closeModal()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Volver
        </button>
        <div class="fs-modal-title-wrap">
          <span class="fs-modal-title">✨ Vanta Cineworks</span>
        </div>
        <button class="fs-close-btn" onclick="closeModal()">✕</button>
      </div>

      <div class="vanta-body">
        <div class="vanta-picker-row">
          <label class="vanta-picker-label">Pregunta sobre:</label>
          <select id="vantaContentSelect" class="csm-input vanta-select" onchange="vantaSelectContent(this.value)">
            <option value="">Recomendaciones generales (sin elegir título)</option>
            ${getAllContent().map(item => `<option value="${item.id}">${item.tipo === 'serie' ? '📺' : '🎬'} ${escapeHtml(item.titulo)}</option>`).join('')}
          </select>
        </div>

        <div class="vanta-chat-window" id="vantaChatWindow">
          <div class="vanta-welcome-msg">
            <div class="vanta-avatar-big">✨</div>
            <h3>Hola, soy Vanta Cineworks</h3>
            <p>Puedo hablarte de cualquier película o serie de la plataforma — de qué trata, qué opina la gente en los foros, o recomendarte algo si no sabes qué ver.</p>
            <div class="vanta-suggestions">
              <button class="vanta-suggestion-chip" onclick="vantaSendSuggestion('¿Qué película me recomiendas?')">¿Qué película me recomiendas?</button>
              <button class="vanta-suggestion-chip" onclick="vantaSendSuggestion('¿Cuál es la mejor serie de la plataforma?')">¿Cuál es la mejor serie?</button>
              <button class="vanta-suggestion-chip" onclick="vantaSendSuggestion('Recomiéndame algo de terror')">Recomiéndame algo de terror</button>
            </div>
          </div>
        </div>

        <div class="vanta-input-row">
          <input id="vantaInput" type="text" placeholder="Escribe tu pregunta..." maxlength="400"
            onkeydown="if(event.key==='Enter')vantaSend()">
          <button id="vantaSendBtn" onclick="vantaSend()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('vantaInput')?.focus(), 200);
};

window.vantaSelectContent = (contentId) => {
  _vantaSelectedContentId = contentId || null;
  const item = contentId ? getContentById(contentId) : null;
  const win = document.getElementById('vantaChatWindow');
  if (!win) return;
  if (item) {
    _vantaSystemNoticeMsg(`Hablando sobre: <strong>${escapeHtml(item.titulo)}</strong>`);
  } else {
    _vantaSystemNoticeMsg('Modo recomendaciones generales — pregúntame qué ver.');
  }
};

function _vantaSystemNoticeMsg(html) {
  const win = document.getElementById('vantaChatWindow');
  if (!win) return;
  const notice = document.createElement('div');
  notice.className = 'vanta-system-notice';
  notice.innerHTML = html;
  win.appendChild(notice);
  win.scrollTop = win.scrollHeight;
}

window.vantaSendSuggestion = (text) => {
  const input = document.getElementById('vantaInput');
  if (input) input.value = text;
  vantaSend();
};

// Builds the context block sent to the AI: description + forum summary
// (average rating + a handful of the most-liked comments) for the selected
// title, or a compact catalog summary when no title is selected.
async function _vantaBuildContext() {
  if (_vantaSelectedContentId) {
    const item = getContentById(_vantaSelectedContentId);
    if (!item) return 'No se encontró información sobre este título.';

    let forumSummary = 'Sin opiniones en el foro todavía.';
    try {
      const posts = await loadForumPosts(_vantaSelectedContentId);
      if (posts.length) {
        const avg = forumAvgRating(posts);
        const topPosts = [...posts]
          .sort((a, b) => (Object.keys(b.likes || {}).length) - (Object.keys(a.likes || {}).length))
          .slice(0, 6);
        forumSummary = `Puntuación media del foro: ${avg || 'sin datos'}/10 (${posts.length} opiniones).\n` +
          'Algunos comentarios destacados:\n' +
          topPosts.map(p => `- "${p.text}" (puntuó ${p.rating ?? '–'}/10)`).join('\n');
      }
    } catch {}

    return [
      `Título: ${item.titulo}`,
      `Tipo: ${item.tipo === 'serie' ? 'Serie' : 'Película'}`,
      item.genero ? `Género: ${item.genero}` : '',
      item.año ? `Año: ${item.año}` : '',
      item.rating ? `Clasificación: ${item.rating}` : '',
      `Descripción: ${item.descripcion || 'Sin descripción disponible.'}`,
      '',
      'Resumen del foro de la comunidad:',
      forumSummary
    ].filter(Boolean).join('\n');
  }

  // No title selected — give the AI a compact view of the whole catalog
  // so it can make real recommendations instead of generic answers.
  const all = getAllContent();
  const catalogList = all.slice(0, 60).map(item =>
    `- ${item.titulo} (${item.tipo === 'serie' ? 'Serie' : 'Película'}${item.genero ? ', ' + item.genero : ''}${item.top10 ? ', Top10 #' + item.top10 : ''}${item.destacado ? ', destacada' : ''})`
  ).join('\n');

  return `Catálogo disponible en la plataforma (puede estar incompleto si hay muchos títulos):\n${catalogList}`;
}

window.vantaSend = async () => {
  if (_vantaSending) return;
  const input = document.getElementById('vantaInput');
  const text = input?.value.trim();
  if (!text) return;

  if (typeof puter === 'undefined' || !puter.ai?.chat) {
    showToast('El servicio de IA no está disponible ahora mismo', 'error');
    return;
  }

  _vantaSending = true;
  input.value = '';
  input.disabled = true;
  document.getElementById('vantaSendBtn')?.setAttribute('disabled', 'true');

  _vantaAppendMsg('user', text);
  _vantaHistory.push({ role: 'user', text });

  const typingId = _vantaAppendTyping();

  try {
    const context = await _vantaBuildContext();
    const systemPrompt = [
      'Eres Vanta Cineworks, el asistente de IA de la plataforma de streaming RBX Infinity.',
      'Hablas en español, de forma cercana y entusiasta, como un amigo experto en cine y series.',
      'Solo puedes recomendar o hablar de títulos que existan en el catálogo proporcionado — nunca inventes películas que no estén ahí.',
      'Si te preguntan por opiniones de la comunidad, basa tu respuesta en el resumen del foro que se te ha dado.',
      'Sé conciso: respuestas de 2 a 5 frases salvo que te pidan más detalle.',
      '',
      'CONTEXTO:',
      context
    ].join('\n');

    const fullPrompt = `${systemPrompt}\n\nPregunta del usuario: ${text}`;
    const response = await puter.ai.chat(fullPrompt, { model: 'gpt-5.4-nano' });
    const answer = typeof response === 'string' ? response : (response?.message?.content || response?.toString?.() || 'No he podido generar una respuesta.');

    _vantaRemoveTyping(typingId);
    _vantaAppendMsg('assistant', answer);
    _vantaHistory.push({ role: 'assistant', text: answer });
  } catch (e) {
    _vantaRemoveTyping(typingId);
    _vantaAppendMsg('assistant', 'Se ha producido un error al pensar la respuesta. Inténtalo de nuevo en unos segundos.');
    console.warn('Vanta Cineworks error:', e);
  } finally {
    _vantaSending = false;
    input.disabled = false;
    document.getElementById('vantaSendBtn')?.removeAttribute('disabled');
    input.focus();
  }
};

function _vantaAppendMsg(role, text) {
  const win = document.getElementById('vantaChatWindow');
  if (!win) return;
  const row = document.createElement('div');
  row.className = `vanta-msg vanta-msg-${role}`;
  row.innerHTML = role === 'assistant'
    ? `<div class="vanta-avatar-sm">✨</div><div class="vanta-msg-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
    : `<div class="vanta-msg-bubble">${escapeHtml(text)}</div>`;
  win.appendChild(row);
  win.scrollTop = win.scrollHeight;
}

function _vantaAppendTyping() {
  const win = document.getElementById('vantaChatWindow');
  if (!win) return null;
  const id = 'vantaTyping_' + Date.now();
  const row = document.createElement('div');
  row.className = 'vanta-msg vanta-msg-assistant';
  row.id = id;
  row.innerHTML = `<div class="vanta-avatar-sm">✨</div><div class="vanta-msg-bubble vanta-typing"><span></span><span></span><span></span></div>`;
  win.appendChild(row);
  win.scrollTop = win.scrollHeight;
  return id;
}

function _vantaRemoveTyping(id) {
  if (id) document.getElementById(id)?.remove();
}

// ─── HOME FULL (with weekly + studios + seasonal + smart rows) ────────────────
async function renderHomePageFull(publicMode = false) {
  await renderHomePage_base(publicMode);
  applySeasonalTheme();
  const homeRows = document.querySelector('.home-rows');
  if (!homeRows) return;

  // Weekly event
  const weeklyHtml = renderWeeklyEventRow();
  if (weeklyHtml) {
    const rows = homeRows.querySelectorAll('.content-row');
    const insertAfter = rows[1] || rows[0];
    if (insertAfter) insertAfter.insertAdjacentHTML('afterend', weeklyHtml);
    else homeRows.insertAdjacentHTML('afterbegin', weeklyHtml);
  }

  // Trending — ranked by aggregate watch/reaction score in Firebase
  try {
    const trendingIds = await getTrendingIds(10);
    const trendingItems = trendingIds.map(id => getContentById(id)).filter(Boolean);
    const trendingHtml = renderTrendingRow(trendingItems, renderCard);
    if (trendingHtml) {
      const rows = homeRows.querySelectorAll('.content-row');
      const insertAfter = rows[0];
      if (insertAfter) insertAfter.insertAdjacentHTML('afterend', trendingHtml);
      else homeRows.insertAdjacentHTML('afterbegin', trendingHtml);
    }
  } catch (e) { console.warn('No se pudo cargar Tendencias:', e); }

  // New this week — real date-based, separate from the manual "nuevo" badge row
  const newWeekItems = getNewThisWeek();
  if (newWeekItems.length > 0) {
    const alreadyShown = homeRows.innerHTML.includes('Nuevo esta semana');
    if (!alreadyShown) {
      const html = `
        <div class="content-row">
          <h2 class="row-title">📅 Nuevo esta semana</h2>
          <div class="cards-track">${newWeekItems.slice(0,10).map(item => renderCard(item)).join('')}</div>
        </div>`;
      const rows = homeRows.querySelectorAll('.content-row');
      const insertAfter = rows[1] || rows[0];
      if (insertAfter) insertAfter.insertAdjacentHTML('afterend', html);
      else homeRows.insertAdjacentHTML('afterbegin', html);
    }
  }

  // Because you watched
  if (!publicMode && Object.keys(watchingData).length > 0) {
    const all = getAllContent().map(normalise);
    const watchedIds = Object.keys(watchingData);
    const because = getBecauseYouWatched(watchedIds, all);
    because.forEach(block => {
      const html = renderBecauseRow(block, renderCard);
      if (html) homeRows.insertAdjacentHTML('beforeend', html);
    });

    // Genre recs
    const genreRecs = getGenreRecommendations(watchingData, all);
    const genreHtml = renderGenreRecommendationRows(genreRecs, renderCard);
    if (genreHtml) homeRows.insertAdjacentHTML('beforeend', genreHtml);
  }

  // Auto-categories
  if (!publicMode) {
    const all = getAllContent().map(normalise);
    const autoCats = generateAutoCategories(all).slice(0, 4);
    autoCats.forEach(cat => {
      // Don't duplicate rows already shown
      const titleAlready = homeRows.innerHTML.includes(cat.name);
      if (!titleAlready && cat.items.length >= 3) {
        homeRows.insertAdjacentHTML('beforeend', `
          <div class="content-row auto-cat-row">
            <h2 class="row-title">${cat.name}</h2>
            <div class="cards-track">${cat.items.slice(0,10).map(item => renderCard(item)).join('')}</div>
          </div>`);
      }
    });
  }

  // Studios row
  const studiosHtml = await renderStudiosRow();
  if (studiosHtml) homeRows.insertAdjacentHTML('beforeend', studiosHtml);
}

// ─── DESCARGA PAGE ────────────────────────────────────────────────────────────
const RELEASES_BASE = 'https://github.com/ikerana35018santanaiker-source/RBX-Infinity-Releases/releases';
const GOOGLE_PLAY   = 'https://play.google.com/store/apps/details?id=com.netflix.mediaclient';

// Build a versioned download URL:
// https://github.com/.../releases/download/<version>/<filename>
function buildDownloadURL(version, filename) {
  return `${RELEASES_BASE}/download/${version}/${filename}`;
}

function detectOS() {
  const ua = navigator.userAgent;
  const platform = navigator.platform || '';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'mac';
  if (/Linux/i.test(platform)) return 'linux';
  return 'unknown';
}


// ─── SEMVER COMPARE ───────────────────────────────────────────────────────────
// Returns 1 if a > b, -1 if a < b, 0 if equal
// Handles pre-release suffixes: 1.0.0 > 1.0.0-Beta
function semverCompare(a, b) {
  const parse = v => {
    const [core, pre] = String(v).split('-');
    const parts = core.split('.').map(n => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, pre: pre || '' };
  };
  const pa = parse(a); const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] > pb.parts[i]) return 1;
    if (pa.parts[i] < pb.parts[i]) return -1;
  }
  // Same core version — release > pre-release
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

// Fetch version.json, then render the full download page
async function renderDownloadPage() {
  const os = detectOS();
  const content = document.getElementById('appContent');
  content.style.opacity = '0'; content.style.transform = 'translateY(12px)';

  // Show skeleton while loading
  content.innerHTML = `
    <div class="descarga-page">
      <div class="dl-hero">
        <div class="dl-hero-bg"></div>
        <div class="dl-hero-content">
          <img src="https://i.ibb.co/zHWzJ1Lt/1-F452206-FCFC-4237-AF61-C3239-AAEC3-BE.jpg" class="dl-hero-logo" alt="RBX Infinity">
          <h1 class="dl-hero-title">RBX Infinity en tu dispositivo</h1>
          <p class="dl-hero-sub">Cargando información de versión...</p>
        </div>
      </div>
      <div class="dl-detected-section" style="text-align:center;padding:60px 0">
        <div class="dl-version-loading">
          <div class="loader-spinner" style="width:32px;height:32px;margin:0 auto 16px"></div>
          <p style="color:rgba(255,255,255,.4);font-size:.85rem">Obteniendo versión actual...</p>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => { content.style.opacity='1'; content.style.transform='translateY(0)'; });

  // Load version.json
  let versionData = { version:'0.0.0', nombre:'RBX Infinity', fecha:'', notas:'', archivos:{ windows:'Windows.zip', android:'Android.apk', linux:'Linux.AppImage', mac:'Mac.dmg' } };
  try {
    const res = await fetch('version.json?_=' + Date.now());
    if (res.ok) versionData = await res.json();
  } catch { /* use defaults */ }

  const v       = versionData.version;
  const files   = versionData.archivos || {};
  const DLURLS  = {
    windows: { url: buildDownloadURL(v, files.windows || 'RBX Infinity-Setup.exe'),   label: files.windows || 'RBX Infinity-Setup.exe' },
    android: { apk: buildDownloadURL(v, files.android || 'RBX Infinity.apk'),         label: files.android || 'RBX Infinity.apk',  play: GOOGLE_PLAY },
    linux:   { url: buildDownloadURL(v, files.linux   || 'RBX Infinity.AppImage'),     label: files.linux   || 'RBX Infinity.AppImage' },
    mac:     { url: buildDownloadURL(v, files.mac     || 'RBX Infinity.dmg'),          label: files.mac     || 'RBX Infinity.dmg' },
  };

  const OSCards = [
    { id:'windows', icon:'<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/windows8/windows8-original.svg" width="28" height="28">', label:'Windows', sub:'Windows 10 / 11' },
    { id:'android', icon:'<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/android/android-original.svg" width="28" height="28">', label:'Android',  sub:'Android 8+' },
    { id:'ios',     icon:'<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="28" height="28">', label:'iOS',       sub:'iPhone / iPad' },
    { id:'mac',     icon:'<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="28" height="28">', label:'macOS',     sub:'macOS 12+' },
    { id:'linux',   icon:'<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg" width="28" height="28">', label:'Linux',     sub:'AppImage' },
  ];

  const renderPrimaryBlock = () => {
    switch(os) {
      case 'windows': return `
        <div class="dl-primary-block">
          <div class="dl-os-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/windows8/windows8-original.svg" width="48" height="48"></div>
          <h2 class="dl-os-detected">RBX Infinity para Windows</h2>
          <p class="dl-os-sub">Windows 10 / 11 · 64-bit</p>
          <div class="dl-version-chip">v${v}</div>
          <a class="dl-btn-main" href="${DLURLS.windows.url}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Descargar para Windows
          </a>
          <p class="dl-file-info">${DLURLS.windows.label}</p>
          <a class="dl-other-version" href="${RELEASES_BASE}" target="_blank" rel="noopener">
            Descargar otra versión →
          </a>
        </div>`;

      case 'android': return `
        <div class="dl-primary-block">
          <div class="dl-os-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/android/android-original.svg" width="48" height="48"></div>
          <h2 class="dl-os-detected">RBX Infinity para Android</h2>
          <p class="dl-os-sub">Android 8.0 o superior</p>
          <div class="dl-version-chip">v${v}</div>
          <a class="dl-btn-main dl-btn-play" href="${DLURLS.android.play}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M3 18.5v-13c0-.83.94-1.3 1.6-.8l10 6.5c.6.4.6 1.2 0 1.6l-10 6.5c-.66.5-1.6.03-1.6-.8z"/></svg>
            Descargar en Google Play
          </a>
          <div class="dl-divider-or">o</div>
          <a class="dl-btn-apk" href="${DLURLS.android.apk}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Descargar APK  (v${v})
          </a>
          <p class="dl-file-info">${DLURLS.android.label}</p>
          <p class="dl-apk-warning">⚠️ Para instalar el APK activa "Orígenes desconocidos" en Ajustes → Seguridad</p>
          <a class="dl-other-version" href="${RELEASES_BASE}" target="_blank" rel="noopener">
            Descargar otra versión →
          </a>
        </div>`;

      case 'ios': return `
        <div class="dl-primary-block dl-coming-soon">
          <div class="dl-os-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="48" height="48"></div>
          <h2 class="dl-os-detected">RBX Infinity para iOS</h2>
          <p class="dl-os-sub">iPhone & iPad</p>
          <div class="dl-soon-badge">Próximamente</div>
          <p class="dl-soon-text">La app de RBX Infinity para iOS está en desarrollo. ¡Pronto en la App Store!</p>
        </div>`;

      case 'mac': return `
        <div class="dl-primary-block">
          <div class="dl-os-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="48" height="48"></div>
          <h2 class="dl-os-detected">RBX Infinity para macOS</h2>
          <p class="dl-os-sub">macOS 12 Monterey o superior</p>
          <div class="dl-version-chip">v${v}</div>
          <a class="dl-btn-main" href="${DLURLS.mac.url}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Descargar para macOS
          </a>
          <p class="dl-file-info">${DLURLS.mac.label}</p>
          <a class="dl-other-version" href="${RELEASES_BASE}" target="_blank" rel="noopener">
            Descargar otra versión →
          </a>
        </div>`;

      case 'linux': return `
        <div class="dl-primary-block">
          <div class="dl-os-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg" width="48" height="48"></div>
          <h2 class="dl-os-detected">RBX Infinity para Linux</h2>
          <p class="dl-os-sub">AppImage &middot; Ubuntu, Debian, Fedora...</p>
          <div class="dl-version-chip">v${v}</div>
          <a class="dl-btn-main" href="${DLURLS.linux.url}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Descargar para Linux
          </a>
          <p class="dl-file-info">${DLURLS.linux.label}</p>
          <p class="dl-file-info" style="opacity:.6;font-size:.78rem">Haz el archivo ejecutable: chmod +x Linux.AppImage</p>
          <a class="dl-other-version" href="${RELEASES_BASE}" target="_blank" rel="noopener">
            Descargar otra versi&oacute;n &rarr;
          </a>
        </div>`;

      default: return `
        <div class="dl-primary-block">
          <div class="dl-os-icon">💻</div>
          <h2 class="dl-os-detected">Descarga RBX Infinity</h2>
          <p class="dl-os-sub">No se pudo detectar tu SO. Elige abajo.</p>
          <div class="dl-version-chip">v${v}</div>
        </div>`;
    }
  };

  const relNotes = versionData.notas ? `
    <div class="dl-release-notes">
      <h3 class="dl-rn-title">📋 Notas de versión — ${versionData.nombre || 'v'+v}</h3>
      <p class="dl-rn-date">${versionData.fecha ? 'Publicado el ' + new Date(versionData.fecha).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'}) : ''}</p>
      <p class="dl-rn-body">${versionData.notas}</p>
    </div>` : '';

  content.innerHTML = `
    <div class="descarga-page">

      <!-- HERO -->
      <div class="dl-hero">
        <div class="dl-hero-bg"></div>
        <div class="dl-hero-content">
          <img src="https://i.ibb.co/zHWzJ1Lt/1-F452206-FCFC-4237-AF61-C3239-AAEC3-BE.jpg" class="dl-hero-logo" alt="RBX Infinity">
          <h1 class="dl-hero-title">RBX Infinity en tu dispositivo</h1>
          <p class="dl-hero-sub">Descarga la app y disfruta sin límites, sin navegador, sin esperas.</p>
          <div class="dl-current-version-badge">
            <span class="dl-cv-dot"></span>
            Versión actual: <strong>${versionData.nombre || v}</strong>
          </div>
        </div>
      </div>

      <!-- DETECTED OS PRIMARY DOWNLOAD -->
      <div class="dl-detected-section">
        <div class="dl-detected-label">
          <span class="dl-badge-detected">Tu dispositivo</span>
          <span class="dl-detected-os">${os !== 'unknown' ? OSCards.find(o=>o.id===os)?.label || 'Desconocido' : 'No detectado'}</span>
        </div>
        ${renderPrimaryBlock()}
        ${relNotes}
      </div>

      <!-- ALL PLATFORMS -->
      <div class="dl-all-section">
        <h2 class="dl-section-title">Todos los dispositivos</h2>
        <div class="dl-platform-grid">

          <!-- WINDOWS -->
          <div class="dl-platform-card ${os==='windows'?'dl-platform-active':''}">
            <div class="dl-pc-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/windows8/windows8-original.svg" width="28" height="28"></div>
            <div class="dl-pc-info">
              <span class="dl-pc-name">Windows</span>
              <span class="dl-pc-sub">Windows 10 / 11 · 64-bit</span>
            </div>
            <div class="dl-pc-actions">
              <a class="dl-pc-btn" href="${DLURLS.windows.url}" title="${DLURLS.windows.label}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                .zip (v${v})
              </a>
              <a class="dl-pc-link" href="${RELEASES_BASE}" target="_blank">Otras versiones</a>
            </div>
          </div>

          <!-- ANDROID -->
          <div class="dl-platform-card ${os==='android'?'dl-platform-active':''}">
            <div class="dl-pc-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/android/android-original.svg" width="28" height="28"></div>
            <div class="dl-pc-info">
              <span class="dl-pc-name">Android</span>
              <span class="dl-pc-sub">Android 8.0+</span>
            </div>
            <div class="dl-pc-actions">
              <a class="dl-pc-btn dl-pc-btn-play" href="${DLURLS.android.play}" target="_blank" rel="noopener">Google Play</a>
              <a class="dl-pc-btn" href="${DLURLS.android.apk}" title="${DLURLS.android.label}">.apk (v${v})</a>
              <a class="dl-pc-link" href="${RELEASES_BASE}" target="_blank">Otras versiones</a>
            </div>
          </div>

          <!-- iOS -->
          <div class="dl-platform-card ${os==='ios'?'dl-platform-active':''}">
            <div class="dl-pc-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="28" height="28"></div>
            <div class="dl-pc-info"><span class="dl-pc-name">iOS</span><span class="dl-pc-sub">iPhone / iPad</span></div>
            <div class="dl-pc-actions"><span class="dl-pc-soon">Próximamente</span></div>
          </div>

          <!-- macOS -->
          <div class="dl-platform-card ${os==='mac'?'dl-platform-active':''}">
            <div class="dl-pc-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="28" height="28"></div>
            <div class="dl-pc-info">
              <span class="dl-pc-name">macOS</span>
              <span class="dl-pc-sub">macOS 12+</span>
            </div>
            <div class="dl-pc-actions">
              <a class="dl-pc-btn" href="${DLURLS.mac.url}" title="${DLURLS.mac.label}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                .dmg (v${v})
              </a>
              <a class="dl-pc-link" href="${RELEASES_BASE}" target="_blank">Otras versiones</a>
            </div>
          </div>

          <!-- Linux -->
          <div class="dl-platform-card ${os==='linux'?'dl-platform-active':''}">
            <div class="dl-pc-icon"><img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg" width="28" height="28"></div>
            <div class="dl-pc-info">
              <span class="dl-pc-name">Linux</span>
              <span class="dl-pc-sub">AppImage &middot; Ubuntu, Fedora...</span>
            </div>
            <div class="dl-pc-actions">
              <a class="dl-pc-btn" href="${DLURLS.linux.url}" title="${DLURLS.linux.label}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                .AppImage (v${v})
              </a>
              <a class="dl-pc-link" href="${RELEASES_BASE}" target="_blank">Otras versiones</a>
            </div>
          </div>

        </div>

        <!-- GitHub link -->
        <div class="dl-github-block">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
          <div>
            <span class="dl-github-title">Historial de versiones en GitHub</span>
            <span class="dl-github-sub">Accede a todas las versiones, notas de cambios y archivos anteriores</span>
          </div>
          <a class="dl-github-btn" href="${RELEASES_BASE}" target="_blank" rel="noopener">
            Ver releases →
          </a>
        </div>

      </div>

      <!-- FEATURES LIST -->
      <div class="dl-features-section">
        <h2 class="dl-section-title">¿Por qué descargar la app?</h2>
        <div class="dl-features-grid">
          <div class="dl-feature-item">
            <span class="dl-feat-icon">⚡</span>
            <span class="dl-feat-title">Más rápida</span>
            <span class="dl-feat-desc">Sin la carga del navegador, inicia en segundos</span>
          </div>
          <div class="dl-feature-item">
            <span class="dl-feat-icon">🔔</span>
            <span class="dl-feat-title">Notificaciones</span>
            <span class="dl-feat-desc">Recibe avisos de estrenos y recordatorios</span>
          </div>
          <div class="dl-feature-item">
            <span class="dl-feat-icon">🖥️</span>
            <span class="dl-feat-title">Pantalla completa real</span>
            <span class="dl-feat-desc">Sin barras del navegador, experiencia total</span>
          </div>
          <div class="dl-feature-item">
            <span class="dl-feat-icon">📱</span>
            <span class="dl-feat-title">Integración nativa</span>
            <span class="dl-feat-desc">Controles de volumen, pausa, notch...</span>
          </div>
        </div>
      </div>

    </div>`;

  requestAnimationFrame(() => {
    content.style.opacity = '1';
    content.style.transform = 'translateY(0)';
  });
}

window.renderDownloadPage = renderDownloadPage;

// ─── TOAST ────────────────────────────────────────────────────────────────────

// ─── LOBBY VIDEO WATCHER ──────────────────────────────────────────────────────
// Watches for video elements created by XPlayer and hooks them for lobby sync
(function() {
  const _obs = new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        const vid = node.tagName === 'VIDEO' ? node : node.querySelector?.('video');
        if (vid && !vid._lobbyHooked && window._currentLobbyContentId) {
          vid._lobbyHooked = true;
          hookPlayerForLobbySync(vid, window._currentLobbyContentId);
        }
      }
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    _obs.observe(document.body, { childList: true, subtree: true });
  });
})();


// ═══════════════════════════════════════════════════════════════════════════════
// INLINE STREAMS SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
let _streamsCurrentUser = null;
let _streamsIsAdmin = false;
let _activeStreamId = null;
let _streamChatUnsub = null;

function _injectStreamStyles() {
  if (document.getElementById('streams-css')) return;
  const s = document.createElement('style');
  s.id = 'streams-css';
  s.textContent = `
  .streams-page{padding:0 0 80px}
  .streams-header{padding:28px 40px 20px}
  .streams-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .streams-sub{color:rgba(232,234,240,.5);font-size:.88rem;padding:0 40px}
  .slive-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ff3b3b;
    margin-right:10px;animation:slivePulse 1.4s infinite;vertical-align:middle}
  @keyframes slivePulse{0%{box-shadow:0 0 0 0 rgba(255,59,59,.5)}70%{box-shadow:0 0 0 8px rgba(255,59,59,0)}100%{box-shadow:0 0 0 0 rgba(255,59,59,0)}}
  .stream-new-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;background:#1a7fff;
    border:none;border-radius:10px;color:#fff;font-size:.85rem;font-weight:700;cursor:pointer;transition:background .2s}
  .stream-new-btn:hover{background:#1260cc}
  .streams-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;padding:0 40px}
  .streams-empty{grid-column:1/-1;text-align:center;color:rgba(232,234,240,.4);padding:60px 0;font-size:.9rem}
  .stream-card{background:rgba(0,18,48,.7);border:1px solid rgba(26,127,255,.15);border-radius:14px;
    overflow:hidden;cursor:pointer;transition:transform .2s,border-color .2s;display:flex;flex-direction:column}
  .stream-card:hover{transform:translateY(-3px);border-color:rgba(26,127,255,.4)}
  .stream-card-live{border-color:rgba(255,59,59,.3)}
  .stream-card-thumb{position:relative;height:160px;background:linear-gradient(135deg,#000d1f,#001a3a);
    background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .stream-card-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.4}
  .stream-live-badge{position:absolute;top:10px;left:10px;background:#ff3b3b;color:#fff;
    font-size:.65rem;font-weight:800;padding:3px 9px;border-radius:20px;letter-spacing:.5px}
  .stream-sched-badge{position:absolute;top:10px;left:10px;background:rgba(26,127,255,.85);color:#fff;
    font-size:.65rem;font-weight:700;padding:3px 9px;border-radius:20px}
  .stream-card-info{padding:14px 16px}
  .stream-card-title{font-size:.95rem;font-weight:700;color:#e8eaf0;margin-bottom:4px}
  .stream-card-desc{font-size:.78rem;color:rgba(232,234,240,.5);line-height:1.4}
  .stream-card-meta{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .stream-type-pill{font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:10px;
    background:rgba(26,127,255,.15);color:#7ab9ff;text-transform:uppercase}
  .stream-type-pill.youtube{background:rgba(255,0,0,.15);color:#ff6b6b}
  .stream-owner{font-size:.75rem;color:rgba(232,234,240,.4)}
  .stream-start-btn{margin-top:8px;padding:6px 14px;border-radius:8px;border:none;background:#1a7fff;color:#fff;font-size:.8rem;font-weight:700;cursor:pointer}
  .stream-end-btn{margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid rgba(255,59,59,.3);background:rgba(255,59,59,.1);color:#ff6b6b;font-size:.8rem;font-weight:700;cursor:pointer}
  /* Create modal */
  .csm-wrap{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;
    opacity:0;pointer-events:none;transition:opacity .28s}
  .csm-wrap.csm-visible{opacity:1;pointer-events:all}
  .csm-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(6px)}
  .csm-card{position:relative;z-index:1;background:#000d1f;border:1px solid rgba(26,127,255,.2);
    border-radius:16px;width:min(580px,96vw);max-height:90vh;overflow-y:auto;padding:32px;
    box-shadow:0 28px 90px rgba(0,0,0,.7);transform:translateY(16px);transition:transform .28s}
  .csm-wrap.csm-visible .csm-card{transform:translateY(0)}
  .csm-close-btn{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.08);border:none;
    color:#e8eaf0;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:.9rem;
    display:flex;align-items:center;justify-content:center}
  .csm-title-h{font-size:1.3rem;font-weight:800;margin-bottom:22px;color:#e8eaf0}
  .csm-label{display:block;font-size:.8rem;color:rgba(232,234,240,.6);margin-bottom:5px;font-weight:600}
  .csm-req{color:#ff6b6b}
  .csm-input{width:100%;background:rgba(255,255,255,.06);border:1.5px solid rgba(26,127,255,.2);
    border-radius:8px;padding:9px 12px;color:#e8eaf0;font-size:.88rem;outline:none;
    transition:border .2s;font-family:inherit;box-sizing:border-box}
  .csm-input:focus{border-color:rgba(26,127,255,.5);background:rgba(26,127,255,.05)}
  textarea.csm-input{resize:vertical;min-height:60px}
  .csm-input option{background:#001030}
  .csm-group{margin-bottom:14px}
  .csm-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
  .csm-section-lbl{font-size:.7rem;font-weight:700;letter-spacing:1px;color:rgba(232,234,240,.35);
    text-transform:uppercase;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.05)}
  .csm-type-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
  .csm-type-opt{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;
    background:rgba(255,255,255,.04);border:2px solid rgba(255,255,255,.08);border-radius:10px;
    cursor:pointer;transition:border .18s,background .18s;text-align:center}
  .csm-type-opt:hover{border-color:rgba(26,127,255,.4)}
  .csm-type-opt input[type=radio]{display:none}
  .csm-type-opt span{font-size:.8rem;font-weight:600;color:rgba(232,234,240,.65)}
  .csm-type-opt small{font-size:.67rem;color:rgba(232,234,240,.3)}
  .csm-type-opt.active{border-color:#1a7fff;background:rgba(26,127,255,.1)}
  .csm-type-opt.active span{color:#7ab9ff}
  .csm-info-box{background:rgba(26,127,255,.07);border:1px solid rgba(26,127,255,.18);
    border-radius:10px;padding:12px 14px;font-size:.82rem;color:rgba(232,234,240,.6);line-height:1.5;margin-bottom:4px}
  .csm-submit-btn{width:100%;padding:13px;background:#1a7fff;border:none;border-radius:10px;
    color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;
    justify-content:center;gap:8px;margin-top:18px;transition:background .2s}
  .csm-submit-btn:hover{background:#1260cc}
  .csm-submit-btn:disabled{opacity:.5;cursor:not-allowed}
  .csm-hidden{display:none}
  /* Stream player */
  .spm-wrap{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
    opacity:0;pointer-events:none;transition:opacity .28s;padding:12px}
  .spm-wrap.spm-visible{opacity:1;pointer-events:all}
  .spm-bg{position:absolute;inset:0;background:rgba(0,0,0,.92);backdrop-filter:blur(6px)}
  .spm-box{position:relative;z-index:1;background:#000a1a;border:1px solid rgba(26,127,255,.2);
    border-radius:16px;width:100%;max-width:1100px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}
  .spm-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
    border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-hdr-l{display:flex;align-items:center;gap:10px}
  .spm-htitle{font-size:.93rem;font-weight:700;color:#e8eaf0}
  .spm-hdr-r{display:flex;align-items:center;gap:8px}
  .spm-close{background:rgba(255,255,255,.08);border:none;color:#e8eaf0;width:28px;height:28px;
    border-radius:50%;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center}
  .spm-end-btn{padding:5px 12px;background:rgba(255,59,59,.15);border:1px solid rgba(255,59,59,.3);
    border-radius:8px;color:#ff6b6b;font-size:.78rem;font-weight:700;cursor:pointer}
  .spm-body{display:flex;flex:1;overflow:hidden;min-height:0}
  .spm-video{flex:1;display:flex;flex-direction:column;background:#000;position:relative}
  .spm-video video,.spm-video iframe{flex:1;width:100%;min-height:0;border:none}
  .spm-no-vid{display:flex;align-items:center;justify-content:center;flex:1;
    color:rgba(232,234,240,.3);font-size:.85rem}
  .spm-screen-cta{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:12px;background:rgba(0,0,0,.7)}
  .spm-share-btn{padding:12px 24px;background:#1a7fff;border:none;border-radius:10px;
    color:#fff;font-size:.9rem;font-weight:700;cursor:pointer}
  .spm-chat{width:260px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid rgba(255,255,255,.06)}
  .spm-chat-hdr{padding:10px 14px;font-size:.8rem;font-weight:700;color:rgba(232,234,240,.45);
    border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-msgs{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:5px}
  .spm-msgs::-webkit-scrollbar{width:3px}
  .spm-msgs::-webkit-scrollbar-thumb{background:rgba(26,127,255,.3)}
  .spm-msg{font-size:.79rem;line-height:1.4}
  .spm-msg-name{font-weight:700;color:#7ab9ff;margin-right:4px}
  .spm-msg-txt{color:rgba(232,234,240,.8)}
  .spm-inp{display:flex;gap:6px;padding:8px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-inp input{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(26,127,255,.18);
    border-radius:8px;padding:7px 10px;color:#e8eaf0;font-size:.82rem;outline:none}
  .spm-inp button{background:#1a7fff;border:none;border-radius:8px;padding:7px 10px;cursor:pointer;color:#fff}
  @media(max-width:680px){.spm-chat{display:none}.csm-row2{grid-template-columns:1fr}.csm-type-grid{grid-template-columns:1fr 1fr}.streams-grid,.streams-header,.streams-sub{padding-left:16px;padding-right:16px}}
  /* Admin stream btn override */
  .admin-page .stream-new-btn{background:rgba(26,127,255,.12);border:1px solid rgba(26,127,255,.28);color:#7ab9ff}
  .admin-page .stream-new-btn:hover{background:rgba(26,127,255,.25);color:#fff}
  `;
  document.head.appendChild(s);
}

// ─── STREAMS PAGE ──────────────────────────────────────────────────────────────
function _renderStreamsPage() {
  const el = document.getElementById('appContent');
  el.innerHTML = `
    <div class="streams-page">
      <div class="streams-header">
        <div class="streams-title-row">
          <h1 class="page-title"><span class="slive-dot"></span>Directos</h1>
          ${_streamsIsAdmin ? `<button class="stream-new-btn" onclick="openCreateStreamModal()">+ Nuevo stream</button>` : ''}
        </div>
        <p class="streams-sub">Sigue los directos en vivo de RBX Infinity.</p>
      </div>
      <div class="streams-grid" id="streamsGrid">
        <div class="streams-empty">Cargando directos...</div>
      </div>
    </div>`;
  _listenStreamsGrid();
}

async function _listenStreamsGrid() {
  const { onValue, ref } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  onValue(ref(db, 'streams'), snap => {
    const grid = document.getElementById('streamsGrid');
    if (!grid) return;
    if (!snap.exists()) { grid.innerHTML = '<div class="streams-empty">No hay directos ahora.</div>'; return; }
    const now = Date.now();
    const list = Object.entries(snap.val())
      .map(([id,s]) => ({id,...s}))
      .filter(s => s.status !== 'ended')
      .sort((a,b) => (a.scheduledAt||a.startedAt||0)-(b.scheduledAt||b.startedAt||0));
    if (!list.length) { grid.innerHTML = '<div class="streams-empty">No hay directos ahora.</div>'; return; }
    grid.innerHTML = list.map(s => {
      const isLive = s.status === 'live';
      const bg = s.banner || s.poster;
      const mine = s.ownerUid === _streamsCurrentUser?.uid;
      return `<div class="stream-card ${isLive?'stream-card-live':''}"
        onclick="${isLive?`openStreamPlayer('${s.id}')`:''}">
        <div class="stream-card-thumb" style="${bg?`background-image:url('${bg}')`:``}">
          ${isLive?'<span class="stream-live-badge">EN VIVO</span>':'<span class="stream-sched-badge">Programado</span>'}
          ${s.poster?`<img src="${s.poster}" class="stream-card-poster" alt="">` : ''}
        </div>
        <div class="stream-card-info">
          <div class="stream-card-meta">
            <span class="stream-type-pill ${s.tipo||''}">${s.tipo==='youtube'?'YouTube':'Pantalla'}</span>
            <span class="stream-owner">${s.ownerName||'Admin'}</span>
          </div>
          <h3 class="stream-card-title">${s.titulo||'Sin título'}</h3>
          ${s.descripcion?`<p class="stream-card-desc">${s.descripcion.slice(0,80)}...</p>`:''}
          ${mine&&isLive?`<button class="stream-end-btn" onclick="event.stopPropagation();_endStream('${s.id}')">Terminar</button>`:''}
          ${mine&&!isLive?`<button class="stream-start-btn" onclick="event.stopPropagation();_startStream('${s.id}')">Empezar ahora</button>`:''}
        </div>
      </div>`;
    }).join('');
  });
}

window._endStream = async (id) => {
  const { update, ref } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  await update(ref(db, `streams/${id}`), { status:'ended', endedAt:Date.now(), broadcasting:false });
  showToast('Stream terminado', 'success');
};
window._startStream = async (id) => {
  const { update, ref } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  await update(ref(db, `streams/${id}`), { status:'live', startedAt:Date.now() });
  showToast('Stream iniciado', 'success');
  openStreamPlayer(id);
};

// ─── CREATE STREAM MODAL ───────────────────────────────────────────────────────
window.openCreateStreamModal = () => {
  document.getElementById('_csmModal')?.remove();
  const m = document.createElement('div');
  m.id = '_csmModal'; m.className = 'csm-wrap';
  m.innerHTML = `
    <div class="csm-backdrop" onclick="closeCreateStreamModal()"></div>
    <div class="csm-card">
      <button class="csm-close-btn" onclick="closeCreateStreamModal()">✕</button>
      <h2 class="csm-title-h">Nuevo Stream</h2>
      <div class="csm-section-lbl">Información</div>
      <div class="csm-group">
        <label class="csm-label">Título <span class="csm-req">*</span></label>
        <input id="_csmTitulo" class="csm-input" type="text" placeholder="Ej: Noche de Terror Especial" maxlength="80">
      </div>
      <div class="csm-group">
        <label class="csm-label">Descripción</label>
        <textarea id="_csmDesc" class="csm-input" rows="2" placeholder="Describe el stream..." maxlength="300"></textarea>
      </div>
      <div class="csm-row2">
        <div>
          <label class="csm-label">Poster (URL) <span class="csm-req">*</span></label>
          <input id="_csmPoster" class="csm-input" type="url" placeholder="https://...">
        </div>
        <div>
          <label class="csm-label">Banner (URL)</label>
          <input id="_csmBanner" class="csm-input" type="url" placeholder="https://...">
        </div>
      </div>
      <div class="csm-row2">
        <div>
          <label class="csm-label">Edad mínima</label>
          <select id="_csmEdad" class="csm-input">
            <option value="0">Sin restricción</option>
            <option value="7">+7</option>
            <option value="12">+12</option>
            <option value="16">+16</option>
            <option value="18">+18</option>
          </select>
        </div>
        <div>
          <label class="csm-label">Programar para</label>
          <input id="_csmSched" class="csm-input" type="datetime-local">
        </div>
      </div>
      <div class="csm-group">
        <label class="csm-label">Tráiler (solo si está programado)</label>
        <input id="_csmTrailer" class="csm-input" type="url" placeholder="https://...">
      </div>
      <div class="csm-section-lbl">Tipo de stream</div>
      <div class="csm-type-grid" style="grid-template-columns:1fr 1fr">
        <label class="csm-type-opt active" id="_csmOptYT" onclick="_csmType('youtube',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><path d="M21.582 7.186a2.506 2.506 0 0 0-1.762-1.773C18.265 5 12 5 12 5s-6.265 0-7.82.413A2.506 2.506 0 0 0 2.418 7.186C2 8.748 2 12 2 12s0 3.252.418 4.814a2.506 2.506 0 0 0 1.762 1.773C5.735 19 12 19 12 19s6.265 0 7.82-.413a2.506 2.506 0 0 0 1.762-1.773C22 15.252 22 12 22 12s0-3.252-.418-4.814zM10 15V9l5.2 3-5.2 3z"/></svg>
          <span>YouTube</span>
        </label>
        <label class="csm-type-opt" id="_csmOptScreen" onclick="_csmType('screen',this)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4z"/></svg>
          <span>Pantalla / Cámara</span><small>En vivo desde el navegador</small>
        </label>
      </div>
      <div id="_csmYTSec">
        <label class="csm-label">URL de YouTube Live <span class="csm-req">*</span></label>
        <input id="_csmYTUrl" class="csm-input" type="url" placeholder="https://www.youtube.com/watch?v=...">
      </div>
      <div id="_csmScreenSec" class="csm-hidden">
        <div class="csm-info-box">Al crear el stream se pedirá que selecciones qué compartir (ventana, app o pantalla) o se activará tu cámara si tu dispositivo no soporta pantalla. Los espectadores lo verán en directo.</div>
      </div>
      <button class="csm-submit-btn" onclick="_doCreateStream()">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        Crear stream
      </button>
    </div>`;
  document.body.appendChild(m);
  requestAnimationFrame(() => m.classList.add('csm-visible'));
};

window.closeCreateStreamModal = () => {
  const m = document.getElementById('_csmModal');
  if (m) { m.classList.remove('csm-visible'); setTimeout(() => m.remove(), 280); }
};

window._csmType = (tipo, el) => {
  document.querySelectorAll('.csm-type-opt').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('_csmYTSec').classList.toggle('csm-hidden', tipo !== 'youtube');
  document.getElementById('_csmScreenSec').classList.toggle('csm-hidden', tipo !== 'screen');
  el.dataset.tipo = tipo;
  window._csmSelectedType = tipo;
};
window._csmSelectedType = 'youtube';

window._doCreateStream = async () => {
  const titulo   = document.getElementById('_csmTitulo')?.value.trim();
  const desc     = document.getElementById('_csmDesc')?.value.trim() || '';
  const poster   = document.getElementById('_csmPoster')?.value.trim();
  const banner   = document.getElementById('_csmBanner')?.value.trim() || null;
  const trailer  = document.getElementById('_csmTrailer')?.value.trim() || null;
  const edad     = parseInt(document.getElementById('_csmEdad')?.value || '0');
  const schedVal = document.getElementById('_csmSched')?.value;
  const schedAt  = schedVal ? new Date(schedVal).getTime() : null;
  const tipo     = window._csmSelectedType || 'youtube';
  const ytUrl    = document.getElementById('_csmYTUrl')?.value.trim() || null;

  if (!titulo)  { showToast('El título es obligatorio', 'error'); return; }
  if (!poster)  { showToast('El poster es obligatorio', 'error'); return; }
  if (tipo === 'youtube' && !ytUrl) { showToast('Añade la URL de YouTube', 'error'); return; }

  const btn = document.querySelector('.csm-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }

  try {
    const { ref, set } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    const id = 'stream_' + Date.now();

    await set(ref(db, `streams/${id}`), {
      id, titulo, descripcion: desc, poster, banner, trailer,
      edadMinima: edad, tipo, youtubeUrl: ytUrl,
      status: schedAt ? 'scheduled' : 'live',
      scheduledAt: schedAt || null,
      startedAt: schedAt ? null : Date.now(),
      ownerUid: _streamsCurrentUser?.uid,
      ownerName: _streamsCurrentUser?.displayName || 'Admin',
      viewerCount: 0,
      broadcasting: false
    });

    closeCreateStreamModal();
    showToast('Stream creado', 'success');

    if (!schedAt) {
      if (tipo === 'screen') {
        setTimeout(() => openStreamPlayer(id, true), 400);
      } else {
        openStreamPlayer(id, false);
      }
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Crear stream'; }
  }
};

// ─── STREAM PLAYER ────────────────────────────────────────────────────────────
window.openStreamPlayer = async (streamId, isOwner = false) => {
  const { get, ref, onValue, push } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  const snap = await get(ref(db, `streams/${streamId}`));
  const s = snap.exists() ? { id: streamId, ...snap.val() } : null;
  if (!s) { showToast('Stream no encontrado', 'error'); return; }
  _activeStreamId = streamId;
  document.getElementById('_spmModal')?.remove();

  const isYT = s.tipo === 'youtube';
  const isScreen = s.tipo === 'screen';
  const m = document.createElement('div');
  m.id = '_spmModal'; m.className = 'spm-wrap';

  let videoHtml = '';
  if (isYT && s.youtubeUrl) {
    let vid = '';
    try { const u = new URL(s.youtubeUrl); vid = u.searchParams.get('v') || u.pathname.split('/').pop(); } catch {}
    videoHtml = `<iframe src="https://www.youtube.com/embed/${vid}?autoplay=1&rel=0" allow="autoplay;fullscreen" allowfullscreen style="flex:1;width:100%;min-height:320px;border:none"></iframe>`;
  } else if (isScreen) {
    videoHtml = `<video id="_spmVid" autoplay playsinline ${isOwner?'muted':''} controls style="flex:1;width:100%;object-fit:contain;background:#000"></video>
      ${isOwner ? `<div class="spm-screen-cta" id="_spmScreenCta">
        <p style="color:rgba(232,234,240,.6);font-size:.88rem;margin-bottom:8px">Comparte tu pantalla o cámara para que los demás puedan verte en directo</p>
        <button class="spm-share-btn" onclick="_startScreenShare('${streamId}')">Empezar a transmitir</button>
      </div>` : `<div class="spm-screen-cta" id="_spmWaitingCta" style="background:rgba(0,0,0,.55)">
        <svg viewBox="0 0 24 24" fill="rgba(232,234,240,.25)" width="40" height="40"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>
        <p style="color:rgba(232,234,240,.4);font-size:.85rem;margin-top:10px">Conectando con el streamer...</p>
      </div>`}`;
  } else {
    videoHtml = '<div class="spm-no-vid">Conectando...</div>';
  }

  m.innerHTML = `
    <div class="spm-bg"></div>
    <div class="spm-box">
      <div class="spm-hdr">
        <div class="spm-hdr-l">
          <span class="slive-dot"></span>
          <span class="spm-htitle">${s.titulo}</span>
        </div>
        <div class="spm-hdr-r">
          ${isOwner && s.status==='live' ? `<button class="spm-end-btn" onclick="_endStream('${streamId}');closeStreamPlayer()">Terminar</button>` : ''}
          <button class="spm-close" onclick="closeStreamPlayer()">✕</button>
        </div>
      </div>
      <div class="spm-body">
        <div class="spm-video">${videoHtml}</div>
        <div class="spm-chat">
          <div class="spm-chat-hdr">Chat en vivo</div>
          <div class="spm-msgs" id="_spmMsgs"></div>
          <div class="spm-inp">
            <input id="_spmInput" type="text" placeholder="Mensaje..." maxlength="200"
              onkeydown="if(event.key==='Enter')_sendStreamMsg()">
            <button onclick="_sendStreamMsg()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(m);
  requestAnimationFrame(() => m.classList.add('spm-visible'));

  // Listen chat
  if (_streamChatUnsub) _streamChatUnsub();
  _streamChatUnsub = onValue(ref(db, `streams/${streamId}/chat`), snap => {
    const msgs = document.getElementById('_spmMsgs');
    if (!msgs || !snap.exists()) return;
    const all = Object.values(snap.val()).sort((a,b) => a.ts-b.ts).slice(-50);
    const atBot = msgs.scrollHeight - msgs.scrollTop <= msgs.clientHeight + 60;
    msgs.innerHTML = all.map(msg => `<div class="spm-msg"><span class="spm-msg-name">${msg.name}</span><span class="spm-msg-txt">${msg.text}</span></div>`).join('');
    if (atBot) msgs.scrollTop = msgs.scrollHeight;
  });

  // Increment viewers
  if (!isOwner) {
    try {
      const { update } = await import('./firebase.js');
      const vSnap = await get(ref(db, `streams/${streamId}/viewerCount`));
      update(ref(db, `streams/${streamId}`), { viewerCount: (vSnap.val()||0)+1 });
    } catch {}

    // If this is a screen/camera stream and the owner is already broadcasting,
    // connect immediately via WebRTC (Firebase used purely for signaling)
    if (isScreen && s.broadcasting) {
      const vid = document.getElementById('_spmVid');
      if (vid) setTimeout(() => _connectAsViewer(streamId, vid), 300);
    }
  }
};

window.closeStreamPlayer = () => {
  const m = document.getElementById('_spmModal');
  if (m) { m.classList.remove('spm-visible'); setTimeout(() => m.remove(), 280); }
  if (_streamChatUnsub) { _streamChatUnsub(); _streamChatUnsub = null; }
  _cleanupRTC();
  _activeStreamId = null;
};

window._sendStreamMsg = async () => {
  const inp = document.getElementById('_spmInput');
  const text = inp?.value.trim();
  if (!text || !_activeStreamId || !_streamsCurrentUser) return;
  inp.value = '';
  const { push, ref } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  push(ref(db, `streams/${_activeStreamId}/chat`), {
    uid: _streamsCurrentUser.uid,
    name: _streamsCurrentUser.displayName || 'Usuario',
    text, ts: Date.now()
  });
};

// ─── WEBRTC P2P BROADCAST SYSTEM ─────────────────────────────────────────────
// Firebase Realtime DB is used ONLY for signaling (exchanging SDP/ICE).
// The actual video/audio travels directly browser-to-browser via WebRTC.
const _RTC_ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]};

let _localStream   = null;   // broadcaster's captured stream
let _broadcastPCs  = {};     // peerId → RTCPeerConnection (broadcaster side, one per viewer)
let _viewerPC      = null;   // viewer side connection
let _rtcUnsubs     = [];     // firebase listener unsubscribers to clean up

window._startScreenShare = async (streamId) => {
  const btn = document.querySelector('.spm-share-btn');
  const canScreen = window.isSecureContext && !!(navigator.mediaDevices?.getDisplayMedia);

  if (btn) { btn.disabled = true; btn.textContent = canScreen ? 'Selecciona qué compartir...' : 'Activando cámara...'; }

  let stream = null;
  try {
    if (canScreen) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width:  { min: 1920, ideal: 1920 },
          height: { min: 1080, ideal: 1080 },
          frameRate: { ideal: 120, max: 120 },
          cursor: 'always'
        },
        audio: { echoCancellation: true, noiseSuppression: false, sampleRate: 48000 }
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
        audio: true
      });
      showToast('Tu dispositivo no soporta compartir pantalla — usando cámara', 'info');
    }
  } catch(e) {
    const msg = e.name === 'NotAllowedError' ? 'Permiso denegado'
      : e.name === 'NotFoundError' ? 'No se encontró cámara/pantalla disponible'
      : e.message;
    showToast('Error: ' + msg, 'error');
    if (btn) { btn.disabled = false; btn.textContent = canScreen ? 'Compartir pantalla' : 'Usar cámara'; }
    return;
  }

  _localStream = stream;

  // Log the resolution/fps the browser actually granted us — getDisplayMedia
  // constraints are only a request; the OS picture-in-picture/share dialog
  // can still cap them lower depending on the source selected.
  const track = stream.getVideoTracks()[0];
  if (track) {
    const settings = track.getSettings();
    console.info(`[Stream] Capturando a ${settings.width}x${settings.height}@${settings.frameRate}fps`);
  }

  // Show local preview (muted to avoid feedback)
  const vid = document.getElementById('_spmVid');
  if (vid) { vid.srcObject = stream; vid.muted = true; vid.play().catch(()=>{}); }
  document.getElementById('_spmScreenCta')?.remove();
  if (btn) btn.style.display = 'none';
  showToast('Transmitiendo en directo', 'success');

  // Mark as broadcasting in Firebase so viewers know to connect
  const { update, ref, onValue } = await import('./firebase.js');
  const { db } = await import('./firebase.js');
  await update(ref(db, `streams/${streamId}`), { broadcasting: true });

  // Listen for incoming viewer offers and answer each one
  const unsub = onValue(ref(db, `streams/${streamId}/rtc/viewers`), async (snap) => {
    if (!snap.exists()) return;
    for (const [peerId, vdata] of Object.entries(snap.val())) {
      // New viewer wanting to connect
      if (vdata.offer && !_broadcastPCs[peerId]) {
        await _answerViewer(streamId, peerId, vdata.offer, stream);
      }
      // Apply ICE candidates the viewer sent us — buffer them if our
      // remote description (their offer) hasn't finished applying yet,
      // same fix as the viewer side, since Firebase can deliver this
      // update before the _answerViewer() await above has resolved.
      if (vdata.viewerCandidates && _broadcastPCs[peerId]) {
        const pc = _broadcastPCs[peerId];
        if (!pc._seenCands) pc._seenCands = new Set();
        if (!pc._pendingCands) pc._pendingCands = [];
        for (const [k, c] of Object.entries(vdata.viewerCandidates)) {
          if (pc._seenCands.has(k)) continue;
          pc._seenCands.add(k);
          if (pc.remoteDescription) {
            pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
          } else {
            pc._pendingCands.push(c);
          }
        }
      }
    }
  });
  _rtcUnsubs.push(unsub);

  // Stop broadcasting cleanly if the user stops sharing from the browser UI
  stream.getVideoTracks()[0]?.addEventListener('ended', async () => {
    showToast('Transmisión detenida', 'info');
    if (vid) vid.srcObject = null;
    await update(ref(db, `streams/${streamId}`), { broadcasting: false });
    _cleanupRTC();
  });
};

async function _answerViewer(streamId, peerId, offer, stream) {
  const pc = new RTCPeerConnection(_RTC_ICE);
  _broadcastPCs[peerId] = pc;

  // Attach our local tracks so the viewer receives them
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  // Raise the video encoder's target bitrate — the default WebRTC bitrate
  // (~1-2.5 Mbps) is what was causing visible lag/compression at 30fps;
  // at 1080p/120fps we need a much higher ceiling for a clean image.
  const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (videoSender) {
    try {
      const params = videoSender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 12_000_000; // 12 Mbps ceiling
      params.encodings[0].maxFramerate = 120;
      await videoSender.setParameters(params);
    } catch (e) { console.warn('No se pudo ajustar el bitrate del stream:', e); }
  }

  const { push, ref, set } = await import('./firebase.js');
  const { db } = await import('./firebase.js');

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) push(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/hostCandidates`), candidate.toJSON());
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  if (pc._pendingCands && pc._pendingCands.length) {
    for (const c of pc._pendingCands) pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
    pc._pendingCands = [];
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await set(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/answer`), { type: answer.type, sdp: answer.sdp });
}

// ─── VIEWER SIDE: connect to the broadcaster ──────────────────────────────────
window._connectAsViewer = async (streamId, videoEl) => {
  const peerId = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  _viewerPC = new RTCPeerConnection(_RTC_ICE);

  // Candidates that arrive from the host before our remote description is
  // set must be queued — calling addIceCandidate too early fails silently
  // and those candidates are lost forever, which is what caused streams to
  // randomly drop the connection / never sync after the first attempt.
  const seenHostCandidates = new Set();
  let remoteDescSet = false;
  let pendingCandidates = [];

  _viewerPC.ontrack = (e) => {
    if (e.streams[0] && videoEl) {
      videoEl.srcObject = e.streams[0];
      videoEl.muted = false;
      videoEl.play().catch(()=>{});
      document.getElementById('_spmWaitingCta')?.remove();
    }
  };

  const { push, ref, set, onValue } = await import('./firebase.js');
  const { db } = await import('./firebase.js');

  _viewerPC.onicecandidate = ({ candidate }) => {
    if (candidate) push(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/viewerCandidates`), candidate.toJSON());
  };

  // Create and send our offer
  const offer = await _viewerPC.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await _viewerPC.setLocalDescription(offer);
  await set(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/offer`), { type: offer.type, sdp: offer.sdp });

  // Wait for the broadcaster's answer
  const unsub1 = onValue(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/answer`), async (snap) => {
    if (!snap.exists() || remoteDescSet || _viewerPC.signalingState !== 'have-local-offer') return;
    try {
      await _viewerPC.setRemoteDescription(new RTCSessionDescription(snap.val()));
      remoteDescSet = true;
      // Flush any host ICE candidates that arrived before we were ready
      for (const c of pendingCandidates) {
        _viewerPC.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
      }
      pendingCandidates = [];
    } catch (e) { console.warn('setRemoteDescription failed:', e); }
  });
  _rtcUnsubs.push(unsub1);

  // Apply ICE candidates the broadcaster sends us — dedupe by key so the
  // same candidate isn't re-applied every time Firebase re-delivers the
  // full snapshot (onValue fires with the whole list on every change).
  const unsub2 = onValue(ref(db, `streams/${streamId}/rtc/viewers/${peerId}/hostCandidates`), (snap) => {
    if (!snap.exists()) return;
    for (const [key, c] of Object.entries(snap.val())) {
      if (seenHostCandidates.has(key)) continue;
      seenHostCandidates.add(key);
      if (remoteDescSet) {
        _viewerPC?.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
      } else {
        pendingCandidates.push(c);
      }
    }
  });
  _rtcUnsubs.push(unsub2);

  return peerId;
};

function _cleanupRTC() {
  _localStream?.getTracks().forEach(t => t.stop());
  _localStream = null;
  Object.values(_broadcastPCs).forEach(pc => { try { pc.close(); } catch {} });
  _broadcastPCs = {};
  if (_viewerPC) { try { _viewerPC.close(); } catch {} _viewerPC = null; }
  _rtcUnsubs.forEach(u => { try { u(); } catch {} });
  _rtcUnsubs = [];
}

export function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.getElementById('toastContainer').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, 3200);
}
window.showToast = showToast;
