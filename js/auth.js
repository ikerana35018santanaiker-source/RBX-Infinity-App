// js/auth.js - Authentication module for RBX Infinity

import {
  auth,
  db,
  googleProvider,
  ref,
  set,
  get,
  update
} from './firebase.js';

import {
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ─── GOOGLE ───────────────────────────────────────────────────────────────────
export async function loginWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(result.user);
  return result.user;
}

// ─── REGISTER — direct, no verification code needed ──────────────────────────
export async function registerUser(username, email, password) {
  // Flag to prevent onAuthStateChanged from creating a duplicate profile
  window._registrationInProgress = true;
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(result.user, { displayName: username });
    await ensureUserProfile(result.user, username);
    return result.user;
  } finally {
    setTimeout(() => { window._registrationInProgress = false; }, 2000);
  }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export async function loginWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  await ensureUserProfile(result.user);
  return result.user;
}

// ─── PASSWORD RESET ───────────────────────────────────────────────────────────
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// ─── LOGOUT ──────────────────────────────────────────────────────────────────
export async function logout() {
  await signOut(auth);
}

// ─── AUTH STATE ───────────────────────────────────────────────────────────────
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

// ─── USER PROFILE ─────────────────────────────────────────────────────────────
export async function ensureUserProfile(user, overrideName = null) {
  const userRef = ref(db, `users/${user.uid}`);
  const snap = await get(userRef);
  // Only create once — prevents double profile on registration
  if (!snap.exists()) {
    const name = overrideName || user.displayName || user.email.split('@')[0];
    await set(userRef, {
      email:       user.email,
      displayName: name,
      username:    name,
      createdAt:   Date.now(),
      banned:      false,
      isAdmin:     false,
      profiles: {
        default: {
          id:       'default',
          name,
          avatar:   'resources/avatars/avatar1.png',
          myList:   {},
          watching: {},
          language: 'es',
          isKids:   false,
          maxRating: null
        }
      },
      activeProfile: 'default',
      parentalPin: null
    });
  }
}

export async function getUserData(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function updateUserData(uid, data) {
  await update(ref(db, `users/${uid}`), data);
}

// ─── PARENTAL PIN ─────────────────────────────────────────────────────────────
// A single 4-digit PIN per account, used to gate creating/editing non-kids
// profiles and switching a kids profile's restrictions off. Stored as plain
// text in the DB (same trust model as the rest of this app's user data) —
// it's a household lock, not an account credential.
export async function setParentalPin(uid, pin) {
  await update(ref(db, `users/${uid}`), { parentalPin: pin });
}

export async function checkParentalPin(uid, pin) {
  const snap = await get(ref(db, `users/${uid}/parentalPin`));
  const stored = snap.exists() ? snap.val() : null;
  if (!stored) return true; // no PIN set — nothing to check
  return stored === pin;
}

export async function hasParentalPin(uid) {
  const snap = await get(ref(db, `users/${uid}/parentalPin`));
  return snap.exists() && !!snap.val();
}
