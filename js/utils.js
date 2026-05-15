// js/utils.js
// Date, timezone, and holiday utilities.
// CRITICAL: This app handles dates in two distinct forms:
//   1. Calendar dates (e.g., "2026-07-15") — timezone-agnostic strings.
//      Used for: avoid lists, shift dates, holiday dates.
//   2. Moments in time (e.g., when master clicked "Premier") — Firestore Timestamps.
//      Always displayed in Asia/Bangkok (ICT, UTC+7), 24-hour format.

// =============================================================================
// Section 1: Calendar date helpers (string-based, no Date objects where possible)
// =============================================================================

/**
 * Return "YYYY-MM-DD" for a given year, month (1-12), day (1-31).
 * Pads with leading zeros. Does NOT validate ranges — caller's responsibility.
 */
export function ymd(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Parse "YYYY-MM-DD" into { year, month, day } as integers.
 * Throws if format is invalid.
 */
export function parseYMD(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Invalid date string: ${dateStr}`);
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    day: parseInt(match[3], 10),
  };
}

/**
 * "YYYY-MM" month key from "YYYY-MM-DD".
 */
export function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7);
}

/**
 * Return number of days in a given year/month (month is 1-12).
 * Handles leap years correctly.
 */
export function daysInMonth(year, month) {
  // Date constructor with day=0 returns last day of previous month.
  // So new Date(2026, 7, 0) = 31 July 2026 (month is 0-indexed in Date).
  return new Date(year, month, 0).getDate();
}

/**
 * Return array of all "YYYY-MM-DD" date strings in a given month.
 * Example: allDatesInMonth(2026, 7) → ["2026-07-01", ..., "2026-07-31"]
 */
export function allDatesInMonth(year, month) {
  const days = daysInMonth(year, month);
  const result = [];
  for (let d = 1; d <= days; d++) {
    result.push(ymd(year, month, d));
  }
  return result;
}

/**
 * Day of week for a "YYYY-MM-DD" date.
 * Returns 0 (Sunday) through 6 (Saturday).
 *
 * IMPORTANT: We construct the Date as UTC noon to avoid timezone shifts.
 * Background: `new Date("2026-07-15")` is parsed as UTC midnight.
 * In Thailand (UTC+7), that's 7am local — same calendar date, OK.
 * But for users west of UTC, midnight UTC = previous day local. We use noon
 * UTC to put the moment safely inside the same calendar date globally.
 */
export function dayOfWeek(dateStr) {
  const { year, month, day } = parseYMD(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return d.getUTCDay();
}

/**
 * Is the date a Saturday (6) or Sunday (0)?
 */
export function isWeekend(dateStr) {
  const dow = dayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

/**
 * Add `n` days to a "YYYY-MM-DD" string and return a new "YYYY-MM-DD".
 * `n` can be negative.
 */
export function addDays(dateStr, n) {
  const { year, month, day } = parseYMD(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Previous and next calendar dates as "YYYY-MM-DD".
 * Useful for the "no 2 consecutive days on Line A" validation.
 */
export function prevDate(dateStr) { return addDays(dateStr, -1); }
export function nextDate(dateStr) { return addDays(dateStr, 1); }

// =============================================================================
// Section 2: ICT (Asia/Bangkok) timestamp formatting
// =============================================================================

/**
 * Format a Firestore Timestamp (or JS Date) into "YYYY-MM-DD HH:mm (ICT)".
 * Uses Intl.DateTimeFormat with explicit Asia/Bangkok timezone — does NOT
 * depend on the user's local timezone.
 *
 * Pass either:
 *   - a Firestore Timestamp object (has .toDate() method), or
 *   - a JS Date, or
 *   - null / undefined → returns "" (empty string, safe for display)
 */
export function formatICT(timestampOrDate) {
  if (!timestampOrDate) return "";

  // Firestore Timestamps have a .toDate() method. JS Dates do not.
  const date = (typeof timestampOrDate.toDate === "function")
    ? timestampOrDate.toDate()
    : timestampOrDate;

  // Use en-GB locale → produces "DD/MM/YYYY, HH:mm" which we reformat.
  // We extract parts explicitly via formatToParts to avoid locale surprises.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (ICT)`;
}

// =============================================================================
// Section 3: Month label helpers (for the 12-button month selector)
// =============================================================================

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

/**
 * "2026-07" → "Jul 2026"
 */
export function monthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  return `${MONTH_SHORT[parseInt(month, 10) - 1]} ${year}`;
}

/**
 * The 12 month keys covering the fellowship period (Jul 2026 → Jun 2027).
 */
export function fellowshipMonths() {
  return [
    "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
  ];
}

// =============================================================================
// Section 4: Date chip label (for "avoid dates" summary)
// =============================================================================

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "2026-07-06" → "Mon 6 Jul"
 * Short, readable label for date chips.
 */
export function dateChipLabel(dateStr) {
  const { month, day } = parseYMD(dateStr);
  const dow = DOW_SHORT[dayOfWeek(dateStr)];
  return `${dow} ${day} ${MONTH_SHORT[month - 1]}`;
}

// =============================================================================
// Section 5: Holiday detection helper
// =============================================================================

/**
 * Given a date string and the holidays array for that month
 * (shape: [{ date, name, custom }, ...]), return the holiday object
 * if the date is a holiday, else null.
 */
export function findHoliday(dateStr, holidaysArray) {
  if (!holidaysArray) return null;
  return holidaysArray.find(h => h.date === dateStr) || null;
}

/**
 * Convenience: is this date a weekend OR a holiday?
 * Used for shift_counts categorization and weekend-cell coloring.
 */
export function isWeekendOrHoliday(dateStr, holidaysArray) {
  return isWeekend(dateStr) || findHoliday(dateStr, holidaysArray) !== null;
}