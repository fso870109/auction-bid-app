'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');
const { applyOps, emptySnapshot, snapshotToOps } = require(path.join(__dirname, '..', 'sync-core.js'));

const PORT = Number(process.env.PORT) || 8787;
const REDIS_URL = process.env.REDIS_URL || process.env.KEY_VALUE_URL || '';
const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || 'https://auction-bid-app.onrender.com,http://127.0.0.1:8766,http://localhost:8766')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ROOM_TTL_SEC = 60 * 60 * 24 * 30;

const rooms = new Map(); // code -> { snap, clients:Set, touched }
let redis = null;

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGINS.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function newCode() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function validCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { snap: emptySnapshot(), clients: new Set(), touched: Date.now() };
    rooms.set(code, r);
  }
  r.touched = Date.now();
  return r;
}

async function loadRoom(code) {
  if (rooms.has(code)) return getRoom(code);
  if (redis) {
    try {
      const raw = await redis.get('room:' + code);
      if (raw) {
        const snap = JSON.parse(raw);
        const r = { snap, clients: new Set(), touched: Date.now() };
        rooms.set(code, r);
        return r;
      }
    } catch (err) {
      console.error('redis get', err.message);
    }
  }
  return null;
}

async function persistRoom(code) {
  if (!redis) return;
  const r = rooms.get(code);
  if (!r) return;
  try {
    await redis.set('room:' + code, JSON.stringify(r.snap), { EX: ROOM_TTL_SEC });
  } catch (err) {
    console.error('redis set', err.message);
  }
}

function adoptSnapshot(raw) {
  const base = emptySnapshot();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.lots && typeof raw.lots === 'object') base.lots = raw.lots;
  if (raw.planItems && typeof raw.planItems === 'object') base.planItems = raw.planItems;
  if (raw.kv && typeof raw.kv === 'object') base.kv = raw.kv;
  if (raw.tombstones && typeof raw.tombstones === 'object') {
    base.tombstones = {
      lots: raw.tombstones.lots && typeof raw.tombstones.lots === 'object' ? raw.tombstones.lots : {},
      plan: raw.tombstones.plan && typeof raw.tombstones.plan === 'object' ? raw.tombstones.plan : {}
    };
  }
  base.rev = Number(raw.rev) || 0;
  return base;
}

function mergeIncoming(room, body) {
  if (!body) return;
  if (Array.isArray(body.ops) && body.ops.length) applyOps(room.snap, body.ops);
  if (body.snapshot) applyOps(room.snap, snapshotToOps(body.snapshot));
}

function incomingOps(body) {
  const ops = [];
  if (body && Array.isArray(body.ops)) ops.push(...body.ops);
  if (body && body.snapshot) ops.push(...snapshotToOps(body.snapshot));
  return ops;
}

function notifyRoom(room, body, from) {
  const ops = incomingOps(body);
  if (!ops.length) return;
  broadcast(room, null, { type: 'ops', ops, from: from || '' });
}

function broadcast(room, except, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients) {
    if (ws !== except && ws.readyState === 1) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

const joinAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = joinAttempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60_000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  joinAttempts.set(ip, rec);
  return rec.n > 30;
}

async function readBody(req, limit) {
  limit = limit || 1_000_000;
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      json(res, 200, { ok: true, redis: !!redis });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      if (rateLimited(ip)) { json(res, 429, { error: '太多請求，請稍後再試' }); return; }
      const body = await readBody(req);
      let code = validCode(body && body.code) ? String(body.code) : '';
      if (code) {
        const existing = await loadRoom(code);
        if (existing) {
          mergeIncoming(existing, body);
          await persistRoom(code);
          notifyRoom(existing, body, 'http');
          json(res, 200, { code, snapshot: existing.snap, existed: true });
          return;
        }
      } else {
        code = newCode();
        for (let i = 0; i < 8; i++) {
          const exists = await loadRoom(code);
          if (!exists) break;
          code = newCode();
        }
      }
      const room = getRoom(code);
      if (body && body.snapshot) room.snap = adoptSnapshot(body.snapshot);
      await persistRoom(code);
      json(res, 200, { code, snapshot: room.snap });
      return;
    }
    const join = url.pathname.match(/^\/api\/rooms\/(\d{6})\/join$/);
    if (req.method === 'POST' && join) {
      if (rateLimited(ip)) { json(res, 429, { error: '太多請求，請稍後再試' }); return; }
      const code = join[1];
      let room = await loadRoom(code);
      if (!room) { json(res, 404, { error: '找不到這個房號' }); return; }
      const body = await readBody(req);
      mergeIncoming(room, body);
      await persistRoom(code);
      notifyRoom(room, body, 'join');
      json(res, 200, { code, snapshot: room.snap });
      return;
    }
    const getRoomPath = url.pathname.match(/^\/api\/rooms\/(\d{6})$/);
    if (req.method === 'GET' && getRoomPath) {
      const code = getRoomPath[1];
      const room = await loadRoom(code);
      if (!room) { json(res, 404, { error: '找不到這個房號' }); return; }
      json(res, 200, { code, ok: true });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error(err);
    json(res, 400, { error: '請求無效' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('room') || '';
  const peer = String(url.searchParams.get('peer') || '').slice(0, 32);
  if (!validCode(code)) { ws.close(1008, 'bad room'); return; }
  const room = await loadRoom(code);
  if (!room) { ws.close(4404, 'no room'); return; }
  room.clients.add(ws);
  ws.roomCode = code;
  ws.peer = peer;
  ws.isAlive = true;
  try {
    ws.send(JSON.stringify({ type: 'hello', snapshot: room.snap, peers: room.clients.size }));
  } catch { /* ignore */ }

  ws.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ops' && Array.isArray(msg.ops)) {
      const ops = msg.ops.slice(0, 500);
      const { applied } = applyOps(room.snap, ops);
      if (applied) {
        await persistRoom(code);
        broadcast(room, ws, { type: 'ops', ops, from: peer });
      }
      try { ws.send(JSON.stringify({ type: 'ack', count: ops.length, applied })); } catch { /* ignore */ }
    } else if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
    }
  });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => {
    room.clients.delete(ws);
  });
});

const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on('close', () => clearInterval(beat));

setInterval(() => {
  if (!redis) return;
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.clients.size === 0 && now - r.touched > 10 * 60 * 1000) {
      persistRoom(code).finally(() => {
        const cur = rooms.get(code);
        if (cur && cur.clients.size === 0) rooms.delete(code);
      });
    }
  }
}, 60_000);

async function connectRedis() {
  if (!REDIS_URL) {
    console.log('No REDIS_URL; rooms stay in memory');
    return;
  }
  try {
    const { createClient } = require('redis');
    redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => console.error('redis', err.message));
    await redis.connect();
    console.log('Redis connected');
  } catch (err) {
    console.error('Redis failed, continuing in memory:', err.message);
    redis = null;
  }
}

connectRedis().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('auction-bid-sync listening on', PORT);
  });
});
