// js/sheet1.js
// Sheet 1: Avoid Requests.
// Everyone edits their OWN avoid dates with a select-then-confirm flow: taps
// accumulate in a pending overlay (color box, no checkmark) and are written
// only on Confirm (color box + checkmark). This prevents mis-taps for both
// colleagues and the master.
// Master additionally: allow-toggle, add-holiday, sees other fellows' colored
// dots on the calendar, and can add/remove any colleague's dates via the table.

import { isMaster, currentSession } from "./auth.js";
import {
  fetchAvoidRequests, fetchHolidays, fetchShiftTable,
  setAllowRequests, toggleAvoidDate, setAvoidDates,
  addCustomHoliday, removeCustomHoliday,
} from "./firestore-api.js";
import {
  parseYMD, daysInMonth, dayOfWeek, allDatesInMonth,
  isWeekend, findHoliday, dateChipLabel, monthLabel,
} from "./utils.js";

// Module-scope state for this sheet.
let _state = null;
let _container = null;
let _ctx = {
  avoidDoc: null,      // { allowRequests, requests }
  holidays: [],        // [{ date, name, custom }]
  shiftDoc: null,      // { premiered, ... }
  monthKey: null,
  // User select-then-confirm overlay: { dateStr: desiredBool } where the
  // value differs from the saved state. true = will be avoided (added),
  // false = will be un-avoided (removed). Empty = no unsaved picks.
  pending: {},
};

// =============================================================================
// Entry point — called once from index.html
// =============================================================================
export function initSheet1({ state, getCurrentMonth }) {
  _state = state;
  _container = document.getElementById("sheet1");

  // Listen for render events from main shell.
  _container.addEventListener("sheet:render", async (ev) => {
    const monthKey = ev.detail.monthKey || getCurrentMonth();
    await renderSheet1(monthKey);
  });

  // Exposed for the month-switch guard in index.html — blocks navigation while
  // there are unconfirmed avoid picks (master or colleague) so taps are never
  // silently lost.
  window.sheet1HasPendingChanges = () =>
    Object.keys(_ctx.pending).length > 0;
}

// =============================================================================
// Top-level render
// =============================================================================
async function renderSheet1(monthKey) {
  // Reset unconfirmed picks when the month actually changes; preserve them
  // across tab switches on the same month.
  if (_ctx.monthKey !== monthKey) _ctx.pending = {};
  _ctx.monthKey = monthKey;
  _container.innerHTML = `<div class="empty-state">Loading…</div>`;

  try {
    const [avoidDoc, holidays, shiftDoc] = await Promise.all([
      fetchAvoidRequests(monthKey),
      fetchHolidays(monthKey),
      fetchShiftTable(monthKey),
    ]);
    _ctx.avoidDoc = avoidDoc;
    _ctx.holidays = holidays;
    _ctx.shiftDoc = shiftDoc;
  } catch (err) {
    console.error("Sheet1 load failed:", err);
    _container.innerHTML = `<div class="empty-state">Failed to load. Check console.</div>`;
    return;
  }

  const master = isMaster();
  const premiered = _ctx.shiftDoc.premiered === true;
  const allow = _ctx.avoidDoc.allowRequests === true;
  // Select-then-confirm applies to anyone choosing their OWN avoid dates —
  // colleagues and the master alike (prevents mis-taps for both).
  const editing = allow && !premiered;

  _container.innerHTML = `
    ${renderToolbar(master, allow, premiered, monthKey)}
    ${editing ? renderAvoidConfirmBar() : ""}
    <div class="sheet1-grid">
      <div>
        ${renderCalendar(monthKey, master, allow, premiered)}
        ${renderAvoidSummary(master)}
      </div>
      <div>
        ${renderHolidayPanel(master)}
      </div>
    </div>
    ${renderMonthFooter(monthKey)}
  `;

  wireToolbarEvents(master);
  wireCalendarEvents(master, allow, premiered);
  wireHolidayPanelEvents(master);
  wireAvoidSummaryEvents(master);
  if (editing) wireAvoidConfirmBar();
}

// =============================================================================
// Toolbar
// =============================================================================
function renderToolbar(master, allow, premiered, monthKey) {
  let status = "";
  if (premiered) {
    status = `<span class="sheet1-status">Month is <strong>PREMIERED</strong> — calendar is read-only.</span>`;
  } else if (!allow) {
    status = `<span class="sheet1-status">Requests are currently <strong>closed</strong>.</span>`;
  } else {
    status = `<span class="sheet1-status">Requests are <strong>open</strong>. Click dates to toggle.</span>`;
  }

  const masterControls = master ? `
    <button id="allowToggleBtn" class="allow-toggle ${allow ? 'on' : 'off'}">
      ${allow ? 'Allow request: ON' : 'Allow request: OFF'}
    </button>
    <button id="addHolidayBtn" class="add-holiday-btn">+ Add Holiday</button>
  ` : "";

  return `
    <div class="sheet1-toolbar">
      ${masterControls}
      ${status}
    </div>
  `;
}

function wireToolbarEvents(master) {
  if (!master) return;
  const toggleBtn = document.getElementById("allowToggleBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      const next = !(_ctx.avoidDoc.allowRequests === true);
      try {
        await setAllowRequests(_ctx.monthKey, next);
        window.showToast(`Requests ${next ? 'opened' : 'closed'}`, "success");
        await renderSheet1(_ctx.monthKey);
      } catch (err) {
        console.error(err);
        window.showToast("Failed to update.", "error");
      }
    });
  }

  const addBtn = document.getElementById("addHolidayBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => openAddHolidayModal());
  }
}

// =============================================================================
// Calendar
// =============================================================================
function renderCalendar(monthKey, master, allow, premiered) {
  const { year, month } = parseYMD(monthKey + "-01");
  const firstDow = dayOfWeek(monthKey + "-01");  // 0=Sun
  const totalDays = daysInMonth(year, month);

  const session = currentSession();
  const requests = _ctx.avoidDoc.requests || {};
  const savedSet = mySavedSet();           // the logged-in person's own dates
  const myNum = session?.fellowNumber;

  let cells = "";

  // Leading empty cells (so date 1 aligns under correct weekday)
  for (let i = 0; i < firstDow; i++) {
    cells += `<div class="cal-cell empty"></div>`;
  }

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${monthKey}-${String(d).padStart(2,"0")}`;
    const weekend = isWeekend(dateStr);
    const hol = findHoliday(dateStr, _ctx.holidays);

    // Who has marked this date as avoid?
    const markedBy = [];
    for (const [fnStr, dates] of Object.entries(requests)) {
      if (dates.includes(dateStr)) markedBy.push(parseInt(fnStr, 10));
    }

    const classes = [
      "cal-cell",
      weekend ? "weekend" : "",
      hol ? "holiday" : "",
      (premiered || !allow) ? "readonly" : "",
    ].filter(Boolean).join(" ");

    // Master view: color dots for OTHER fellows. The master's own avoid is
    // shown as the border + checkmark below (same as any fellow's own view),
    // so exclude self from the dots to avoid double-marking.
    let dotsHtml = "";
    if (master) {
      const others = markedBy.filter(fn => fn !== myNum);
      if (others.length > 0) {
        dotsHtml = `<div class="cal-fellow-dots">` +
          others.map(fn => {
            const f = _state.fellowsByNum[fn];
            if (!f) return "";
            return `<span class="cal-fellow-dot" style="background:${f.color}" title="${f.name}"></span>`;
          }).join("") +
          `</div>`;
      }
    }

    // Everyone: reflect the logged-in person's own saved + unconfirmed picks.
    let borderStyle = "";
    let stateClass = "";
    const st = userDateState(dateStr, savedSet);
    if (st !== "none") {
      stateClass = st === "confirmed" ? "avoid-confirmed"
                 : st === "pending-add" ? "avoid-pending"
                 : "avoid-removing";
      borderStyle = `border-color:${session.color}`;
    }
    // CSS shows the checkmark only on .avoid-confirmed cells.
    const checkHtml = `<span class="cal-checkmark">✓</span>`;

    cells += `
      <div class="${classes} ${stateClass}"
           data-date="${dateStr}"
           style="${borderStyle}"
           title="${hol ? hol.name : ''}">
        <span class="cal-date">${d}</span>
        ${hol ? `<span class="cal-holiday-icon">✦</span>` : ""}
        ${checkHtml}
        ${dotsHtml}
      </div>
    `;
  }

  const weekdayHeaders = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
    .map(d => `<div class="calendar-weekday">${d}</div>`).join("");

  return `
    <div class="calendar">
      <div class="calendar-weekdays">${weekdayHeaders}</div>
      <div class="calendar-grid">${cells}</div>
    </div>
  `;
}

function wireCalendarEvents(master, allow, premiered) {
  const savedSet = mySavedSet();
  const cells = _container.querySelectorAll(".cal-cell[data-date]");
  cells.forEach(cell => {
    cell.addEventListener("click", () => {
      const dateStr = cell.dataset.date;
      // Read-only conditions (apply to everyone):
      if (premiered) {
        window.showToast("Month is premiered. Edits locked.", "warning");
        return;
      }
      if (!allow) {
        window.showToast("Requests are currently closed.", "warning");
        return;
      }

      // Everyone edits their OWN avoid dates through the pending overlay —
      // NOTHING is written until Confirm. We update only this cell + the bar
      // (no full re-render), which prevents the mis-tap / scroll-jump problem.
      toggleUserPending(dateStr, savedSet);
      updateUserCell(dateStr, savedSet);
      refreshConfirmBar();
    });
  });
}

// =============================================================================
// User select-then-confirm overlay (pending picks)
// =============================================================================
function mySavedSet() {
  const session = currentSession();
  const arr = (_ctx.avoidDoc.requests || {})[String(session.fellowNumber)] || [];
  return new Set(arr);
}

// Resolve a date's display state for the user, given their saved set.
//   "confirmed"      saved and unchanged → color box + checkmark
//   "pending-add"    newly picked, not yet saved → color box, no checkmark
//   "pending-remove" was saved, marked to remove → faded/struck
//   "none"           not avoided
function userDateState(dateStr, savedSet) {
  const inSaved = savedSet.has(dateStr);
  const hasPending = Object.prototype.hasOwnProperty.call(_ctx.pending, dateStr);
  if (!hasPending) return inSaved ? "confirmed" : "none";
  return _ctx.pending[dateStr] ? "pending-add" : "pending-remove";
}

// The final list the user intends to save (saved ± pending).
function myMergedDates(savedSet) {
  const out = new Set(savedSet);
  for (const [d, want] of Object.entries(_ctx.pending)) {
    if (want) out.add(d); else out.delete(d);
  }
  return [...out].sort();
}

function toggleUserPending(dateStr, savedSet) {
  const inSaved = savedSet.has(dateStr);
  const hasPending = Object.prototype.hasOwnProperty.call(_ctx.pending, dateStr);
  const cur = hasPending ? _ctx.pending[dateStr] : inSaved;
  const want = !cur;
  // Only store the value if it actually differs from saved; otherwise drop it
  // so "tap then tap back" leaves no phantom pending entry.
  if (want === inSaved) delete _ctx.pending[dateStr];
  else _ctx.pending[dateStr] = want;
}

function updateUserCell(dateStr, savedSet) {
  const cell = _container.querySelector(`.cal-cell[data-date="${dateStr}"]`);
  if (!cell) return;
  const session = currentSession();
  cell.classList.remove("avoid-confirmed", "avoid-pending", "avoid-removing");
  const st = userDateState(dateStr, savedSet);
  if (st === "confirmed")        { cell.classList.add("avoid-confirmed"); cell.style.borderColor = session.color; }
  else if (st === "pending-add") { cell.classList.add("avoid-pending");   cell.style.borderColor = session.color; }
  else if (st === "pending-remove") { cell.classList.add("avoid-removing"); cell.style.borderColor = session.color; }
  else { cell.style.borderColor = ""; }
}

// =============================================================================
// Confirm bar (sticky, top) — Confirm / Discard pending avoid picks
// =============================================================================
function renderAvoidConfirmBar() {
  return `
    <div class="avoid-confirm-bar" id="avoidConfirmBar">
      <span class="avoid-warn" id="avoidWarn"></span>
      <div class="avoid-bar-actions">
        <button id="avoidDiscardBtn" class="discard-btn" disabled>Discard</button>
        <button id="avoidConfirmBtn" class="save-btn" disabled>Confirm</button>
      </div>
    </div>
  `;
}

function wireAvoidConfirmBar() {
  const confirmBtn = _container.querySelector("#avoidConfirmBtn");
  const discardBtn = _container.querySelector("#avoidDiscardBtn");
  if (confirmBtn) confirmBtn.addEventListener("click", onConfirmAvoid);
  if (discardBtn) discardBtn.addEventListener("click", onDiscardAvoid);
  refreshConfirmBar();
}

function refreshConfirmBar() {
  const bar = _container.querySelector("#avoidConfirmBar");
  if (!bar) return;
  const n = Object.keys(_ctx.pending).length;
  bar.classList.toggle("has-pending", n > 0);
  bar.querySelector("#avoidWarn").textContent = n > 0
    ? `${n} unsaved change${n === 1 ? "" : "s"} — tap Confirm to save them`
    : "Tap the dates you want to avoid, then tap Confirm.";
  bar.querySelector("#avoidConfirmBtn").disabled = n === 0;
  bar.querySelector("#avoidDiscardBtn").disabled = n === 0;
}

async function onConfirmAvoid() {
  if (Object.keys(_ctx.pending).length === 0) return;
  const session = currentSession();
  const merged = myMergedDates(mySavedSet());
  const confirmBtn = _container.querySelector("#avoidConfirmBtn");
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    await setAvoidDates(_ctx.monthKey, session.fellowNumber, merged);
    _ctx.pending = {};
    window.showToast("Avoid dates saved.", "success");
    await renderSheet1(_ctx.monthKey);
  } catch (err) {
    console.error(err);
    window.showToast("Failed to save. Check console.", "error", 4000);
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

function onDiscardAvoid() {
  if (Object.keys(_ctx.pending).length === 0) return;
  _ctx.pending = {};
  renderSheet1(_ctx.monthKey);
}

// =============================================================================
// Holiday panel (right column)
// =============================================================================
function renderHolidayPanel(master) {
  const rows = _ctx.holidays.map(h => {
    const day = parseInt(h.date.slice(-2), 10);
    const delBtn = (master && h.custom)
      ? `<button class="h-delete" data-date="${h.date}" title="Delete">×</button>`
      : "";
    return `
      <div class="holiday-row ${h.custom ? 'custom' : ''}">
        <span class="h-date">${day}</span>
        <span class="h-name">${escapeHtml(h.name)}</span>
        ${delBtn}
      </div>
    `;
  }).join("");

  return `
    <div class="holiday-panel">
      <h3>Holidays — ${monthLabel(_ctx.monthKey)}</h3>
      ${_ctx.holidays.length === 0
        ? `<div class="empty-state">No holidays this month.</div>`
        : rows}
    </div>
  `;
}

function wireHolidayPanelEvents(master) {
  if (!master) return;
  const buttons = _container.querySelectorAll(".h-delete");
  buttons.forEach(btn => {
    btn.addEventListener("click", async () => {
      const dateStr = btn.dataset.date;
      if (!confirm(`Delete custom holiday on ${dateStr}?`)) return;
      try {
        await removeCustomHoliday(_ctx.monthKey, dateStr);
        window.showToast("Holiday removed.", "success");
        await renderSheet1(_ctx.monthKey);
      } catch (err) {
        console.error(err);
        window.showToast(err.message || "Failed to remove.", "error");
      }
    });
  });
}

function openAddHolidayModal() {
  const monthKey = _ctx.monthKey;
  const { year, month } = parseYMD(monthKey + "-01");
  const total = daysInMonth(year, month);

  const dayOptions = [];
  for (let d = 1; d <= total; d++) {
    dayOptions.push(`<option value="${String(d).padStart(2,'0')}">${d}</option>`);
  }

  window.openModal(`
    <h2>Add Holiday — ${monthLabel(monthKey)}</h2>
    <div class="modal-row">
      <label>Day</label>
      <select id="newHolidayDay">${dayOptions.join("")}</select>
    </div>
    <div class="modal-row">
      <label>Name</label>
      <input id="newHolidayName" type="text" placeholder="Holiday name" maxlength="60">
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.closeModal()">Cancel</button>
      <button class="btn-primary" id="newHolidayConfirmBtn">Add</button>
    </div>
  `);

  document.getElementById("newHolidayConfirmBtn").addEventListener("click", async () => {
    const day = document.getElementById("newHolidayDay").value;
    const name = document.getElementById("newHolidayName").value.trim();
    if (!name) {
      window.showToast("Please enter a name.", "warning");
      return;
    }
    const dateStr = `${monthKey}-${day}`;
    try {
      await addCustomHoliday(monthKey, dateStr, name);
      window.closeModal();
      window.showToast("Holiday added.", "success");
      await renderSheet1(monthKey);
    } catch (err) {
      console.error(err);
      window.showToast(err.message || "Failed to add holiday.", "error");
    }
  });
}

// =============================================================================
// Avoid summary (below calendar)
// =============================================================================
function renderAvoidSummary(master) {
  if (master) {
    // When premiered the month is frozen — chips are read-only (no ×, no add).
    const premiered = _ctx.shiftDoc.premiered === true;

    // Table grouped by fellow. When editable, each chip carries a × to remove
    // that fellow's date, and each row gets a "+ Add date" button.
    const rows = _state.fellows.map(f => {
      const myDates = (_ctx.avoidDoc.requests || {})[String(f.fellowNumber)] || [];
      const chips = myDates.length === 0
        ? `<span class="empty-state">—</span>`
        : myDates.map(d => premiered
            ? `<span class="date-chip">${escapeHtml(dateChipLabel(d))}</span>`
            : `<span class="date-chip removable" data-fellow="${f.fellowNumber}" data-date="${d}">${escapeHtml(dateChipLabel(d))} <span class="x">×</span></span>`
          ).join(" ");
      const addBtn = premiered
        ? ""
        : `<button class="avoid-add-btn" data-fellow="${f.fellowNumber}">+ Add date</button>`;
      return `
        <tr>
          <td><span class="fellow-chip" style="background:${f.color}">#${f.fellowNumber} ${escapeHtml(f.name)}</span></td>
          <td><div class="avoid-cell">${chips} ${addBtn}</div></td>
        </tr>
      `;
    }).join("");
    return `
      <div class="avoid-summary">
        <h3>All Avoid Requests — ${monthLabel(_ctx.monthKey)}</h3>
        <table class="avoid-table">
          <thead><tr><th>Fellow</th><th>Dates</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } else {
    // User: read-only glance-list of what WILL be saved (saved ± pending).
    // Editing happens on the calendar; removal is tap-to-mark then Confirm.
    const merged = myMergedDates(mySavedSet());
    return `
      <div class="avoid-summary">
        <h3>My Avoid Dates — ${monthLabel(_ctx.monthKey)}</h3>
        <div class="date-chips">
          ${merged.length === 0
            ? `<span class="empty-state">No dates selected.</span>`
            : merged.map(d => `<span class="date-chip static">${escapeHtml(dateChipLabel(d))}</span>`).join("")}
        </div>
      </div>
    `;
  }
}

function wireAvoidSummaryEvents(master) {
  // Master keeps add/remove controls on colleagues' rows. The user summary is
  // now display-only — colleagues edit on the calendar via the confirm bar.
  if (master) wireMasterAvoidSummary();
}

// Master-only: remove a colleague's avoid date (× on a chip) or add one
// (+ Add date per fellow). Both confirm before writing. Disabled when the
// month is premiered, since the schedule is frozen for everyone then.
function wireMasterAvoidSummary() {
  if (_ctx.shiftDoc.premiered === true) return;

  // Remove — × on a colleague's chip.
  _container.querySelectorAll(".avoid-summary .date-chip.removable").forEach(chip => {
    chip.addEventListener("click", () => {
      const fellowNumber = parseInt(chip.dataset.fellow, 10);
      const dateStr = chip.dataset.date;
      const f = _state.fellowsByNum[fellowNumber];
      const who = f ? f.name : `Fellow ${fellowNumber}`;
      window.openModal(`
        <h2>Remove avoid date</h2>
        <p style="color:var(--text-dim); margin-bottom:16px;">
          You are about to remove <strong>${escapeHtml(who)}</strong>'s avoid date
          (<strong>${escapeHtml(dateChipLabel(dateStr))}</strong>). Confirm this action.
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" onclick="window.closeModal()">No</button>
          <button class="btn-danger" id="confirmRemoveAvoidBtn">Yes</button>
        </div>
      `);
      document.getElementById("confirmRemoveAvoidBtn").addEventListener("click", async () => {
        try {
          await toggleAvoidDate(_ctx.monthKey, fellowNumber, dateStr);
          window.closeModal();
          window.showToast("Avoid date removed.", "success");
          await renderSheet1(_ctx.monthKey);
        } catch (err) {
          console.error(err);
          window.showToast("Failed to remove. Check console.", "error");
        }
      });
    });
  });

  // Add — + Add date per fellow row.
  _container.querySelectorAll(".avoid-summary .avoid-add-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      openMasterAddAvoidModal(parseInt(btn.dataset.fellow, 10));
    });
  });
}

function openMasterAddAvoidModal(fellowNumber) {
  const monthKey = _ctx.monthKey;
  const { year, month } = parseYMD(monthKey + "-01");
  const total = daysInMonth(year, month);
  const f = _state.fellowsByNum[fellowNumber];
  const who = f ? f.name : `Fellow ${fellowNumber}`;

  const dayOptions = [];
  for (let d = 1; d <= total; d++) {
    dayOptions.push(`<option value="${String(d).padStart(2, "0")}">${d}</option>`);
  }

  window.openModal(`
    <h2>Add avoid date — ${escapeHtml(who)}</h2>
    <div class="modal-row">
      <label>Day</label>
      <select id="addAvoidDay">${dayOptions.join("")}</select>
    </div>
    <p style="color:var(--text-dim); margin-bottom:16px;">
      Add an avoid date for this colleague. Confirm this action.
    </p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.closeModal()">No</button>
      <button class="btn-primary" id="confirmAddAvoidBtn">Yes</button>
    </div>
  `);

  document.getElementById("confirmAddAvoidBtn").addEventListener("click", async () => {
    const day = document.getElementById("addAvoidDay").value;
    const dateStr = `${monthKey}-${day}`;
    const existing = (_ctx.avoidDoc.requests || {})[String(fellowNumber)] || [];
    if (existing.includes(dateStr)) {
      // toggleAvoidDate would REMOVE an existing date — guard against that so
      // "add" never silently deletes.
      window.showToast("Already an avoid date for this colleague.", "warning");
      return;
    }
    try {
      await toggleAvoidDate(monthKey, fellowNumber, dateStr);
      window.closeModal();
      window.showToast("Avoid date added.", "success");
      await renderSheet1(monthKey);
    } catch (err) {
      console.error(err);
      window.showToast("Failed to add. Check console.", "error");
    }
  });
}

// =============================================================================
// Month footer stats
// =============================================================================
function renderMonthFooter(monthKey) {
  const dates = allDatesInMonth(...monthKey.split("-").map(s => parseInt(s, 10)));
  let weekday = 0, weHol = 0;
  for (const d of dates) {
    if (isWeekend(d) || findHoliday(d, _ctx.holidays)) weHol++;
    else weekday++;
  }
  return `
    <div class="month-footer-stats">
      <span>Weekdays: <strong>${weekday}</strong></span>
      <span>Weekend + Holiday: <strong>${weHol}</strong></span>
      <span>Total: <strong>${dates.length}</strong></span>
    </div>
  `;
}

// =============================================================================
// Helpers
// =============================================================================
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}