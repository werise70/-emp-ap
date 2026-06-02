/**
 * EMP Backend Server
 * - REST API: signup, login, check user
 * - WebSocket: real-time message relay between devices
 * - In-memory storage (swap for DB in production)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── IN-MEMORY STORES ─────────────────────────────────────
// accounts: { [userId]: { pinHash, createdAt } }
const accounts = new Map();
// Seed admin
const ADMIN_ID = 'BSB93SP';
const ADMIN_PIN_HASH = bcrypt.hashSync('000000', 10); // default admin pin
accounts.set(ADMIN_ID, { pinHash: ADMIN_PIN_HASH, createdAt: Date.now() });

// messages: { [userId]: [ {id, from, to, text, mtype, time, locked} ] }
const messages = new Map();

// sessions: { [token]: userId }
const sessions = new Map();

// online sockets: { [userId]: WebSocket }
const onlineSockets = new Map();

// admin state
const adminState = {
  totalKill: false,
  blockSignups: false,
  blockLogins: false,
  suspended: new Set(),
};

// ─── HELPERS ──────────────────────────────────────────────
function genToken() { return uuidv4().replace(/-/g, ''); }
function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  return sessions.get(token) || null;
}
function isAdmin(userId) { return userId === ADMIN_ID; }

// ─── REST API ─────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Check if ID exists
app.get('/api/users/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  res.json({ exists: accounts.has(id) });
});

// Sign up
app.post('/api/signup', async (req, res) => {
  if (adminState.totalKill || adminState.blockSignups) {
    return res.status(403).json({ error: 'signups are currently disabled' });
  }
  const { userId, pin } = req.body;
  if (!userId || !pin || userId.length !== 7 || pin.length !== 6) {
    return res.status(400).json({ error: 'invalid userId or pin' });
  }
  const id = userId.toUpperCase();
  if (accounts.has(id)) {
    return res.status(409).json({ error: 'ID already taken' });
  }
  const pinHash = await bcrypt.hash(pin, 10);
  accounts.set(id, { pinHash, createdAt: Date.now() });
  messages.set(id, []);
  const token = genToken();
  sessions.set(token, id);
  res.json({ ok: true, token, userId: id });
});

// Login
app.post('/api/login', async (req, res) => {
  if (adminState.totalKill || adminState.blockLogins) {
    return res.status(403).json({ error: 'logins are currently disabled' });
  }
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'missing fields' });
  const id = userId.toUpperCase();
  const account = accounts.get(id);
  if (!account) return res.status(404).json({ error: 'ID not found' });
  if (adminState.suspended.has(id) && !isAdmin(id)) {
    return res.status(403).json({ error: 'account suspended' });
  }
  const valid = await bcrypt.compare(pin, account.pinHash);
  if (!valid) return res.status(401).json({ error: 'wrong PIN' });
  const token = genToken();
  sessions.set(token, id);
  // return any pending messages
  const pending = messages.get(id) || [];
  messages.set(id, []); // clear after delivery
  res.json({ ok: true, token, userId: id, pending });
});

// Get pending messages (poll fallback)
app.get('/api/messages', (req, res) => {
  const userId = getUserFromToken(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const pending = messages.get(userId) || [];
  messages.set(userId, []);
  res.json({ messages: pending });
});

// Send message via REST (fallback if WS not connected)
app.post('/api/send', (req, res) => {
  const senderId = getUserFromToken(req);
  if (!senderId) return res.status(401).json({ error: 'unauthorized' });
  const { toId, text, mtype } = req.body;
  if (!toId || !text) return res.status(400).json({ error: 'missing fields' });
  const to = toId.toUpperCase();
  if (!accounts.has(to)) return res.status(404).json({ error: 'recipient not found' });

  const msg = {
    id: uuidv4(),
    from: senderId,
    to,
    text,
    mtype: mtype || 'text',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(),
  };

  // Try live WebSocket delivery first
  const recipientWs = onlineSockets.get(to);
  if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
    recipientWs.send(JSON.stringify({ type: 'message', payload: msg }));
    return res.json({ ok: true, delivered: 'live' });
  }

  // Queue for next login/poll
  if (!messages.has(to)) messages.set(to, []);
  messages.get(to).push(msg);
  res.json({ ok: true, delivered: 'queued' });
});

// Admin: list accounts
app.get('/api/admin/accounts', (req, res) => {
  const userId = getUserFromToken(req);
  if (!isAdmin(userId)) return res.status(403).json({ error: 'forbidden' });
  const list = [];
  for (const [id] of accounts) {
    list.push({ id, suspended: adminState.suspended.has(id), online: onlineSockets.has(id) });
  }
  res.json({ accounts: list });
});

// Admin: suspend/restore
app.post('/api/admin/suspend', (req, res) => {
  const userId = getUserFromToken(req);
  if (!isAdmin(userId)) return res.status(403).json({ error: 'forbidden' });
  const { targetId, action } = req.body; // action: 'suspend' | 'restore'
  if (action === 'suspend') adminState.suspended.add(targetId.toUpperCase());
  else adminState.suspended.delete(targetId.toUpperCase());
  res.json({ ok: true });
});

// Admin: system controls
app.post('/api/admin/control', (req, res) => {
  const userId = getUserFromToken(req);
  if (!isAdmin(userId)) return res.status(403).json({ error: 'forbidden' });
  const { key, value } = req.body;
  if (key === 'totalKill') adminState.totalKill = value;
  if (key === 'blockSignups') adminState.blockSignups = value;
  if (key === 'blockLogins') adminState.blockLogins = value;
  res.json({ ok: true });
});

// Serve app for all other routes (SPA)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── WEBSOCKET ────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  let authenticatedUserId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Auth handshake
    if (msg.type === 'auth') {
      const userId = sessions.get(msg.token);
      if (!userId) { ws.send(JSON.stringify({ type: 'auth_fail' })); return; }
      authenticatedUserId = userId;
      onlineSockets.set(userId, ws);
      ws.send(JSON.stringify({ type: 'auth_ok', userId }));

      // Deliver any queued messages
      const queued = messages.get(userId) || [];
      if (queued.length > 0) {
        queued.forEach(m => ws.send(JSON.stringify({ type: 'message', payload: m })));
        messages.set(userId, []);
      }
      return;
    }

    if (!authenticatedUserId) { ws.send(JSON.stringify({ type: 'error', msg: 'not authenticated' })); return; }

    // Send message
    if (msg.type === 'send') {
      const { toId, text, mtype } = msg;
      if (!toId || !text) return;
      const to = toId.toUpperCase();
      if (!accounts.has(to)) {
        ws.send(JSON.stringify({ type: 'error', msg: 'recipient not found' }));
        return;
      }

      const envelope = {
        id: uuidv4(),
        from: authenticatedUserId,
        to,
        text,
        mtype: mtype || 'text',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ts: Date.now(),
      };

      // Confirm delivery to sender
      ws.send(JSON.stringify({ type: 'sent_ok', id: envelope.id }));

      // Live delivery or queue
      const recipientWs = onlineSockets.get(to);
      if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
        recipientWs.send(JSON.stringify({ type: 'message', payload: envelope }));
      } else {
        if (!messages.has(to)) messages.set(to, []);
        messages.get(to).push(envelope);
      }
    }

    // Presence ping
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    }
  });

  ws.on('close', () => {
    if (authenticatedUserId) onlineSockets.delete(authenticatedUserId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`EMP server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
