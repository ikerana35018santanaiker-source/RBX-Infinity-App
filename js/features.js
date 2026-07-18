// js/features.js — XCine Enhanced Features
// Ratings, smart search, "Because you watched", auto-categories,
// share lists, avatar editor, watch history, genre-based recommendations

import { db, ref as fbRef, push as fbPush, get as fbGet, set as fbSet, update as fbUpdate } from './firebase.js';

// ─── RATINGS & REACTIONS ─────────────────────────────────────────────────────
const REACTION_OPTS = [
  { emoji: '❤️', label: 'Me encanta', key: 'love' },
  { emoji: '👍', label: 'Me gusta', key: 'like' },
  { emoji: '😂', label: 'Divertido', key: 'funny' },
  { emoji: '😮', label: 'Sorprendente', key: 'wow' },
  { emoji: '😢', label: 'Triste', key: 'sad' },
  { emoji: '😡', label: 'No me gusta', key: 'angry' },
];

export async function getRatings(contentId) {
  try {
    const snap = await fbGet(fbRef(db, `ratings/${contentId}`));
    return snap.exists() ? snap.val() : {};
  } catch { return {}; }
}

export async function setRating(contentId, uid, key) {
  await fbSet(fbRef(db, `ratings/${contentId}/${uid}`), key);
  bumpTrendScore(contentId, 2); // a reaction counts more than a view
}

export async function getMyRating(contentId, uid) {
  const snap = await fbGet(fbRef(db, `ratings/${contentId}/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export function renderRatingSection(contentId, uid) {
  return `
    <div class="rating-section" id="ratingSection_${contentId}">
      <h4 class="rating-title">¿Qué te pareció?</h4>
      <div class="rating-reactions" id="ratingReactions_${contentId}">
        ${REACTION_OPTS.map(r => `
          <button class="rating-btn" id="rateBtn_${contentId}_${r.key}"
            onclick="submitRating('${contentId}','${uid}','${r.key}',this)"
            title="${r.label}">
            <span class="rating-emoji">${r.emoji}</span>
            <span class="rating-count" id="rateCount_${contentId}_${r.key}">0</span>
          </button>`).join('')}
      </div>
      <div class="rating-avg" id="ratingAvg_${contentId}"></div>
    </div>`;
}

export async function loadAndDisplayRatings(contentId, uid) {
  const ratings = await getRatings(contentId);
  const counts = {};
  let myRating = null;
  REACTION_OPTS.forEach(r => { counts[r.key] = 0; });

  Object.entries(ratings).forEach(([userId, key]) => {
    if (counts[key] !== undefined) counts[key]++;
    if (userId === uid) myRating = key;
  });

  REACTION_OPTS.forEach(r => {
    const countEl = document.getElementById(`rateCount_${contentId}_${r.key}`);
    if (countEl) countEl.textContent = counts[r.key] || '';
    const btn = document.getElementById(`rateBtn_${contentId}_${r.key}`);
    if (btn) btn.classList.toggle('active', r.key === myRating);
  });

  // Show dominant reaction in avg
  const total = Object.values(counts).reduce((a,b)=>a+b, 0);
  const avgEl = document.getElementById(`ratingAvg_${contentId}`);
  if (avgEl && total > 0) {
    const top = REACTION_OPTS.reduce((a,b) => counts[a.key] >= counts[b.key] ? a : b);
    avgEl.textContent = `${total} valoración${total>1?'es':''} · Más: ${top.emoji}`;
  }
}

window.submitRating = async (contentId, uid, key, btn) => {
  await setRating(contentId, uid, key);
  document.querySelectorAll(`[id^="rateBtn_${contentId}_"]`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  await loadAndDisplayRatings(contentId, uid);
};

// ─── SMART SEARCH ─────────────────────────────────────────────────────────────
// Fuzzy search + genre/year/type filters + search history
const SEARCH_HISTORY_KEY = 'xc_search_history';

export function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

export function addToSearchHistory(query) {
  if (!query || query.length < 2) return;
  const history = getSearchHistory().filter(h => h !== query);
  history.unshift(query);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
}

export function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
}

export function smartSearch(query, allContent) {
  if (!query) return [];
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  // Tokenize query
  const tokens = q.split(/\s+/).filter(Boolean);

  // Try to extract filters
  let yearFilter  = null;
  let typeFilter  = null;
  let genreFilter = null;
  const cleanTokens = [];

  tokens.forEach(tok => {
    if (/^\d{4}$/.test(tok)) { yearFilter = parseInt(tok); return; }
    if (['serie','series','show'].includes(tok)) { typeFilter = 'serie'; return; }
    if (['pelicula','película','film','movie'].includes(tok)) { typeFilter = 'pelicula'; return; }
    if (['terror','horror'].includes(tok)) { genreFilter = 'terror'; return; }
    if (['accion','acción','action'].includes(tok)) { genreFilter = 'acción'; return; }
    if (['drama'].includes(tok)) { genreFilter = 'drama'; return; }
    if (['thriller','suspenso','suspense'].includes(tok)) { genreFilter = 'thriller'; return; }
    cleanTokens.push(tok);
  });

  const scored = allContent.map(item => {
    const title = (item.titulo||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const desc  = (item.descripcion||'').toLowerCase();
    const genre = (item.genero||'').toLowerCase();
    const cats  = (item.categorias||[]).map(c=>c.toLowerCase()).join(' ');
    const etiq  = (item.etiqueta||'').toLowerCase();
    let score = 0;

    // Year filter
    if (yearFilter && item.año !== yearFilter) return null;
    // Type filter
    if (typeFilter && item.tipo && item.tipo !== typeFilter) return null;
    // Genre filter
    if (genreFilter && !genre.includes(genreFilter) && !cats.includes(genreFilter)) return null;

    // Title exact match
    if (title === q)            score += 100;
    // Title starts with
    if (title.startsWith(q))    score += 60;
    // Title contains full query
    if (title.includes(q))      score += 40;
    // Token matches
    cleanTokens.forEach(tok => {
      if (title.includes(tok))  score += 20;
      if (desc.includes(tok))   score += 5;
      if (genre.includes(tok))  score += 10;
      if (cats.includes(tok))   score += 8;
      if (etiq.includes(tok))   score += 4;
    });

    // Slight boost for released (non-upcoming) content
    if (!item._upcoming && score > 0) score += 5;

    if (score === 0) return null;
    return { item, score };
  }).filter(Boolean);

  return scored.sort((a,b)=>b.score-a.score).map(s=>s.item);
}

// ─── BECAUSE YOU WATCHED ──────────────────────────────────────────────────────
export function getBecauseYouWatched(watchedIds, allContent) {
  if (!watchedIds.length) return [];
  const results = [];
  const seen = new Set(watchedIds);

  watchedIds.slice(0, 3).forEach(wId => {
    const watched = allContent.find(i => i.id === wId);
    if (!watched) return;
    const recs = allContent.filter(item => {
      if (seen.has(item.id)) return false;
      const sameGenre = item.genero === watched.genero;
      const sharedCat = (item.categorias||[]).some(c => (watched.categorias||[]).includes(c));
      const sameType = item.tipo === watched.tipo;
      return sameGenre || (sharedCat && sameType);
    });
    if (recs.length) {
      results.push({ becauseOf: watched, items: recs.slice(0, 6) });
      recs.forEach(r => seen.add(r.id));
    }
  });
  return results;
}

export function renderBecauseRow(becauseBlock, renderCardFn) {
  if (!becauseBlock.items.length) return '';
  return `
    <div class="content-row because-row">
      <div class="because-header">
        <span class="because-label">Porque viste</span>
        <span class="because-title">${becauseBlock.becauseOf.titulo}</span>
      </div>
      <div class="cards-track">${becauseBlock.items.map(item => renderCardFn(item)).join('')}</div>
    </div>`;
}

// ─── AUTO CATEGORIES ─────────────────────────────────────────────────────────
export function generateAutoCategories(allContent) {
  const categoryMap = {};

  allContent.forEach(item => {
    // By genre
    if (item.genero) {
      if (!categoryMap[item.genero]) categoryMap[item.genero] = [];
      categoryMap[item.genero].push(item);
    }
    // By sub-categories
    (item.categorias || []).forEach(cat => {
      if (!categoryMap[cat]) categoryMap[cat] = [];
      categoryMap[cat].push(item);
    });
    // By year decade
    if (item.año) {
      const decade = Math.floor(item.año / 10) * 10;
      const key = `Años ${decade}s`;
      if (!categoryMap[key]) categoryMap[key] = [];
      categoryMap[key].push(item);
    }
    // New this year
    const currentYear = new Date().getFullYear();
    if (item.año && item.año >= currentYear) {
      const key = `Estrenos ${currentYear}`;
      if (!categoryMap[key]) categoryMap[key] = [];
      categoryMap[key].push(item);
    }
  });

  // Filter: only categories with 2+ items
  return Object.entries(categoryMap)
    .filter(([, items]) => items.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, items]) => ({ name, items }));
}

// ─── SHARE LIST ───────────────────────────────────────────────────────────────
export async function shareMyList(uid, profileId, listIds, profileName) {
  const shareId = Math.random().toString(36).slice(2, 10).toUpperCase();
  await fbSet(fbRef(db, `sharedLists/${shareId}`), {
    uid, profileId, profileName,
    listIds,
    createdAt: Date.now(),
    expires: Date.now() + 7 * 86400000 // 7 days
  });
  return shareId;
}

export async function getSharedList(shareId) {
  const snap = await fbGet(fbRef(db, `sharedLists/${shareId}`));
  if (!snap.exists()) return null;
  const data = snap.val();
  if (Date.now() > data.expires) return null;
  return data;
}

export function renderShareModal(shareId) {
  const url = `${window.location.origin}${window.location.pathname}#/shared/${shareId}`;
  return `
    <div class="share-modal-content">
      <div class="share-modal-icon">🔗</div>
      <h3>Lista compartida</h3>
      <p>Cualquiera con este enlace puede ver tu lista durante 7 días.</p>
      <div class="share-url-box">
        <input type="text" value="${url}" readonly id="shareUrlInput">
        <button class="xp-btn-primary" onclick="copyShareUrl()">Copiar</button>
      </div>
      <div class="share-options">
        <button class="share-opt-btn" onclick="shareToWhatsApp('${url}')">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.225.61 4.31 1.67 6.09L.057 24l5.995-1.574A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.007-1.37l-.36-.214-3.727.977.999-3.62-.235-.372A9.818 9.818 0 1112 21.818z"/></svg>
          WhatsApp
        </button>
        <button class="share-opt-btn" onclick="copyShareUrl()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          Copiar enlace
        </button>
      </div>
    </div>`;
}

window.copyShareUrl = () => {
  const input = document.getElementById('shareUrlInput');
  if (input) { navigator.clipboard.writeText(input.value); }
};
window.shareToWhatsApp = (url) => {
  window.open(`https://wa.me/?text=Mira mi lista en XCine: ${encodeURIComponent(url)}`, '_blank');
};

// ─── AVATAR EDITOR ────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  '#1a7fff','#ff4466','#ff9900','#00cc66','#9b59b6','#ff6b35','#00b4ff','#ff1744'
];
const AVATAR_ICONS = ['🎬','🎭','👻','🚀','🔥','⭐','🎃','🦁','🐺','🦊','🐉','👾'];

export function renderAvatarEditor(profile) {
  return `
    <div class="avatar-editor" id="avatarEditor">
      <div class="avatar-preview-area">
        <div class="avatar-big-preview" id="avatarBigPreview"
          style="background:${profile.avatarColor||'#1a7fff'}">
          <span class="avatar-big-icon" id="avatarBigIcon">${profile.avatarIcon||'🎬'}</span>
        </div>
        <div class="avatar-name">${profile.name}</div>
      </div>
      <div class="avatar-editor-section">
        <label>Icono</label>
        <div class="avatar-icon-grid">
          ${AVATAR_ICONS.map(icon => `
            <button class="avatar-icon-btn ${(profile.avatarIcon||'🎬')===icon?'selected':''}"
              onclick="selectAvatarIcon('${icon}',this)">${icon}</button>`).join('')}
        </div>
      </div>
      <div class="avatar-editor-section">
        <label>Color de fondo</label>
        <div class="avatar-color-row">
          ${AVATAR_COLORS.map(color => `
            <button class="avatar-color-btn ${(profile.avatarColor||'#1a7fff')===color?'selected':''}"
              style="background:${color}" onclick="selectAvatarColor('${color}',this)"></button>`).join('')}
        </div>
      </div>
    </div>`;
}

window.selectAvatarIcon = (icon, btn) => {
  document.querySelectorAll('.avatar-icon-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const preview = document.getElementById('avatarBigIcon');
  if (preview) preview.textContent = icon;
  window._pendingAvatarIcon = icon;
};

window.selectAvatarColor = (color, btn) => {
  document.querySelectorAll('.avatar-color-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const preview = document.getElementById('avatarBigPreview');
  if (preview) preview.style.background = color;
  window._pendingAvatarColor = color;
};

// ─── WATCH HISTORY ────────────────────────────────────────────────────────────
export function renderWatchHistoryRow(watchingData, allContent, renderCardFn) {
  const sorted = Object.entries(watchingData)
    .sort((a, b) => (b[1].updatedAt||0) - (a[1].updatedAt||0))
    .slice(0, 20);

  if (!sorted.length) return '';

  const items = sorted.map(([id, data]) => {
    const item = allContent.find(i => i.id === id);
    if (!item) return null;
    return { ...item, _progress: data.progress || 0, _time: data.currentTime || 0 };
  }).filter(Boolean);

  if (!items.length) return '';

  return `
    <div class="content-row watching-row">
      <div class="row-title-wrap">
        <h2 class="row-title">▶ Seguir viendo</h2>
        <button class="row-link-btn" onclick="navigateTo('mynetflix')">Ver todo</button>
      </div>
      <div class="cards-track watching-track">
        ${items.map(item => renderWatchingCard(item, renderCardFn)).join('')}
      </div>
    </div>`;
}

function renderWatchingCard(item, renderCardFn) {
  const prog = item._progress || 0;
  const remaining = prog > 0 ? `${100 - prog}% restante` : '';
  return `
    <div class="content-card watching-card" data-id="${item.id}" onclick="openContent('${item.id}')">
      <div class="card-img-wrap">
        <img src="${item.poster||item.banner}" alt="${item.titulo}" loading="lazy"
          onerror="this.src='https://via.placeholder.com/300x450/001030/4488ff?text=XCine'">
        <div class="watching-play-overlay">
          <div class="watching-play-circle">▶</div>
          ${remaining ? `<div class="watching-remaining">${remaining}</div>` : ''}
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${prog}%"></div></div>
        <div class="watching-info-overlay">
          <span class="card-title">${item.titulo}</span>
          ${item.tipo==='serie' && item._epInfo ? `<span style="font-size:.72rem;color:rgba(255,255,255,0.6)">${item._epInfo}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ─── GENRE-BASED RECOMMENDATIONS ─────────────────────────────────────────────
export function getGenreRecommendations(watchingData, allContent) {
  const genreCount = {};

  Object.keys(watchingData).forEach(id => {
    const item = allContent.find(i => i.id === id);
    if (!item) return;
    const genres = [item.genero, ...(item.categorias||[])].filter(Boolean);
    genres.forEach(g => { genreCount[g] = (genreCount[g]||0) + 1; });
  });

  if (!Object.keys(genreCount).length) return [];

  const topGenres = Object.entries(genreCount)
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 3)
    .map(([g]) => g);

  const watchedIds = new Set(Object.keys(watchingData));

  return topGenres.map(genre => {
    const items = allContent.filter(item => {
      if (watchedIds.has(item.id)) return false;
      return item.genero === genre || (item.categorias||[]).includes(genre);
    });
    return items.length >= 2 ? { genre, items: items.slice(0,10) } : null;
  }).filter(Boolean);
}

export function renderGenreRecommendationRows(recs, renderCardFn) {
  return recs.map(rec => `
    <div class="content-row">
      <h2 class="row-title">Por tu interés en <em>${rec.genre}</em></h2>
      <div class="cards-track">${rec.items.map(item => renderCardFn(item)).join('')}</div>
    </div>`).join('');
}

// ─── TRENDING ─────────────────────────────────────────────────────────────────
// A single flat node (trending/{contentId} -> score) so the home page can
// rank "Tendencias" with one read instead of scanning every rating/watch
// entry in the DB. Bumped a little on every watch, more on a reaction —
// decays naturally in relevance since it's not time-windowed, but that's
// an acceptable tradeoff for how cheap it is to read.
export function bumpTrendScore(contentId, amount = 1) {
  if (!contentId) return;
  fbGet(fbRef(db, `trending/${contentId}`)).then(snap => {
    const current = snap.exists() ? (snap.val() || 0) : 0;
    fbSet(fbRef(db, `trending/${contentId}`), current + amount).catch(() => {});
  }).catch(() => {});
}

export async function getTrendingIds(limit = 10) {
  try {
    const snap = await fbGet(fbRef(db, 'trending'));
    if (!snap.exists()) return [];
    const entries = Object.entries(snap.val() || {});
    return entries
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, limit)
      .map(([id]) => id);
  } catch { return []; }
}

export function renderTrendingRow(trendingItems, renderCardFn) {
  if (!trendingItems.length) return '';
  return `
    <div class="content-row trending-row">
      <h2 class="row-title">🔥 Tendencias</h2>
      <div class="cards-track">${trendingItems.map((item, i) => `
        <div class="trending-card-wrap">
          <span class="trending-rank">${i + 1}</span>
          ${renderCardFn(item)}
        </div>`).join('')}</div>
    </div>`;
}
