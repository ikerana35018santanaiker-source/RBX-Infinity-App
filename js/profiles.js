// js/profiles.js - Profile management module

import { db, ref, get, update } from './firebase.js';

const AVAILABLE_AVATARS = [
  'resources/avatars/avatar1.png',
  'resources/avatars/avatar2.png',
  'resources/avatars/avatar3.png',
  'resources/avatars/avatar4.png',
  'resources/avatars/avatar_5.png',
  'resources/avatars/avatar_6.png',
  'resources/avatars/avatar_7.png',
  'resources/avatars/avatar_8.png',
  'resources/avatars/avatar_9.png',
  'resources/avatars/avatar_10.png',
];

export function getAvailableAvatars() {
  return AVAILABLE_AVATARS;
}

export async function getProfiles(uid) {
  const snap = await get(ref(db, `users/${uid}/profiles`));
  return snap.exists() ? snap.val() : {};
}

export async function getActiveProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  if (!snap.exists()) return null;
  const data = snap.val();
  const activeId = data.activeProfile || 'default';
  return { id: activeId, ...data.profiles[activeId] };
}

export async function setActiveProfile(uid, profileId) {
  await update(ref(db, `users/${uid}`), { activeProfile: profileId });
}

export async function createProfile(uid, profileData) {
  const id = 'profile_' + Date.now();
  await update(ref(db, `users/${uid}/profiles`), {
    [id]: {
      id,
      name: profileData.name,
      avatar: profileData.avatar || AVAILABLE_AVATARS[0],
      myList: {},
      watching: {},
      language: profileData.language || 'es',
      isKids: profileData.isKids || false,
      maxRating: profileData.isKids ? 7 : (profileData.maxRating ?? null)
    }
  });
  return id;
}

export async function updateProfile(uid, profileId, data) {
  await update(ref(db, `users/${uid}/profiles/${profileId}`), data);
}

export async function deleteProfile(uid, profileId) {
  const snap = await get(ref(db, `users/${uid}`));
  const userData = snap.val();
  if (Object.keys(userData.profiles).length <= 1) throw new Error('No puedes eliminar el único perfil');
  const profiles = { ...userData.profiles };
  delete profiles[profileId];
  const newActive = profileId === userData.activeProfile ? Object.keys(profiles)[0] : userData.activeProfile;
  await update(ref(db, `users/${uid}`), { profiles, activeProfile: newActive });
}

export async function addToMyList(uid, profileId, contentId) {
  await update(ref(db, `users/${uid}/profiles/${profileId}/myList`), { [contentId]: true });
}

export async function removeFromMyList(uid, profileId, contentId) {
  const snap = await get(ref(db, `users/${uid}/profiles/${profileId}/myList`));
  if (snap.exists()) {
    const list = snap.val();
    delete list[contentId];
    await update(ref(db, `users/${uid}/profiles/${profileId}`), { myList: list });
  }
}

export async function getMyList(uid, profileId) {
  const snap = await get(ref(db, `users/${uid}/profiles/${profileId}/myList`));
  return snap.exists() ? Object.keys(snap.val()) : [];
}

export async function updateWatching(uid, profileId, contentId, progress, currentTime = 0) {
  await update(ref(db, `users/${uid}/profiles/${profileId}/watching`), {
    [contentId]: { progress, currentTime, updatedAt: Date.now() }
  });
}

export async function getWatching(uid, profileId) {
  const snap = await get(ref(db, `users/${uid}/profiles/${profileId}/watching`));
  return snap.exists() ? snap.val() : {};
}

// Manually remove a single title from "Seguir viendo" — used by the ✕
// button on continue-watching cards so a title the user didn't like stops
// showing up on the home screen.
export async function removeFromWatching(uid, profileId, contentId) {
  const snap = await get(ref(db, `users/${uid}/profiles/${profileId}/watching`));
  if (!snap.exists()) return;
  const watching = snap.val();
  delete watching[contentId];
  await update(ref(db, `users/${uid}/profiles/${profileId}`), { watching });
}

// ─── PARENTAL CONTROLS / RATING ──────────────────────────────────────────────
// Content in the catalog stores `rating` as free text: "NR", "+15 Años",
// "+18 Años", "TP", etc. This maps that text to a minimum-age number so it
// can be compared against a profile's maxRating.
export function parseRatingAge(rating) {
  if (!rating) return 0;
  const r = String(rating).toUpperCase();
  if (r === 'TP' || r === 'NR' || r.includes('TODOS')) return 0;
  const match = r.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// True if `item` is allowed to be shown/played on `profile`.
// Non-kids profiles with no maxRating set see everything.
export function isContentAllowed(item, profile) {
  if (!profile) return true;
  if (profile.maxRating == null) return true;
  return parseRatingAge(item?.rating) <= profile.maxRating;
}

// Filters a content array down to what's allowed for a profile.
export function filterAllowedContent(items, profile) {
  if (!profile || profile.maxRating == null) return items;
  return items.filter(item => isContentAllowed(item, profile));
}
