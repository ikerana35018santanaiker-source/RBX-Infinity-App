// js/interactive-player.js — XCine Interactive Video Engine
// Bandersnatch-style branching video player.
// Reuses Video.js the same way player.js does, but adds:
//   - choice buttons that fade in near the end of a video node
//   - 15s auto-pick (first button) if the user doesn't choose
//   - "muerte" nodes: rewind to the last node before this one
//   - "final" nodes: end the interactive, offer "watch again" / "exit"

import { db, ref as fbRef, get as fbGet, set as fbSet } from './firebase.js';

let vjsPlayer = null;
let _state = {
  interactivo: null,     // full interactivo object from interactivos.json
  currentVideo: null,     // current video node
  history: [],            // stack of video ids visited, for "muerte" rewind
  buttonsShown: false,
  choiceTimer: null,
  countdownInterval: null,
  onExit: null,
  onProgress: null,
  userId: null,
};

const BUTTONS_LEAD_TIME = 8;   // seconds before video end when buttons start fading in
const CHOICE_TIMEOUT_MS = 15000; // 15s auto-pick window

// ─── OPEN INTERACTIVE PLAYER ──────────────────────────────────────────────────
export function openInteractivePlayer(interactivo, opts = {}) {
  closeInteractivePlayer();
  _state.interactivo = interactivo;
  _state.history = [];
  _state.onExit = opts.onExit || null;
  _state.onProgress = opts.onProgress || null;
  _state.userId = opts.userId || null;

  const container = document.getElementById('videoPlayer');
  container.innerHTML = buildShellHTML(interactivo);
  container.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const startVideoId = opts.resumeVideoId || interactivo.videoInicial;
  playVideoNode(startVideoId, /*pushHistory*/ true);
}

function buildShellHTML(interactivo) {
  return `
  <div class="ip-wrap" id="ipWrap">
    <div class="ip-player-area" id="ipPlayerArea">
      <video id="ipVideo" class="video-js vjs-xcine-skin vjs-big-play-centered" playsinline preload="metadata"></video>

      <!-- Subtitle display -->
      <div class="ip-subtitle-display" id="ipSubtitleDisplay"></div>

      <!-- Top bar -->
      <div class="ip-top-bar">
        <button class="ip-back-btn" onclick="exitInteractive()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        </button>
        <div class="ip-title-area">
          <span class="ip-main-title">${escapeHtml(interactivo.titulo)}</span>
          <span class="ip-node-title" id="ipNodeTitle"></span>
        </div>
        <div class="ip-top-actions">
          <button class="ip-ctrl-btn" id="ipSubBtn" onclick="toggleIpSubMenu()" title="Subtítulos" style="display:none">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>
            CC
          </button>
          <button class="ip-ctrl-btn" id="ipAudioBtn" onclick="toggleIpAudioMenu()" title="Audio" style="display:none">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            AU
          </button>
        </div>
      </div>

      <!-- Subtitle menu -->
      <div class="ip-sub-menu" id="ipSubMenu" style="display:none">
        <div class="ip-menu-header">Subtítulos</div>
        <div id="ipSubList"><div class="ip-menu-item active" onclick="selectIpSubtitle(null,this)">Desactivados</div></div>
      </div>

      <!-- Audio menu -->
      <div class="ip-sub-menu" id="ipAudioMenu" style="display:none;right:100px">
        <div class="ip-menu-header">Pista de audio</div>
        <div id="ipAudioList"><div class="ip-menu-item active" onclick="selectIpAudioTrack(null,this)">Original</div></div>
      </div>

      <!-- Choice buttons overlay -->
      <div class="ip-choices" id="ipChoices" style="display:none">
        <div class="ip-choices-inner" id="ipChoicesInner"></div>
        <div class="ip-choice-timer" id="ipChoiceTimer" style="display:none">
          <svg viewBox="0 0 36 36" width="34" height="34">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"></circle>
            <circle id="ipTimerRing" cx="18" cy="18" r="15.5" fill="none" stroke="#1a7fff" stroke-width="3"
              stroke-dasharray="97.4" stroke-dashoffset="0" transform="rotate(-90 18 18)"></circle>
          </svg>
        </div>
      </div>

      <!-- Death overlay -->
      <div class="ip-death-overlay" id="ipDeathOverlay" style="display:none">
        <div class="ip-death-inner">
          <div class="ip-death-icon">✕</div>
          <h2>Has muerto</h2>
          <p>Tu decisión llevó a este final. Volviendo al punto anterior...</p>
        </div>
      </div>

      <!-- Final overlay -->
      <div class="ip-final-overlay" id="ipFinalOverlay" style="display:none">
        <div class="ip-final-inner">
          <div class="ip-final-icon">🎬</div>
          <h2 id="ipFinalTitle">Fin de la historia</h2>
          <p>Has llegado a uno de los finales de esta historia interactiva.</p>
          <div class="ip-final-actions">
            <button class="ip-btn-primary" onclick="restartInteractive()">↺ Repetir desde el inicio</button>
            <button class="ip-btn-ghost" onclick="exitInteractive()">Salir</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ─── PLAY A VIDEO NODE ────────────────────────────────────────────────────────
function playVideoNode(videoId, pushHistory = true) {
  const video = (_state.interactivo.videos || []).find(v => v.id === videoId);
  if (!video) { showIpToast('Vídeo no encontrado en el interactivo', 'error'); return; }

  if (pushHistory) _state.history.push(videoId);
  _state.currentVideo = video;
  _state.buttonsShown = false;
  _state._lastProgressSave = 0;
  clearTimeout(_state.choiceTimer);
  clearInterval(_state.countdownInterval);

  hideChoices();
  hideDeath();
  hideFinal();

  const nodeTitleEl = document.getElementById('ipNodeTitle');
  if (nodeTitleEl) nodeTitleEl.textContent = video.titulo || '';

  buildSubAndAudioMenus(video);
  initIpVideoJS(video.url);
}

function initIpVideoJS(src) {
  if (typeof videojs === 'undefined') {
    Promise.all([
      loadScript('https://vjs.zencdn.net/8.10.0/video.min.js'),
      loadStyle('https://vjs.zencdn.net/8.10.0/video-js.min.css')
    ]).then(() => _setupIpVJS(src));
  } else {
    _setupIpVJS(src);
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
function loadStyle(href) {
  return new Promise((res) => {
    if (document.querySelector(`link[href="${href}"]`)) { res(); return; }
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
    l.onload = res;
    document.head.appendChild(l);
  });
}

function _setupIpVJS(src) {
  // Dispose any previous instance before creating a new one
  if (vjsPlayer) { try { vjsPlayer.dispose(); } catch {} vjsPlayer = null; }

  const el = document.getElementById('ipVideo');
  if (!el) return;

  vjsPlayer = videojs('ipVideo', {
    autoplay: true,
    controls: true,
    fluid: false,
    fill: true,
    sources: [{ src, type: guessType(src) }],
    userActions: { hotkeys: true },
    controlBar: {
      children: ['playToggle', 'volumePanel', 'currentTimeDisplay', 'timeDivider', 'durationDisplay', 'progressControl', 'fullscreenToggle']
    }
  });

  vjsPlayer.ready(() => {
    vjsPlayer.play().catch(() => {});
    vjsPlayer.on('timeupdate', onIpTimeUpdate);
    vjsPlayer.on('ended', onIpVideoEnded);
    vjsPlayer.on('error', () => showIpToast('Error al cargar el vídeo', 'error'));
  });
}

function guessType(src) {
  if (src.includes('.m3u8')) return 'application/x-mpegURL';
  if (src.includes('.webm')) return 'video/webm';
  return 'video/mp4';
}

// ─── TIME UPDATE: trigger button fade-in near the end ─────────────────────────
function onIpTimeUpdate() {
  if (!vjsPlayer || !_state.currentVideo) return;
  const ct = vjsPlayer.currentTime();
  const dur = vjsPlayer.duration() || 0;
  if (!dur) return;

  const video = _state.currentVideo;
  const hasChoices = Array.isArray(video.botones) && video.botones.length > 0;

  // Save progress for "continue watching" style tracking (interactive progress).
  // Throttled to every 3s — timeupdate fires several times per second, and
  // without this every tick was writing straight to Firebase.
  if (_state.onProgress && _state.userId) {
    if (!_state._lastProgressSave || ct - _state._lastProgressSave >= 3) {
      _state._lastProgressSave = ct;
      _state.onProgress(_state.interactivo.id, video.id, ct);
    }
  }

  // Subtitle rendering
  updateIpSubtitleDisplay(ct);

  if (!hasChoices) return; // muerte/final nodes have no buttons

  const remaining = dur - ct;
  if (!_state.buttonsShown && remaining <= BUTTONS_LEAD_TIME) {
    _state.buttonsShown = true;
    showChoices(video.botones);
  }
}

function onIpVideoEnded() {
  const video = _state.currentVideo;
  if (!video) return;

  // No choices and video finished → resolve ending state
  if (!video.botones || video.botones.length === 0) {
    if (video.muerte) { triggerDeath(); return; }
    if (video.final) { triggerFinal(); return; }
    // Linear video with no defined next step and not flagged — just stop.
    return;
  }
  // If it had choices but the user never clicked and we somehow reached
  // "ended" without the 15s timeout firing yet, force the auto-pick now.
  if (_state.buttonsShown) autoPickFirstChoice();
}

// ─── CHOICE BUTTONS ───────────────────────────────────────────────────────────
function showChoices(botones) {
  const wrap = document.getElementById('ipChoices');
  const inner = document.getElementById('ipChoicesInner');
  const timerWrap = document.getElementById('ipChoiceTimer');
  if (!wrap || !inner) return;

  inner.innerHTML = botones.map((b, i) => `
    <button class="ip-choice-btn" style="animation-delay:${i * 90}ms" onclick="selectChoice('${b.id}')">
      ${escapeHtml(b.texto)}
    </button>`).join('');

  wrap.style.display = 'flex';
  requestAnimationFrame(() => wrap.classList.add('ip-choices-visible'));

  // Start the 15s countdown ring + auto-pick timer
  if (timerWrap) {
    timerWrap.style.display = 'flex';
    const ring = document.getElementById('ipTimerRing');
    const circumference = 97.4; // 2*PI*r with r=15.5
    let elapsed = 0;
    const step = 100;
    clearInterval(_state.countdownInterval);
    _state.countdownInterval = setInterval(() => {
      elapsed += step;
      const pct = Math.min(elapsed / CHOICE_TIMEOUT_MS, 1);
      if (ring) ring.style.strokeDashoffset = String(circumference * pct);
      if (pct >= 1) clearInterval(_state.countdownInterval);
    }, step);
  }

  clearTimeout(_state.choiceTimer);
  _state.choiceTimer = setTimeout(() => {
    if (_state.buttonsShown) autoPickFirstChoice();
  }, CHOICE_TIMEOUT_MS);
}

function hideChoices() {
  const wrap = document.getElementById('ipChoices');
  const timerWrap = document.getElementById('ipChoiceTimer');
  if (wrap) { wrap.classList.remove('ip-choices-visible'); wrap.style.display = 'none'; }
  if (timerWrap) timerWrap.style.display = 'none';
  clearTimeout(_state.choiceTimer);
  clearInterval(_state.countdownInterval);
}

function autoPickFirstChoice() {
  const video = _state.currentVideo;
  if (!video || !video.botones || !video.botones.length) return;
  selectChoiceInternal(video.botones[0].id, /*autoPicked*/ true);
}

window.selectChoice = (buttonId) => selectChoiceInternal(buttonId, false);

function selectChoiceInternal(buttonId, autoPicked) {
  const video = _state.currentVideo;
  if (!video) return;
  const boton = (video.botones || []).find(b => b.id === buttonId);
  if (!boton) return;

  clearTimeout(_state.choiceTimer);
  clearInterval(_state.countdownInterval);
  hideChoices();

  if (autoPicked) showIpToast('Tiempo agotado — se elige automáticamente', 'info');

  playVideoNode(boton.videoDestino, /*pushHistory*/ true);
}

// ─── MUERTE: rewind to previous node ───────────────────────────────────────────
function triggerDeath() {
  if (vjsPlayer) vjsPlayer.pause();
  const overlay = document.getElementById('ipDeathOverlay');
  if (overlay) overlay.style.display = 'flex';

  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    // Pop the current (death) node off the history, then pop again to get
    // the node BEFORE the one that led here, and replay it as a fresh node
    // (without re-pushing, since we're going back to it).
    _state.history.pop(); // remove the death node itself
    const previousNodeId = _state.history.pop(); // the node right before death
    if (previousNodeId) {
      playVideoNode(previousNodeId, /*pushHistory*/ true);
    } else {
      // No history at all (death was the very first node) → restart interactivo
      playVideoNode(_state.interactivo.videoInicial, true);
    }
  }, 2200);
}

// ─── FINAL: end of interactive ─────────────────────────────────────────────────
function triggerFinal() {
  if (vjsPlayer) vjsPlayer.pause();
  const overlay = document.getElementById('ipFinalOverlay');
  const titleEl = document.getElementById('ipFinalTitle');
  if (titleEl) titleEl.textContent = _state.currentVideo?.titulo ? `Final: ${_state.currentVideo.titulo}` : 'Fin de la historia';
  if (overlay) overlay.style.display = 'flex';
}

function hideDeath() { const el = document.getElementById('ipDeathOverlay'); if (el) el.style.display = 'none'; }
function hideFinal() { const el = document.getElementById('ipFinalOverlay'); if (el) el.style.display = 'none'; }

window.restartInteractive = () => {
  hideFinal();
  _state.history = [];
  playVideoNode(_state.interactivo.videoInicial, true);
};

window.exitInteractive = () => closeInteractivePlayer();

// ─── SUBTITLES & AUDIO TRACKS (per video node) ────────────────────────────────
let _ipSubtitleCues = [];

function buildSubAndAudioMenus(video) {
  const subBtn = document.getElementById('ipSubBtn');
  const audioBtn = document.getElementById('ipAudioBtn');
  const subList = document.getElementById('ipSubList');
  const audioList = document.getElementById('ipAudioList');

  _ipSubtitleCues = [];
  const display = document.getElementById('ipSubtitleDisplay');
  if (display) display.textContent = '';

  const subs = video.subtitulos || [];
  const tracks = video.audiotracks || [];

  if (subBtn) subBtn.style.display = subs.length ? 'flex' : 'none';
  if (audioBtn) audioBtn.style.display = tracks.length ? 'flex' : 'none';

  if (subList) {
    subList.innerHTML = `<div class="ip-menu-item active" onclick="selectIpSubtitle(null,this)">Desactivados</div>` +
      subs.map(s => `<div class="ip-menu-item" onclick='selectIpSubtitle(${JSON.stringify(JSON.stringify(s))},this)'>${escapeHtml(s.idioma)}</div>`).join('');
  }
  if (audioList) {
    audioList.innerHTML = `<div class="ip-menu-item active" onclick="selectIpAudioTrack(null,this)">Original</div>` +
      tracks.map(t => `<div class="ip-menu-item" onclick='selectIpAudioTrack(${JSON.stringify(JSON.stringify(t))},this)'>${escapeHtml(t.idioma)}</div>`).join('');
  }
}

window.toggleIpSubMenu = () => {
  const m = document.getElementById('ipSubMenu');
  const a = document.getElementById('ipAudioMenu');
  if (a) a.style.display = 'none';
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
};
window.toggleIpAudioMenu = () => {
  const m = document.getElementById('ipAudioMenu');
  const s = document.getElementById('ipSubMenu');
  if (s) s.style.display = 'none';
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
};

window.selectIpSubtitle = async (subJson, el) => {
  document.querySelectorAll('#ipSubList .ip-menu-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('ipSubMenu').style.display = 'none';
  const sub = subJson ? JSON.parse(subJson) : null;
  if (!sub) { _ipSubtitleCues = []; const d = document.getElementById('ipSubtitleDisplay'); if (d) d.textContent = ''; return; }
  try {
    const res = await fetch(sub.url);
    const text = await res.text();
    _ipSubtitleCues = parseVTT(text);
  } catch { showIpToast('No se pudo cargar el subtítulo', 'error'); _ipSubtitleCues = []; }
};

function updateIpSubtitleDisplay(ct) {
  if (!_ipSubtitleCues.length) return;
  const display = document.getElementById('ipSubtitleDisplay');
  if (!display) return;
  const cue = _ipSubtitleCues.find(c => ct >= c.start && ct <= c.end);
  display.innerHTML = cue ? cue.text.replace(/\n/g, '<br>') : '';
}

function parseVTT(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
    const parseTime = t => {
      const p = t.split(':');
      if (p.length === 3) return +p[0]*3600 + +p[1]*60 + parseFloat(p[2].replace(',','.'));
      return +p[0]*60 + parseFloat(p[1].replace(',','.'));
    };
    const textLines = lines.slice(lines.indexOf(timeLine) + 1).join('\n');
    if (textLines.trim()) cues.push({ start: parseTime(startStr), end: parseTime(endStr), text: textLines.trim() });
  }
  return cues;
}

// ─── ALTERNATE AUDIO TRACK (mp3 synced to the video) ──────────────────────────
let _ipAudioEl = null;

window.selectIpAudioTrack = (trackJson, el) => {
  document.querySelectorAll('#ipAudioList .ip-menu-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('ipAudioMenu').style.display = 'none';

  if (_ipAudioEl) { _ipAudioEl.pause(); _ipAudioEl.src = ''; _ipAudioEl = null; }
  if (vjsPlayer) vjsPlayer.muted(false);

  const track = trackJson ? JSON.parse(trackJson) : null;
  if (!track || !vjsPlayer) return;

  const nativeVid = vjsPlayer.el().querySelector('video');
  if (!nativeVid) return;

  vjsPlayer.muted(true);
  _ipAudioEl = new Audio(track.url);
  _ipAudioEl.currentTime = nativeVid.currentTime;
  if (!nativeVid.paused) _ipAudioEl.play().catch(() => {});

  nativeVid.addEventListener('play',  () => { if (_ipAudioEl) { _ipAudioEl.currentTime = nativeVid.currentTime; _ipAudioEl.play().catch(()=>{}); } });
  nativeVid.addEventListener('pause', () => _ipAudioEl?.pause());
  nativeVid.addEventListener('seeked', () => { if (_ipAudioEl) _ipAudioEl.currentTime = nativeVid.currentTime; });
};

// ─── CLOSE / EXIT ──────────────────────────────────────────────────────────────
export function closeInteractivePlayer() {
  clearTimeout(_state.choiceTimer);
  clearInterval(_state.countdownInterval);
  if (vjsPlayer) { try { vjsPlayer.dispose(); } catch {} vjsPlayer = null; }
  if (_ipAudioEl) { try { _ipAudioEl.pause(); } catch {} _ipAudioEl = null; }

  const container = document.getElementById('videoPlayer');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  document.body.style.overflow = '';

  const exitCb = _state.onExit;
  _state = { interactivo: null, currentVideo: null, history: [], buttonsShown: false, choiceTimer: null, countdownInterval: null, onExit: null, onProgress: null, userId: null };
  if (exitCb) exitCb();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function showIpToast(msg, type = 'info') {
  const wrap = document.getElementById('ipWrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `ip-toast ip-toast-${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.classList.add('ip-toast-visible'), 10);
  setTimeout(() => { t.classList.remove('ip-toast-visible'); setTimeout(() => t.remove(), 300); }, 3000);
}

function escapeHtml(t) {
  return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
