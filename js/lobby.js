// js/lobby.js — RBX Infinity Multiplayer Lobbies
// PeerJS + Firebase Realtime DB + Web Audio API + WebRTC
// Features: lobbies, voice/video/text chat, synced video, click broadcast,
//           audio visualizer (Discord-style green ring + waveform)

import { db, ref as fbRef, set as fbSet, get as fbGet, push as fbPush, update as fbUpdate, onValue as fbOnValue, remove as fbRemove } from './firebase.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
let _peer        = null;     // PeerJS Peer instance
let _lobbyId     = null;     // current lobby ID / pin
let _lobbyRef    = null;     // Firebase ref
let _connections = {};       // peerId → { conn, stream, videoEl, audioCtx, analyser }
let _localStream = null;     // local MediaStream (voice+video)
let _videoEnabled= false;
let _voiceEnabled= false;
let _currentUser = null;
let _isOwner     = false;
let _lobbyData   = null;
let _unsubLobby  = null;     // firebase listener cleanup
let _audioCtx    = null;
let _localAnalyser = null;
let _vizFrameId  = null;
let _onVideoSync = null;     // callback(action, time, src) → app.js plays video
let _lastVideoTs = 0;        // prevent replaying old videoState events

const PEERJS_CONFIG = {
  // Use PeerJS's public cloud broker directly — there is no custom
  // "peerjs.rbxinfinity.app" server running, so pointing at it made every
  // connection silently fail and fall back inconsistently.
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' }
    ],
    // Pre-gather ICE candidates before they're needed — cuts the time to
    // first frame on call setup, since candidates don't have to be
    // negotiated fresh for every new connection.
    iceCandidatePoolSize: 4
  },
  // PeerJS-level tuning: smaller reconnect/ping intervals so a dropped
  // link (common on mobile networks) is detected and repaired quickly
  // instead of silently freezing the stream.
  pingInterval: 3000
};

// Preferred video encoding params for the camera/screen tracks we send.
// Capping resolution/framerate keeps encode time and bandwidth in check —
// the previous unrestricted getDisplayMedia() request could ask for 4K@60,
// which on a P2P mesh with several viewers was the single biggest cause
// of visible lag (encode queue backing up faster than it could drain).
const VIDEO_SEND_CONSTRAINTS = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } };
const MAX_VIDEO_BITRATE_KBPS = 900; // per-peer cap; keeps the mesh usable past 3-4 viewers

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initLobbySystem(user, onVideoSyncCallback) {
  _currentUser = user;
  _onVideoSync = onVideoSyncCallback;
}

// ─── PEER SETUP ───────────────────────────────────────────────────────────────
function getPeer() {
  if (_peer && !_peer.destroyed) return Promise.resolve(_peer);
  return new Promise((resolve, reject) => {
    // Load PeerJS dynamically
    if (typeof Peer === 'undefined') {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = () => _createPeer(resolve, reject);
      s.onerror = () => reject(new Error('No se pudo cargar PeerJS'));
      document.head.appendChild(s);
    } else {
      _createPeer(resolve, reject);
    }
  });
}

function _createPeer(resolve, reject) {
  const peerId = _currentUser.uid.slice(0, 16) + '_' + Date.now().toString(36);
  const peer = new Peer(peerId, PEERJS_CONFIG);
  let settled = false;

  peer.on('open', (id) => {
    if (settled) return;
    settled = true;
    _peer = peer;
    resolve(peer);
  });

  peer.on('error', (err) => {
    // 'unavailable-id' just means a stale connection with the same id —
    // PeerJS automatically retries with a fresh one, so ignore it.
    if (err.type === 'unavailable-id') return;
    if (!settled) {
      settled = true;
      reject(new Error('No se pudo conectar al servidor de señalización: ' + err.type));
    } else {
      console.warn('[Lobby] Peer error after connection established:', err.type, err.message);
    }
  });

  peer.on('connection', (conn) => _handleIncomingDataConn(conn));
  peer.on('call', (call) => _handleIncomingCall(call));
  peer.on('disconnected', () => {
    // Try a single reconnect attempt — common after network blips
    try { peer.reconnect(); } catch {}
  });
}

// ─── LOBBY CRUD ───────────────────────────────────────────────────────────────
export async function createLobby(opts) {
  /*
    opts: { pin, name, maxUsers, isPublic, allowVideo, contentId, contentTitle }
  */
  const peer = await getPeer();
  const pin = (opts.pin || Math.random().toString(36).slice(2,8)).toUpperCase();
  _lobbyId = pin;
  _isOwner = true;

  const lobbyData = {
    pin,
    name: opts.name || `Lobby de ${_currentUser.displayName || 'usuario'}`,
    owner: _currentUser.uid,
    ownerName: _currentUser.displayName || 'Usuario',
    maxUsers: opts.maxUsers || 8,
    isPublic: opts.isPublic !== false,
    allowVideo: opts.allowVideo !== false,
    createdAt: Date.now(),
    contentId: opts.contentId || null,
    contentTitle: opts.contentTitle || null,
    videoState: { action: 'pause', time: 0, src: null, ts: Date.now() },
    members: {
      [_currentUser.uid]: {
        uid: _currentUser.uid,
        name: _currentUser.displayName || 'Usuario',
        peerId: peer.id,
        joinedAt: Date.now(),
        isOwner: true
      }
    }
  };

  _lobbyRef = fbRef(db, `lobbies/${pin}`);
  await fbSet(_lobbyRef, lobbyData);
  _lobbyData = lobbyData;
  _subscribeToLobby(pin);
  return pin;
}

export async function joinLobby(pin) {
  const peer = await getPeer();
  pin = pin.toUpperCase().trim();
  const snap = await fbGet(fbRef(db, `lobbies/${pin}`));
  if (!snap.exists()) throw new Error('Lobby no encontrado. Verifica el PIN.');

  const data = snap.val();
  const memberCount = Object.keys(data.members || {}).length;
  if (memberCount >= (data.maxUsers || 8)) throw new Error('El lobby está lleno.');

  _lobbyId = pin;
  _isOwner = data.owner === _currentUser.uid;
  _lobbyRef = fbRef(db, `lobbies/${pin}`);
  _lobbyData = data;

  // Register as member
  await fbUpdate(fbRef(db, `lobbies/${pin}/members/${_currentUser.uid}`), {
    uid: _currentUser.uid,
    name: _currentUser.displayName || 'Usuario',
    peerId: peer.id,
    joinedAt: Date.now(),
    isOwner: false
  });

  _subscribeToLobby(pin);

  // Connect to all existing members
  const members = data.members || {};
  for (const [uid, member] of Object.entries(members)) {
    if (uid !== _currentUser.uid && member.peerId) {
      _connectToPeer(member.peerId, member.name);
    }
  }

  return data;
}

export async function leaveLobby() {
  if (!_lobbyId) return;

  // Remove member from Firebase
  try {
    await fbRemove(fbRef(db, `lobbies/${_lobbyId}/members/${_currentUser?.uid}`));
    // If owner, delete whole lobby
    if (_isOwner) {
      await fbRemove(fbRef(db, `lobbies/${_lobbyId}`));
    }
  } catch {}

  _cleanup();
}

function _cleanup() {
  // Close all peer connections
  Object.values(_connections).forEach(({ conn }) => {
    try { conn?.close(); } catch {}
  });
  _connections = {};

  // Stop local streams
  _localStream?.getTracks().forEach(t => t.stop());
  _localStream = null;
  _voiceEnabled = false;
  _videoEnabled = false;

  // Cancel visualizer
  if (_vizFrameId) { cancelAnimationFrame(_vizFrameId); _vizFrameId = null; }
  _audioCtx?.close().catch(() => {});
  _audioCtx = null;

  // Unsubscribe Firebase
  if (_unsubLobby) { _unsubLobby(); _unsubLobby = null; }

  _lobbyId = null;
  _lobbyRef = null;
  _lobbyData = null;
  _isOwner = false;

  if (_peer && !_peer.destroyed) {
    _peer.destroy();
    _peer = null;
  }
}

// ─── FIREBASE SYNC ────────────────────────────────────────────────────────────
let _unsubChat = null;
let _seenChatIds = new Set();

function _subscribeToLobby(pin) {
  if (_unsubLobby) _unsubLobby();
  const ref = fbRef(db, `lobbies/${pin}`);
  _unsubLobby = fbOnValue(ref, (snap) => {
    if (!snap.exists()) { _onLobbyDeleted(); return; }
    const data = snap.val();
    _lobbyData = data;
    _renderLobbyUI(data);

    // New members → connect (creates data conn + ensures a video tile slot exists)
    const members = data.members || {};
    for (const [uid, member] of Object.entries(members)) {
      if (uid !== _currentUser?.uid && member.peerId && !_connections[member.peerId]) {
        _ensurePeerSlot(member.peerId, member.name);
        _connectToPeer(member.peerId, member.name);
      }
    }

    // Video sync — ALL members update UI, non-owners also open the content
    if (data.videoState && data.videoState.ts > (_lastVideoTs || 0)) {
      _lastVideoTs = data.videoState.ts;
      _handleVideoSync(data.videoState);
    }
  });

  // Chat is delivered through Firebase (reliable, no P2P needed). The
  // previous version only sent chat via PeerJS DataConnections, which
  // silently dropped every message whenever the P2P link wasn't up yet.
  if (_unsubChat) _unsubChat();
  _seenChatIds = new Set();
  _unsubChat = fbOnValue(fbRef(db, `lobbies/${pin}/chat`), (snap) => {
    if (!snap.exists()) return;
    const entries = Object.entries(snap.val());
    for (const [msgId, msg] of entries) {
      if (_seenChatIds.has(msgId)) continue;
      _seenChatIds.add(msgId);
      const isSelf = msg.uid === _currentUser?.uid;
      addChatMsg({ ...msg, type: isSelf ? 'self' : 'peer' });
    }
  });
}

let _lastSyncTs = 0;
function _handleVideoSync(vs) {
  if (!vs) return;

  // Update lobby content zone UI for everyone
  _updateContentZoneUI(vs);

  // Non-owners: actually open/play the content
  if (!_isOwner && _onVideoSync) {
    _onVideoSync(vs.action, vs.time, vs.src, vs.contentId, vs.contentTitle);
  }

  // play/pause/seek apply to everyone (owner already has it playing)
  if (vs.action === 'play' || vs.action === 'pause' || vs.action === 'seek') {
    _applyPlaybackSync(vs);
  }
}

function _updateContentZoneUI(vs) {
  // Update the "now playing" label in topbar
  if (vs.contentTitle) {
    const lbl = document.getElementById('lobbyContentTitle');
    if (lbl) lbl.textContent = `🎬 ${vs.contentTitle}`;
  }
  // Update content zone placeholder
  const noContent = document.getElementById('lrNoContent');
  if (noContent && vs.action === 'open' && (vs.contentId || vs.src)) {
    const title = vs.contentTitle || vs.contentId || 'Contenido';
    noContent.innerHTML = `
      <div style="font-size:2rem;margin-bottom:8px">▶</div>
      <p style="font-weight:700;color:#7ab9ff;margin-bottom:4px">${_escHtmlLobby(title)}</p>
      <p style="color:rgba(232,234,240,.45);font-size:.82rem">Reproduciéndose en el player</p>`;
  }
}

function _applyPlaybackSync(vs) {
  const video = document.querySelector('#videoPlayer video, #xpPlayerArea video');
  if (!video) return;
  if (typeof vs.time === 'number' && Math.abs(video.currentTime - vs.time) > 1.5) {
    video.currentTime = vs.time;
  }
  if (vs.action === 'play')  video.play().catch(() => {});
  if (vs.action === 'pause') video.pause();
}

function _onLobbyDeleted() {
  showLobbyToast('El lobby ha sido cerrado por el creador.', 'error');
  closeLobbyUI();
  _cleanup();
}

// ─── PEER CONNECTIONS (data) ──────────────────────────────────────────────────
function _connectToPeer(peerId, name) {
  if (!_peer || _connections[peerId]) return;
  const conn = _peer.connect(peerId, { reliable: true });
  _connections[peerId] = { conn, name };
  _setupDataConn(conn, name, peerId);
}

function _handleIncomingDataConn(conn) {
  const peerId = conn.peer;
  _connections[peerId] = _connections[peerId] || { conn, name: '?' };
  _connections[peerId].conn = conn;
  _setupDataConn(conn, _connections[peerId].name, peerId);
}

function _setupDataConn(conn, name, peerId) {
  conn.on('open', () => {
    addChatMsg({ type: 'system', text: `${name || 'Alguien'} se unió al chat` });
    // If we have a stream and they're new, call them
    if (_localStream) _callPeer(peerId);
  });

  conn.on('data', (data) => _handleDataMsg(data, peerId));

  conn.on('close', () => {
    const n = _connections[peerId]?.name || 'Alguien';
    addChatMsg({ type: 'system', text: `${n} abandonó el lobby` });
    _removePeerUI(peerId);
    delete _connections[peerId];
    _renderMembersUI();
  });
}

function _handleDataMsg(msg, peerId) {
  switch (msg.type) {
    case 'click':
      _showRemoteClick(msg.x, msg.y, msg.name);
      break;
    case 'reaction':
      _showFloatingReaction(msg.emoji, false);
      break;
  }
}

function _broadcastData(msg) {
  Object.values(_connections).forEach(({ conn }) => {
    try { conn?.send(msg); } catch {}
  });
}

// ─── WEBRTC CALLS (voice+video) ───────────────────────────────────────────────
async function _callPeer(peerId) {
  if (!_peer || !_localStream) return;
  // Close any previous outgoing call to this peer first — otherwise
  // toggling the camera/mic mid-session stacks up duplicate connections.
  if (_connections[peerId]?.call) {
    try { _connections[peerId].call.close(); } catch {}
  }
  const call = _peer.call(peerId, _localStream);
  if (!_connections[peerId]) _connections[peerId] = {};
  _connections[peerId].call = call;
  call.on('stream', (remoteStream) => {
    _attachRemoteStream(peerId, remoteStream);
  });
  call.on('close', () => {
    if (_connections[peerId]) _connections[peerId].stream = null;
  });
  // Cap the bitrate we send to this peer once the underlying
  // RTCPeerConnection exists — PeerJS exposes it as call.peerConnection.
  // Without this, the encoder defaults to a much higher bitrate ceiling
  // that the mesh can't sustain once 3+ viewers are pulling a stream.
  _capOutgoingVideoBitrate(call);
}

function _capOutgoingVideoBitrate(call) {
  const pc = call?.peerConnection;
  if (!pc) { setTimeout(() => _capOutgoingVideoBitrate(call), 300); return; }
  const trySender = () => {
    const sender = pc.getSenders?.().find(s => s.track?.kind === 'video');
    if (!sender) return false;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE_KBPS * 1000;
    sender.setParameters(params).catch(() => {});
    return true;
  };
  if (!trySender()) setTimeout(trySender, 500);
}

function _handleIncomingCall(call) {
  if (_connections[call.peer]?.incomingCall) {
    try { _connections[call.peer].incomingCall.close(); } catch {}
  }
  if (!_localStream) {
    // Answer with empty stream if no local media
    call.answer(new MediaStream());
  } else {
    call.answer(_localStream);
  }
  if (!_connections[call.peer]) _connections[call.peer] = {};
  _connections[call.peer].incomingCall = call;
  call.on('stream', (remoteStream) => {
    _attachRemoteStream(call.peer, remoteStream);
  });
}

// ─── PEER VIDEO TILES ─────────────────────────────────────────────────────────
// Creates the HTML slot a remote peer's <video> will be attached to.
// This was missing entirely before: _attachRemoteStream looked up
// `#peer-vid-{id}` but nothing ever created that element, so incoming
// camera streams had nowhere to render (hence the black screen).
function _ensurePeerSlot(peerId, name) {
  const grid = document.getElementById('lobbyVideoGrid');
  if (!grid) return;
  const safeId = peerId.replace(/[^a-z0-9]/gi, '_');
  if (document.getElementById(`peer-slot-${safeId}`)) return; // already exists

  const tile = document.createElement('div');
  tile.className = 'lobby-video-tile lobby-peer-tile';
  tile.id = `peer-slot-${safeId}`;
  tile.innerHTML = `
    <div class="peer-vid-container" id="peer-vid-${safeId}"></div>
    <span class="vid-tile-name">${_escHtmlLobby(name || 'Usuario')}</span>
    <div class="vid-ring" id="ringvid_${safeId}"></div>`;
  grid.appendChild(tile);
  grid.style.display = 'grid';
}

function _attachRemoteStream(peerId, stream) {
  if (!_connections[peerId]) _connections[peerId] = {};
  _connections[peerId].stream = stream;

  const name = _connections[peerId].name || _lobbyData?.members
    ? Object.values(_lobbyData?.members || {}).find(m => m.peerId === peerId)?.name
    : null;

  // Make sure the slot exists even if the member-list listener hasn't
  // created it yet (e.g. the call arrives before the Firebase update).
  _ensurePeerSlot(peerId, name || _connections[peerId].name);

  const container = document.getElementById(`peer-vid-${peerId.replace(/[^a-z0-9]/gi,'_')}`);
  if (!container) return;
  let video = container.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    container.appendChild(video);
  }
  video.srcObject = stream;
  video.play().catch(() => {}); // some browsers require an explicit play() after srcObject changes
  _connections[peerId].videoEl = video;

  // Only run the audio visualizer if the stream actually carries audio —
  // creating an AnalyserNode on a video-only stream just wastes cycles.
  if (stream.getAudioTracks().length > 0) {
    _setupPeerAudioViz(peerId, stream);
  }

  // Hide the tile's placeholder state once real video tracks arrive,
  // and reflect camera-off state (audio-only) with a clear placeholder.
  const hasVideo = stream.getVideoTracks().some(t => t.enabled);
  container.classList.toggle('peer-vid-no-camera', !hasVideo);
}

// ─── AUDIO VISUALIZER (Web Audio API) ────────────────────────────────────────
function _setupLocalAudioViz(stream) {
  if (!stream) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _audioCtx.createMediaStreamSource(stream);
    _localAnalyser = _audioCtx.createAnalyser();
    _localAnalyser.fftSize = 256;
    source.connect(_localAnalyser);
    _drawLocalViz();
  } catch {}
}

function _drawLocalViz() {
  const canvas = document.getElementById('localAudioCanvas');
  if (!canvas || !_localAnalyser) return;
  const ctx = canvas.getContext('2d');
  const buf = new Uint8Array(_localAnalyser.frequencyBinCount);

  const draw = () => {
    _vizFrameId = requestAnimationFrame(draw);
    _localAnalyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a,b)=>a+b,0) / buf.length;
    const isSpeaking = avg > 18;

    // Green ring on avatar (sidebar) + local video tile ring
    const ring = document.getElementById('localSpeakRing');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
    const localRing = document.getElementById('localVidRing');
    if (localRing) localRing.classList.toggle('speaking', isSpeaking);
    const localTile = document.getElementById('localVideoTile');
    if (localTile) localTile.classList.toggle('speaking', isSpeaking);

    // Waveform bars
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = canvas.width / buf.length * 2.5;
    buf.forEach((val, i) => {
      const h = (val / 255) * canvas.height;
      const r = isSpeaking ? 74 : 60;
      const g = isSpeaking ? 222 : 160;
      const b = 128;
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.fillRect(i * barW, canvas.height - h, barW - 1, h);
    });
  };
  draw();
}

function _setupPeerAudioViz(peerId, stream) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _audioCtx.createMediaStreamSource(stream);
    const analyser = _audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    _connections[peerId].analyser = analyser;
    _drawPeerViz(peerId, analyser);
  } catch {}
}

function _drawPeerViz(peerId, analyser) {
  const escaped = CSS.escape(peerId);
  const canvasId = `peerAudioCanvas_${peerId.replace(/[^a-z0-9]/gi,'_')}`;
  const buf = new Uint8Array(analyser.frequencyBinCount);

  const draw = () => {
    if (!_connections[peerId]) return;
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a,b)=>a+b,0) / buf.length;
    const isSpeaking = avg > 18;

    // Ring — both the sidebar avatar ring and the video tile ring
    const ring = document.getElementById(`ring_${peerId.replace(/[^a-z0-9]/gi,'_')}`);
    if (ring) ring.classList.toggle('speaking', isSpeaking);
    const ringVid = document.getElementById(`ringvid_${peerId.replace(/[^a-z0-9]/gi,'_')}`);
    if (ringVid) ringVid.classList.toggle('speaking', isSpeaking);
    const tile = document.getElementById(`peer-slot-${peerId.replace(/[^a-z0-9]/gi,'_')}`);
    if (tile) tile.classList.toggle('speaking', isSpeaking);

    // Canvas
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = canvas.width / buf.length * 2.5;
    buf.forEach((val, i) => {
      const h = (val / 255) * canvas.height;
      ctx.fillStyle = isSpeaking ? 'rgba(74,222,128,0.85)' : 'rgba(60,160,128,0.5)';
      ctx.fillRect(i * barW, canvas.height - h, barW - 1, h);
    });
  };
  draw();
}

function _removePeerUI(peerId) {
  const safeId = peerId.replace(/[^a-z0-9]/gi, '_');
  document.getElementById(`peer-slot-${safeId}`)?.remove();
  // Hide the grid again if no one else has video/streams left
  const grid = document.getElementById('lobbyVideoGrid');
  if (grid && !_videoEnabled && !Object.values(_connections).some(c => c.stream)) {
    grid.style.display = 'none';
  }
}

// ─── MEDIA TOGGLE ─────────────────────────────────────────────────────────────
export async function toggleVoice() {
  if (!_voiceEnabled) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!_localStream) _localStream = stream;
      else stream.getAudioTracks().forEach(t => _localStream.addTrack(t));
      _voiceEnabled = true;
      _setupLocalAudioViz(_localStream);
      // Call all connected peers
      Object.keys(_connections).forEach(_callPeer);
      _updateMediaUI();
    } catch(e) {
      showLobbyToast('No se pudo acceder al micrófono: ' + e.message, 'error');
    }
  } else {
    _localStream?.getAudioTracks().forEach(t => { t.stop(); _localStream.removeTrack(t); });
    _voiceEnabled = false;
    _updateMediaUI();
  }
}

export async function toggleVideo() {
  if (!_videoEnabled) {
    try {
      const vStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_SEND_CONSTRAINTS });
      if (!_localStream) _localStream = vStream;
      else vStream.getVideoTracks().forEach(t => _localStream.addTrack(t));
      _videoEnabled = true;
      // Show local preview
      const localVid = document.getElementById('localVideo');
      if (localVid) { localVid.srcObject = _localStream; localVid.play().catch(()=>{}); }
      Object.keys(_connections).forEach(_callPeer);
      _updateMediaUI();
    } catch(e) {
      showLobbyToast('No se pudo acceder a la cámara: ' + e.message, 'error');
    }
  } else {
    _localStream?.getVideoTracks().forEach(t => { t.stop(); _localStream.removeTrack(t); });
    _videoEnabled = false;
    const localVid = document.getElementById('localVideo');
    if (localVid) localVid.srcObject = null;
    _updateMediaUI();
  }
}

function _updateMediaUI() {
  const micBtn = document.getElementById('lobbyMicBtn');
  const camBtn = document.getElementById('lobbyCamBtn');
  if (micBtn) {
    micBtn.classList.toggle('active', _voiceEnabled);
    micBtn.title = _voiceEnabled ? 'Silenciar micrófono' : 'Activar micrófono';
    micBtn.innerHTML = _voiceEnabled
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>`;
  }
  if (camBtn) {
    camBtn.classList.toggle('active', _videoEnabled);
    camBtn.title = _videoEnabled ? 'Apagar cámara' : 'Activar cámara';
  }

  // Show/hide video grid
  const videoGrid = document.getElementById('lobbyVideoGrid');
  if (videoGrid) videoGrid.style.display = (_videoEnabled || Object.values(_connections).some(c => c.stream)) ? 'grid' : 'none';

  // Local tile
  const localTile = document.getElementById('localVideoTile');
  if (localTile) localTile.style.display = _videoEnabled ? 'flex' : 'none';
}

// ─── VIDEO SYNC (owner only) ──────────────────────────────────────────────────
export async function syncVideoAction(action, time, src, contentId, contentTitle) {
  if (!_lobbyRef) return;
  // Only the lobby owner is allowed to drive playback for everyone else.
  // Non-owners calling this (e.g. a stray event listener) must be a no-op,
  // otherwise a guest could hijack play/pause/seek for the whole party.
  if (!_isOwner) return;
  const vs = {
    action,
    time:        time        || 0,
    src:         src         || null,
    contentId:   contentId   || null,
    contentTitle: contentTitle || null,
    ts: Date.now()
  };
  await fbUpdate(fbRef(db, `lobbies/${_lobbyId}/videoState`), vs);
  // Also update root contentTitle for lobby card display
  if (contentTitle) {
    await fbUpdate(_lobbyRef, { contentTitle, contentId: contentId || null });
  }
}

// ─── PARTYWATCH: create a lobby already bound to a piece of content ─────────
// Used by the "PartyWatch" button on the content detail page — skips the
// separate lobby-picker flow entirely and drops the owner straight into the
// player with the content already playing for everyone who joins.
export async function createPartyWatch(opts) {
  const pin = await createLobby({
    name: opts.name || `PartyWatch de ${_currentUser?.displayName || 'usuario'}`,
    isPublic: opts.isPublic !== false,
    allowVideo: true,
    contentId: opts.contentId || null,
    contentTitle: opts.contentTitle || null
  });
  return pin;
}

export function isPartyOwner() {
  return _isOwner;
}

export function getCurrentLobbyId() {
  return _lobbyId;
}

// ─── CLICK BROADCAST ──────────────────────────────────────────────────────────
export function broadcastClick(x, y) {
  _broadcastData({
    type: 'click',
    x, y,
    name: _currentUser?.displayName || 'Alguien',
    ts: Date.now()
  });
  _showRemoteClick(x, y, 'Tú', true);
}

function _showRemoteClick(x, y, name, isSelf = false) {
  const overlay = document.getElementById('lobbyClickOverlay');
  if (!overlay) return;
  const dot = document.createElement('div');
  dot.className = 'lobby-click-dot' + (isSelf ? ' click-self' : '');
  dot.style.left = (x * 100) + '%';
  dot.style.top = (y * 100) + '%';
  dot.innerHTML = `<div class="click-ripple"></div><span class="click-name">${name}</span>`;
  overlay.appendChild(dot);
  setTimeout(() => dot.remove(), 1800);
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
export function sendChatMsg(text) {
  if (!text?.trim() || !_lobbyRef || !_lobbyId) return;
  const msg = { uid: _currentUser?.uid, name: _currentUser?.displayName || 'Yo', text: text.trim(), ts: Date.now() };
  // Firebase is the single source of truth for chat delivery — the listener
  // set up in _subscribeToLobby will render this message (and everyone
  // else's) as soon as it round-trips, including our own.
  fbPush(fbRef(db, `lobbies/${_lobbyId}/chat`), msg).catch(() => {
    showLobbyToast('No se pudo enviar el mensaje', 'error');
  });
}

export function addChatMsg(msg) {
  const list = document.getElementById('lobbyChatList');
  if (!list) return;
  const div = document.createElement('div');
  div.className = `lchat-msg lchat-${msg.type}`;
  if (msg.type === 'system') {
    div.innerHTML = `<span class="lchat-system">${msg.text}</span>`;
  } else {
    const time = msg.ts ? new Date(msg.ts).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}) : '';
    div.innerHTML = `
      <span class="lchat-name">${msg.type==='self'?'Tú':msg.name}</span>
      <span class="lchat-text">${escHtml(msg.text)}</span>
      <span class="lchat-time">${time}</span>`;
  }
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function escHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _escHtmlLobby(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── LOBBY BROWSER UI ─────────────────────────────────────────────────────────
export async function loadPublicLobbies() {
  const snap = await fbGet(fbRef(db, 'lobbies'));
  if (!snap.exists()) return [];
  return Object.values(snap.val())
    .filter(l => l.isPublic)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ─── LOBBY ROOM UI ────────────────────────────────────────────────────────────
function _renderLobbyUI(data) {
  const nameEl = document.getElementById('lobbyRoomTitle');
  if (nameEl) nameEl.textContent = data.name;

  const pinEl = document.getElementById('lobbyRoomPin');
  if (pinEl) pinEl.textContent = `PIN: ${data.pin}`;

  _renderMembersUI(data.members);
  _renderPartyMembersPanel(data.members);

  // Sync content title
  if (data.contentTitle) {
    const ctEl = document.getElementById('lobbyContentTitle');
    if (ctEl) ctEl.textContent = `🎬 ${data.contentTitle}`;
  }
}

// Populates the new embedded PartyWatch panel's member pills
// (#xpPartyMembers, in the player). Kept here so it updates on the same
// real-time Firebase tick as everything else, instead of polling.
function _renderPartyMembersPanel(members) {
  members = members || _lobbyData?.members || {};
  const container = document.getElementById('xpPartyMembers');
  if (!container) return;
  container.innerHTML = Object.values(members).map(m => {
    const safeId = m.peerId?.replace(/[^a-z0-9]/gi,'_') || m.uid;
    const name = String(m.name || 'Usuario').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `
      <div class="xp-party-member">
        <span class="xp-party-member-avatar" id="ring_${safeId}">${name.charAt(0).toUpperCase()}</span>
        <span class="xp-party-member-name">${name}${m.isOwner ? ' 👑' : ''}</span>
      </div>`;
  }).join('');
}

function _renderMembersUI(members) {
  members = members || _lobbyData?.members || {};
  const container = document.getElementById('lobbyMembersList');
  if (!container) return;
  container.innerHTML = Object.values(members).map(m => {
    const safeId = m.peerId?.replace(/[^a-z0-9]/gi,'_') || m.uid;
    return `
      <div class="lobby-member" id="lmember_${safeId}">
        <div class="lm-avatar-wrap">
          <div class="lm-avatar" id="ring_${safeId}">
            ${m.name?.charAt(0).toUpperCase() || '?'}
          </div>
        </div>
        <span class="lm-name">${m.name || 'Usuario'}${m.isOwner?'  👑':''}</span>
        <canvas id="peerAudioCanvas_${safeId}" width="48" height="20" class="peer-audio-canvas"></canvas>
      </div>`;
  }).join('');
}

function _updateMediaUI_members() {
  _renderMembersUI();
  _updateMediaUI();
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showLobbyToast(msg, type = 'info') {
  if (window.showToast) { window.showToast(msg, type); return; }
  console.log(`[Lobby ${type}]`, msg);
}

// ─── FLOATING REACTIONS ───────────────────────────────────────────────────────
export function sendReaction(emoji) {
  _broadcastData({ type: 'reaction', emoji });
  _showFloatingReaction(emoji, true);
}

function _showFloatingReaction(emoji, isSelf) {
  const overlay = document.getElementById('lobbyReactionOverlay');
  if (!overlay) return;
  const el = document.createElement('div');
  el.className = 'lobby-float-emoji';
  el.style.left = (20 + Math.random() * 60) + '%';
  el.textContent = emoji;
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ─── CLOSE LOBBY UI ───────────────────────────────────────────────────────────
export function closeLobbyUI() {
  const el = document.getElementById('lobbyRoomModal');
  if (el) { el.classList.remove('lr-visible'); setTimeout(() => el.remove(), 300); }
}

// ─── EXPORTS for app.js ──────────────────────────────────────────────────────
export {
  _lobbyId as lobbyId,
  _isOwner as isOwner,
  _lobbyData as lobbyData,
  _connections as lobbyConnections,
};

export { leaveLobby as leavePartyWatch };
