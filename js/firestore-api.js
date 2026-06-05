// js/firestore-api.js
// Single data-access layer. All Firestore reads/writes go through here.
// UI files import named functions — they never import Firestore SDK directly.

import {
  doc, getDoc, setDoc, updateDoc, deleteField,
  collection, getDocs, serverTimestamp,
  runTransaction, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { db } from "./firebase-config.js";
import { isWeekend, fellowshipMonths } from "./utils.js";

// =============================================================================
// Section 1: Auth code → fellow lookup (used during login)
// =============================================================================

/**
 * Look up an auth code. Returns { name, fellowNumber, role } if found, else null.
 * Caller is responsible for being signed in (anonymously) before calling.
 */
export async function lookupAuthCode(code) {
  const snap = await getDoc(doc(db, "auth_codes", code));
  if (!snap.exists()) return null;
  return snap.data();
}

/**
 * Write the current user's session doc, mapping their Firebase UID to fellow info.
 * Called immediately after successful auth code lookup.
 *
 * `code` is the login code the user typed. The security rules re-verify the
 * written role/fellowNumber against auth_codes/{code} server-side, so a client
 * cannot forge a master session. It is stored only in the user's own session
 * doc (readable solely by them).
 */
export async function writeUserSession(uid, fellowNumber, role, code) {
  await setDoc(doc(db, "user_sessions", uid), {
    fellowNumber,
    role,
    code,
    lastLoginAt: serverTimestamp(),
  });
}

// =============================================================================
// Section 2: Fellows (static reference data)
// =============================================================================

/**
 * Fetch all 8 fellows as an array, sorted by fellowNumber ascending.
 * Returns: [{ fellowNumber, name, color }, ...]
 */
export async function fetchAllFellows() {
  const snap = await getDocs(collection(db, "fellows"));
  const fellows = snap.docs.map(d => d.data());
  fellows.sort((a, b) => a.fellowNumber - b.fellowNumber);
  return fellows;
}

// =============================================================================
// Section 3: Holidays
// =============================================================================

/**
 * Fetch holidays for a month. Returns array (possibly empty), or [] if doc missing.
 * Shape: [{ date: "2026-07-28", name: "...", custom: false }, ...]
 */
export async function fetchHolidays(monthKey) {
  const snap = await getDoc(doc(db, "holidays", monthKey));
  if (!snap.exists()) return [];
  return snap.data().dates || [];
}

/**
 * Add a custom holiday to a month. Master only.
 * Uses read-modify-write — fine because holidays are low-contention.
 */
export async function addCustomHoliday(monthKey, dateStr, name) {
  const ref = doc(db, "holidays", monthKey);
  const snap = await getDoc(ref);
  const current = snap.exists() ? (snap.data().dates || []) : [];

  // Reject duplicates on the same date.
  if (current.some(h => h.date === dateStr)) {
    throw new Error(`Date ${dateStr} already has a holiday`);
  }

  const next = [...current, { date: dateStr, name, custom: true }];
  // Sort by date for stable display.
  next.sort((a, b) => a.date.localeCompare(b.date));

  await setDoc(ref, { dates: next }, { merge: true });
}

/**
 * Remove a custom holiday. Master only. Refuses to delete non-custom (seeded) ones.
 */
export async function removeCustomHoliday(monthKey, dateStr) {
  const ref = doc(db, "holidays", monthKey);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const current = snap.data().dates || [];

  const target = current.find(h => h.date === dateStr);
  if (!target) return;
  if (target.custom !== true) {
    throw new Error("Cannot delete seeded (non-custom) holidays");
  }

  const next = current.filter(h => h.date !== dateStr);
  await setDoc(ref, { dates: next }, { merge: true });
}

// =============================================================================
// Section 4: Avoid requests
// =============================================================================

/**
 * Fetch the avoid_requests doc for a month.
 * Returns { allowRequests: bool, requests: { "<fellowNumber>": [dateStrs] } }.
 * If doc doesn't exist, returns a default-shaped object.
 */
export async function fetchAvoidRequests(monthKey) {
  const snap = await getDoc(doc(db, "avoid_requests", monthKey));
  if (!snap.exists()) {
    return { allowRequests: false, requests: {} };
  }
  const data = snap.data();
  return {
    allowRequests: data.allowRequests === true,
    requests: data.requests || {},
  };
}

/**
 * Master toggles the allowRequests flag for a month.
 */
export async function setAllowRequests(monthKey, allow) {
  const ref = doc(db, "avoid_requests", monthKey);
  // Use setDoc with merge to create-or-update.
  await setDoc(ref, { allowRequests: !!allow }, { merge: true });
}

/**
 * Toggle a single avoid date for a fellow.
 * If the date is in their list, remove it. Otherwise, add it.
 *
 * Uses a transaction to prevent two simultaneous toggles from clobbering each other.
 * This matters if a master rapidly toggles multiple dates for different fellows,
 * or if a fellow has the app open in two tabs.
 */
export async function toggleAvoidDate(monthKey, fellowNumber, dateStr) {
  const ref = doc(db, "avoid_requests", monthKey);
  const slot = String(fellowNumber);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists() ? snap.data() : { allowRequests: false, requests: {} };
    const requests = { ...(data.requests || {}) };
    const current = requests[slot] || [];

    let next;
    if (current.includes(dateStr)) {
      next = current.filter(d => d !== dateStr);
    } else {
      next = [...current, dateStr].sort();
    }

    requests[slot] = next;
    // Use set with merge to preserve allowRequests and other fields.
    tx.set(ref, { requests }, { merge: true });
  });
}

// =============================================================================
// Section 5: Shift table
// =============================================================================

/**
 * Fetch shift_table doc for a month.
 * Returns { premiered, premieredAt, premieredAtICT, lastUnpremieredAt, shifts }.
 * If doc missing, returns sensible defaults.
 *
 * `shifts` is normalized to the flat schema { dateStr: fellowNum } regardless
 * of whether the stored doc uses the old { dateStr: {lineA, lineB} } format.
 */
export async function fetchShiftTable(monthKey) {
  const snap = await getDoc(doc(db, "shift_table", monthKey));
  if (!snap.exists()) {
    return {
      premiered: false,
      premieredAt: null,
      premieredAtICT: "",
      lastUnpremieredAt: null,
      shifts: {},
    };
  }
  const data = snap.data();
  return { ...data, shifts: normalizeShifts(data.shifts || {}) };
}

/**
 * Real-time subscription to a shift_table doc. Returns an unsubscribe function.
 * Use this in the user view to auto-refresh when master saves.
 *
 * Callback receives the same shape as fetchShiftTable — shifts is normalized
 * to flat { dateStr: fellowNum } form.
 */
export function subscribeShiftTable(monthKey, callback) {
  const ref = doc(db, "shift_table", monthKey);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      callback({
        premiered: false, premieredAt: null, premieredAtICT: "",
        lastUnpremieredAt: null, shifts: {}
      });
    } else {
      const data = snap.data();
      callback({ ...data, shifts: normalizeShifts(data.shifts || {}) });
    }
  });
}

/**
 * Normalize a raw shifts map from Firestore into flat { dateStr: fellowNum }.
 * Accepts the legacy { dateStr: {lineA, lineB} } shape and migrates it lazily.
 */
function normalizeShifts(raw) {
  const out = {};
  for (const [date, val] of Object.entries(raw)) {
    if (val == null) continue;
    if (typeof val === "number") {
      out[date] = val;
    } else if (typeof val === "object" && val.lineA != null) {
      // Legacy schema: take Line A, drop Line B entirely (per new design).
      out[date] = val.lineA;
    }
    // Anything else: silently drop.
  }
  return out;
}

/**
 * Commit a batch of pending shift assignments for one month. Master only.
 *
 * Replaces the per-cell writeShiftCell API. All pending changes for the
 * month land in a single Firestore transaction:
 *   - shift_table.shifts is updated with the new values.
 *   - Every fellow's shift_counts.byMonth[monthKey] is recomputed from
 *     the new authoritative state (no delta accounting — eliminates drift).
 *
 * @param monthKey  "YYYY-MM"
 * @param pending   { dateStr: fellowNum | null } — null clears the cell.
 *                  Pass an empty object for a no-op.
 *
 * Returns { written: number } on success. Throws on rules denial or transaction failure.
 *
 * IMPORTANT: This function does NOT validate the scheduling rules
 * (no-consecutive-days, avoid-conflict). The caller (sheet2.js) must run
 * client-side validation before calling. Firestore rules only enforce
 * who can write, not what's logically consistent.
 */
export async function commitShiftChanges(monthKey, pending) {
  const dates = Object.keys(pending || {});
  if (dates.length === 0) {
    return { written: 0 };
  }

  const shiftRef = doc(db, "shift_table", monthKey);
  const holidaysRef = doc(db, "holidays", monthKey);

  await runTransaction(db, async (tx) => {
    // ---- READ PHASE ----
    const shiftSnap = await tx.get(shiftRef);
    const holSnap = await tx.get(holidaysRef);

    const oldDocData = shiftSnap.exists() ? shiftSnap.data() : { premiered: false };
    const oldShifts = normalizeShifts(oldDocData.shifts || {});
    const holidayDates = holSnap.exists()
      ? (holSnap.data().dates || []).map(h => h.date)
      : [];

    // Apply pending changes in memory.
    const newShifts = { ...oldShifts };
    for (const [date, fn] of Object.entries(pending)) {
      if (fn == null) {
        delete newShifts[date];
      } else {
        newShifts[date] = fn;
      }
    }

    // ---- WRITE PHASE ----
    // We need to fully REPLACE the shifts map (not merge), because deleting
    // a cell must remove the key — Firestore's set+merge deep-merges nested
    // maps and would leave the old key behind. Solution: write the whole doc
    // with all top-level fields preserved, but shifts wholesale-replaced.
    // This also auto-migrates any legacy { lineA, lineB } entries into the
    // flat schema, since oldShifts came through normalizeShifts above.
    const newDoc = { ...oldDocData, shifts: newShifts };
    tx.set(shiftRef, newDoc);

    // Recompute byMonth[monthKey] for every fellow from the authoritative
    // post-edit shifts state. Use set+merge with a nested object (rather than
    // a dotted-path update) so the write also creates the shift_counts doc if
    // it doesn't exist yet — tx.update would throw on a missing doc.
    for (let fn = 1; fn <= 8; fn++) {
      const counts = recomputeMonthCountFromShifts(newShifts, fn, holidayDates);
      tx.set(doc(db, "shift_counts", String(fn)), {
        byMonth: { [monthKey]: counts },
      }, { merge: true });
    }
  });

  return { written: dates.length };
}

/**
 * Private helper: count occurrences of `fellowNum` in a flat shifts map,
 * categorized as weekday vs weekendHoliday.
 */
function recomputeMonthCountFromShifts(shifts, fellowNum, holidayDates) {
  let weekday = 0;
  let weekendHoliday = 0;
  for (const [dateStr, val] of Object.entries(shifts)) {
    // Tolerate both flat and legacy-wrapped formats defensively.
    const fn = (typeof val === "object" && val !== null) ? val.lineA : val;
    if (fn !== fellowNum) continue;
    if (isWeekend(dateStr) || holidayDates.includes(dateStr)) {
      weekendHoliday++;
    } else {
      weekday++;
    }
  }
  return { weekday, weekendHoliday };
}

/**
 * Reconcile shift_counts against shift_table for ALL 12 fellowship months.
 * For each fellow, recompute byMonth from authoritative shift_table data
 * and overwrite shift_counts/{fellowNum} with the corrected totals.
 *
 * Called silently by sheet2.js when the master opens Sheet 2 — self-heals
 * any drift left over from old delta-accounting bugs or partial writes.
 *
 * Master-only (rules enforce this; will throw permission-denied for users).
 *
 * Returns: number of fellow docs that were actually corrected (0 if all
 * already in sync).
 */
export async function reconcileAllCounts() {
  const months = fellowshipMonths();

  const [shiftDocs, holDocs, countsSnap] = await Promise.all([
    Promise.all(months.map(mk => getDoc(doc(db, "shift_table", mk)))),
    Promise.all(months.map(mk => getDoc(doc(db, "holidays", mk)))),
    getDocs(collection(db, "shift_counts")),
  ]);

  // Build expected byMonth per fellow from authoritative shift_table data.
  const expectedByMonth = {};
  for (let fn = 1; fn <= 8; fn++) expectedByMonth[fn] = {};

  for (let i = 0; i < months.length; i++) {
    const mk = months[i];
    const shifts = shiftDocs[i].exists() ? (shiftDocs[i].data().shifts || {}) : {};
    const holidayDates = holDocs[i].exists()
      ? (holDocs[i].data().dates || []).map(h => h.date)
      : [];
    for (let fn = 1; fn <= 8; fn++) {
      expectedByMonth[fn][mk] = recomputeMonthCountFromShifts(shifts, fn, holidayDates);
    }
  }

  // Compare each fellow's current vs expected, correct on mismatch.
  let corrected = 0;
  for (const cd of countsSnap.docs) {
    const fn = parseInt(cd.id, 10);
    if (isNaN(fn) || fn < 1 || fn > 8) continue;
    const current = cd.data().byMonth || {};
    const expected = expectedByMonth[fn];

    let mismatch = false;
    for (const mk of months) {
      const cur = current[mk] || { weekday: 0, weekendHoliday: 0 };
      const exp = expected[mk];
      if (cur.weekday !== exp.weekday || cur.weekendHoliday !== exp.weekendHoliday) {
        mismatch = true;
        break;
      }
    }

    if (mismatch) {
      // Full overwrite (no merge). lifetime is derived from byMonth so it
      // can never drift apart from per-month totals.
      const lifetime = sumLifetimeFromByMonth(expected);
      await setDoc(doc(db, "shift_counts", String(fn)), {
        byMonth: expected,
        lifetime,
      });
      corrected++;
    }
  }

  return corrected;
}

function sumLifetimeFromByMonth(byMonth) {
  let weekday = 0;
  let weekendHoliday = 0;
  for (const counts of Object.values(byMonth)) {
    weekday += counts.weekday || 0;
    weekendHoliday += counts.weekendHoliday || 0;
  }
  return { weekday, weekendHoliday, total: weekday + weekendHoliday };
}

/**
 * Premier a month: lock it from edits. Master only.
 * Sets premiered=true and stamps the timestamp.
 */
export async function premierMonth(monthKey, ictFormatter) {
  const ref = doc(db, "shift_table", monthKey);
  // We compute ICT string client-side using serverTimestamp() approximation.
  // Note: ictFormatter is called with a fresh JS Date — it represents client time,
  // not server time. Server timestamp is still stored separately for audit.
  // For display, we'll re-format premieredAt from the server timestamp on read.
  await setDoc(ref, {
    premiered: true,
    premieredAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * Unpremier a month: unlock it. Master only.
 */
export async function unpremierMonth(monthKey) {
  const ref = doc(db, "shift_table", monthKey);
  await setDoc(ref, {
    premiered: false,
    lastUnpremieredAt: serverTimestamp(),
  }, { merge: true });
}

// =============================================================================
// Section 6: Shift counts
// =============================================================================

/**
 * Fetch all 8 shift_counts docs as a map: { 1: {lifetime, byMonth}, 2: {...}, ... }.
 */
export async function fetchAllShiftCounts() {
  const snap = await getDocs(collection(db, "shift_counts"));
  const result = {};
  snap.docs.forEach(d => {
    result[d.id] = d.data();
  });
  return result;
}