// js/firebase-config.js
// Public Firebase configuration. Safe to commit to a public repo.
// Security is enforced by firestore.rules, NOT by hiding this config.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCpk-6H8PmjZbhYtgQHXyeYbM9Q8Vsj340",
  authDomain: "shift-manager-7acec.firebaseapp.com",
  projectId: "shift-manager-7acec",
  storageBucket: "shift-manager-7acec.firebasestorage.app",
  messagingSenderId: "152164832281",
  appId: "1:152164832281:web:676678602bf156f0f6c688",
  measurementId: "G-ZR4WB7Q7VX"
};

// Initialize Firebase once. All other modules import `app`, `auth`, `db` from here.
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };