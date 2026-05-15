# Cardiology Fellowship Shift Manager

Browser-based shift scheduling app for 8 cardiology fellows.
Period: 1 July 2026 – 30 June 2027.

**Tech:** Plain HTML/CSS/JS (ES6 modules, no build step) + Firebase
(Anonymous Auth + Firestore). Hosted as static files (GitHub Pages).

---

## Architecture summary

- **No server code.** Everything runs in the browser.
- **Auth:** Firebase Anonymous Auth → user types a code → app looks up
  `auth_codes/{code}` in Firestore to identify fellow + role.
- **Security:** Enforced by `firestore.rules` server-side. The Firebase
  config in `js/firebase-config.js` is public by design.
- **Real-time:** `shift_table` doc has a live listener; user views update
  automatically when master saves.

## File tree
shift-manager/
├── index.html              Main app (login + tabs + panels)
├── seed.html               One-time data seeder (delete after use)
├── firestore.rules         Security rules — paste into Firebase Console
├── .gitignore
├── README.md
├── css/
│   └── style.css           Dark space theme
└── js/
├── firebase-config.js  Public Firebase config
├── firestore-api.js    All Firestore reads/writes
├── utils.js            Date / timezone helpers
├── auth.js             Login/logout
├── sheet1.js           Avoid Requests UI
└── sheet2.js           Shift Manager UI