'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');
const { applyOps, emptySnapshot, snapshotToOps } = require(path.join(__dirname, '..', 'sync-core.js'));

const PORT = Number(process.env.PORT) || 8787;
const REDIS_URL = process.env.REDIS_URL || process.env.KEY_VALUE_URL || '';
const IS_RENDER = !!process.env.RENDER;
const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || 'https://auction-bid-app.onrender.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ROOM_TTL_SEC = 60 * 60 * 24 * 30;
// A phone re-creating its room sends the whole snapshot (hundreds of lots with per-field stamps
// run past 256 KB), so the JSON endpoints take up to 1.5 MB. Socket messages stay small.
const BODY_LIMIT = 1536 * 1024;
const WS_MSG_LIMIT = 1536 * 1024; // v112: same as BODY_LIMIT; a too-big frame used to close the socket and jam the phone's queue
const MAX_OPS = 200;
const MAX_DEVICES = 12; // v112: a team room (was 2: a third phone or a re-installed phone could never be approved)
const MAX_PENDING = 5;
const AUTO_APPROVE_DEVICES = 2; // the first two phones join on the invite alone; more need the owner's OK
const PENDING_TTL_MS = 10 * 60 * 1000;
const JOIN_ERROR = '無法加入這個房間';
const RETRY_ERROR = '請稍後再試';
const OP_KINDS = new Set(['lot-upsert', 'lot-delete', 'plan-upsert', 'plan-delete', 'kv']);
const LABEL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PEPPER = process.env.SYNC_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SYNC_SECRET) {
  console.log('SYNC_SECRET not set; using a process-local key (restore tickets will not survive restarts)');
}

const SERVER_VERSION = 'v112';
const rooms = new Map();
let redis = null;

/* ---------- Global auction progress (shared by every room) ----------
   Only lot numbers per market day + 場次 + 台. No names, lots, notes, or
   room data. Last write wins by the anchor time (converted to server time). */
const GP_TTL_SEC = 60 * 60 * 24 * 2;
const GP_HALVES = { fruit: 'f', morning: 'm', afternoon: 'a' };
const GP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const GP_DEV_PER_MIN = 40;
const GP_IP_PER_MIN = 120;
const gpDays = new Map(); // day -> Map(key -> entry)
const gpClients = new Set();
const gpBuckets = new Map();

function taipeiDayStr(ms) {
  const d = new Date((ms || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function gpDayOk(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return false;
  const now = Date.now();
  const allowed = [taipeiDayStr(now - 86400000), taipeiDayStr(now), taipeiDayStr(now + 86400000)];
  return allowed.includes(day);
}

function gpKeyOk(half, mid) {
  const p = GP_HALVES[half];
  return !!p && typeof mid === 'string' && new RegExp('^' + p + '[1-9]$').test(mid);
}

function gpRateOk(ip, dev) {
  const now = Date.now();
  const hit = (key, limit) => {
    let rec = gpBuckets.get(key);
    if (!rec || now - rec.start > 60000) rec = { start: now, n: 0 };
    rec.n += 1;
    gpBuckets.set(key, rec);
    return rec.n <= limit;
  };
  const a = hit('ip:' + ip, GP_IP_PER_MIN);
  const b = hit('dev:' + String(dev || '').slice(0, 64), GP_DEV_PER_MIN);
  return a && b;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of gpBuckets) if (now - rec.start > 120000) gpBuckets.delete(k);
  for (const day of gpDays.keys()) if (!gpDayOk(day)) gpDays.delete(day);
}, 60000);

async function gpLoadDay(day) {
  if (gpDays.has(day)) return gpDays.get(day);
  const map = new Map();
  if (redis) {
    try {
      const raw = await redis.hGetAll('gp:' + day);
      for (const [k, v] of Object.entries(raw || {})) {
        try { map.set(k, JSON.parse(v)); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error('redis gp get', err.message);
    }
  }
  if (!gpDays.has(day)) gpDays.set(day, map);
  return gpDays.get(day);
}

async function gpPersist(day, key, entry) {
  if (!redis) return;
  try {
    await redis.hSet('gp:' + day, key, JSON.stringify(entry));
    await redis.expire('gp:' + day, GP_TTL_SEC);
  } catch (err) {
    console.error('redis gp set', err.message);
  }
}

function gpEntries(map) {
  const out = [];
  for (const [key, e] of map) {
    const [half, mid] = key.split('|');
    out.push({ half, mid, entry: e });
  }
  return out;
}

/* Validate and normalize one update. Returns entry or an error string. */
function gpNormalize(msg) {
  const a = msg && msg.anchor;
  if (!a || typeof a !== 'object') return 'bad';
  const now = Date.now();
  const clientNow = Number(msg.clientNow);
  const at = Number(a.at);
  if (!Number.isFinite(at) || !Number.isFinite(clientNow)) return 'bad';
  let skew = now - clientNow;
  if (!Number.isFinite(skew)) skew = 0;
  let atS = Math.round(at + skew);
  if (atS > now) atS = now;
  if (atS < now - GP_MAX_AGE_MS) return 'stale';
  const cleared = !!a.cleared || a.number == null || a.number === '';
  let number = null;
  if (!cleared) {
    number = Number(a.number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) return 'bad';
  }
  // Edit time decides who wins (last write wins). Clamp to server now.
  let tsS = Number.isFinite(Number(msg.ts)) ? Math.round(Number(msg.ts) + skew) : now;
  if (tsS > now) tsS = now;
  if (tsS < now - GP_MAX_AGE_MS) return 'stale';
  return {
    number,
    cleared,
    paused: !!a.paused,
    ended: !!a.ended,
    at: atS,
    ts: tsS
  };
}

/* Same content (auto-advance anchor within a few seconds): ignore, avoids echo loops. */
function gpSame(a, b) {
  return !!a && !!b && a.number === b.number && !!a.cleared === !!b.cleared
    && !!a.paused === !!b.paused && !!a.ended === !!b.ended && Math.abs(Number(a.at) - Number(b.at)) < 5000;
}

function gpBroadcast(day, msg) {
  const data = JSON.stringify(msg);
  for (const c of gpClients) {
    if (c.readyState === 1 && c.gpDay === day) {
      try { c.send(data); } catch { /* ignore */ }
    }
  }
}

async function gpHandle(ws, ip, msg) {
  if (!ws.originOk) { send(ws, { type: 'gp-error', error: 'origin' }); return; }
  if (msg.type === 'gp-sub') {
    const day = String(msg.day || '');
    if (!gpDayOk(day)) { send(ws, { type: 'gp-error', error: 'day' }); return; }
    ws.gpDay = day;
    ws.gpId = String(msg.gpId || '').slice(0, 64);
    gpClients.add(ws);
    const map = await gpLoadDay(day);
    send(ws, { type: 'gp-snap', day, entries: gpEntries(map), serverNow: Date.now() });
    return;
  }
  if (msg.type === 'gp-set') {
    const day = String(msg.day || '');
    const half = String(msg.half || '');
    const mid = String(msg.mid || '');
    if (!gpDayOk(day) || !gpKeyOk(half, mid)) { send(ws, { type: 'gp-error', error: 'key' }); return; }
    if (!gpRateOk(ip, msg.gpId || ws.gpId)) { send(ws, { type: 'gp-error', error: 'rate' }); return; }
    const entry = gpNormalize(msg);
    const key = half + '|' + mid;
    const map = await gpLoadDay(day);
    const cur = map.get(key);
    if (typeof entry === 'string') {
      send(ws, { type: 'gp-error', error: entry, day, half, mid, entry: cur || null, serverNow: Date.now() });
      return;
    }
    if (cur && (gpSame(cur, entry) || Number(cur.ts) > entry.ts)) {
      // Older or duplicate: tell the sender what is current so it converges.
      send(ws, { type: 'gp', day, half, mid, entry: cur || null, serverNow: Date.now() });
      return;
    }
    map.set(key, entry);
    await gpPersist(day, key, entry);
    gpBroadcast(day, { type: 'gp', day, half, mid, entry, serverNow: Date.now() });
  }
}

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOW_ORIGINS.includes(origin)) return true;
  if (!IS_RENDER && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return true;
  return false;
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (originAllowed(origin)) {
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

function newSecret() {
  return crypto.randomBytes(16).toString('base64url');
}
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}
function newId() {
  return crypto.randomBytes(12).toString('base64url');
}
function newLabel() {
  let s = '';
  for (let i = 0; i < 4; i++) s += LABEL_ALPHABET[crypto.randomInt(0, LABEL_ALPHABET.length)];
  return s;
}
function isLegacyCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}
function isSecret(code) {
  return /^[A-Za-z0-9_-]{22,64}$/.test(String(code || ''));
}
function hashToken(token) {
  return crypto.createHash('sha256').update(PEPPER + ':' + String(token || '')).digest('hex');
}
function tokenOk(record, token) {
  if (!record || !record.tokenHash || !token) return false;
  try {
    const a = Buffer.from(record.tokenHash, 'hex');
    const b = Buffer.from(hashToken(token), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
function restoreTicket(code, deviceId, role) {
  return crypto.createHmac('sha256', PEPPER).update('v1:' + code + ':' + deviceId + ':' + role).digest('base64url');
}
function restoreTicketOk(code, deviceId, role, ticket) {
  if (!ticket) return false;
  const expect = restoreTicket(code, deviceId, role);
  try {
    const a = Buffer.from(expect);
    const b = Buffer.from(String(ticket));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

const failBuckets = new Map();
function bucketKey(ip, deviceId) {
  return 'ip:' + ip + (deviceId ? '|dev:' + String(deviceId).slice(0, 64) : '');
}
function lockedUntil(key) {
  const rec = failBuckets.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  return rec.lockedUntil > Date.now() ? rec.lockedUntil : 0;
}
function isLocked(ip, deviceId) {
  return lockedUntil(bucketKey(ip, deviceId)) > 0 || lockedUntil(bucketKey(ip, '')) > 0;
}
function recordFail(ip, deviceId) {
  const keys = [bucketKey(ip, ''), bucketKey(ip, deviceId)].filter((v, i, a) => a.indexOf(v) === i);
  const now = Date.now();
  let wait = 0;
  for (const key of keys) {
    let rec = failBuckets.get(key);
    if (!rec || now - rec.windowStart > 15 * 60 * 1000) rec = { n: 0, lockedUntil: 0, windowStart: now };
    rec.n += 1;
    if (rec.n >= 5) {
      const exp = Math.min(15 * 60 * 1000, 15000 * Math.pow(2, Math.min(rec.n - 5, 6)));
      rec.lockedUntil = now + exp;
    }
    failBuckets.set(key, rec);
    if (rec.lockedUntil > wait) wait = rec.lockedUntil;
  }
  return wait;
}
function recordSuccess(ip, deviceId) {
  failBuckets.delete(bucketKey(ip, deviceId));
}

function emptyRoom(secret, label, ownerDeviceId) {
  return {
    secret,
    label: label || newLabel(),
    createdAt: Date.now(),
    ownerDeviceId: ownerDeviceId || '',
    devices: {},
    pending: {},
    snap: emptySnapshot(),
    clients: new Set(),
    touched: Date.now()
  };
}

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
  if ([...s].length > 20) s = [...s].slice(0, 20).join('').trim();
  return s;
}

function approvedCount(room) {
  return Object.values(room.devices || {}).filter((d) => d && d.approved && !d.revoked).length;
}

function publicDevices(room, me) {
  return Object.entries(room.devices || {})
    .filter(([, d]) => d && d.approved && !d.revoked)
    .map(([id, d]) => ({
      deviceId: id,
      name: sanitizeName(d && d.name),
      role: id === room.ownerDeviceId ? 'owner' : 'member',
      isMe: id === me,
      joinedAt: d.joinedAt || 0,
      lastSeen: d.lastSeen || 0,
      appVersion: typeof d.appVersion === 'string' ? d.appVersion.slice(0, 16) : '',
      online: deviceOnline(room, id)
    }));
}

function deviceOnline(room, id) {
  for (const ws of room.clients || []) {
    if (ws.deviceId === id && ws.readyState === 1 && ws.authed) return true;
  }
  return false;
}

function publicPending(room) {
  prunePending(room);
  return Object.entries(room.pending || {}).map(([id, p]) => ({
    requestId: id,
    deviceId: p.deviceId,
    name: sanitizeName((room.devices[p.deviceId] && room.devices[p.deviceId].name) || p.name),
    createdAt: p.createdAt
  }));
}

function prunePending(room) {
  const now = Date.now();
  for (const [id, p] of Object.entries(room.pending || {})) {
    if (!p || now - (p.createdAt || 0) > PENDING_TTL_MS) delete room.pending[id];
  }
}

function getCached(code) {
  const r = rooms.get(code);
  if (r) r.touched = Date.now();
  return r || null;
}

const roomLoads = new Map();
async function loadRoom(code) {
  if (rooms.has(code)) return getCached(code);
  // v112: two phones reconnecting at the same moment (server restart / wake-up) each
  // read Redis and each made their own room object; the second replaced the first in
  // the map, so the first phone sat in an orphan room and never got the other's ops.
  if (roomLoads.has(code)) return roomLoads.get(code);
  const p = loadRoomFromStore(code).finally(() => roomLoads.delete(code));
  roomLoads.set(code, p);
  return p;
}

async function loadRoomFromStore(code) {
  if (redis) {
    try {
      const raw = await redis.get('room:' + code);
      if (raw) {
        const data = JSON.parse(raw);
        let room;
        if (data && data.snap) {
          room = emptyRoom(code, data.label, data.ownerDeviceId);
          room.createdAt = data.createdAt || room.createdAt;
          room.devices = data.devices || {};
          room.pending = data.pending || {};
          room.snap = data.snap;
        } else if (data && data.lots) {
          // Legacy snapshot-only record (old 6-digit rooms)
          room = emptyRoom(code, data.label || '舊房', '');
          room.legacy = true;
          room.snap = data;
        } else {
          return null;
        }
        if (rooms.has(code)) return getCached(code);
        rooms.set(code, room);
        return room;
      }
    } catch (err) {
      console.error('redis get', err.message);
    }
  }
  return null;
}

const TOMBSTONE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
function pruneTombstones(r) {
  const tomb = r && r.snap && r.snap.tombstones;
  if (!tomb) return;
  const cut = Date.now() - TOMBSTONE_MAX_AGE_MS;
  for (const k of ['lots', 'plan']) {
    const m = tomb[k];
    if (!m || typeof m !== 'object') continue;
    for (const id of Object.keys(m)) {
      const ts = Number(m[id]);
      if (Number.isFinite(ts) && ts < cut) delete m[id];
    }
  }
}

async function persistRoom(code) {
  if (!redis) return;
  const r = rooms.get(code);
  if (!r) return;
  pruneTombstones(r);
  try {
    const payload = JSON.stringify({
      label: r.label,
      createdAt: r.createdAt,
      ownerDeviceId: r.ownerDeviceId,
      devices: r.devices,
      pending: r.pending,
      snap: r.snap
    });
    await redis.set('room:' + code, payload, { EX: ROOM_TTL_SEC });
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

function validOps(ops) {
  if (!Array.isArray(ops) || ops.length > MAX_OPS) return false;
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !OP_KINDS.has(op.kind)) return false;
  }
  return true;
}
// v112: keep the good ops of a batch instead of throwing the whole batch away.
function goodOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.slice(0, 2000).filter((op) => op && typeof op === 'object' && OP_KINDS.has(op.kind));
}

function mergeIncoming(room, body) {
  if (!body) return [];
  const ops = [];
  if (Array.isArray(body.ops)) ops.push(...goodOps(body.ops));
  if (body.snapshot && typeof body.snapshot === 'object') ops.push(...snapshotToOps(body.snapshot));
  if (!ops.length) return [];
  const { applied } = applyOps(room.snap, ops);
  return applied ? ops : [];
}

function broadcast(room, except, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients) {
    if (ws !== except && ws.readyState === 1 && ws.authed) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

function send(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
}

function kickDeviceSockets(room, deviceId, reason) {
  for (const ws of [...room.clients]) {
    if (ws.deviceId === deviceId) {
      send(ws, { type: reason || 'kicked' });
      try { ws.close(4403, reason || 'kicked'); } catch { /* ignore */ }
    }
  }
}

function membershipPayload(room, deviceId, extra) {
  const rec = room.devices[deviceId];
  const role = deviceId === room.ownerDeviceId ? 'owner' : 'member';
  const out = {
    code: room.secret,
    label: room.label,
    deviceId,
    role,
    status: rec && rec.approved && !rec.revoked ? 'approved' : 'pending',
    devices: publicDevices(room, deviceId)
  };
  if (role === 'owner') out.pending = publicPending(room);
  if (extra) Object.assign(out, extra);
  return out;
}

function registerDevice(room, deviceId, token, asOwner, name) {
  const id = deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(deviceId) ? deviceId : newId();
  const tok = token || newToken();
  room.devices[id] = {
    tokenHash: hashToken(tok),
    approved: true,
    revoked: false,
    joinedAt: Date.now(),
    name: sanitizeName(name)
  };
  if (asOwner || !room.ownerDeviceId) room.ownerDeviceId = id;
  return { deviceId: id, deviceToken: tok, role: id === room.ownerDeviceId ? 'owner' : 'member' };
}

async function readBody(req, limit) {
  limit = limit || BODY_LIMIT;
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
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      json(res, 200, { ok: true, redis: !!redis });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/gp') {
      const day = String(url.searchParams.get('day') || taipeiDayStr());
      if (!gpDayOk(day)) { json(res, 400, { error: 'day' }); return; }
      const map = await gpLoadDay(day);
      json(res, 200, { day, entries: gpEntries(map), serverNow: Date.now() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      if (isLocked(ip, '')) { json(res, 429, { error: RETRY_ERROR }); return; }
      const body = await readBody(req);
      const secret = newSecret();
      const room = emptyRoom(secret, newLabel(), '');
      if (body && body.snapshot) room.snap = adoptSnapshot(body.snapshot);
      const dev = registerDevice(room, body && body.deviceId, null, true, body && body.name);
      rooms.set(secret, room);
      await persistRoom(secret);
      recordSuccess(ip, dev.deviceId);
      json(res, 200, Object.assign(membershipPayload(room, dev.deviceId, {
        deviceToken: dev.deviceToken,
        restoreToken: restoreTicket(secret, dev.deviceId, 'owner'),
        snapshot: room.snap
      })));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/join') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const deviceId = body && body.deviceId;
      if (isLocked(ip, deviceId)) { json(res, 429, { error: RETRY_ERROR }); return; }
      if (!isSecret(code) || isLegacyCode(code)) {
        recordFail(ip, deviceId);
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const room = await loadRoom(code);
      if (!room || room.legacy) {
        recordFail(ip, deviceId);
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      // Rejoin of an approved device
      if (deviceId && room.devices[deviceId] && tokenOk(room.devices[deviceId], body.deviceToken) && room.devices[deviceId].approved && !room.devices[deviceId].revoked) {
        if (body && body.name) {
          room.devices[deviceId].name = sanitizeName(body.name);
        }
        const merged = mergeIncoming(room, body);
        await persistRoom(code);
        if (merged.length) broadcast(room, null, { type: 'ops', ops: merged, from: deviceId });
        recordSuccess(ip, deviceId);
        const role = deviceId === room.ownerDeviceId ? 'owner' : 'member';
        json(res, 200, membershipPayload(room, deviceId, {
          snapshot: room.snap,
          restoreToken: restoreTicket(code, deviceId, role)
        }));
        return;
      }
      // Rejoin of a still-pending request
      if (deviceId && room.devices[deviceId] && tokenOk(room.devices[deviceId], body.deviceToken) && !room.devices[deviceId].approved && !room.devices[deviceId].revoked) {
        const reqId = Object.keys(room.pending).find((id) => room.pending[id].deviceId === deviceId);
        json(res, 200, { status: 'pending', requestId: reqId || '', deviceId, code: room.secret, label: room.label });
        return;
      }
      prunePending(room);
      if (approvedCount(room) < AUTO_APPROVE_DEVICES) {
        const dev = registerDevice(room, deviceId, null, false, body && body.name);
        const merged = mergeIncoming(room, body);
        await persistRoom(code);
        recordSuccess(ip, dev.deviceId);
        if (merged.length) broadcast(room, null, { type: 'ops', ops: merged, from: dev.deviceId });
        broadcast(room, null, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
        json(res, 200, membershipPayload(room, dev.deviceId, {
          deviceToken: dev.deviceToken,
          restoreToken: restoreTicket(code, dev.deviceId, dev.role),
          snapshot: room.snap
        }));
        return;
      }
      // Room full: pending approval
      if (Object.keys(room.pending).length >= MAX_PENDING) {
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const id = deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(deviceId) ? deviceId : newId();
      const tok = newToken();
      const requestId = newId();
      const joinName = sanitizeName(body && body.name);
      room.devices[id] = { tokenHash: hashToken(tok), approved: false, revoked: false, joinedAt: Date.now(), name: joinName };
      room.pending[requestId] = { deviceId: id, createdAt: Date.now(), name: joinName };
      await persistRoom(code);
      broadcast(room, null, { type: 'join-request', request: { requestId, deviceId: id, name: joinName, createdAt: Date.now() } });
      json(res, 200, { status: 'pending', requestId, deviceId: id, deviceToken: tok, code: room.secret, label: room.label });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/restore') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const deviceId = body && body.deviceId;
      if (isLocked(ip, deviceId)) { json(res, 429, { error: RETRY_ERROR }); return; }
      if (!isSecret(code) || !deviceId || !restoreTicketOk(code, deviceId, 'owner', body.restoreToken)) {
        recordFail(ip, deviceId);
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      let room = await loadRoom(code);
      if (!room) {
        room = emptyRoom(code, (body && body.label) || newLabel(), deviceId);
        if (body && body.snapshot) room.snap = adoptSnapshot(body.snapshot);
        const tok = body.deviceToken || newToken();
        room.devices[deviceId] = { tokenHash: hashToken(tok), approved: true, revoked: false, joinedAt: Date.now(), name: sanitizeName(body && body.name) };
        room.ownerDeviceId = deviceId;
        rooms.set(code, room);
        await persistRoom(code);
        recordSuccess(ip, deviceId);
        json(res, 200, membershipPayload(room, deviceId, {
          deviceToken: tok,
          restoreToken: restoreTicket(code, deviceId, 'owner'),
          snapshot: room.snap,
          restored: true
        }));
        return;
      }
      if (room.legacy) {
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const rec = room.devices[deviceId];
      if (!rec || !tokenOk(rec, body.deviceToken) || rec.revoked || deviceId !== room.ownerDeviceId) {
        recordFail(ip, deviceId);
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const merged = mergeIncoming(room, body);
      await persistRoom(code);
      if (merged.length) broadcast(room, null, { type: 'ops', ops: merged, from: deviceId });
      recordSuccess(ip, deviceId);
      json(res, 200, membershipPayload(room, deviceId, { snapshot: room.snap }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/approve') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const room = isSecret(code) ? await loadRoom(code) : null;
      if (!room || room.legacy) { json(res, 403, { error: JOIN_ERROR }); return; }
      const rec = room.devices[body.deviceId];
      if (!rec || !tokenOk(rec, body.deviceToken) || body.deviceId !== room.ownerDeviceId) {
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const requestId = body.requestId;
      const pending = room.pending && room.pending[requestId];
      if (!pending) { json(res, 400, { error: '這個申請已經不在了' }); return; }
      const target = pending.deviceId;
      delete room.pending[requestId];
      if (body.accept) {
        if (approvedCount(room) >= MAX_DEVICES) {
          if (room.devices[target]) room.devices[target].revoked = true;
          await persistRoom(code);
          kickDeviceSockets(room, target, 'rejected');
          json(res, 409, { error: '房間已有兩支手機', devices: publicDevices(room, body.deviceId), pending: publicPending(room) });
          return;
        }
        if (room.devices[target]) {
          room.devices[target].approved = true;
          room.devices[target].revoked = false;
        }
        await persistRoom(code);
        for (const ws of room.clients) {
          if (ws.deviceId === target) {
            ws.authed = true;
            send(ws, { type: 'approved', snapshot: room.snap, devices: publicDevices(room, target) });
          }
        }
        broadcast(room, null, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
        json(res, 200, membershipPayload(room, body.deviceId));
        return;
      }
      if (room.devices[target]) room.devices[target].revoked = true;
      await persistRoom(code);
      kickDeviceSockets(room, target, 'rejected');
      json(res, 200, membershipPayload(room, body.deviceId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/kick') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const room = isSecret(code) ? await loadRoom(code) : null;
      if (!room || room.legacy) { json(res, 403, { error: JOIN_ERROR }); return; }
      const rec = room.devices[body.deviceId];
      if (!rec || !tokenOk(rec, body.deviceToken) || body.deviceId !== room.ownerDeviceId) {
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      const target = body.targetDeviceId;
      if (!target || target === body.deviceId) { json(res, 400, { error: '無法移除這支手機' }); return; }
      if (room.devices[target]) room.devices[target].revoked = true;
      for (const [id, p] of Object.entries(room.pending || {})) {
        if (p.deviceId === target) delete room.pending[id];
      }
      await persistRoom(code);
      kickDeviceSockets(room, target, 'kicked');
      broadcast(room, null, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
      json(res, 200, membershipPayload(room, body.deviceId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/profile') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const room = isSecret(code) ? await loadRoom(code) : null;
      if (!room || room.legacy) { json(res, 403, { error: JOIN_ERROR }); return; }
      const rec = room.devices[body.deviceId];
      if (!rec || !tokenOk(rec, body.deviceToken) || rec.revoked) {
        json(res, 403, { error: JOIN_ERROR });
        return;
      }
      rec.name = sanitizeName(body && body.name);
      if (room.pending) {
        for (const p of Object.values(room.pending)) {
          if (p && p.deviceId === body.deviceId) p.name = rec.name;
        }
      }
      await persistRoom(code);
      broadcast(room, null, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
      json(res, 200, membershipPayload(room, body.deviceId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms/leave') {
      const body = await readBody(req);
      const code = String((body && body.code) || '');
      const room = isSecret(code) ? await loadRoom(code) : null;
      if (!room) { json(res, 200, { ok: true }); return; }
      const rec = room.devices[body.deviceId];
      if (rec && tokenOk(rec, body.deviceToken)) {
        rec.revoked = true;
        rec.approved = false;
        if (room.ownerDeviceId === body.deviceId) {
          const next = Object.entries(room.devices).find(([, d]) => d && d.approved && !d.revoked);
          room.ownerDeviceId = next ? next[0] : '';
        }
        await persistRoom(code);
        kickDeviceSockets(room, body.deviceId, 'left');
        broadcast(room, null, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
      }
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (err && err.message === 'too large') { json(res, 413, { error: '資料太大' }); return; }
    console.error(err);
    json(res, 400, { error: '請求無效' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_MSG_LIMIT });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.authed = false;
  ws.isAlive = true;
  ws.roomCode = '';
  ws.deviceId = '';
  ws.originOk = originAllowed(req.headers.origin || '');
  ws.gpDay = '';

  ws.on('message', async (buf) => {
    if (buf && buf.length > WS_MSG_LIMIT) { try { ws.close(1009, 'too large'); } catch { /* ignore */ } return; }
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'gp-sub' || msg.type === 'gp-set') {
      try { await gpHandle(ws, ip, msg); } catch (err) { console.error('gp', err && err.message); }
      return;
    }
    if (msg.type === 'gp-ping') { send(ws, { type: 'gp-pong' }); return; }

    if (msg.type === 'auth') {
      const code = String(msg.code || '');
      const deviceId = msg.deviceId;
      if (isLocked(ip, deviceId)) { send(ws, { type: 'error', error: RETRY_ERROR }); ws.close(4408, 'locked'); return; }
      if (!isSecret(code) || isLegacyCode(code)) {
        recordFail(ip, deviceId);
        send(ws, { type: 'error', error: JOIN_ERROR });
        ws.close(4403, 'auth');
        return;
      }
      const room = await loadRoom(code);
      const rec = room && !room.legacy && deviceId ? room.devices[deviceId] : null;
      if (!room || !rec || !tokenOk(rec, msg.token) || rec.revoked) {
        recordFail(ip, deviceId);
        send(ws, { type: 'error', error: JOIN_ERROR });
        ws.close(4403, 'auth');
        return;
      }
      recordSuccess(ip, deviceId);
      ws.roomCode = code;
      ws.deviceId = deviceId;
      ws.token = msg.token;
      room.clients.add(ws);
      rec.lastSeen = Date.now();
      if (typeof msg.appVersion === 'string') rec.appVersion = msg.appVersion.slice(0, 16);
      if (typeof msg.name === 'string' && msg.name.trim()) rec.name = sanitizeName(msg.name);
      if (!rec.approved) {
        ws.authed = false;
        ws.pending = true;
        send(ws, { type: 'hello', status: 'pending', label: room.label, deviceId });
        return;
      }
      ws.authed = true;
      const role = deviceId === room.ownerDeviceId ? 'owner' : 'member';
      broadcast(room, ws, { type: 'devices', devices: publicDevices(room, ''), pending: publicPending(room) });
      send(ws, {
        type: 'hello',
        serverVersion: SERVER_VERSION,
        status: 'approved',
        snapshot: room.snap,
        label: room.label,
        role,
        devices: publicDevices(room, deviceId),
        pending: role === 'owner' ? publicPending(room) : []
      });
      return;
    }

    if (!ws.roomCode || !ws.deviceId) return;
    const room = getCached(ws.roomCode) || (await loadRoom(ws.roomCode));
    if (!room) { ws.close(4404, 'auth'); return; }
    const rec = room.devices[ws.deviceId];
    const tok = msg.token || ws.token;
    if (!rec || !tokenOk(rec, tok) || rec.revoked) {
      send(ws, { type: 'kicked' });
      ws.close(4403, 'auth');
      return;
    }
    if (!rec.approved) {
      if (msg.type === 'ping') send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'ops') {
      const ops = goodOps(msg.ops);
      const count = Array.isArray(msg.ops) ? msg.ops.length : 0;
      rec.lastSeen = Date.now();
      if (typeof msg.appVersion === 'string') rec.appVersion = msg.appVersion.slice(0, 16);
      const { applied } = ops.length ? applyOps(room.snap, ops) : { applied: 0 };
      if (applied) {
        await persistRoom(ws.roomCode);
        broadcast(room, ws, { type: 'ops', ops, from: ws.deviceId });
      }
      send(ws, { type: 'ack', count, applied, seq: msg.seq });
    } else if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
    }
  });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => {
    gpClients.delete(ws);
    if (ws.roomCode && rooms.has(ws.roomCode)) {
      const r = rooms.get(ws.roomCode);
      r.clients.delete(ws);
      if (ws.authed) broadcast(r, null, { type: 'devices', devices: publicDevices(r, ''), pending: publicPending(r) });
    }
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
