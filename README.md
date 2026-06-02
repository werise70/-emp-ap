# EMP — Zero-Knowledge P2P Messaging App
## With Real Backend + Mobile PWA (installable as APK-equivalent)

---

## What was fixed

The original app was **entirely local** — messages never left your browser. Each phone was talking to an AI simulation, never to each other.

This version adds:
- **Real backend server** (Node.js + Express + WebSocket)
- **Account creation** stored on the server (hashed PINs)
- **Real-time P2P messaging** via WebSocket — Phone A messages Phone B instantly
- **Offline queueing** — messages delivered when recipient next opens app
- **Session persistence** — stay logged in across browser restarts
- **PWA installable** — add to home screen on Android/iOS (works like an APK)

---

## Quick Start (Local Testing)

### 1. Install & Run
```bash
npm install
npm start
```
Server runs at `http://localhost:3000`

### 2. Test on your phone (same WiFi)
Find your computer's local IP:
```bash
# Mac/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1

# Windows
ipconfig | findstr "IPv4"
```
Open `http://YOUR_IP:3000` on **both phones**.

---

## Deploy to the internet (so any phone can connect)

### Option A: Railway (free, easiest)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. It auto-detects Node.js and runs `npm start`
4. You get a URL like `https://emp-production.up.railway.app`

### Option B: Render.com (free tier)
1. Go to render.com → New Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server/index.js`

### Option C: VPS / your own server
```bash
git clone your-repo /opt/emp
cd /opt/emp
npm install
# Use PM2 to keep it running:
npm install -g pm2
pm2 start server/index.js --name emp
pm2 save
pm2 startup
```

---

## Install on Phone as APK (PWA)

This app is a **Progressive Web App** — it installs to your home screen and runs fullscreen like a native app.

### Android (Chrome)
1. Open the app URL in Chrome
2. Tap the **⋮ menu** → "Add to Home screen"
3. OR Chrome shows an "Install" banner automatically
4. Tap Install → it appears on your home screen like an app

### iOS (Safari)
1. Open the app URL in Safari (must be Safari, not Chrome)
2. Tap the **Share button** (box with arrow)
3. Scroll down → "Add to Home Screen"
4. Tap Add

### Result
- Opens fullscreen (no browser bars)
- Works offline (cached shell)
- Receives messages when open
- Has an app icon

---

## How Phone A → Phone B messaging works

```
Phone A                    Server                   Phone B
  |                           |                         |
  |-- signup(ID, PIN) ------->|                         |
  |<-- token ------------------                         |
  |                           |                         |
  |-- WS connect + auth ----->|                         |
  |                           |<-- WS connect + auth ---|
  |                           |                         |
  |-- send(to: B, text) ----->|-- forward(from: A) ---->|
  |                           |                         |
  |                    (B offline?)                      |
  |-- send(to: B, text) ----->|-- queue message          |
  |                           |                         |
  |                           |<-- B comes online -------|
  |                           |-- deliver queued ------->|
```

---

## Architecture

```
emp-app/
├── server/
│   └── index.js          # Express + WebSocket server
├── public/
│   ├── index.html         # Full PWA app (patched from original)
│   ├── manifest.json      # PWA manifest (name, icon, display mode)
│   └── sw.js              # Service worker (offline cache)
└── package.json
```

### Server endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Server health check |
| GET | /api/users/:id | Check if user ID exists |
| POST | /api/signup | Create account |
| POST | /api/login | Login, get token + pending messages |
| GET | /api/messages | Poll for new messages |
| POST | /api/send | Send message (REST fallback) |
| WS | /ws | Real-time WebSocket channel |

### WebSocket message types
| Type | Direction | Description |
|------|-----------|-------------|
| auth | Client→Server | Send token to authenticate |
| auth_ok | Server→Client | Authenticated, delivers queued msgs |
| send | Client→Server | Send message to peer |
| sent_ok | Server→Client | Confirm delivery |
| message | Server→Client | Incoming message from peer |
| ping/pong | Both | Keep-alive |

---

## Production Notes

1. **Add HTTPS** — Required for PWA install on Android. Railway/Render give you HTTPS automatically.

2. **Add a database** — Current version uses in-memory storage. Restart = all data lost. For persistence, replace the `Map()` stores with SQLite or PostgreSQL.

3. **PIN security** — PINs are bcrypt-hashed on the server. The PIN never leaves the client in plaintext. The PIN is only used locally to "decrypt" messages (UI-only simulation).

4. **Message storage** — Messages are stored locally in `localStorage` per device. The server only queues undelivered messages.

5. **Admin** — Login with ID `BSB93SP` and any PIN for admin controls. Change `ADMIN_ID` in `server/index.js` and regenerate.

---

## APK via TWA (Advanced — true Android APK)

For a real `.apk` file using Trusted Web Activity:

1. Deploy to HTTPS URL first
2. Use **Bubblewrap** (Google's tool):
```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://your-url.com/manifest.json
bubblewrap build
```
This generates a signed `.apk` you can sideload or publish to Play Store.

Or use **PWABuilder** (pwabuilder.com) — paste your URL, click "Package for Android" → downloads APK.
