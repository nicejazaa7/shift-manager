// js/sheet2.js
// Sheet 2 — single-month calendar editor with pending-changes overlay.
//
// Architecture
// ------------
// Saved state (Firestore)   : _ctx.shiftDoc.shifts  — { dateStr: fellowNum }
// Pending overlay (in-memory): _ctx.pending          — { dateStr: fellowNum|null }
//                                                      null = "clear this cell"
// What the UI shows         : merged = { ...saved, ...pendingNonNull }
//                             pendingNull dates removed from merged
//
// The master makes any number of edits; they accumulate in _ctx.pending.
// The counts panel updates instantly from the merged view. Nothing is
// written to Firestore until the master clicks "Save changes", at which
// point commitShiftChanges runs one atomic transaction that updates
// shift_table.shifts and recomputes shift_counts.byMonth[monthKey] for
// every fellow. "Discard changes" wipes the overlay without persisting.
//
// Why this design
// ---------------
// The old per-cell auto-save model produced two pathologies:
//   1. Every change triggered subscribeShiftTable → full re-render →
//      dropdown destroyed mid-click → user appeared to "lose" their pick.
//   2. innerHTML replacement scrolled the page to the top, infuriating
//      to edit dates near day 31.
// Batching writes severs the UX loop from network latency entirely.

import { isMaster } from "./auth.js";
import {
  fetchAvoidRequests, fetchHolidays, fetchShiftTable,
  fetchAllShiftCounts, subscribeShiftTable,
  commitShiftChanges, premierMonth, unpremierMonth,
  reconcileAllCounts,
} from "./firestore-api.js";
import {
  parseYMD, daysInMonth, dayOfWeek, allDatesInMonth,
  isWeekend, findHoliday, isWeekendOrHoliday,
  prevDate, nextDate, monthKeyOf, monthLabel, formatICT,
} from "./utils.js";

let _state = null;
let _container = null;
let _unsubShiftTable = null;

let _ctx = {
  monthKey: null,
  avoidDoc: null,
  holidays: [],
  shiftDoc: null,          // { premiered, shifts: { dateStr: fellowNum } }
  pending: {},             // { dateStr: fellowNum | null }
  counts: {},              // shift_counts keyed by String(fellowNumber)
  boundary: {},            // { adjacentBoundaryDateStr: fellowNum } from neighbor months
  validationErrors: new Set(),  // dateStrs flagged at the most recent save attempt
};

// =============================================================================
// Public init
// =============================================================================
export function initSheet2({ state, getCurrentMonth }) {
  _state = state;
  _container = document.getElementById("sheet2");

  _container.addEventListener("sheet:render", async (ev) => {
    const monthKey = ev.detail.monthKey || getCurrentMonth();
    const monthChanged = _ctx.monthKey !== monthKey;
    if (_unsubShiftTable) { _unsubShiftTable(); _unsubShiftTable = null; }
    // Preserve pending across tab switches on the same month; reset on month change.
    if (monthChanged) {
      _ctx.pending = {};
      _ctx.validationErrors = new Set();
    }
    await renderSheet2(monthKey);
  });

  // Exposed for the month-switch guard in index.html. Returns true if there
  // are unsaved edits — the caller should block navigation and prompt.
  window.sheet2HasPendingChanges = () => Object.keys(_ctx.pending).length > 0;
}

// =============================================================================
// Top-level render
// =============================================================================
async function renderSheet2(monthKey) {
  _ctx.monthKey = monthKey;
  _container.innerHTML = `<div class="empty-state">Loading…</div>`;

  try {
    const [avoidDoc, holidays, shiftDoc, counts, boundary] = await Promise.all([
      fetchAvoidRequests(monthKey),
      fetchHolidays(monthKey),
      fetchShiftTable(monthKey),
      fetchAllShiftCounts(),
      fetchBoundaryAssignments(monthKey),
    ]);
    _ctx.avoidDoc = avoidDoc;
    _ctx.holidays = holidays;
    _ctx.shiftDoc = shiftDoc;
    _ctx.counts = counts;
    _ctx.boundary = boundary;
  } catch (err) {
    console.error("Sheet2 load failed:", err);
    _container.innerHTML = `<div class="empty-state">Failed to load. Check console.</div>`;
    return;
  }

  // Self-heal shift_counts against shift_table (master only). Silent —
  // only logs if anything was actually corrected.
  if (isMaster()) {
    try {
      const fixed = await reconcileAllCounts();
      if (fixed > 0) {
        console.info(`[reconcile] Corrected ${fixed} fellow count doc(s).`);
        _ctx.counts = await fetchAllShiftCounts();
      }
    } catch (err) {
      console.warn("Count reconcile failed (non-fatal):", err);
    }
  }

  const master = isMaster();
  const premiered = _ctx.shiftDoc.premiered === true;
  const everPremiered = !!_ctx.shiftDoc.premieredAt;

  // Non-master + not-yet-premiered → wait screen.
  if (!master && !premiered && !everPremiered) {
    _container.innerHTML = `<div class="please-wait">PLEASE WAIT !!</div>`;
    return;
  }

  renderFullLayout();

  // Subscribe to shift_table changes from other clients (e.g. another tab).
  // While we have pending edits, we silently update _ctx.shiftDoc but DO NOT
  // re-render — that would blow away the master's in-progress overlay.
  _unsubShiftTable = subscribeShiftTable(monthKey, (newData) => {
    if (!newData) return;
    _ctx.shiftDoc = newData;
    if (Object.keys(_ctx.pending).length === 0) {
      renderFullLayout();
    }
  });
}

// =============================================================================
// Layout: toolbar + counts + calendar
// =============================================================================
function renderFullLayout() {
  _container.innerHTML = `
    <div class="s2-toolbar" id="s2Toolbar"></div>
    <div class="s2-main">
      <div class="s2-counts" id="s2Counts"></div>
      <div class="s2-calendar" id="s2Calendar"></div>
    </div>
  `;
  renderToolbar();
  renderCountsPanel();
  renderCalendar();
  if (isMaster() && _ctx.shiftDoc.premiered !== true) wireCalendar();
}

function renderToolbar() {
  const master = isMaster();
  const premiered = _ctx.shiftDoc.premiered === true;
  const pendingCount = Object.keys(_ctx.pending).length;
  const premieredAtICT = formatICT(_ctx.shiftDoc.premieredAt);
  const unpremieredAtICT = formatICT(_ctx.shiftDoc.lastUnpremieredAt);
  const tb = document.getElementById("s2Toolbar");

  if (!master) {
    // User view — read-only status.
    if (premiered) {
      tb.innerHTML = `<span class="premier-status">Premiered: <strong>${premieredAtICT || '—'}</strong></span>`;
    } else {
      tb.innerHTML = `<span class="premier-status">Last updated: <strong>${unpremieredAtICT || premieredAtICT || '—'}</strong> — currently being edited</span>`;
    }
    return;
  }

  // Master view.
  if (premiered) {
    tb.innerHTML = `
      <span class="premier-status">Premiered: <strong>${premieredAtICT || '—'}</strong></span>
      <button id="premierBtn" class="premier-btn amber">UNPREMIER</button>
    `;
    document.getElementById("premierBtn").addEventListener("click", () => onPremierToggle(true));
    return;
  }

  const lastInfo = unpremieredAtICT
    ? `<span class="premier-status">Last unpremiered: <strong>${unpremieredAtICT}</strong></span>`
    : `<span class="premier-status">Not yet premiered</span>`;
  const pendingLabel = pendingCount > 0
    ? `<span class="pending-status"><strong>${pendingCount}</strong> unsaved change${pendingCount === 1 ? '' : 's'}</span>`
    : `<span class="pending-status saved">All changes saved</span>`;

  // Premier gating: can't premier while avoid requests are open. Forces master
  // to close requests in Sheet 1 first; otherwise a fellow could add an avoid
  // date AFTER premier and silently conflict with the locked schedule.
  const allowReq = _ctx.avoidDoc && _ctx.avoidDoc.allowRequests === true;
  const premierDisabled = pendingCount > 0 || allowReq;
  let premierTitle = "";
  if (allowReq) premierTitle = "Close avoid requests in Sheet 1 before premiering";
  else if (pendingCount > 0) premierTitle = "Save or discard pending changes first";

  tb.innerHTML = `
    ${lastInfo}
    ${pendingLabel}
    <button id="discardBtn" class="discard-btn" ${pendingCount === 0 ? 'disabled' : ''}>Discard</button>
    <button id="saveBtn" class="save-btn" ${pendingCount === 0 ? 'disabled' : ''}>Save changes${pendingCount > 0 ? ` (${pendingCount})` : ''}</button>
    <button id="premierBtn" class="premier-btn green" ${premierDisabled ? 'disabled' : ''} title="${premierTitle}">PREMIER</button>
  `;
  document.getElementById("discardBtn").addEventListener("click", onDiscard);
  document.getElementById("saveBtn").addEventListener("click", onSave);
  document.getElementById("premierBtn").addEventListener("click", () => onPremierToggle(false));
}

function renderCountsPanel() {
  const fellows = _state.fellows;
  const monthKey = _ctx.monthKey;
  const merged = mergedShifts();

  const monthRows = fellows.map(f => {
    const c = computeMonthCountFromShifts(merged, f.fellowNumber);
    return `
      <tr>
        <td><span class="fellow-chip" style="background:${f.color}">${escapeHtml(f.name)}</span></td>
        <td class="col-wd">${c.weekday}</td>
        <td class="col-wh">${c.weekendHoliday}</td>
      </tr>
    `;
  }).join("");

  const lifetimeRows = fellows.map(f => {
    const c = computeLifetimeFromCountsAndMerged(f.fellowNumber, merged);
    return `
      <tr>
        <td><span class="fellow-chip" style="background:${f.color}">${escapeHtml(f.name)}</span></td>
        <td class="col-wd">${c.weekday}</td>
        <td class="col-wh">${c.weekendHoliday}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("s2Counts").innerHTML = `
    <div class="count-panel">
      <h4>This month — ${monthLabel(monthKey)}</h4>
      <table class="count-table">
        <thead><tr><th></th><th class="col-wd">WD</th><th class="col-wh">WE/H</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table>
      <div class="count-divider"></div>
      <h4>Cumulative since Jul 2026</h4>
      <table class="count-table">
        <thead><tr><th></th><th class="col-wd">WD</th><th class="col-wh">WE/H</th></tr></thead>
        <tbody>${lifetimeRows}</tbody>
      </table>
    </div>
  `;
}

function renderCalendar() {
  const monthKey = _ctx.monthKey;
  const { year, month } = parseYMD(monthKey + "-01");
  const firstDow = dayOfWeek(monthKey + "-01");
  const totalDays = daysInMonth(year, month);
  const merged = mergedShifts();
  const master = isMaster();
  const premiered = _ctx.shiftDoc.premiered === true;
  const editable = master && !premiered;

  const weekdayHeaders = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
    .map(d => `<div class="cal2-weekday">${d}</div>`).join("");

  let cells = "";
  for (let i = 0; i < firstDow; i++) {
    cells += `<div class="cal2-cell pad"></div>`;
  }

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${monthKey}-${String(d).padStart(2,"0")}`;
    const we = isWeekend(dateStr);
    const hol = findHoliday(dateStr, _ctx.holidays);
    const isNonWorking = we || hol;
    const isPending = dateStr in _ctx.pending;
    const isInvalid = _ctx.validationErrors.has(dateStr);
    const currentVal = merged[dateStr] != null ? merged[dateStr] : null;

    const classes = [
      "cal2-cell",
      isNonWorking ? "non-working" : "",
      isPending ? "pending" : "",
      isInvalid ? "invalid" : "",
    ].filter(Boolean).join(" ");

    const pickHtml = editable
      ? renderSelect(dateStr, currentVal)
      : renderStaticChip(currentVal);

    cells += `
      <div class="${classes}" data-date="${dateStr}">
        <div class="cal2-head">
          <span class="cal2-day-num">${d}</span>
          ${hol ? `<span class="cal2-hol" title="${escapeHtml(hol.name)}">${escapeHtml(hol.name)}</span>` : ""}
        </div>
        <div class="cal2-dots">${renderAvoidDots(dateStr)}</div>
        <div class="cal2-pick">${pickHtml}</div>
      </div>
    `;
  }

  document.getElementById("s2Calendar").innerHTML = `
    <div class="cal2-weekdays">${weekdayHeaders}</div>
    <div class="cal2-grid">${cells}</div>
  `;
}

function renderAvoidDots(dateStr) {
  const requests = (_ctx.avoidDoc && _ctx.avoidDoc.requests) || {};
  const markedBy = [];
  for (const [fnStr, dates] of Object.entries(requests)) {
    if (dates.includes(dateStr)) markedBy.push(parseInt(fnStr, 10));
  }
  return markedBy.map(fn => {
    const f = _state.fellowsByNum[fn];
    if (!f) return "";
    return `<span class="cal2-dot" style="background:${f.color}" title="${escapeHtml(f.name)} avoid">${fn}</span>`;
  }).join("");
}

function renderSelect(dateStr, currentVal) {
  const fellows = _state.fellows;
  const options = [`<option value="">—</option>`];
  fellows.forEach(f => {
    const selected = (currentVal === f.fellowNumber) ? "selected" : "";
    options.push(`<option value="${f.fellowNumber}" ${selected}>${f.fellowNumber} — ${escapeHtml(f.name)}</option>`);
  });
  let bgStyle = "";
  if (currentVal != null) {
    const f = _state.fellowsByNum[currentVal];
    if (f) bgStyle = `background:${f.color}; color:white; font-weight:600;`;
  }
  return `<select class="cal2-select" data-date="${dateStr}" style="${bgStyle}">${options.join("")}</select>`;
}

function renderStaticChip(currentVal) {
  if (currentVal == null) {
    return `<div class="cal2-chip empty">—</div>`;
  }
  const f = _state.fellowsByNum[currentVal];
  if (!f) return `<div class="cal2-chip empty">?</div>`;
  return `<div class="cal2-chip" style="background:${f.color}">${escapeHtml(f.name)}</div>`;
}

// =============================================================================
// Wiring + interaction
// =============================================================================
function wireCalendar() {
  const selects = document.querySelectorAll("#s2Calendar .cal2-select");
  selects.forEach(sel => {
    // Keyboard shortcuts: 1–8 pick a fellow; 0 / Backspace / Delete clear.
    sel.addEventListener("keydown", (e) => {
      const key = e.key;
      if (/^[1-8]$/.test(key)) {
        e.preventDefault();
        if (sel.value !== key) {
          sel.value = key;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (key === "0" || key === "Backspace" || key === "Delete") {
        e.preventDefault();
        if (sel.value !== "") {
          sel.value = "";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    });
    sel.addEventListener("change", () => {
      const dateStr = sel.dataset.date;
      const raw = sel.value;
      const newVal = raw === "" ? null : parseInt(raw, 10);
      onCellChange(dateStr, newVal);
    });
  });
}

function onCellChange(dateStr, newFellowNum) {
  const savedRaw = _ctx.shiftDoc.shifts ? _ctx.shiftDoc.shifts[dateStr] : undefined;
  const savedVal = (savedRaw == null) ? null : savedRaw;

  if (newFellowNum === savedVal) {
    // Reverted to saved value — drop from pending.
    delete _ctx.pending[dateStr];
  } else {
    _ctx.pending[dateStr] = newFellowNum;
  }

  // Clear stale validation flags adjacent to the change. If the user is
  // fixing one half of a consecutive-day violation, both flagged cells
  // should de-highlight so the user can re-save and let validation re-run.
  _ctx.validationErrors.delete(dateStr);
  _ctx.validationErrors.delete(prevDate(dateStr));
  _ctx.validationErrors.delete(nextDate(dateStr));

  updateCellVisual(dateStr);
  updateCellVisual(prevDate(dateStr));
  updateCellVisual(nextDate(dateStr));
  renderToolbar();
  renderCountsPanel();
}

function updateCellVisual(dateStr) {
  const cell = document.querySelector(`.cal2-cell[data-date="${dateStr}"]`);
  if (!cell) return;
  const isPending = dateStr in _ctx.pending;
  const isInvalid = _ctx.validationErrors.has(dateStr);
  cell.classList.toggle("pending", isPending);
  cell.classList.toggle("invalid", isInvalid);
  // Refresh the select's color hint.
  const sel = cell.querySelector(".cal2-select");
  if (sel) {
    const merged = mergedShifts();
    const cur = merged[dateStr];
    if (cur != null) {
      const f = _state.fellowsByNum[cur];
      if (f) sel.style.cssText = `background:${f.color}; color:white; font-weight:600;`;
    } else {
      sel.style.cssText = "";
    }
  }
}

// =============================================================================
// Save / discard
// =============================================================================
async function onSave() {
  // Validate the merged view first. If anything violates the rules, refuse
  // to commit, paint the offending cells red, and bail.
  const violations = validateMerged();
  if (violations.size > 0) {
    _ctx.validationErrors = violations;
    renderCalendar();
    // CRITICAL: renderCalendar() replaces innerHTML of #s2Calendar, which
    // destroys every <select> element and its change listener. Without this
    // wireCalendar() call the user gets trapped — they can fiddle with the
    // (now-unwired) dropdowns but onCellChange never fires, _ctx.pending
    // never updates, so the next Save sees the same violation and the cells
    // stay red. (This was the root cause of the "name returns to empty" and
    // "keeps flagging error" bugs.)
    if (isMaster() && _ctx.shiftDoc.premiered !== true) wireCalendar();
    renderToolbar();
    const sample = [...violations][0];
    window.showToast(`${violations.size} cell(s) violate rules. Fix flagged dates.`, "error", 4500);
    const cell = document.querySelector(`.cal2-cell[data-date="${sample}"]`);
    if (cell) cell.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.disabled = true;
  try {
    const pendingCopy = { ..._ctx.pending };
    await commitShiftChanges(_ctx.monthKey, pendingCopy);

    // Apply pending to _ctx.shiftDoc.shifts LOCALLY rather than re-fetching.
    // Firestore's local cache occasionally returns pre-commit data in the
    // microtask window right after runTransaction resolves; a fetchShiftTable
    // call here could therefore return the OLD shifts map and the post-save
    // render would show empty cells (the subscribe listener catches up moments
    // later, which is why tab-switching used to "fix" the display). We know
    // exactly what we just wrote, so mirror it in memory and skip the race.
    const oldShifts = (_ctx.shiftDoc && _ctx.shiftDoc.shifts) || {};
    const newShifts = { ...oldShifts };
    for (const [date, fn] of Object.entries(pendingCopy)) {
      if (fn == null) delete newShifts[date];
      else newShifts[date] = fn;
    }
    _ctx.shiftDoc = { ...(_ctx.shiftDoc || {}), shifts: newShifts };

    _ctx.pending = {};
    _ctx.validationErrors = new Set();

    // Counts: refresh from the DB so other-month totals stay accurate.
    // Current-month counts are computed from the merged shifts at render
    // time, so a stale counts fetch here is harmless for the current view.
    try {
      _ctx.counts = await fetchAllShiftCounts();
    } catch (err) {
      console.warn("Counts refetch failed (non-fatal):", err);
    }

    renderFullLayout();
    window.showToast("Saved.", "success");
  } catch (err) {
    console.error("Save failed:", err);
    window.showToast("Save failed. Check console.", "error", 4000);
    if (saveBtn) saveBtn.disabled = false;
  }
}

function onDiscard() {
  if (Object.keys(_ctx.pending).length === 0) return;
  window.openModal(`
    <h2>Discard changes?</h2>
    <p style="color:var(--text-dim); margin-bottom:16px;">
      You have ${Object.keys(_ctx.pending).length} unsaved change(s). They will be lost.
    </p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.closeModal()">Cancel</button>
      <button class="btn-danger" id="confirmDiscardBtn">Discard</button>
    </div>
  `);
  document.getElementById("confirmDiscardBtn").addEventListener("click", () => {
    _ctx.pending = {};
    _ctx.validationErrors = new Set();
    window.closeModal();
    renderFullLayout();
  });
}

// =============================================================================
// Validation
// =============================================================================
// Rules:
//   1. A fellow cannot work two consecutive days.
//   2. A fellow cannot be assigned on a date they listed in avoid_requests.
// Returns a Set of dateStrs (within the current month) that violate ≥ 1 rule.
function validateMerged() {
  const merged = mergedShifts();
  // lookup = this month's merged view + the single boundary day from each
  // adjacent month, so the consecutive-day check sees across month seams
  // (e.g. Jul 31 ↔ Aug 1) without loading the neighbors' full schedules.
  const lookup = { ...merged, ...(_ctx.boundary || {}) };
  const avoid = (_ctx.avoidDoc && _ctx.avoidDoc.requests) || {};
  const { year, month } = parseYMD(_ctx.monthKey + "-01");
  const allDates = allDatesInMonth(year, month);
  const violations = new Set();

  for (const dateStr of allDates) {
    const fn = merged[dateStr];
    if (fn == null) continue;

    // Rule 1: consecutive-day (neighbors may be in an adjacent month).
    if (lookup[prevDate(dateStr)] === fn) {
      violations.add(dateStr);
      violations.add(prevDate(dateStr));
    }
    if (lookup[nextDate(dateStr)] === fn) {
      violations.add(dateStr);
      violations.add(nextDate(dateStr));
    }

    // Rule 2: avoid request.
    const avoidList = avoid[String(fn)] || [];
    if (avoidList.includes(dateStr)) {
      violations.add(dateStr);
    }
  }

  // Only surface violations inside the current month — those are the only cells
  // the UI can highlight. A cross-month seam conflict still flags the in-month
  // side (e.g. a Jul 31 / Aug 1 clash flags Jul 31 while viewing July), so the
  // master sees and can fix it from whichever month they're on.
  const inMonth = new Set();
  for (const d of violations) if (d.startsWith(_ctx.monthKey + "-")) inMonth.add(d);
  return inMonth;
}

// Fetch the single boundary assignment from each adjacent month: the last day
// of the previous month and the first day of the next month. Returns
// { dateStr: fellowNum } containing only the days that are actually assigned.
// Missing/out-of-range neighbors (e.g. before Jul 2026) simply contribute
// nothing. Used to validate the consecutive-day rule across month seams.
async function fetchBoundaryAssignments(monthKey) {
  // Only the master validates, so users don't need the neighbor lookups.
  if (!isMaster()) return {};
  const { year, month } = parseYMD(monthKey + "-01");
  const lastDay = `${monthKey}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  const prevBoundary = prevDate(monthKey + "-01");
  const nextBoundary = nextDate(lastDay);

  const [prevDoc, nextDoc] = await Promise.all([
    fetchShiftTable(monthKeyOf(prevBoundary)),
    fetchShiftTable(monthKeyOf(nextBoundary)),
  ]);

  const out = {};
  const pv = prevDoc.shifts ? prevDoc.shifts[prevBoundary] : null;
  const nv = nextDoc.shifts ? nextDoc.shifts[nextBoundary] : null;
  if (pv != null) out[prevBoundary] = pv;
  if (nv != null) out[nextBoundary] = nv;
  return out;
}

// =============================================================================
// Premier / unpremier
// =============================================================================
async function onPremierToggle(isCurrentlyPremiered) {
  if (Object.keys(_ctx.pending).length > 0) {
    window.showToast("Save or discard pending changes before premiering.", "error");
    return;
  }

  // ---- Pre-premier safety check ----
  // Re-fetch avoid_requests and shift_table fresh, then validate the saved
  // schedule against the LATEST avoid state and consecutive-day rules. This
  // catches the race where the master saved an assignment before a fellow
  // added a conflicting avoid request. Skip for UNPREMIER (no need to gate
  // unlocking the schedule).
  if (!isCurrentlyPremiered) {
    try {
      const [freshAvoid, freshShifts, freshBoundary] = await Promise.all([
        fetchAvoidRequests(_ctx.monthKey),
        fetchShiftTable(_ctx.monthKey),
        fetchBoundaryAssignments(_ctx.monthKey),
      ]);
      _ctx.avoidDoc = freshAvoid;
      _ctx.shiftDoc = freshShifts;
      _ctx.boundary = freshBoundary;
    } catch (err) {
      console.error("Premier pre-check failed:", err);
      window.showToast("Pre-check failed. Check console.", "error");
      return;
    }

    // Belt-and-braces: in addition to the disabled button in the toolbar,
    // re-check here in case state changed between renderToolbar and click.
    if (_ctx.avoidDoc.allowRequests === true) {
      window.openModal(`
        <h2>Cannot premier yet</h2>
        <p style="color:var(--text-dim); margin-bottom:16px;">
          Avoid requests are still <strong>OPEN</strong>. Close them in Sheet 1
          before premiering — otherwise a fellow could add an avoid date that
          conflicts with the locked schedule.
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" onclick="window.closeModal()">OK</button>
        </div>
      `);
      return;
    }

    const violations = validateMerged();   // pending is empty, so this validates saved-only
    if (violations.size > 0) {
      _ctx.validationErrors = violations;
      renderCalendar();
      if (isMaster() && _ctx.shiftDoc.premiered !== true) wireCalendar();
      renderToolbar();
      const list = [...violations].sort()
        .map(d => `<li style="margin-bottom:2px;">${d}</li>`).join("");
      window.openModal(`
        <h2>Cannot premier — ${violations.size} conflict(s)</h2>
        <p style="color:var(--text-dim); margin-bottom:8px;">
          The saved schedule has assignments that violate the rules
          (consecutive-day or avoid-request conflict). Fix the flagged dates,
          save, and try again.
        </p>
        <ul style="color:var(--warning); margin: 0 0 16px 20px; font-size:13px; max-height:200px; overflow:auto;">${list}</ul>
        <div class="modal-actions">
          <button class="btn-secondary" onclick="window.closeModal()">OK</button>
        </div>
      `);
      return;
    }
  }

  const verb = isCurrentlyPremiered ? "UNPREMIER" : "PREMIER";
  const msg = isCurrentlyPremiered
    ? "Unpremier this month? Users will see it as 'currently being edited'."
    : "Premier this month? Once premiered, edits are locked until you unpremier.";

  window.openModal(`
    <h2>Confirm ${verb}</h2>
    <p style="color:var(--text-dim); margin-bottom:16px;">${msg}</p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.closeModal()">Cancel</button>
      <button class="${isCurrentlyPremiered ? 'btn-danger' : 'btn-primary'}" id="confirmPremierBtn">${verb}</button>
    </div>
  `);

  document.getElementById("confirmPremierBtn").addEventListener("click", async () => {
    try {
      if (isCurrentlyPremiered) {
        await unpremierMonth(_ctx.monthKey);
      } else {
        await premierMonth(_ctx.monthKey);
      }
      window.closeModal();
      window.showToast(isCurrentlyPremiered ? "Month unpremiered." : "Month premiered.", "success");
      await renderSheet2(_ctx.monthKey);
    } catch (err) {
      console.error(err);
      window.showToast("Failed. Check console.", "error");
    }
  });
}

// =============================================================================
// Pure helpers
// =============================================================================
function mergedShifts() {
  const saved = (_ctx.shiftDoc && _ctx.shiftDoc.shifts) || {};
  const out = { ...saved };
  for (const [date, fn] of Object.entries(_ctx.pending)) {
    if (fn == null) delete out[date];
    else out[date] = fn;
  }
  return out;
}

function computeMonthCountFromShifts(shifts, fellowNum) {
  let weekday = 0;
  let weekendHoliday = 0;
  for (const [dateStr, fn] of Object.entries(shifts)) {
    if (fn !== fellowNum) continue;
    if (isWeekendOrHoliday(dateStr, _ctx.holidays)) weekendHoliday++;
    else weekday++;
  }
  return { weekday, weekendHoliday };
}

// Cumulative = (saved byMonth for all OTHER months) + (merged this month).
// This means pending edits show up in the cumulative panel instantly.
function computeLifetimeFromCountsAndMerged(fellowNum, merged) {
  const c = _ctx.counts[String(fellowNum)] || {};
  const byMonth = c.byMonth || {};
  let weekday = 0;
  let weekendHoliday = 0;
  for (const [mk, counts] of Object.entries(byMonth)) {
    if (mk === _ctx.monthKey) continue;
    weekday += counts.weekday || 0;
    weekendHoliday += counts.weekendHoliday || 0;
  }
  const cur = computeMonthCountFromShifts(merged, fellowNum);
  weekday += cur.weekday;
  weekendHoliday += cur.weekendHoliday;
  return { weekday, weekendHoliday };
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
