# Cardiology Fellowship Shift Manager — project notes

Browser-based shift scheduler for **8 cardiology fellows**, period **1 Jul 2026 – 30 Jun 2027**.
Plain HTML/CSS/JS (ES6 modules, **no build step**) + Firebase (Anonymous Auth + Firestore).
Hosted as static files on **GitHub Pages** (repo: `nicejazaa7/shift-manager`, branch `main`).

There is one **master** (the admin/scheduler) and the rest are **users** (colleagues).

---

## Run / test locally

ES6 modules don't work from `file://` — you MUST serve over http:

```
python -m http.server 8000      # then open http://localhost:8000
```

- **Local testing hits the LIVE Firebase database** (same `firebase-config.js`). There is no
  staging/sandbox. When testing writes, touch only your own data or use Discard. To test the
  colleague flow, log in as a non-master fellow and only change that fellow's own dates.
- After any deploy, **hard-refresh** (Ctrl+Shift+R) — GitHub Pages + browser cache serve stale JS otherwise.

## Deploy

- `git push` to `main` → GitHub Pages rebuilds in ~1–2 min. Commit/push only when the user asks.
- **Firestore rules are NOT auto-deployed.** `firestore.rules` is the source of truth; to apply it you
  must paste it into Firebase Console → Firestore → Rules → Publish (no `firebase.json`/CLI configured here).
- Commit message footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## ⚠️ Golden rule for safe deploys (problem we hit)

Classify every change before shipping:
- **Client-only, same data shape** → safe to deploy live anytime; active users pick it up on reload.
- **Rules change** OR **data-shape change** → must be coordinated. Client and rules can be mutually
  incompatible (e.g. the security fix: new client writes a `code` field that old rules reject, and new
  rules require it). Deploy rules first / together, deploy at a quiet time, tell users to hard-refresh.
- There is **no single payload that satisfies both old and new rules** during a rules change — plan the cutover.

---

## File map

```
index.html              App shell: login, tabs, month bar, toast/modal helpers, month-switch guard
firestore.rules         Security rules — SOURCE OF TRUTH (paste into console to deploy)
css/style.css           Dark "space" theme
js/firebase-config.js   Public Firebase config (safe to commit; security is in rules)
js/firestore-api.js     ONLY file that talks to Firestore — all reads/writes go through here
js/auth.js              Login/logout, session in sessionStorage
js/utils.js             Date/timezone helpers (string dates; ICT display via Intl)
js/sheet1.js            Tab 1 "Avoid Requests"
js/sheet2.js            Tab 2 "Shift Manager" (calendar editor)
```
(`seed.html` was deleted after one-time seeding. No tests, no linter.)

## Data model (Firestore)

All real data is keyed by **fellowNumber (1–8)**, never by login code.

- `auth_codes/{code}` → `{ name, fellowNumber, role }`. **Doc id IS the login code.** `get` allowed,
  `list` denied. To change a password: create a new doc with the new code id (same fields), delete old.
- `fellows/{fellowNumber}` → `{ fellowNumber, name, color }`. Static.
- `user_sessions/{uid}` → `{ fellowNumber, role, code, lastLoginAt }`. Written on login; rules verify
  `role`/`fellowNumber` against `auth_codes/{code}`.
- `avoid_requests/{monthKey}` → `{ allowRequests: bool, requests: { "<fellowNumber>": [dateStr,...] } }`.
- `holidays/{monthKey}` → `{ dates: [{ date, name, custom }] }`.
- `shift_table/{monthKey}` → `{ premiered, premieredAt, lastUnpremieredAt, shifts: { dateStr: fellowNum } }`.
  Legacy `{lineA,lineB}` shape is lazily normalized on read (`normalizeShifts`).
- `shift_counts/{fellowNumber}` → `{ lifetime, byMonth: { monthKey: {weekday, weekendHoliday} } }`.
  **Recomputed from shift_table** on every save (no delta accounting); self-healed via `reconcileAllCounts`.

monthKey = `"YYYY-MM"`, dateStr = `"YYYY-MM-DD"`. 12 fellowship months from `fellowshipMonths()`.

## Security model

- Anonymous Auth is open (anyone can sign in). All authorization is in `firestore.rules`.
- `isMaster()` reads the caller's `user_sessions` doc role. The write rule for that doc cross-checks
  `auth_codes/{code}` so a client **cannot** forge a master session. (This was a real privilege-escalation
  bug — see commit c9499f1. Don't loosen the user_sessions write rule.)
- Master writes are unconditional; user writes to `avoid_requests` are restricted to their own slot,
  only when `allowRequests==true` and not premiered (`onlyMyRequestsSlotChanged`).

## Key conventions / patterns

- **All Firestore access via `firestore-api.js`.** UI files never import the Firebase SDK directly.
- **Pending-overlay pattern** (used in both sheets): edits accumulate in an in-memory `_ctx.pending`,
  nothing is written until Confirm/Save (one batched transaction). Avoids per-tap writes that caused
  re-render scroll-jumps / lost taps. Month-switch is blocked while pending exists
  (`window.sheet1HasPendingChanges` / `window.sheet2HasPendingChanges`, checked in index.html).
- `escapeHtml()` on all user-supplied strings interpolated into HTML.
- Dates handled as strings; `dayOfWeek` builds Date at UTC noon to avoid TZ shifts.

## Sheet behavior

**Sheet 1 (Avoid Requests):**
- Everyone edits their OWN avoid dates via **select-then-confirm**: tap = pending (color box, no
  checkmark) → Confirm writes all (`setAvoidDates`, one transaction) → confirmed (color box + checkmark);
  tapping a saved date marks it faded/struck for removal. Sticky top bar shows count + Confirm/Discard.
- Master also sees other fellows' avoid dates as colored dots, and can **add/remove any colleague's**
  dates from the "All Avoid Requests" table (× to remove, "+ Add date" to add; both confirm; immediate
  write via `toggleAvoidDate`; hidden when premiered).

**Sheet 2 (Shift Manager):**
- Master assigns one fellow per day on a calendar. Pending overlay → Save commits via
  `commitShiftChanges` (one transaction: writes shifts + recomputes all 8 fellows' counts).
- Client-side validation before save: no consecutive days (incl. cross-month seams via
  `fetchBoundaryAssignments`), no avoid-conflict. Bad cells flagged red.
- **Premier** locks a month (read-only for all). Can't premier while avoid requests are open or pending
  changes exist. Unpremier to edit again.

## Known limitations / watch-outs

- No automated tests. Verify changes by running locally and clicking through.
- Local testing mutates production data (no sandbox).
- `commitShiftChanges` / counts assume the 8 `shift_counts` docs exist (writes use set+merge so they
  self-create now).
- Changing a fellow's login code: keep the SAME `fellowNumber` or you reassign all their shifts/counts.
