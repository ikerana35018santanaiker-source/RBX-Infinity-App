// js/lobby-ui.js — RBX Infinity PartyWatch UI
// PartyWatch is started directly from a content's detail page (see the
// "PartyWatch" button next to Reproducir in app.js) and lives inside the
// video player as a side panel — there's no separate lobby-browser page
// or content picker anymore. This module wires that panel up to the
// P2P/Firebase engine in lobby.js.

import {
  initLobbySystem, leaveLobby,
  toggleVoice, toggleVideo, syncVideoAction,
  broadcastClick, sendChatMsg, addChatMsg,
  sendReaction, closeLobbyUI, getCurrentLobbyId
} from './lobby.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
let _uiCurrentUser  = null;
let _getContentById = null;
let _openContentFn  = null;
let _isLobbyOwner   = false;

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initLobbiesUI(user, getContentByIdFn, openContentFn, showToastFn,
                               getAllContentFn, getUpcomingFn) {
  _uiCurrentUser  = user;
  _getContentById = getContentByIdFn;
  _openContentFn  = openContentFn;

  initLobbySystem(user, _handleSyncedVideo);
}

// ─── VIDEO SYNC HANDLER (called for all members, owner only updates UI) ───────
function _handleSyncedVideo(action, time, src, contentId, contentTitle) {
  if (action === 'open') {
    // Non-owners: actually open the content, in PartyWatch mode so they get
    // the panel + stay hooked into playback sync (hookPlayerForLobbySync is
    // wired up inside playContent/playEpisode's onReady when partyOpts is
    // passed) instead of opening a disconnected normal player.
    if (!_isLobbyOwner) {
      const partyOpts = { isOwner: false, pin: getCurrentLobbyId() };

      // Trailer (src only, no contentId)
      if (src && !contentId && window.openTrailer) {
        window.openTrailer(src);
        setTimeout(() => _seekVideo(time), 1000);
        return;
      }
      // Episode key: "serieId_sNeM" → "serieId_s1e2"
      if (contentId) {
        const epMatch = contentId.match(/^(.+)_s(\d+)e(\d+)$/);
        if (epMatch && window.playEpisode) {
          window.playEpisode(epMatch[1], +epMatch[2], +epMatch[3], partyOpts);
          setTimeout(() => _seekVideo(time), 1200);
          return;
        }
        if (window.playContent) {
          window.playContent(contentId, partyOpts);
          setTimeout(() => _seekVideo(time), 1000);
        } else if (_openContentFn) {
          _openContentFn(contentId);
          setTimeout(() => _seekVideo(time), 1000);
        }
      }
    }
  } else if (action === 'play' || action === 'pause' || action === 'seek') {
    _syncPlayback(action, time);
  }
}

function _seekVideo(time) {
  const v = document.querySelector('#videoPlayer video, #xpPlayerArea video');
  if (v && typeof time === 'number' && time > 0) v.currentTime = time;
}

function _syncPlayback(action, time) {
  const v = document.querySelector('#videoPlayer video, #xpPlayerArea video');
  if (!v) return;
  if (typeof time === 'number' && Math.abs(v.currentTime - time) > 1.5) v.currentTime = time;
  if (action === 'play')  v.play().catch(() => {});
  if (action === 'pause') v.pause();
}

export function hookPlayerForLobbySync(videoElement, contentId) {
  if (!videoElement) return;
  const sync = (action) => syncVideoAction(action, videoElement.currentTime, videoElement.src, contentId);
  videoElement.addEventListener('play',   () => sync('play'));
  videoElement.addEventListener('pause',  () => sync('pause'));
  videoElement.addEventListener('seeked', () => sync('seek'));
}

function escHtml(t) { return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── PARTYWATCH PANEL (embedded in the player) ──────────────────────────────
// Camera/voice tiles, members, and chat live in a side panel inside the
// video player (#xpPartyPanel in player.js). Mic/cam toggles sit under the
// camera area. Only the owner drives playback — enforced in lobby.js's
// syncVideoAction and by hiding transport controls in player.js.
let _partyPin = null;

export function initPartyWatchPanel(videoElement, isOwner, pin, item) {
  _isLobbyOwner = isOwner;
  _partyPin = pin;

  const pinLabel = document.getElementById('partyPinLabel');
  if (pinLabel) pinLabel.textContent = pin || '';

  _aliasPartyPanelIds();

  // Owner: hook the actual <video> so play/pause/seek broadcast to everyone.
  if (isOwner && videoElement) {
    hookPlayerForLobbySync(videoElement, item?.id);
  }

  document.addEventListener('xplayer:closed', _onPartyPlayerClosed, { once: true });
}

function _onPartyPlayerClosed() {
  leaveLobby().catch(() => {});
  _isLobbyOwner = false;
  _partyPin = null;
}

// The camera/voice engine in lobby.js targets fixed element ids
// (#lobbyMicBtn, #lobbyVideoGrid, #localVideo, etc.) that used to live in
// the old standalone lobby-room modal. Rather than duplicate that logic,
// we alias the equivalent elements inside the new player-embedded panel to
// those same ids once, so lobby.js's existing UI-update code works
// unmodified against the new layout.
function _aliasPartyPanelIds() {
  const map = [
    ['partyMicBtn', 'lobbyMicBtn'],
    ['partyCamBtn', 'lobbyCamBtn'],
    ['xpPartyCams', 'lobbyVideoGrid'],
    ['xpPartyChatList', 'lobbyChatList'],
  ];
  for (const [from, to] of map) {
    const el = document.getElementById(from);
    if (el && el.id !== to) el.id = to;
  }

  // Local camera tile + video + speak ring need to exist inside the cams
  // grid the same way the old modal expected them.
  const grid = document.getElementById('lobbyVideoGrid');
  if (grid && !document.getElementById('localVideoTile')) {
    const tile = document.createElement('div');
    tile.className = 'lobby-video-tile local-tile xp-party-cam-tile';
    tile.id = 'localVideoTile';
    tile.style.display = 'none';
    tile.innerHTML = `
      <video id="localVideo" autoplay muted playsinline></video>
      <span class="vid-tile-name">Tú</span>
      <div class="vid-ring" id="localVidRing"></div>`;
    grid.appendChild(tile);
  }
}

window.togglePartyPanel = () => {
  const panel = document.getElementById('xpPartyPanel');
  const btn = document.getElementById('xpPartyCollapseBtn');
  if (!panel) return;
  const collapsed = panel.classList.toggle('xp-party-collapsed');
  if (btn) btn.textContent = collapsed ? '‹' : '›';
};

window.togglePartyVoice = () => { toggleVoice(); };
window.togglePartyVideo = () => { toggleVideo(); };

window.copyPartyPin = () => {
  if (!_partyPin) return;
  navigator.clipboard.writeText(_partyPin).then(() => window.showToast?.('PIN copiado ✓', 'success'));
};

window.sendPartyChatMsg = () => {
  const input = document.getElementById('xpPartyChatInput');
  if (!input) return;
  sendChatMsg(input.value);
  input.value = '';
};

window.handlePartyAreaClick = (e) => {
  const overlay = document.getElementById('lobbyClickOverlay');
  if (!overlay) return;
  const rect = overlay.getBoundingClientRect();
  broadcastClick(
    (e.clientX - rect.left) / rect.width,
    (e.clientY - rect.top)  / rect.height
  );
};

window.leavePartyWatchAndClose = async () => {
  if (!confirm('¿Salir de PartyWatch?')) return;
  await leaveLobby().catch(() => {});
  _isLobbyOwner = false;
  window.closeXPlayer?.();
  window.showToast?.('Saliste de PartyWatch', 'info');
};

// addChatMsg / sendReaction / closeLobbyUI are re-exported implicitly via
// lobby.js's own window bindings where needed elsewhere in the app.
export { addChatMsg, sendReaction, closeLobbyUI };
