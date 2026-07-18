// js/player.js —  Enhanced Video.js Player
// Features: Video.js, skip intro, auto-next, quality selector, subtitles,
//           remaining time, watch party, ratings, reactions

// Firebase access for watch-party/reactions now goes entirely through
// lobby.js — this module no longer talks to Firebase directly.

// ─── STATE ────────────────────────────────────────────────────────────────────
let vjsPlayer = null;
let playerState = {
  contentId: null,
  serieId: null,
  seasonNum: null,
  epNum: null,
  title: '',
  isSerie: false,
  nextEp: null,
  startTime: 0,
  subtitles: [],       // [{label, src, srclang}]
  qualities: [],       // [{label, src}]
  introStart: null,    // seconds
  introEnd: null,
  currentQuality: 'auto',
  watchPartyId: null,
  autoNextCountdown: null,
  onNext: null,
  onClose: null,
  onProgress: null,
  partyMode: false,
  isPartyOwner: false,
  partyPin: null,
};

// ─── OPEN PLAYER ──────────────────────────────────────────────────────────────
export function openXPlayer(opts) {
  closeXPlayer();
  Object.assign(playerState, {
    contentId: opts.contentId || null,
    serieId: opts.serieId || opts.contentId,
    seasonNum: opts.seasonNum || null,
    epNum: opts.epNum || null,
    title: opts.title || '',
    isSerie: opts.isSerie || false,
    nextEp: opts.nextEp || null,
    startTime: opts.startTime || 0,
    subtitles: opts.subtitles || [],
    audioTracks: opts.audioTracks || [],
    qualities: opts.qualities || [],
    introStart: opts.introStart ?? null,
    introEnd: opts.introEnd ?? null,
    currentQuality: 'auto',
    watchPartyId: null,
    autoNextCountdown: null,
    onNext: opts.onNext || null,
    onClose: opts.onClose || null,
    onProgress: opts.onProgress || null,
    onReady: opts.onReady || null,
    partyMode: opts.partyMode || false,
    isPartyOwner: opts.isPartyOwner || false,
    partyPin: opts.partyPin || null,
  });

  const container = document.getElementById('videoPlayer');
  container.innerHTML = buildPlayerHTML(opts);
  container.classList.toggle('xp-party-active', !!opts.partyMode);
  container.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  _injectPlayerStyles(); // inject CSS once

  if (!opts.src) {
    document.getElementById('xPlayerNoVideo').style.display = 'flex';
    return;
  }
  initVideoJS(opts.src, opts.startTime || 0);
}

function buildPlayerHTML(opts) {
  const hasSubs = opts.subtitles && opts.subtitles.length > 0;
  const hasAudio  = opts.audioTracks && opts.audioTracks.length > 0;

  return `
  <div class="xplayer-wrap" id="xPlayerWrap">

    <div class="xp-no-video" id="xPlayerNoVideo" style="display:none">
      <div class="xp-no-video-inner">
        <div style="font-size:3rem">🎬</div>
        <h3>Vídeo no disponible todavía</h3>
        <p>Este contenido aún no tiene archivo de vídeo asociado.</p>
        <button class="xp-btn-ghost" onclick="closeXPlayer()">← Volver</button>
      </div>
    </div>

    <div class="xp-player-area" id="xpPlayerArea">
      <video id="xpVideo" class="video-js vjs-xcine-skin vjs-big-play-centered"
        playsinline preload="metadata"></video>

      ${opts.partyMode ? `<div class="lobby-click-overlay" id="lobbyClickOverlay" onclick="handlePartyAreaClick(event)"></div>
      <div class="lobby-reaction-overlay" id="lobbyReactionOverlay"></div>` : ''}

      <button class="xp-skip-intro" id="xpSkipIntro" style="display:none" onclick="skipIntro()">
        Saltar intro →
      </button>

      <div class="xp-auto-next" id="xpAutoNext" style="display:none">
        <div class="xp-auto-next-inner">
          ${opts.nextEp?.thumbnail ? `<img src="${opts.nextEp.thumbnail}" alt="">` : '<div class="xp-next-thumb-placeholder">▶</div>'}
          <div class="xp-auto-next-info">
            <span class="xp-auto-next-label">Siguiente episodio en</span>
            <span class="xp-auto-next-countdown" id="xpNextCount">5</span>
            <span class="xp-auto-next-title">${opts.nextEp?.title || ''}</span>
          </div>
          <div class="xp-auto-next-btns">
            <button class="xp-btn-primary" onclick="playNextNow()">▶ Reproducir ahora</button>
            <button class="xp-btn-ghost" onclick="cancelAutoNext()">Cancelar</button>
          </div>
        </div>
      </div>

      <!-- Subtitle pill — styled via CSS vars set by _applySubStyle() -->
      <div class="xp-subtitle-display" id="xpSubtitleDisplay"
        style="--sub-size:1.4rem;--sub-color:#fff;--sub-bg:rgba(0,0,0,.76);--sub-font:'Helvetica Neue';--sub-shadow:0 1px 6px rgba(0,0,0,1)">
      </div>

      <div class="xp-time-remaining" id="xpTimeRemaining" style="display:none"></div>

      <div class="xp-top-bar" id="xpTopBar">
        <button class="xp-back-btn" onclick="closeXPlayer()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        </button>
        <div class="xp-title-area">
          <span class="xp-main-title" id="xpMainTitle">${opts.title}</span>
          ${opts.isSerie && opts.seasonNum ? `<span class="xp-ep-label">T${opts.seasonNum} · E${opts.epNum}</span>` : ''}
        </div>
        <div class="xp-top-actions">

          <!-- Quality — always visible -->
          <button class="xp-ctrl-btn" id="xpQualityBtn" onclick="toggleQualityMenu()" title="Calidad de vídeo"
            ${opts.partyMode && !opts.isPartyOwner ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
            <span id="xpQualityLabel" class="xp-ctrl-lbl">HD</span>
          </button>

          <!-- CC — always visible; dim if no subs -->
          <button class="xp-ctrl-btn ${hasSubs ? '' : 'xp-ctrl-dim'}" id="xpSubBtn"
            onclick="toggleSubMenu()" title="${hasSubs ? 'Subtítulos' : 'Sin subtítulos'}"
            ${opts.partyMode && !opts.isPartyOwner ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>
            <span id="xpSubLabel" class="xp-ctrl-lbl" style="opacity:${hasSubs ? 1 : .4}">CC</span>
          </button>

          <!-- Sub style / customize -->
          <button class="xp-ctrl-btn ${hasSubs ? '' : 'xp-ctrl-dim'}" id="xpSubStyleBtn"
            onclick="toggleSubStylePanel()" title="Personalizar subtítulos"
            ${opts.partyMode && !opts.isPartyOwner ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
          </button>

          ${opts.partyMode ? `
          <span class="xp-party-badge" title="${opts.isPartyOwner ? 'Eres el anfitrión' : 'Viendo en PartyWatch'}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            PartyWatch${opts.isPartyOwner ? ' · Anfitrión' : ''}
          </span>` : ''}
        </div>
      </div>

      <!-- Quality menu -->
      <div class="xp-quality-menu" id="xpQualityMenu" style="display:none">
        <div class="xp-menu-header">Calidad de vídeo</div>
        <div id="xpQualityList"></div>
      </div>

      <!-- Subtitle language menu -->
      <div class="xp-sub-menu" id="xpSubMenu" style="display:none">
        <div class="xp-menu-header">Idioma de subtítulos</div>
        <div id="xpSubList">
          <div class="xp-menu-item xp-item-active" onclick="selectSubtitle(null,this)">
            <span class="xp-mcheck">✓</span> Desactivados
          </div>
        </div>
      </div>

      <!-- Subtitle style panel -->
      <div class="xp-sub-menu xp-sub-style-panel" id="xpSubStylePanel" style="display:none"></div>
    </div>

    ${opts.partyMode ? `
    <!-- PARTYWATCH SIDE PANEL: camera/voice tiles + members + chat, populated by lobby-ui.js -->
    <div class="xp-party-panel" id="xpPartyPanel">
      <div class="xp-party-header">
        <span>👥 PartyWatch</span>
        <button class="xp-party-collapse" id="xpPartyCollapseBtn" onclick="togglePartyPanel()" title="Ocultar panel">›</button>
      </div>
      <div class="xp-party-cams lobby-video-grid" id="xpPartyCams" style="display:none">
        <!-- local + remote video tiles injected here -->
      </div>
      <div class="xp-party-media-controls" id="xpPartyMediaControls">
        <button class="xp-party-ctrl-btn" id="partyMicBtn" onclick="togglePartyVoice()" title="Micrófono">
          <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>
        </button>
        <button class="xp-party-ctrl-btn" id="partyCamBtn" onclick="togglePartyVideo()" title="Cámara">
          <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        </button>
        <button class="xp-party-ctrl-btn" id="partyPinBtn" onclick="copyPartyPin()" title="Copiar PIN">
          <span id="partyPinLabel">PIN</span>
        </button>
        <button class="xp-party-ctrl-btn xp-party-leave" onclick="leavePartyWatchAndClose()" title="Salir de PartyWatch">
          <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
        </button>
      </div>
      <div class="xp-party-members" id="xpPartyMembers"></div>
      <div class="xp-party-chat">
        <div class="xp-party-chat-list" id="xpPartyChatList"></div>
        <div class="xp-party-chat-input">
          <input id="xpPartyChatInput" type="text" placeholder="Mensaje..." maxlength="200"
            onkeydown="if(event.key==='Enter')sendPartyChatMsg()">
          <button onclick="sendPartyChatMsg()">➤</button>
        </div>
      </div>
    </div>` : ''}

    <div class="xp-reactions-bar" id="xpReactionsBar">
      <div class="xp-reactions-row">
        ${['❤️','😂','😮','😢','🔥','👏'].map(e=>`<button class="xp-reaction-btn" onclick="sendReaction('${e}')">${e}</button>`).join('')}
      </div>
      <div class="xp-flying-reactions" id="xpFlyingReactions"></div>
    </div>
  </div>`;
}

// ─── VIDEO.JS INIT ────────────────────────────────────────────────────────────
function initVideoJS(src, startTime) {
  // Load Video.js dynamically if not present
  if (typeof videojs === 'undefined') {
    Promise.all([
      loadScript('https://vjs.zencdn.net/8.10.0/video.min.js'),
      loadStyle('https://vjs.zencdn.net/8.10.0/video-js.min.css')
    ]).then(() => _setupVJS(src, startTime));
  } else {
    _setupVJS(src, startTime);
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

function _setupVJS(src, startTime) {
  const el = document.getElementById('xpVideo');
  if (!el) return;

  const isYT = src.includes('youtube') || src.includes('youtu.be');
  if (isYT) {
    // YouTube: use iframe fallback
    const area = document.getElementById('xpPlayerArea');
    if (area) {
      const ytId = src.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1];
      area.innerHTML = `
        <div class="xp-yt-wrap">
          <iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&start=${Math.floor(startTime||0)}"
            allow="autoplay;fullscreen" allowfullscreen style="width:100%;height:100%;border:none;display:block"></iframe>
          <button class="xp-back-btn xp-yt-back" onclick="closeXPlayer()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
        </div>`;
    }
    return;
  }

  const isRestrictedViewer = playerState.partyMode && !playerState.isPartyOwner;

  vjsPlayer = videojs('xpVideo', {
    autoplay: true,
    controls: true,
    fluid: false,
    fill: true,
    playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
    sources: [{ src, type: guessType(src) }],
    userActions: { hotkeys: !isRestrictedViewer },
    controlBar: isRestrictedViewer
      ? { children: ['volumePanel', 'currentTimeDisplay', 'timeDivider', 'durationDisplay', 'fullscreenToggle'] }
      : {
          children: [
            'playToggle', 'volumePanel', 'currentTimeDisplay',
            'timeDivider', 'durationDisplay', 'progressControl',
            'playbackRateMenuButton', 'fullscreenToggle'
          ]
        }
  });

  // Belt-and-suspenders: even with playToggle/progressControl removed from
  // the control bar, block direct play()/pause()/currentTime writes that
  // could be triggered via hotkeys or programmatically, so a non-owner
  // truly cannot drive playback for the party.
  if (isRestrictedViewer) {
    vjsPlayer.ready(() => {
      const video = vjsPlayer.el().querySelector('video');
      if (!video) return;
      video.addEventListener('click', (e) => { e.stopPropagation(); }, true);
    });
  }

  vjsPlayer.ready(() => {
    if (startTime > 0) vjsPlayer.currentTime(startTime);
    // Fix: was _state.onReady (bug)
    if (playerState.onReady) {
      const nativeVid = vjsPlayer.el().querySelector('video');
      if (nativeVid) playerState.onReady(nativeVid);
    }
    buildQualityMenu(src);
    buildSubMenu();
    _loadSubStyle();
    _applySubStyle();
    buildSubStylePanel();
    vjsPlayer.on('timeupdate', onTimeUpdate);
    vjsPlayer.on('ended', onVideoEnded);
    vjsPlayer.on('error', onVideoError);
  });
}

function guessType(src) {
  if (src.includes('.m3u8')) return 'application/x-mpegURL';
  if (src.includes('.mp4')) return 'video/mp4';
  if (src.includes('.webm')) return 'video/webm';
  return 'video/mp4';
}

// ─── TIME UPDATE ──────────────────────────────────────────────────────────────
let _lastSavedPct = -1;
let _introShown = false;
let _autoNextTriggered = false;
let _activeSubTrack = null;
let _subInterval = null;

function onTimeUpdate() {
  if (!vjsPlayer) return;
  const ct = vjsPlayer.currentTime();
  const dur = vjsPlayer.duration() || 0;
  const pct = dur > 0 ? Math.round((ct / dur) * 100) : 0;

  // Save progress every 5%.
  // If >= 95% → mark as completed (pct = 0) so rewatching starts from beginning.
  if (pct > 0 && pct !== _lastSavedPct && pct % 5 === 0) {
    _lastSavedPct = pct;
    const reportPct = pct >= 95 ? 0 : pct;  // 0 = completed / watch from start
    if (playerState.onProgress) playerState.onProgress(reportPct, ct);
  }

  // Skip intro button
  const { introStart, introEnd } = playerState;
  const skipBtn = document.getElementById('xpSkipIntro');
  if (skipBtn && introStart !== null && introEnd !== null) {
    const inIntro = ct >= introStart && ct < introEnd;
    skipBtn.style.display = inIntro ? 'block' : 'none';
  }

  // Time remaining
  const remEl = document.getElementById('xpTimeRemaining');
  if (remEl && dur > 0) {
    const rem = dur - ct;
    if (rem > 0 && rem < dur) {
      remEl.style.display = 'block';
      remEl.textContent = `${formatSecs(rem)} restantes`;
    } else {
      remEl.style.display = 'none';
    }
  }

  // Auto-next: show at 95% or last 30 secs
  const threshold = dur > 0 && (pct >= 95 || (dur - ct) <= 30);
  if (threshold && playerState.nextEp && !_autoNextTriggered) {
    _autoNextTriggered = true;
    showAutoNext();
  }

  // Custom subtitle rendering
  updateSubtitleDisplay(ct);
}

function onVideoEnded() {
  // Mark as completed so it starts from beginning next time
  if (playerState.onProgress) playerState.onProgress(0, 0);
  if (playerState.nextEp && !_autoNextTriggered) playNextNow();
}

function onVideoError() {
  showXPlayerToast('Error al cargar el vídeo. Comprueba la URL.', 'error');
}

function formatSecs(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ─── SKIP INTRO ───────────────────────────────────────────────────────────────
window.skipIntro = () => {
  if (!vjsPlayer || playerState.introEnd === null) return;
  vjsPlayer.currentTime(playerState.introEnd);
  const btn = document.getElementById('xpSkipIntro');
  if (btn) btn.style.display = 'none';
};

// ─── AUTO NEXT ────────────────────────────────────────────────────────────────
let _autoNextTimer = null;

function showAutoNext() {
  const el = document.getElementById('xpAutoNext');
  if (!el) return;
  el.style.display = 'flex';
  let count = 5;
  const countEl = document.getElementById('xpNextCount');
  if (countEl) countEl.textContent = count;
  _autoNextTimer = setInterval(() => {
    count--;
    if (countEl) countEl.textContent = count;
    if (count <= 0) { clearInterval(_autoNextTimer); playNextNow(); }
  }, 1000);
}

window.playNextNow = () => {
  clearInterval(_autoNextTimer);
  hideAutoNext();
  if (playerState.onNext) playerState.onNext();
};

window.cancelAutoNext = () => {
  clearInterval(_autoNextTimer);
  hideAutoNext();
  _autoNextTriggered = false;
};

function hideAutoNext() {
  const el = document.getElementById('xpAutoNext');
  if (el) el.style.display = 'none';
}

// ─── QUALITY MENU ─────────────────────────────────────────────────────────────
// Video.js 8.x bundles videojs-http-streaming (VHS), which already does
// real adaptive bitrate switching for .m3u8 sources with zero extra config
// — it watches bandwidth and swaps renditions on its own. What was missing
// here was the UI: the old menu showed fake preset labels with no src,
// which did nothing when clicked. This now reads the HLS manifest's real
// renditions (when the source is HLS) so "Auto" is genuine ABR and the
// other options are real, clickable qualities from the actual stream.
function buildQualityMenu(currentSrc) {
  const list = document.getElementById('xpQualityList');
  const btn = document.getElementById('xpQualityBtn');
  if (!list) return;

  const hasExplicitQualities = playerState.qualities && playerState.qualities.length > 0;

  if (hasExplicitQualities) {
    // Catalog-provided quality URLs take priority — same behavior as before.
    _renderQualityItems([{ label: 'Auto', src: null, bitrate: '' }, ...playerState.qualities]);
    if (btn) btn.style.display = '';
    return;
  }

  const isHls = /\.m3u8($|\?)/i.test(currentSrc || '');
  if (isHls && vjsPlayer?.tech_?.vhs) {
    // Real adaptive bitrate: read the actual renditions HLS parsed out of
    // the manifest instead of guessing at bitrate labels. (If a browser
    // plays this HLS source natively instead of through VHS — e.g. Safari
    // in some configs — tech_.vhs won't exist; that falls through to the
    // "no manual selector" branch below since the browser's own native ABR
    // already handles it without needing UI here.)
    _waitForVhsRenditions(() => {
      const reps = vjsPlayer.tech_.vhs.representations();
      if (!reps || !reps.length) {
        _renderQualityItems([{ label: 'Auto (adaptativo)', src: null, bitrate: '' }]);
        if (btn) btn.style.display = '';
        return;
      }
      const sorted = [...reps].sort((a, b) => (b.height || 0) - (a.height || 0));
      const items = [
        { label: 'Auto (adaptativo)', isAuto: true, bitrate: '' },
        ...sorted.map(r => ({
          label: r.height ? `${r.height}p` : 'Calidad',
          bitrate: r.bandwidth ? `~${(r.bandwidth / 1_000_000).toFixed(1)} Mbps` : '',
          rendition: r
        }))
      ];
      _renderQualityItems(items);
      if (btn) btn.style.display = '';
    });
    return;
  }

  // Plain MP4 with no explicit qualities and no HLS manifest — there is
  // nothing real to switch between, so don't show fake options that look
  // clickable but silently do nothing.
  if (btn) btn.style.display = 'none';
}

// VHS parses the manifest asynchronously right after the source loads, so
// representations() can be empty for a moment on first open — retry briefly
// instead of showing an empty menu.
function _waitForVhsRenditions(cb, attempt = 0) {
  const reps = vjsPlayer?.tech_?.vhs?.representations?.();
  if ((reps && reps.length) || attempt >= 10) { cb(); return; }
  setTimeout(() => _waitForVhsRenditions(cb, attempt + 1), 300);
}

function _renderQualityItems(items) {
  const list = document.getElementById('xpQualityList');
  if (!list) return;
  list.innerHTML = items.map((q, i) => `
    <div class="xp-menu-item ${i === 0 ? 'xp-item-active' : ''}"
      data-idx="${i}"
      onclick="selectQuality(${i}, this)">
      <span class="xp-mcheck" style="opacity:${i === 0 ? 1 : 0}">✓</span>
      <span class="xp-qlbl">${q.label}</span>
      ${q.bitrate ? `<span class="xp-qbr">${q.bitrate}</span>` : ''}
    </div>`).join('');
  _qualityItems = items;

  const lbl = document.getElementById('xpQualityLabel');
  if (lbl) lbl.textContent = 'AUTO';
}

let _qualityItems = [];

window.toggleQualityMenu = () => {
  const m = document.getElementById('xpQualityMenu');
  const s = document.getElementById('xpSubMenu');
  const sp = document.getElementById('xpSubStylePanel');
  if (s)  s.style.display = 'none';
  if (sp) sp.style.display = 'none';
  if (m)  m.style.display = m.style.display === 'none' ? 'block' : 'none';
};

window.selectQuality = (idx, el) => {
  const item = _qualityItems[idx];
  if (!item) return;

  if (item.src) {
    // Catalog-provided quality URL — swap the source directly, same as before.
    const ct = vjsPlayer.currentTime();
    vjsPlayer.src({ src: item.src, type: guessType(item.src) });
    vjsPlayer.ready(() => { vjsPlayer.currentTime(ct); vjsPlayer.play(); });
  } else if (item.rendition) {
    // Real HLS rendition — force VHS onto this one by disabling every
    // other rendition, which is how VHS's manual quality selection works
    // (there's no dedicated "select quality" call, only per-rendition enable).
    const reps = vjsPlayer?.tech_?.vhs?.representations?.() || [];
    reps.forEach(r => r.enabled(r === item.rendition));
  } else if (item.isAuto) {
    // Back to automatic ABR — re-enable every rendition so VHS's bandwidth
    // logic drives the choice again instead of being pinned to one.
    const reps = vjsPlayer?.tech_?.vhs?.representations?.() || [];
    reps.forEach(r => r.enabled(true));
  }

  document.querySelectorAll('#xpQualityList .xp-menu-item').forEach(i => {
    i.classList.remove('xp-item-active');
    const ch = i.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '0';
  });
  el.classList.add('xp-item-active');
  const ch = el.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '1';
  const lbl = document.getElementById('xpQualityLabel');
  if (lbl) lbl.textContent = item.label.includes('Auto') ? 'AUTO'
    : (item.label.split('·')[1]?.trim() || item.label.split(' ')[0]);
  document.getElementById('xpQualityMenu').style.display = 'none';
};

// ─── AUDIO TRACKS ─────────────────────────────────────────────────────────────
// audioTracks: [{ label: 'Español', src: 'audio_es.mp3', srclang: 'es' }]
// Plays as separate <audio> element synced to the video timeline.
let _audioEl = null;
let _audioActive = null;

function buildAudioMenu() {
  const btn = document.getElementById('xpAudioBtn');
  const list = document.getElementById('xpAudioList');
  if (!list) return;

  const tracks = playerState.audioTracks || [];
  if (!tracks.length) {
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = '';

  list.innerHTML = `
    <div class="xp-menu-item xp-item-active" data-audio-src="" onclick="selectAudioTrack(this)">
      <span class="xp-mcheck">✓</span>
      <span class="xp-qlbl">Original (vídeo)</span>
    </div>
    ${tracks.map(t => `
      <div class="xp-menu-item" data-audio-src="${encodeURIComponent(t.src)}"
        data-audio-label="${t.label}" onclick="selectAudioTrack(this)">
        <span class="xp-mcheck" style="opacity:0">✓</span>
        <span class="xp-qlbl">${t.label}</span>
        <span class="xp-qbr">MP3</span>
      </div>`).join('')}`;
}

window.toggleAudioMenu = () => {
  const m = document.getElementById('xpAudioMenu');
  const q = document.getElementById('xpQualityMenu');
  const s = document.getElementById('xpSubMenu');
  const sp = document.getElementById('xpSubStylePanel');
  [q, s, sp].forEach(el => el && (el.style.display = 'none'));
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
};

window.selectAudioTrack = async (el) => {
  const src = decodeURIComponent(el.dataset.audioSrc || '');
  const label = el.dataset.audioLabel || 'Original';

  document.querySelectorAll('#xpAudioList .xp-menu-item').forEach(i => {
    i.classList.remove('xp-item-active');
    const ch = i.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '0';
  });
  el.classList.add('xp-item-active');
  const ch = el.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '1';
  document.getElementById('xpAudioMenu').style.display = 'none';

  const lbl = document.getElementById('xpAudioLabel');

  // Destroy previous audio track
  if (_audioEl) {
    _audioEl.pause();
    _audioEl.src = '';
    _audioEl = null;
  }

  if (!src) {
    // Restore original video audio
    if (vjsPlayer) {
      const vid = vjsPlayer.el().querySelector('video');
      if (vid) vid.muted = false;
    }
    if (lbl) lbl.textContent = 'AUDIO';
    showXPlayerToast('Audio original restaurado', 'success');
    return;
  }

  // Mute the video's own audio track, play the MP3 in sync
  if (vjsPlayer) {
    const vid = vjsPlayer.el().querySelector('video');
    if (vid) vid.muted = true;
  }

  showXPlayerToast(`Cargando audio: ${label}…`, 'info');
  _audioEl = new Audio(src);
  _audioEl.volume = vjsPlayer ? vjsPlayer.volume() : 1;

  try {
    await new Promise((res, rej) => {
      _audioEl.oncanplaythrough = res;
      _audioEl.onerror = () => rej(new Error('No se pudo cargar el audio'));
      _audioEl.load();
      setTimeout(() => res(), 5000); // max 5s wait
    });
    const ct = vjsPlayer ? vjsPlayer.currentTime() : 0;
    _audioEl.currentTime = ct;
    if (!vjsPlayer?.paused()) _audioEl.play().catch(() => {});
    if (lbl) lbl.textContent = label.slice(0, 3).toUpperCase();
    showXPlayerToast(`✓ Audio: ${label}`, 'success');

    // Sync play/pause with video
    if (vjsPlayer) {
      vjsPlayer.on('play',  () => _audioEl?.play().catch(() => {}));
      vjsPlayer.on('pause', () => _audioEl?.pause());
      vjsPlayer.on('seeked', () => { if (_audioEl) _audioEl.currentTime = vjsPlayer.currentTime(); });
    }
  } catch(e) {
    showXPlayerToast(e.message, 'error');
    _audioEl = null;
    if (vjsPlayer) { const v = vjsPlayer.el().querySelector('video'); if (v) v.muted = false; }
  }
};

// ─── SUBTITLES ─────────────────────────────────────────────────────────────────
// Persistent style settings
const SUB_DEFAULTS = { size: 100, color: '#ffffff', bg: 'rgba(0,0,0,0.76)', font: 'Helvetica Neue', shadow: true };
const SUB_FONTS = ['Helvetica Neue','Arial','Georgia','Courier New','Trebuchet MS','Impact','Verdana','Tahoma'];
let _subStyle = { ...SUB_DEFAULTS };
let _subtitleCues = [];
let _subCache = {};

function _loadSubStyle() {
  try { const s = localStorage.getItem('xp_sub_style'); if (s) _subStyle = { ...SUB_DEFAULTS, ...JSON.parse(s) }; } catch {}
}
function _saveSubStyle() {
  try { localStorage.setItem('xp_sub_style', JSON.stringify(_subStyle)); } catch {}
}
function _applySubStyle() {
  const el = document.getElementById('xpSubtitleDisplay');
  if (!el) return;
  el.style.setProperty('--sub-size',   `${(_subStyle.size / 100) * 1.4}rem`);
  el.style.setProperty('--sub-color',  _subStyle.color);
  el.style.setProperty('--sub-bg',     _subStyle.bg === 'none' ? 'transparent' : _subStyle.bg);
  el.style.setProperty('--sub-font',   _subStyle.font);
  el.style.setProperty('--sub-shadow', _subStyle.shadow ? '0 1px 6px rgba(0,0,0,1)' : 'none');
}

function buildSubMenu() {
  const list = document.getElementById('xpSubList');
  if (!list) return;
  playerState.subtitles.forEach(sub => {
    const item = document.createElement('div');
    item.className = 'xp-menu-item';
    item.innerHTML = `<span class="xp-mcheck" style="opacity:0">✓</span> ${sub.label}`;
    item.onclick = () => selectSubtitle(sub, item);
    list.appendChild(item);
  });
}

window.toggleSubMenu = () => {
  const m = document.getElementById('xpSubMenu');
  const q = document.getElementById('xpQualityMenu');
  const sp = document.getElementById('xpSubStylePanel');
  if (q)  q.style.display = 'none';
  if (sp) sp.style.display = 'none';
  if (m)  m.style.display = m.style.display === 'none' ? 'block' : 'none';
};

window.toggleSubStylePanel = () => {
  const m  = document.getElementById('xpSubMenu');
  const q  = document.getElementById('xpQualityMenu');
  const sp = document.getElementById('xpSubStylePanel');
  if (m) m.style.display = 'none';
  if (q) q.style.display = 'none';
  if (!sp) return;
  sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
};

window.selectSubtitle = async (sub, el) => {
  document.querySelectorAll('#xpSubList .xp-menu-item').forEach(i => {
    i.classList.remove('xp-item-active');
    const ch = i.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '0';
  });
  if (el) {
    el.classList.add('xp-item-active');
    const ch = el.querySelector('.xp-mcheck'); if (ch) ch.style.opacity = '1';
  }
  document.getElementById('xpSubMenu').style.display = 'none';
  const lbl = document.getElementById('xpSubLabel');

  if (!sub) {
    _subtitleCues = [];
    const d = document.getElementById('xpSubtitleDisplay'); if (d) d.innerHTML = '';
    if (lbl) { lbl.textContent = 'CC'; lbl.style.opacity = '.4'; }
    return;
  }
  if (lbl) { lbl.textContent = (sub.srclang || 'CC').toUpperCase(); lbl.style.opacity = '1'; }

  if (_subCache[sub.src]) { _subtitleCues = _subCache[sub.src]; return; }

  showXPlayerToast('Cargando subtítulos…', 'info');
  try {
    const res = await fetch(sub.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const isSRT = sub.src.split('?')[0].toLowerCase().endsWith('.srt')
      || !text.trimStart().startsWith('WEBVTT');
    const cues = _parseSubs(text);
    if (!cues.length) throw new Error('Archivo vacío o formato no reconocido');
    _subCache[sub.src] = cues;
    _subtitleCues = cues;
    showXPlayerToast(`✓ ${sub.label} · ${cues.length} subtítulos`, 'success');
  } catch(e) {
    showXPlayerToast(`Error: ${e.message}`, 'error');
    _subtitleCues = [];
  }
};

function _parseSubs(raw) {
  const cues = [];
  const text = raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti === -1) continue;
    const parts = lines[ti].split('-->');
    const s = _parseSubTime(parts[0]), e = _parseSubTime(parts[1]);
    if (isNaN(s) || isNaN(e)) continue;
    const txt = lines.slice(ti + 1).join('\n')
      .replace(/<[^>]+>/g,'').replace(/\{[^}]*\}/g,'')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    if (txt) cues.push({ start: s, end: e, text: txt });
  }
  return cues;
}
function _parseSubTime(raw) {
  const t = (raw||'').replace(',','.').trim().split(/\s/)[0];
  const p = t.split(':');
  if (p.length === 3) return +p[0]*3600 + +p[1]*60 + parseFloat(p[2]);
  if (p.length === 2) return +p[0]*60 + parseFloat(p[1]);
  return parseFloat(t);
}

function updateSubtitleDisplay(ct) {
  const el = document.getElementById('xpSubtitleDisplay');
  if (!el) return;
  if (!_subtitleCues.length) { el.innerHTML = ''; return; }
  const cue = _subtitleCues.find(c => ct >= c.start && ct <= c.end);
  el.innerHTML = cue ? `<span class="xp-sub-pill">${cue.text.replace(/\n/g,'<br>')}</span>` : '';
}

// ─── SUBTITLE STYLE PANEL ─────────────────────────────────────────────────────
function buildSubStylePanel() {
  const panel = document.getElementById('xpSubStylePanel');
  if (!panel) return;
  const fontOpts = SUB_FONTS.map(f =>
    `<option value="${f}" ${_subStyle.font===f?'selected':''}>${f}</option>`).join('');
  panel.innerHTML = `
    <div class="xp-menu-header">✏️ Personalizar subtítulos</div>
    <div class="xp-ss-body">
      <label class="xp-ss-lbl">Tamaño
        <div class="xp-ss-row">
          <input type="range" min="50" max="200" step="10" value="${_subStyle.size}"
            oninput="xpSubStyleChange('size',+this.value);document.getElementById('xpSzVal').textContent=this.value+'%'">
          <span id="xpSzVal" class="xp-ss-val">${_subStyle.size}%</span>
        </div>
      </label>
      <label class="xp-ss-lbl">Color
        <div class="xp-ss-row">
          <input type="color" value="${_subStyle.color}" oninput="xpSubStyleChange('color',this.value)">
          <div class="xp-ss-presets">
            ${['#ffffff','#ffff00','#00ffff','#ff6b6b','#90ee90'].map(c =>
              `<button class="xp-ss-dot" style="background:${c}"
                onclick="xpSubStyleChange('color','${c}');document.querySelector('#xpSubStylePanel input[type=color]').value='${c}'"></button>`
            ).join('')}
          </div>
        </div>
      </label>
      <label class="xp-ss-lbl">Fondo
        <div class="xp-ss-row" style="flex-wrap:wrap;gap:5px">
          ${[['rgba(0,0,0,0.76)','Oscuro'],['rgba(0,0,0,0.4)','Suave'],['none','Sin fondo'],['rgba(0,0,128,0.8)','Azul']].map(([v,l]) =>
            `<button class="xp-ss-bg ${_subStyle.bg===v?'xp-ss-bg-on':''}"
              onclick="xpSubStyleChange('bg','${v}');document.querySelectorAll('.xp-ss-bg').forEach(b=>b.classList.remove('xp-ss-bg-on'));this.classList.add('xp-ss-bg-on')">${l}</button>`
          ).join('')}
        </div>
      </label>
      <label class="xp-ss-lbl">Fuente
        <select class="xp-ss-sel" onchange="xpSubStyleChange('font',this.value)">${fontOpts}</select>
      </label>
      <label class="xp-ss-lbl" style="flex-direction:row;align-items:center;justify-content:space-between">
        Sombra <input type="checkbox" ${_subStyle.shadow?'checked':''} onchange="xpSubStyleChange('shadow',this.checked)">
      </label>
      <button class="xp-ss-reset" onclick="xpSubStyleReset()">↺ Restablecer</button>
    </div>`;
}

window.xpSubStyleChange = (key, val) => { _subStyle[key]=val; _saveSubStyle(); _applySubStyle(); };
window.xpSubStyleReset  = () => {
  _subStyle = { ...SUB_DEFAULTS };
  _saveSubStyle(); buildSubStylePanel(); _applySubStyle();
  showXPlayerToast('Subtítulos restablecidos','info');
};

// ─── INJECT CSS ───────────────────────────────────────────────────────────────
function _injectPlayerStyles() {
  if (document.getElementById('xp-styles')) return;
  const s = document.createElement('style');
  s.id = 'xp-styles';
  s.textContent = `
    .xp-subtitle-display{position:absolute;bottom:72px;left:50%;transform:translateX(-50%);z-index:28;text-align:center;pointer-events:none;max-width:84%}
    .xp-sub-pill{display:inline-block;background:var(--sub-bg);color:var(--sub-color);font-family:var(--sub-font),Arial,sans-serif;font-size:var(--sub-size);font-weight:500;line-height:1.55;padding:5px 18px 7px;border-radius:5px;text-shadow:var(--sub-shadow);white-space:pre-wrap;max-width:100%}
    .xp-ctrl-lbl{font-size:.68rem;font-weight:800;letter-spacing:.05em;line-height:1}
    .xp-ctrl-dim{opacity:.35;pointer-events:none}
    .xp-menu-item{display:flex;align-items:center;gap:7px;padding:9px 16px;cursor:pointer;font-size:.87rem;color:rgba(232,234,240,.8);transition:background .15s,color .15s}
    .xp-menu-item:hover{background:rgba(26,127,255,.14);color:#fff}
    .xp-item-active{color:#fff!important}
    .xp-mcheck{color:#1a7fff;font-size:.85rem;flex-shrink:0;width:14px}
    .xp-qlbl{flex:1}
    .xp-qbr{font-size:.68rem;color:rgba(232,234,240,.38);background:rgba(255,255,255,.06);padding:1px 6px;border-radius:7px}
    .xp-menu-header{padding:10px 16px 8px;font-size:.7rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(232,234,240,.4);border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:3px}
    .xp-sub-style-panel{width:290px!important;max-height:400px;overflow-y:auto}
    .xp-ss-body{display:flex;flex-direction:column;gap:11px;padding:10px 16px 16px}
    .xp-ss-lbl{display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:rgba(232,234,240,.65)}
    .xp-ss-row{display:flex;align-items:center;gap:9px}
    .xp-ss-val{font-size:.78rem;font-weight:700;color:#1a7fff;min-width:36px;text-align:right}
    .xp-ss-lbl input[type=range]{flex:1;accent-color:#1a7fff}
    .xp-ss-lbl input[type=color]{width:30px;height:26px;border:none;border-radius:6px;cursor:pointer;background:none}
    .xp-ss-lbl input[type=checkbox]{width:16px;height:16px;accent-color:#1a7fff;cursor:pointer}
    .xp-ss-presets{display:flex;gap:5px}
    .xp-ss-dot{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.2);cursor:pointer;transition:transform .15s}
    .xp-ss-dot:hover{transform:scale(1.2)}
    .xp-ss-bg{padding:4px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(232,234,240,.65);font-size:.74rem;cursor:pointer;transition:background .15s}
    .xp-ss-bg:hover,.xp-ss-bg-on{background:rgba(26,127,255,.2);border-color:rgba(26,127,255,.4);color:#fff}
    .xp-ss-sel{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#e8eaf0;border-radius:7px;padding:5px 8px;font-size:.82rem;width:100%;cursor:pointer}
    .xp-ss-reset{margin-top:4px;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(232,234,240,.45);font-size:.78rem;cursor:pointer;transition:background .15s}
    .xp-ss-reset:hover{background:rgba(255,255,255,.07);color:#e8eaf0}
  `;
  document.head.appendChild(s);
}

// ─── REACTIONS ────────────────────────────────────────────────────────────────
window.sendReaction = (emoji) => {
  const container = document.getElementById('xpFlyingReactions');
  if (!container) return;
  const el = document.createElement('span');
  el.className = 'xp-fly-emoji';
  el.textContent = emoji;
  el.style.left = (20 + Math.random() * 60) + '%';
  container.appendChild(el);
  setTimeout(() => el.remove(), 2000);
};

function sendReactionLocal(emoji) {
  const container = document.getElementById('xpFlyingReactions');
  if (!container) return;
  const el = document.createElement('span');
  el.className = 'xp-fly-emoji xp-fly-remote';
  el.textContent = emoji;
  el.style.left = (20 + Math.random() * 60) + '%';
  container.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ─── CLOSE PLAYER ─────────────────────────────────────────────────────────────
export function closeXPlayer() {
  clearInterval(_autoNextTimer);
  _autoNextTriggered = false;

  // Save the exact progress at close time — onTimeUpdate only reports every
  // 5%, so without this a user closing mid-tramo (e.g. at 43%) would have
  // "Seguir viendo" resume from the last saved 40% instead of where they
  // actually stopped.
  if (vjsPlayer && playerState.onProgress) {
    try {
      const ct = vjsPlayer.currentTime();
      const dur = vjsPlayer.duration() || 0;
      const pct = dur > 0 ? Math.round((ct / dur) * 100) : 0;
      if (pct > 0) {
        const reportPct = pct >= 95 ? 0 : pct;
        playerState.onProgress(reportPct, ct);
      }
    } catch {}
  }

  _lastSavedPct = -1;
  _introShown = false;
  _subtitleCues = [];

  const wasPartyMode = playerState.partyMode;

  if (vjsPlayer) {
    try { vjsPlayer.dispose(); } catch {}
    vjsPlayer = null;
  }

  const container = document.getElementById('videoPlayer');
  if (container) {
    container.style.display = 'none';
    container.classList.remove('xp-party-active');
    container.innerHTML = '';
  }
  document.body.style.overflow = '';

  // Let lobby-ui.js tear down camera/mic/peer connections — the player
  // doesn't own that state, so it just signals that it closed.
  if (wasPartyMode) {
    document.dispatchEvent(new CustomEvent('xplayer:closed'));
  }
  playerState.partyMode = false;
  playerState.isPartyOwner = false;
  playerState.partyPin = null;

  if (playerState.onClose) playerState.onClose();
}
window.closeXPlayer = closeXPlayer;

// ─── TOAST IN PLAYER ──────────────────────────────────────────────────────────
function showXPlayerToast(msg, type = 'info') {
  const wrap = document.getElementById('xPlayerWrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `xp-toast xp-toast-${type}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.classList.add('xp-toast-visible'), 10);
  setTimeout(() => { t.classList.remove('xp-toast-visible'); setTimeout(() => t.remove(), 300); }, 3000);
}

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Expose for app.js to set current user
export function setPlayerUser(user) {
  window._xcineCurrentUser = user;
}
