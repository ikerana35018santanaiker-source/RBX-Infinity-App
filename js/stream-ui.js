// js/streams-ui.js — RBX Infinity Streams UI
// Renders the streams page, admin creation panel, and live viewer

import {
  initStreams, getStreams, listenStreams, createStream,
  startScheduledStream, endStream, startScreenShare,
  watchScreenShare, sendStreamChat, listenStreamChat,
  incrementViewers, decrementViewers, checkScheduledNotifications
} from './streams.js';

let _user     = null;
let _isAdmin  = false;
let _streamsUnsub = null;
let _chatUnsub    = null;
let _activeStreamId = null;
let _screenPeerId   = null;

// ─── INIT ──────────────────────────────────────────────────────────────────────
export function initStreamsUI(user, userData) {
  _user    = user;
  _isAdmin = !!(userData?.isAdmin);
  initStreams(user, _isAdmin);
  // Request notification permission once
  if (_isAdmin && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Check scheduled notifications every 2 min
  if (_isAdmin) {
    checkScheduledNotifications(user?.uid);
    setInterval(() => checkScheduledNotifications(user?.uid), 120_000);
  }
}

// ─── STREAMS PAGE ──────────────────────────────────────────────────────────────
export function renderStreamsPage() {
  const content = document.getElementById('appContent');
  content.style.opacity = '0';
  content.innerHTML = `
    <div class="streams-page">
      <div class="streams-header">
        <div class="streams-title-row">
          <h1 class="page-title">
            <span class="live-dot"></span> Directos
          </h1>
          ${_isAdmin ? `
          <button class="stream-create-btn" onclick="openCreateStreamModal()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
            Nuevo stream
          </button>` : ''}
        </div>
        <p class="streams-sub">Sigue los directos en vivo de RBX Infinity.</p>
      </div>
      <div class="streams-grid" id="streamsGrid">
        <div class="streams-loading">
          <div class="loader-spinner" style="width:24px;height:24px;margin:0 auto 8px"></div>
          <p>Cargando directos...</p>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => { content.style.opacity = '1'; });
  _loadStreamsGrid();
}

function _loadStreamsGrid() {
  if (_streamsUnsub) _streamsUnsub();
  _streamsUnsub = listenStreams(streams => {
    const grid = document.getElementById('streamsGrid');
    if (!grid) return;
    if (!streams.length) {
      grid.innerHTML = `
        <div class="streams-empty">
          <div style="font-size:3rem;margin-bottom:12px">📡</div>
          <p>No hay directos activos ahora mismo.</p>
          <p style="font-size:.82rem;opacity:.5;margin-top:6px">Vuelve pronto o activa las notificaciones.</p>
        </div>`;
      return;
    }
    const now = Date.now();
    grid.innerHTML = streams.map(s => _renderStreamCard(s, now)).join('');
  });
}

function _renderStreamCard(s, now) {
  const isLive      = s.status === 'live';
  const isScheduled = s.status === 'scheduled';
  const timeLabel   = isScheduled && s.scheduledAt
    ? _formatScheduled(s.scheduledAt, now) : null;
  const bg = s.banner || s.poster;
  return `
    <div class="stream-card ${isLive ? 'stream-card-live' : 'stream-card-scheduled'}"
      onclick="${isLive ? `openStreamPlayer('${s.id}')` : (s.ownerUid === _user?.uid ? `startStreamNow('${s.id}')` : '')}">
      <div class="stream-card-thumb" style="${bg ? `background-image:url('${bg}')` : ''}">
        ${isLive ? '<span class="stream-live-badge">EN VIVO</span>' : ''}
        ${isScheduled ? `<span class="stream-sched-badge">${timeLabel || 'Programado'}</span>` : ''}
        ${s.edadMinima > 0 ? `<span class="stream-age-badge">+${s.edadMinima}</span>` : ''}
        ${s.poster ? `<img src="${s.poster}" alt="${_esc(s.titulo)}" class="stream-card-poster">` : ''}
        ${isLive ? `<div class="stream-card-viewers"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg> ${s.viewerCount || 0}</div>` : ''}
      </div>
      <div class="stream-card-info">
        <div class="stream-card-type-row">
          <span class="stream-type-pill ${s.tipo}">${_typeLbl(s.tipo)}</span>
          <span class="stream-card-owner">${_esc(s.ownerName || 'Admin')}</span>
        </div>
        <h3 class="stream-card-title">${_esc(s.titulo)}</h3>
        ${s.descripcion ? `<p class="stream-card-desc">${_esc(s.descripcion.substring(0,80))}${s.descripcion.length>80?'...':''}</p>` : ''}
        ${s.ownerUid === _user?.uid && isScheduled ? `
          <button class="stream-start-btn" onclick="event.stopPropagation();startStreamNow('${s.id}')">
            Empezar ahora
          </button>` : ''}
        ${s.ownerUid === _user?.uid && isLive ? `
          <button class="stream-end-btn" onclick="event.stopPropagation();endStreamNow('${s.id}')">
            Terminar stream
          </button>` : ''}
      </div>
    </div>`;
}

function _typeLbl(tipo) {
  return tipo === 'youtube' ? 'YouTube' : tipo === 'screen' ? 'Pantalla' : tipo === 'obs' ? 'OBS' : 'Directo';
}

function _formatScheduled(ts, now) {
  const diff = ts - now;
  if (diff <= 0) return 'Listo para empezar';
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `En ${d}d ${h % 24}h`;
  if (h > 0) return `En ${h}h ${m % 60}m`;
  return `En ${m} min`;
}

// ─── CREATE STREAM MODAL (admin) ───────────────────────────────────────────────
window.openCreateStreamModal = () => {
  document.getElementById('createStreamModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'createStreamModal';
  modal.className = 'csm-wrap';
  modal.innerHTML = `
    <div class="csm-backdrop" onclick="closeCreateStreamModal()"></div>
    <div class="csm-card">
      <button class="csm-close" onclick="closeCreateStreamModal()">✕</button>
      <h2 class="csm-title">Nuevo Stream</h2>

      <div class="csm-section">Información</div>
      <div class="csm-field">
        <label>Título <span class="csm-req">*</span></label>
        <input id="csmTitulo" type="text" placeholder="Ej: Noche de Terror Especial" maxlength="80">
      </div>
      <div class="csm-field">
        <label>Descripción</label>
        <textarea id="csmDesc" rows="2" placeholder="Describe el stream..." maxlength="300"></textarea>
      </div>
      <div class="csm-row2">
        <div class="csm-field">
          <label>Poster (URL) <span class="csm-req">*</span></label>
          <input id="csmPoster" type="url" placeholder="https://...">
        </div>
        <div class="csm-field">
          <label>Banner (URL)</label>
          <input id="csmBanner" type="url" placeholder="https://...">
        </div>
      </div>
      <div class="csm-row2">
        <div class="csm-field">
          <label>Edad mínima</label>
          <select id="csmEdad">
            <option value="0">Sin restricción</option>
            <option value="7">+7</option>
            <option value="12">+12</option>
            <option value="16">+16</option>
            <option value="18">+18</option>
          </select>
        </div>
        <div class="csm-field">
          <label>Programar para</label>
          <input id="csmSchedule" type="datetime-local">
        </div>
      </div>

      <div class="csm-section">Tipo de stream</div>
      <div class="csm-type-grid">
        <label class="csm-type-card csm-type-active" id="csmTypeYT">
          <input type="radio" name="csmType" value="youtube" checked onchange="csmSwitchType(this.value)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M21.582 7.186a2.506 2.506 0 0 0-1.762-1.773C18.265 5 12 5 12 5s-6.265 0-7.82.413A2.506 2.506 0 0 0 2.418 7.186C2 8.748 2 12 2 12s0 3.252.418 4.814a2.506 2.506 0 0 0 1.762 1.773C5.735 19 12 19 12 19s6.265 0 7.82-.413a2.506 2.506 0 0 0 1.762-1.773C22 15.252 22 12 22 12s0-3.252-.418-4.814zM10 15V9l5.2 3-5.2 3z"/></svg>
          <span>YouTube</span>
        </label>
        <label class="csm-type-card" id="csmTypeScreen">
          <input type="radio" name="csmType" value="screen" onchange="csmSwitchType(this.value)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6zm8 9l-4-4h3V8h2v3h3l-4 4z"/></svg>
          <span>Pantalla</span>
          <small>Captura directa</small>
        </label>
        <label class="csm-type-card" id="csmTypeOBS">
          <input type="radio" name="csmType" value="obs" onchange="csmSwitchType(this.value)">
          <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 3a7 7 0 1 1 0 14A7 7 0 0 1 12 5zm0 2a5 5 0 1 0 0 10A5 5 0 0 0 12 7z"/></svg>
          <span>OBS Studio</span>
          <small>WHIP/WebRTC</small>
        </label>
      </div>

      <!-- YouTube URL -->
      <div id="csmYTSection" class="csm-type-section">
        <div class="csm-field">
          <label>URL de YouTube Live <span class="csm-req">*</span></label>
          <input id="csmYTUrl" type="url" placeholder="https://www.youtube.com/watch?v=...">
          <small>Pega el enlace del directo de YouTube</small>
        </div>
      </div>

      <!-- Screen share info -->
      <div id="csmScreenSection" class="csm-type-section" style="display:none">
        <div class="csm-info-box">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          <p>Al crear el stream, se te pedirá que <strong>selecciones qué compartir</strong> (ventana, aplicación o pantalla completa). Compatible con móvil y tablet.</p>
        </div>
      </div>

      <!-- OBS info -->
      <div id="csmOBSSection" class="csm-type-section" style="display:none">
        <div class="csm-info-box">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          <p>Necesitas <strong>OBS Studio 30+</strong>. Al crear el stream se generará un <strong>WHIP endpoint</strong> que debes pegar en OBS → Settings → Stream → Service: WHIP.</p>
        </div>
      </div>

      <!-- Trailer (for scheduled) -->
      <div id="csmTrailerSection" class="csm-field" style="margin-top:12px">
        <label>Tráiler (solo si está programado)</label>
        <input id="csmTrailer" type="url" placeholder="https://... (mp4 o YouTube)">
      </div>

      <button class="csm-create-btn" onclick="doCreateStream()">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        Crear stream
      </button>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('csm-visible'));
};

window.closeCreateStreamModal = () => {
  const m = document.getElementById('createStreamModal');
  if (m) { m.classList.remove('csm-visible'); setTimeout(() => m.remove(), 280); }
};

window.csmSwitchType = (tipo) => {
  ['YT','Screen','OBS'].forEach(t => {
    const sec = document.getElementById(`csm${t}Section`);
    const card = document.getElementById(`csmType${t}`);
    if (sec) sec.style.display = 'none';
    if (card) card.classList.remove('csm-type-active');
  });
  const map = { youtube:'YT', screen:'Screen', obs:'OBS' };
  const k = map[tipo];
  if (k) {
    document.getElementById(`csm${k}Section`).style.display = 'block';
    document.getElementById(`csmType${k}`)?.classList.add('csm-type-active');
  }
};

window.doCreateStream = async () => {
  const titulo    = document.getElementById('csmTitulo')?.value.trim();
  const descripcion = document.getElementById('csmDesc')?.value.trim() || '';
  const poster    = document.getElementById('csmPoster')?.value.trim();
  const banner    = document.getElementById('csmBanner')?.value.trim() || null;
  const trailer   = document.getElementById('csmTrailer')?.value.trim() || null;
  const edadMinima = parseInt(document.getElementById('csmEdad')?.value || '0');
  const tipo      = document.querySelector('input[name="csmType"]:checked')?.value || 'youtube';
  const ytUrl     = document.getElementById('csmYTUrl')?.value.trim() || null;
  const schedVal  = document.getElementById('csmSchedule')?.value;
  const scheduledAt = schedVal ? new Date(schedVal).getTime() : null;

  if (!titulo) { window.showToast?.('El título es obligatorio', 'error'); return; }
  if (!poster) { window.showToast?.('El poster es obligatorio', 'error'); return; }
  if (tipo === 'youtube' && !ytUrl) { window.showToast?.('Añade la URL de YouTube', 'error'); return; }

  const btn = document.querySelector('.csm-create-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }

  try {
    const streamId = await createStream({
      titulo, descripcion, poster, banner, trailer,
      edadMinima, tipo, youtubeUrl: ytUrl,
      scheduled: !!scheduledAt, scheduledAt
    });

    closeCreateStreamModal();

    if (tipo === 'screen' && !scheduledAt) {
      window.showToast?.('Stream creado. Selecciona qué compartir...', 'success');
      setTimeout(() => openStreamPlayer(streamId, true), 500);
    } else if (tipo === 'obs' && !scheduledAt) {
      _showOBSEndpoint(streamId);
    } else if (!scheduledAt) {
      window.showToast?.('Stream en vivo', 'success');
      openStreamPlayer(streamId, true);
    } else {
      window.showToast?.(`Stream programado para ${new Date(scheduledAt).toLocaleString('es-ES')}`, 'success');
    }
  } catch(e) {
    window.showToast?.('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Crear stream'; }
  }
};

function _showOBSEndpoint(streamId) {
  const endpoint = `${location.origin}/obs-whip/${streamId}`;
  const modal = document.createElement('div');
  modal.className = 'obs-modal-wrap';
  modal.innerHTML = `
    <div class="obs-backdrop" onclick="this.parentElement.remove()"></div>
    <div class="obs-card">
      <h3>Conecta OBS Studio</h3>
      <p>Copia este WHIP endpoint en OBS:</p>
      <p style="font-weight:700;margin:4px 0 2px">Settings → Stream → Service: WHIP</p>
      <div class="obs-endpoint">
        <code id="obsEndpointCode">${endpoint}</code>
        <button onclick="navigator.clipboard.writeText('${endpoint}');window.showToast?.('Copiado ✓','success')">
          Copiar
        </button>
      </div>
      <p style="font-size:.8rem;opacity:.6;margin-top:8px">OBS Studio 30+ requerido. Usa Bearer token: stream_${streamId}</p>
      <button class="csm-create-btn" style="margin-top:16px" onclick="this.closest('.obs-modal-wrap').remove();openStreamPlayer('${streamId}',true)">
        Ya estoy emitiendo desde OBS
      </button>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.querySelector('.obs-card').style.opacity = '1');
}

// ─── START / END stream ────────────────────────────────────────────────────────
window.startStreamNow = async (streamId) => {
  try {
    await startScheduledStream(streamId);
    window.showToast?.('Stream iniciado', 'success');
    openStreamPlayer(streamId, true);
  } catch(e) { window.showToast?.('Error: ' + e.message, 'error'); }
};

window.endStreamNow = async (streamId) => {
  if (!confirm('¿Seguro que quieres terminar el stream?')) return;
  await endStream(streamId);
  const modal = document.getElementById('streamPlayerModal');
  if (modal) { modal.classList.remove('spm-visible'); setTimeout(() => modal.remove(), 300); }
  window.showToast?.('Stream terminado', 'success');
};

// ─── STREAM PLAYER MODAL ──────────────────────────────────────────────────────
window.openStreamPlayer = async (streamId, isOwner = false) => {
  const snap = await (async () => {
    const { get: fbGet, ref: fbRef } = await import('./firebase.js');
    const { db } = await import('./firebase.js');
    return fbGet(fbRef(db, `streams/${streamId}`));
  })();

  const streamData = snap.exists() ? { id: streamId, ...snap.val() } : null;
  if (!streamData) { window.showToast?.('Stream no encontrado', 'error'); return; }

  _activeStreamId = streamId;
  document.getElementById('streamPlayerModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'streamPlayerModal';
  modal.className = 'spm-wrap';

  const isScreen = streamData.tipo === 'screen';
  const isOBS    = streamData.tipo === 'obs';
  const isYT     = streamData.tipo === 'youtube';

  modal.innerHTML = `
    <div class="spm-backdrop"></div>
    <div class="spm-box">
      <!-- Header -->
      <div class="spm-header">
        <div class="spm-header-left">
          <span class="live-dot"></span>
          <span class="spm-title">${_esc(streamData.titulo)}</span>
          <span class="spm-viewers" id="spmViewers">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
            ${streamData.viewerCount || 0}
          </span>
        </div>
        <div class="spm-header-right">
          ${isOwner && streamData.status === 'live' ? `
          <button class="stream-end-btn-top" onclick="endStreamNow('${streamId}')">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 6h12v12H6z"/></svg>
            Terminar
          </button>` : ''}
          <button class="spm-close-btn" onclick="closeStreamPlayer()">✕</button>
        </div>
      </div>

      <!-- Body: video + chat -->
      <div class="spm-body">
        <!-- Video area -->
        <div class="spm-video-area">
          ${isYT ? _buildYTEmbed(streamData.youtubeUrl) : `
          <video id="spmVideo" autoplay playsinline controls
            style="width:100%;height:100%;object-fit:contain;background:#000">
          </video>
          ${isOwner && isScreen ? `
          <div class="spm-screen-controls">
            <button class="spm-ctrl-btn" id="spmShareBtn" onclick="startShareStream('${streamId}')">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6zm8 9l-4-4h3V8h2v3h3l-4 4z"/></svg>
              Compartir pantalla
            </button>
          </div>` : ''}
          `}
          ${streamData.descripcion ? `<div class="spm-desc">${_esc(streamData.descripcion)}</div>` : ''}
        </div>

        <!-- Chat -->
        <div class="spm-chat">
          <div class="spm-chat-header">Chat en vivo</div>
          <div class="spm-chat-msgs" id="spmChatMsgs"></div>
          <div class="spm-chat-input">
            <input id="spmChatInput" type="text" placeholder="Mensaje..." maxlength="200"
              onkeydown="if(event.key==='Enter')sendStreamMsg()">
            <button onclick="sendStreamMsg()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('spm-visible'));

  // Chat listener
  _chatUnsub = listenStreamChat(streamId, msgs => _renderStreamChat(msgs));

  // Viewer count
  if (!isOwner) incrementViewers(streamId);

  // Screen share viewer
  if (isScreen && !isOwner) {
    const vid = document.getElementById('spmVideo');
    if (vid) {
      watchScreenShare(streamId, vid).then(pid => { _screenPeerId = pid; }).catch(e => {
        window.showToast?.('Error al conectar: ' + e.message, 'error');
      });
    }
  }
};

function _buildYTEmbed(url) {
  if (!url) return '<div class="spm-no-video">Sin URL de YouTube</div>';
  // Extract video ID
  let vid = '';
  try {
    const u = new URL(url);
    vid = u.searchParams.get('v') || u.pathname.split('/').pop();
  } catch { vid = url.split('v=')[1]?.split('&')[0] || ''; }
  if (!vid) return `<div class="spm-no-video">URL inválida</div>`;
  return `<iframe
    src="https://www.youtube.com/embed/${vid}?autoplay=1&rel=0"
    allow="autoplay; fullscreen" allowfullscreen
    style="width:100%;height:100%;border:none;min-height:320px">
  </iframe>`;
}

window.startShareStream = async (streamId) => {
  const btn = document.getElementById('spmShareBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Compartiendo...'; }
  try {
    const stream = await startScreenShare(streamId);
    const vid = document.getElementById('spmVideo');
    if (vid) { vid.srcObject = stream; vid.muted = true; vid.play().catch(() => {}); }
    if (btn) btn.style.display = 'none';
    window.showToast?.('Pantalla compartida', 'success');
  } catch(e) {
    window.showToast?.('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Compartir pantalla'; }
  }
};

window.closeStreamPlayer = () => {
  const modal = document.getElementById('streamPlayerModal');
  if (modal) { modal.classList.remove('spm-visible'); setTimeout(() => modal.remove(), 300); }
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
  if (_activeStreamId) { decrementViewers(_activeStreamId); _activeStreamId = null; }
};

function _renderStreamChat(msgs) {
  const list = document.getElementById('spmChatMsgs');
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop <= list.clientHeight + 60;
  list.innerHTML = msgs.map(m => `
    <div class="spm-msg">
      <span class="spm-msg-name">${_esc(m.name)}</span>
      <span class="spm-msg-text">${_esc(m.text)}</span>
    </div>`).join('');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

window.sendStreamMsg = async () => {
  const input = document.getElementById('spmChatInput');
  const text = input?.value.trim();
  if (!text || !_activeStreamId) return;
  input.value = '';
  try { await sendStreamChat(_activeStreamId, text); }
  catch(e) { window.showToast?.('Error al enviar mensaje', 'error'); }
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function _esc(t) {
  return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
export function injectStreamStyles() {
  if (document.getElementById('streams-css')) return;
  const s = document.createElement('style');
  s.id = 'streams-css';
  s.textContent = `
  /* ── Page ── */
  .streams-page{padding:0 0 80px}
  .streams-header{padding:28px 40px 20px}
  .streams-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .streams-sub{color:rgba(232,234,240,.5);font-size:.88rem;padding:0 40px}
  .live-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ff3b3b;
    margin-right:10px;animation:livePulse 1.4s infinite;box-shadow:0 0 0 0 rgba(255,59,59,.5)}
  @keyframes livePulse{0%{box-shadow:0 0 0 0 rgba(255,59,59,.5)}70%{box-shadow:0 0 0 8px rgba(255,59,59,0)}100%{box-shadow:0 0 0 0 rgba(255,59,59,0)}}
  .stream-create-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;background:#1a7fff;
    border:none;border-radius:10px;color:#fff;font-size:.85rem;font-weight:700;cursor:pointer;transition:background .2s}
  .stream-create-btn:hover{background:#1260cc}
  .streams-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;padding:0 40px}
  .streams-empty{grid-column:1/-1;text-align:center;color:rgba(232,234,240,.4);padding:60px 0;font-size:.9rem}
  .streams-loading{grid-column:1/-1;text-align:center;color:rgba(232,234,240,.4);padding:60px 0;font-size:.85rem}

  /* ── Stream card ── */
  .stream-card{background:rgba(0,18,48,.7);border:1px solid rgba(26,127,255,.15);border-radius:14px;
    overflow:hidden;cursor:pointer;transition:transform .2s,border-color .2s;display:flex;flex-direction:column}
  .stream-card:hover{transform:translateY(-3px);border-color:rgba(26,127,255,.4)}
  .stream-card-live{border-color:rgba(255,59,59,.3)}
  .stream-card-live:hover{border-color:rgba(255,59,59,.6)}
  .stream-card-thumb{position:relative;height:160px;background:linear-gradient(135deg,#000d1f,#001a3a);
    display:flex;align-items:center;justify-content:center;overflow:hidden}
  .stream-card-thumb{background-size:cover;background-position:center}
  .stream-card-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.4}
  .stream-live-badge{position:absolute;top:10px;left:10px;background:#ff3b3b;color:#fff;
    font-size:.65rem;font-weight:800;padding:3px 9px;border-radius:20px;letter-spacing:.5px;text-transform:uppercase}
  .stream-sched-badge{position:absolute;top:10px;left:10px;background:rgba(26,127,255,.85);color:#fff;
    font-size:.65rem;font-weight:700;padding:3px 9px;border-radius:20px}
  .stream-age-badge{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.75);color:#fff;
    font-size:.65rem;font-weight:700;padding:3px 8px;border-radius:6px}
  .stream-card-viewers{position:absolute;bottom:8px;right:10px;display:flex;align-items:center;gap:4px;
    color:rgba(232,234,240,.7);font-size:.75rem;background:rgba(0,0,0,.6);padding:2px 7px;border-radius:10px}
  .stream-card-info{padding:14px 16px}
  .stream-card-type-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
  .stream-type-pill{font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:10px;
    background:rgba(26,127,255,.15);color:#7ab9ff;text-transform:uppercase}
  .stream-type-pill.youtube{background:rgba(255,0,0,.15);color:#ff6b6b}
  .stream-card-owner{font-size:.75rem;color:rgba(232,234,240,.4)}
  .stream-card-title{font-size:.95rem;font-weight:700;color:#e8eaf0;margin-bottom:4px}
  .stream-card-desc{font-size:.78rem;color:rgba(232,234,240,.5);line-height:1.4}
  .stream-start-btn,.stream-end-btn{margin-top:10px;padding:6px 14px;border-radius:8px;border:none;
    font-size:.8rem;font-weight:700;cursor:pointer}
  .stream-start-btn{background:#1a7fff;color:#fff}
  .stream-end-btn{background:rgba(255,59,59,.15);color:#ff6b6b;border:1px solid rgba(255,59,59,.3)}

  /* ── Create modal ── */
  .csm-wrap{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;
    opacity:0;pointer-events:none;transition:opacity .28s}
  .csm-wrap.csm-visible{opacity:1;pointer-events:all}
  .csm-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(6px)}
  .csm-card{position:relative;z-index:1;background:#000d1f;border:1px solid rgba(26,127,255,.2);
    border-radius:16px;width:min(600px,96vw);max-height:90vh;overflow-y:auto;padding:32px;
    box-shadow:0 28px 90px rgba(0,0,0,.7);transform:translateY(16px);transition:transform .28s}
  .csm-wrap.csm-visible .csm-card{transform:translateY(0)}
  .csm-close{position:absolute;top:16px;right:16px;background:rgba(255,255,255,.08);border:none;
    color:#e8eaf0;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:.85rem;
    display:flex;align-items:center;justify-content:center}
  .csm-title{font-size:1.3rem;font-weight:700;margin-bottom:20px;color:#e8eaf0}
  .csm-section{font-size:.72rem;font-weight:700;letter-spacing:1px;color:rgba(232,234,240,.4);
    text-transform:uppercase;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.06)}
  .csm-field{margin-bottom:14px}
  .csm-field label{display:block;font-size:.82rem;color:rgba(232,234,240,.7);margin-bottom:5px;font-weight:600}
  .csm-field input,.csm-field textarea,.csm-field select{width:100%;background:rgba(255,255,255,.06);
    border:1px solid rgba(26,127,255,.2);border-radius:8px;padding:9px 12px;color:#e8eaf0;
    font-size:.88rem;outline:none;transition:border .2s;font-family:inherit}
  .csm-field input:focus,.csm-field textarea:focus,.csm-field select:focus{border-color:rgba(26,127,255,.5)}
  .csm-field textarea{resize:vertical;min-height:60px}
  .csm-field small{font-size:.75rem;color:rgba(232,234,240,.35);margin-top:4px;display:block}
  .csm-field select option{background:#001030}
  .csm-req{color:#ff6b6b}
  .csm-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .csm-type-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .csm-type-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 10px;
    background:rgba(255,255,255,.04);border:2px solid rgba(255,255,255,.08);border-radius:10px;
    cursor:pointer;transition:border .2s,background .2s;text-align:center}
  .csm-type-card input{display:none}
  .csm-type-card span{font-size:.8rem;font-weight:600;color:rgba(232,234,240,.7)}
  .csm-type-card small{font-size:.68rem;color:rgba(232,234,240,.35)}
  .csm-type-card:hover{border-color:rgba(26,127,255,.4)}
  .csm-type-active{border-color:#1a7fff !important;background:rgba(26,127,255,.1) !important}
  .csm-type-active span{color:#7ab9ff}
  .csm-info-box{display:flex;gap:12px;background:rgba(26,127,255,.07);border:1px solid rgba(26,127,255,.2);
    border-radius:10px;padding:14px;font-size:.82rem;color:rgba(232,234,240,.65);line-height:1.55}
  .csm-create-btn{width:100%;padding:13px;background:#1a7fff;border:none;border-radius:10px;
    color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;
    justify-content:center;gap:8px;margin-top:18px;transition:background .2s}
  .csm-create-btn:hover{background:#1260cc}
  .csm-create-btn:disabled{opacity:.5;cursor:not-allowed}

  /* ── OBS modal ── */
  .obs-modal-wrap{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center}
  .obs-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.8)}
  .obs-card{position:relative;z-index:1;background:#000d1f;border:1px solid rgba(26,127,255,.2);
    border-radius:14px;padding:28px;width:min(500px,94vw);opacity:0;transition:opacity .3s}
  .obs-card h3{font-size:1.1rem;font-weight:700;margin-bottom:10px}
  .obs-card p{font-size:.85rem;color:rgba(232,234,240,.6);margin-bottom:6px}
  .obs-endpoint{display:flex;gap:8px;background:rgba(0,0,0,.4);border:1px solid rgba(26,127,255,.2);
    border-radius:8px;padding:10px 12px;margin:10px 0}
  .obs-endpoint code{flex:1;font-size:.78rem;word-break:break-all;color:#7ab9ff}
  .obs-endpoint button{background:#1a7fff;border:none;color:#fff;border-radius:6px;
    padding:4px 10px;cursor:pointer;font-size:.78rem;font-weight:700;white-space:nowrap}

  /* ── Stream player modal ── */
  .spm-wrap{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
    opacity:0;pointer-events:none;transition:opacity .28s;padding:16px}
  .spm-wrap.spm-visible{opacity:1;pointer-events:all}
  .spm-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.9);backdrop-filter:blur(6px)}
  .spm-box{position:relative;z-index:1;background:#000a1a;border:1px solid rgba(26,127,255,.2);
    border-radius:16px;width:100%;max-width:1100px;max-height:92vh;display:flex;flex-direction:column;
    overflow:hidden;box-shadow:0 28px 90px rgba(0,0,0,.8)}
  .spm-header{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;
    border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-header-left{display:flex;align-items:center;gap:10px}
  .spm-title{font-size:.95rem;font-weight:700;color:#e8eaf0}
  .spm-viewers{display:flex;align-items:center;gap:4px;color:rgba(232,234,240,.4);font-size:.75rem}
  .spm-header-right{display:flex;align-items:center;gap:8px}
  .stream-end-btn-top{padding:5px 12px;background:rgba(255,59,59,.15);border:1px solid rgba(255,59,59,.3);
    border-radius:8px;color:#ff6b6b;font-size:.78rem;font-weight:700;cursor:pointer}
  .spm-close-btn{background:rgba(255,255,255,.08);border:none;color:#e8eaf0;width:28px;height:28px;
    border-radius:50%;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center}
  .spm-body{display:flex;flex:1;overflow:hidden;min-height:0}
  .spm-video-area{flex:1;display:flex;flex-direction:column;background:#000;position:relative;min-height:320px}
  .spm-video-area video,.spm-video-area iframe{flex:1;min-height:0}
  .spm-desc{padding:8px 14px;font-size:.78rem;color:rgba(232,234,240,.4);border-top:1px solid rgba(255,255,255,.05)}
  .spm-no-video{display:flex;align-items:center;justify-content:center;flex:1;color:rgba(232,234,240,.3);font-size:.88rem}
  .spm-screen-controls{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.6)}
  .spm-ctrl-btn{padding:12px 22px;background:#1a7fff;border:none;border-radius:10px;
    color:#fff;font-size:.9rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:8px}
  .spm-chat{width:280px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid rgba(255,255,255,.06)}
  .spm-chat-header{padding:10px 14px;font-size:.8rem;font-weight:700;color:rgba(232,234,240,.5);
    border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-chat-msgs{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px}
  .spm-chat-msgs::-webkit-scrollbar{width:3px}
  .spm-chat-msgs::-webkit-scrollbar-thumb{background:rgba(26,127,255,.3)}
  .spm-msg{font-size:.8rem;line-height:1.4}
  .spm-msg-name{font-weight:700;color:#7ab9ff;margin-right:4px}
  .spm-msg-text{color:rgba(232,234,240,.8)}
  .spm-chat-input{display:flex;gap:6px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .spm-chat-input input{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(26,127,255,.2);
    border-radius:8px;padding:7px 10px;color:#e8eaf0;font-size:.82rem;outline:none}
  .spm-chat-input button{background:#1a7fff;border:none;border-radius:8px;padding:7px 10px;
    cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center}

  @media(max-width:700px){
    .spm-chat{display:none}
    .csm-row2{grid-template-columns:1fr}
    .csm-type-grid{grid-template-columns:1fr 1fr}
    .streams-grid{padding:0 16px}
    .streams-header{padding:20px 16px 12px}
    .streams-sub{padding:0 16px}
  }`;
  document.head.appendChild(s);
}
