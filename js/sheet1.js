// js/sheet1.js
// Sheet 1: Avoid Requests.
// Master sees: allow-toggle + add-holiday button + multi-colored calendar + per-fellow avoid table.
// User sees: read-only calendar reflecting their own marks + their own date-chip summary.

import { isMaster, currentSession } from "./auth.js";
import {
  fetchAvoidRequests, fetchHolidays, fetchShiftTable,
  setAllowRequests, toggleAvoidDate,
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
}

// =============================================================================
// Top-level render
// =============================================================================
async function renderSheet1(monthKey) {
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

  _container.innerHTML = `
    ${renderToolbar(master, allow, premiered, monthKey)}
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
  const myFellowNum = session?.fellowNumber;
  const requests = _ctx.avoidDoc.requests || {};

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

    const myMarked = markedBy.includes(myFellowNum);

    const classes = [
      "cal-cell",
      weekend ? "weekend" : "",
      hol ? "holiday" : "",
      (premiered || !allow) ? "readonly" : "",
    ].filter(Boolean).join(" ");

    // Master view: show all fellow color dots
    let dotsHtml = "";
    if (master && markedBy.length > 0) {
      dotsHtml = `<div class="cal-fellow-dots">` +
        markedBy.map(fn => {
          const f = _state.fellowsByNum[fn];
          if (!f) return "";
          return `<span class="cal-fellow-dot" style="background:${f.color}" title="${f.name}"></span>`;
        }).join("") +
        `</div>`;
    }

    // User view: just a checkmark if they marked it
    let checkHtml = "";
    let borderStyle = "";
    if (!master && myMarked) {
      checkHtml = `<span class="cal-checkmark">✓</span>`;
      borderStyle = `border-color:${session.color}`;
    }

    cells += `
      <div class="${classes}"
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
  const cells = _container.querySelectorAll(".cal-cell[data-date]");
  cells.forEach(cell => {
    cell.addEventListener("click", async () => {
      const dateStr = cell.dataset.date;
      // Read-only conditions:
      if (premiered) {
        window.showToast("Month is premiered. Edits locked.", "warning");
        return;
      }
      if (!allow) {
        window.showToast("Requests are currently closed.", "warning");
        return;
      }

      const session = currentSession();
      // For master: clicking toggles for self only (per spec). Master views see
      // all fellows' marks but click-toggle still targets their own fellowNumber.
      const targetFellow = session.fellowNumber;

      try {
        await toggleAvoidDate(_ctx.monthKey, targetFellow, dateStr);
        // Re-fetch and re-render. Could be optimized to local mutation but
        // keeping simple for correctness.
        await renderSheet1(_ctx.monthKey);
      } catch (err) {
        console.error(err);
        window.showToast("Failed to update. Check rules/permissions.", "error");
      }
    });
  });
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
    // Table grouped by fellow
    const rows = _state.fellows.map(f => {
      const myDates = (_ctx.avoidDoc.requests || {})[String(f.fellowNumber)] || [];
      const chips = myDates.length === 0
        ? `<span class="empty-state">—</span>`
        : myDates.map(d => `<span class="date-chip">${escapeHtml(dateChipLabel(d))}</span>`).join(" ");
      return `
        <tr>
          <td><span class="fellow-chip" style="background:${f.color}">#${f.fellowNumber} ${escapeHtml(f.name)}</span></td>
          <td>${chips}</td>
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
    // User: their own date chips with click-to-remove
    const session = currentSession();
    const myDates = (_ctx.avoidDoc.requests || {})[String(session.fellowNumber)] || [];
    return `
      <div class="avoid-summary">
        <h3>My Avoid Dates — ${monthLabel(_ctx.monthKey)}</h3>
        <div class="date-chips" id="myDateChips">
          ${myDates.length === 0
            ? `<span class="empty-state">No dates selected.</span>`
            : myDates.map(d => `
                <span class="date-chip" data-date="${d}">
                  ${escapeHtml(dateChipLabel(d))} <span class="x">×</span>
                </span>
              `).join("")}
        </div>
      </div>
    `;
  }
}

function wireAvoidSummaryEvents(master) {
  if (master) return;
  const allow = _ctx.avoidDoc.allowRequests === true;
  const premiered = _ctx.shiftDoc.premiered === true;
  if (premiered || !allow) return;

  const session = currentSession();
  const chips = _container.querySelectorAll("#myDateChips .date-chip");
  chips.forEach(chip => {
    chip.addEventListener("click", async () => {
      const dateStr = chip.dataset.date;
      try {
        await toggleAvoidDate(_ctx.monthKey, session.fellowNumber, dateStr);
        await renderSheet1(_ctx.monthKey);
      } catch (err) {
        console.error(err);
        window.showToast("Failed to update.", "error");
      }
    });
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