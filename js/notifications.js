// js/notifications.js - RBX Infinity notification system
// Two triggers: a series the user follows drops a new episode, or a
// stream they'd be interested in goes live. Both are detected client-side
// while the app is open (there's no push server / VAPID setup here), so
// this covers "app open in a background tab" rather than "app fully
// closed" — the service worker is what makes even that much reliable
// across browsers instead of notifications silently not firing.

import { db, ref as fbRef, onValue as fbOnValue, get as fbGet } from './firebase.js';

const EPISODE_COUNTS_KEY = 'rbx_ep_counts';
const NOTIF_PREF_KEY = 'rbx_notif_enabled';

let _swRegistration = null;
let _streamsListenerBound = false;
let _knownLiveStreamIds = new Set();

// ─── SETUP ────────────────────────────────────────────────────────────────────
export async function initNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    _swRegistration = await navigator.serviceWorker.register('sw.js');
  } catch (e) {
    console.warn('No se pudo registrar el service worker de notificaciones:', e);
  }
}

export function notificationsSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

export function notificationsEnabled() {
  return notificationsSupported()
    && Notification.permission === 'granted'
    && localStorage.getItem(NOTIF_PREF_KEY) !== 'off';
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) throw new Error('Este navegador no soporta notificaciones');
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    localStorage.setItem(NOTIF_PREF_KEY, 'on');
  }
  return result;
}

export function disableNotifications() {
  localStorage.setItem(NOTIF_PREF_KEY, 'off');
}

export function enableNotifications() {
  localStorage.setItem(NOTIF_PREF_KEY, 'on');
}

// ─── SHOW ─────────────────────────────────────────────────────────────────────
async function _show(title, options) {
  if (!notificationsEnabled()) return;
  try {
    if (_swRegistration) {
      await _swRegistration.showNotification(title, options);
    } else {
      new Notification(title, options); // fallback if SW registration failed
    }
  } catch (e) { console.warn('No se pudo mostrar la notificación:', e); }
}

// ─── NEW EPISODE DETECTION ─────────────────────────────────────────────────────
// Compares each followed series' current episode count against the last
// count seen on this device. No backend watcher needed — this just runs
// once per app load against whatever catalog.js already loaded.
export function checkNewEpisodes(allSeries, followedIds) {
  if (!followedIds.length || !notificationsEnabled()) return;
  let counts = {};
  try { counts = JSON.parse(localStorage.getItem(EPISODE_COUNTS_KEY) || '{}'); } catch {}

  allSeries.forEach(serie => {
    const totalEps = Array.isArray(serie.temporadas)
      ? serie.temporadas.reduce((acc, t) => acc + (t.episodios?.length || 0), 0)
      : 0;
    const prevCount = counts[serie.id];
    const isFollowed = followedIds.includes(serie.id);

    if (isFollowed && prevCount != null && totalEps > prevCount) {
      _show(`Nuevo episodio de ${serie.titulo}`, {
        body: 'Ya está disponible en RBX Infinity',
        icon: serie.poster || 'favicon.ico',
        tag: `new-ep-${serie.id}`,
        data: { url: `#/${serie.id}` }
      });
    }
    counts[serie.id] = totalEps;
  });

  try { localStorage.setItem(EPISODE_COUNTS_KEY, JSON.stringify(counts)); } catch {}
}

// ─── LIVE STREAM DETECTION ──────────────────────────────────────────────────────
// Listens to the streams/ node and notifies once per stream the moment its
// status flips to 'live'. Bound once per session; safe to call repeatedly.
export function watchForLiveStreams() {
  if (_streamsListenerBound || !notificationsEnabled()) return;
  _streamsListenerBound = true;

  fbOnValue(fbRef(db, 'streams'), (snap) => {
    if (!snap.exists()) return;
    Object.entries(snap.val()).forEach(([id, s]) => {
      if (s.status === 'live' && !_knownLiveStreamIds.has(id)) {
        _knownLiveStreamIds.add(id);
        _show(`🔴 ${s.titulo} está en directo`, {
          body: `${s.ownerName || 'RBX Infinity'} está transmitiendo ahora`,
          icon: s.poster || 'favicon.ico',
          tag: `live-${id}`,
          data: { url: '#/streams' }
        });
      }
      if (s.status !== 'live') _knownLiveStreamIds.delete(id);
    });
  });
}

// Seed the "already live" set on load so a stream that was already live
// before notifications were enabled doesn't fire immediately.
export async function seedKnownLiveStreams() {
  try {
    const snap = await fbGet(fbRef(db, 'streams'));
    if (!snap.exists()) return;
    Object.entries(snap.val()).forEach(([id, s]) => {
      if (s.status === 'live') _knownLiveStreamIds.add(id);
    });
  } catch {}
}
