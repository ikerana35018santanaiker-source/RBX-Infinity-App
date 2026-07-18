// js/firebase.js - Firebase configuration and initialization

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase, ref, set, get, update, push, onValue, remove } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const firebaseConfig = {
  apiKey: "AIzaSyARiBf3ZqxX_58pVYd3l22lE3brHQLvDVg",
  authDomain: "haha-guys.firebaseapp.com",
  databaseURL: "https://haha-guys-default-rtdb.firebaseio.com",
  projectId: "haha-guys",
  storageBucket: "haha-guys.firebasestorage.app",
  messagingSenderId: "19532501458",
  appId: "1:19532501458:web:afb20932a983503da1f80b",
  measurementId: "G-D7CSDBK69R"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();
export { ref, set, get, update, push, onValue, remove };
