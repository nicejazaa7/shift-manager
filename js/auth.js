// js/auth.js
// Login, logout, and session restoration.
// The login flow is:
//   1. User types code in login screen.
//   2. signInAnonymously() — gets a Firebase UID (a stable anonymous identity).
//   3. Look up auth_codes/{code} — verify code exists, get name/fellowNumber/role.
//   4. Write user_sessions/{uid} with the fellow info.
//   5. Store {fellowNumber, name, role} in sessionStorage for the tab session.
//   6. Render the main app.
//
// Logout:
//   - Clear sessionStorage.
//   - signOut() to drop the Firebase auth state.
//   - Reload page to return to login screen.

import {
  signInAnonymously,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { auth } from "./firebase-config.js";
import { lookupAuthCode, writeUserSession } from "./firestore-api.js";

// =============================================================================
// Section 1: Session storage helpers
// =============================================================================
// We use sessionStorage (not localStorage) so closing the tab logs you out.
// This is appropriate for a shared-device scenario (clinical workstations).
// localStorage would persist forever, which is risky in a hospital setting.

const SESSION_KEY = "shiftmgr.session";

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// =============================================================================
// Section 2: Public API
// =============================================================================

/**
 * Return current session, or null if not logged in.
 * Shape: { uid, fellowNumber, name, role, color }
 */
export function currentSession() {
  return loadSession();
}

/**
 * True if the current user is the master.
 */
export function isMaster() {
  const s = loadSession();
  return s !== null && s.role === "master";
}

/**
 * Attempt to log in with a code.
 *
 * @param code  string typed by user
 * @returns     { success: true, session } on success
 *              { success: false, error: "..." } on failure
 *
 * Does NOT throw on bad codes — returns structured error for UI to display.
 * DOES throw on unexpected errors (network, permission denied) — caller logs.
 */
export async function login(code) {
  const trimmed = (code || "").trim();
  if (!trimmed) {
    return { success: false, error: "Please enter a code" };
  }

  // Step 1: anonymous sign-in. This gets us a Firebase UID.
  // If the user is already signed in (e.g., from a previous session), we
  // still re-sign-in to get a fresh UID — simpler than reusing.
  let userCredential;
  try {
    userCredential = await signInAnonymously(auth);
  } catch (err) {
    console.error("Anonymous sign-in failed:", err);
    return { success: false, error: "Sign-in failed. Check your internet connection." };
  }

  const uid = userCredential.user.uid;

  // Step 2: look up the code in auth_codes.
  let fellow;
  try {
    fellow = await lookupAuthCode(trimmed);
  } catch (err) {
    console.error("Code lookup failed:", err);
    // Sign out to avoid a dangling anonymous session.
    await signOut(auth).catch(() => {});
    return { success: false, error: "Unable to verify code. Try again." };
  }

  if (!fellow) {
    // Bad code: clean up the anonymous auth state.
    await signOut(auth).catch(() => {});
    return { success: false, error: "Invalid code" };
  }

  // Step 3: write the session doc. Firestore rules verify it on the server.
  // We pass the code so the rules can re-check role/fellowNumber against
  // auth_codes/{code} — this is what prevents a forged 'master' session.
  try {
    await writeUserSession(uid, fellow.fellowNumber, fellow.role, trimmed);
  } catch (err) {
    console.error("Session write failed:", err);
    await signOut(auth).catch(() => {});
    return { success: false, error: "Could not establish session. Try again." };
  }

  // Step 4: store session in sessionStorage.
  // We include color here for convenience — UI uses it often, and re-fetching
  // every render is wasteful. Color is denormalized from fellows/{fellowNumber}.
  const session = {
    uid,
    fellowNumber: fellow.fellowNumber,
    name: fellow.name,
    role: fellow.role,
    // color is filled in by the caller (main app init) after fetching fellows.
    // We don't fetch it here because auth.js shouldn't know about the fellows
    // collection layout — keeps responsibilities clean.
  };
  saveSession(session);

  return { success: true, session };
}

/**
 * Update the cached session with additional fields (e.g., color).
 * Used by main app to attach color after the fellows collection is fetched.
 */
export function patchSession(patch) {
  const s = loadSession();
  if (!s) return;
  saveSession({ ...s, ...patch });
}

/**
 * Log out: clear local session, sign out of Firebase, reload page.
 */
export async function logout() {
  clearSession();
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Sign-out error (non-fatal):", err);
  }
  // Force a full page reload to wipe in-memory state.
  window.location.reload();
}

// =============================================================================
// Section 3: Auth state observer (defensive)
// =============================================================================

/**
 * Subscribe to Firebase auth state changes. Fires when sign-in/sign-out happens.
 * We use this to detect inconsistency (e.g., Firebase signed us out but
 * sessionStorage still claims a session). If detected, clear session.
 */
export function watchAuthState(onChange) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      // Firebase says no auth — make sure our local session is clear too.
      const local = loadSession();
      if (local) {
        clearSession();
      }
    }
    if (onChange) onChange(user);
  });
}