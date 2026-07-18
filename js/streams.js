// js/streams.js — RBX Infinity Live Streams System
// Admin streams: YouTube link, Screen Share, or OBS WHIP/WebRTC
// Viewers watch in real-time. Scheduled streams show in catalog.

import { db, ref as fbRef, set as fbSet, get as fbGet, update as fbUpdate,
         push as fbPush, onValue as fbOnValue, remove as fbRemove } from './firebase.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
let _currentUser      = null;
let _isAdmin          = false;
let _activeStream     = null;   // current stream being watched
let _obsPC            = null;   // RTCPeerConnection for OBS WHIP
let _screenStream     = null;   // MediaStream for screen share
let _screenPC         = null;   // RTCPeerConnection for screen share broadcast
let _viewerPCs        = {};     // peerId → RTCPeerConnection (for broadcast)
let _streamUnsubscribe = null;

const STREAMS_REF = 'streams';

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initStreams(user, isAdmin) {
  _currentUser = user;
  _isAdmin = isAdmin;
}

// ─── GET ALL STREAMS (live + scheduled) ──────────────────────────────────────
export async function getStreams() {
  const snap = await fbGet(fbRef(db, STREAMS_REF));
  if (!snap.exists()) return [];
  const now = Date.now();
  return Object.entries(snap.val())
    .map(([id, s]) => ({ id, ...s }))
    .filter(s => s.status !== 'ended')
    .sort((a, b) => (a.scheduledAt || a.startedAt || 0) - (b.scheduledAt || b.startedAt || 0));
}

export function listenStreams(callback) {
  const unsub = fbOnValue(fbRef(db, STREAMS_REF), snap => {
    if (!snap.exists()) { callback([]); return; }
    const now = Date.now();
    const list = Object.entries(snap.val())
      .map(([id, s]) => ({ id, ...s }))
      .filter(s => s.status !== 'ended')
      .sort((a, b) => (a.scheduledAt || a.startedAt || 0) - (b.scheduledAt || b.startedAt || 0));
    callback(list);
  });
  return unsub;
}

// ─── CREATE STREAM (admin) ────────────────────────────────────────────────────
export async function createStream(opts) {
  const id = 'stream_' + Date.now();
  const now = Date.now();
  const data = {
    id,
    titulo:      opts.titulo,
    descripcion: opts.descripcion || '',
    poster:      opts.poster || null,
    banner:      opts.banner || null,
    trailer:     opts.trailer || null,       // only for scheduled
    edadMinima:  opts.edadMinima || 0,
    tipo:        opts.tipo,                  // 'youtube' | 'screen' | 'obs'
    youtubeUrl:  opts.youtubeUrl || null,
    status:      opts.scheduled ? 'scheduled' : 'live',
    scheduledAt: opts.scheduledAt || null,
    startedAt:   opts.scheduled ? null : now,
    ownerUid:    _currentUser?.uid,
    ownerName:   _currentUser?.displayName || 'Admin',
    viewerCount: 0,
    chatEnabled: true,
  };
  await fbSet(fbRef(db, `${STREAMS_REF}/${id}`), data);
  return id;
}

export async function startScheduledStream(streamId) {
  await fbUpdate(fbRef(db, `${STREAMS_REF}/${streamId}`), {
    status: 'live',
    startedAt: Date.now()
  });
}

export async function endStream(streamId) {
  await fbUpdate(fbRef(db, `${STREAMS_REF}/${streamId}`), {
    status: 'ended',
    endedAt: Date.now()
  });
  _cleanupBroadcast();
}

// ─── SCREEN SHARE BROADCAST ───────────────────────────────────────────────────
export async function startScreenShare(streamId) {
  try {
    _screenStream = await navigator.mediaDevices.getDisplayMedia({
      // 120fps capture was forcing the encoder to churn through far more
      // frames than the P2P mesh could actually deliver, which is what
      // caused viewers to see stutter/lag build up over time. 30fps at a
      // capped resolution keeps encode time low and playback smooth.
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: true
    });
    // Store offer in Firebase for viewers to connect
    await _broadcastViaFirebase(streamId, _screenStream);
    return _screenStream;
  } catch(e) {
    throw new Error('No se pudo capturar la pantalla: ' + e.message);
  }
}

async function _broadcastViaFirebase(streamId, stream) {
  // Listen for viewer ICE/SDP requests
  fbOnValue(fbRef(db, `${STREAMS_REF}/${streamId}/viewers`), async (snap) => {
    if (!snap.exists()) return;
    for (const [peerId, vdata] of Object.entries(snap.val())) {
      if (vdata.offer && !_viewerPCs[peerId]) {
        await _handleViewerOffer(streamId, peerId, vdata.offer, stream);
      }
    }
  });
}

async function _handleViewerOffer(streamId, peerId, offer, stream) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 4
  });
  _viewerPCs[peerId] = pc;

  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.onicecandidate = async ({ candidate }) => {
    if (candidate) {
      await fbPush(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/hostCandidates`), candidate.toJSON());
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await fbSet(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/answer`), answer);

  // Same per-viewer bitrate cap as lobby.js — each additional viewer on a
  // P2P mesh multiplies the host's total upload, so an uncapped encoder
  // quickly saturates upload bandwidth and every viewer sees it as lag.
  const trySender = () => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return false;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 1_200_000; // 1.2 Mbps ceiling per viewer
    sender.setParameters(params).catch(() => {});
    return true;
  };
  if (!trySender()) setTimeout(trySender, 500);
}

function _cleanupBroadcast() {
  Object.values(_viewerPCs).forEach(pc => { try { pc.close(); } catch {} });
  _viewerPCs = {};
  if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
}

// ─── VIEWER: WATCH SCREEN SHARE ───────────────────────────────────────────────
export async function watchScreenShare(streamId, videoElement) {
  const peerId = 'v_' + _currentUser?.uid + '_' + Date.now();
  _screenPC = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  _screenPC.ontrack = (e) => {
    if (e.streams[0]) {
      videoElement.srcObject = e.streams[0];
      videoElement.play().catch(() => {});
    }
  };

  _screenPC.onicecandidate = async ({ candidate }) => {
    if (candidate) {
      await fbPush(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/viewerCandidates`), candidate.toJSON());
    }
  };

  // Create offer
  const offer = await _screenPC.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await _screenPC.setLocalDescription(offer);
  await fbSet(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/offer`), offer);

  // Wait for answer
  fbOnValue(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/answer`), async (snap) => {
    if (snap.exists() && _screenPC.signalingState === 'have-local-offer') {
      await _screenPC.setRemoteDescription(new RTCSessionDescription(snap.val()));
    }
  });

  // ICE candidates from host
  fbOnValue(fbRef(db, `${STREAMS_REF}/${streamId}/viewers/${peerId}/hostCandidates`), (snap) => {
    if (!snap.exists()) return;
    Object.values(snap.val()).forEach(c => {
      _screenPC?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    });
  });

  return peerId;
}

// ─── STREAM CHAT ──────────────────────────────────────────────────────────────
export async function sendStreamChat(streamId, text) {
  if (!_currentUser || !text?.trim()) return;
  await fbPush(fbRef(db, `${STREAMS_REF}/${streamId}/chat`), {
    uid:  _currentUser.uid,
    name: _currentUser.displayName || 'Usuario',
    text: text.trim(),
    ts:   Date.now()
  });
}

export function listenStreamChat(streamId, callback) {
  return fbOnValue(fbRef(db, `${STREAMS_REF}/${streamId}/chat`), snap => {
    if (!snap.exists()) { callback([]); return; }
    const msgs = Object.values(snap.val()).sort((a,b) => a.ts - b.ts).slice(-60);
    callback(msgs);
  });
}

// ─── INCREMENT VIEWER COUNT ───────────────────────────────────────────────────
export async function incrementViewers(streamId) {
  try {
    const snap = await fbGet(fbRef(db, `${STREAMS_REF}/${streamId}/viewerCount`));
    await fbUpdate(fbRef(db, `${STREAMS_REF}/${streamId}`), {
      viewerCount: (snap.val() || 0) + 1
    });
  } catch {}
}

export async function decrementViewers(streamId) {
  try {
    const snap = await fbGet(fbRef(db, `${STREAMS_REF}/${streamId}/viewerCount`));
    const count = Math.max(0, (snap.val() || 1) - 1);
    await fbUpdate(fbRef(db, `${STREAMS_REF}/${streamId}`), { viewerCount: count });
  } catch {}
}

// ─── NOTIFICATION: check scheduled streams ────────────────────────────────────
export async function checkScheduledNotifications(uid) {
  if (!uid) return;
  const snap = await fbGet(fbRef(db, STREAMS_REF));
  if (!snap.exists()) return;
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  Object.values(snap.val()).forEach(s => {
    if (s.ownerUid !== uid) return;
    if (s.status !== 'scheduled') return;
    if (!s.scheduledAt) return;
    const diff = s.scheduledAt - now;
    if (diff > 0 && diff <= fiveMin) {
      // Show notification
      if (Notification.permission === 'granted') {
        new Notification(`¡Tu stream "${s.titulo}" empieza pronto!`, {
          body: 'El stream comienza en menos de 5 minutos. ¡Prepárate!',
          icon: s.poster || '/favicon.ico'
        });
      }
      window.showToast?.(`Tu stream "${s.titulo}" empieza en ${Math.ceil(diff/60000)} min`, 'info');
    }
  });
}
