/* Shared auction progress for 拍賣標貨助手.
   Every phone (any room, or no room) shares only the "現在拍到幾號" anchor per
   auction day + 場次 + 台. Lots, 標到/流標, 優先, 備註 and item lists stay in the room. */
'use strict';

const GP_ID_RE = { fruit: /^f[1-9]$/, morning: /^m[1-9]$/, afternoon: /^a[1-9]$/ };
const GP_SAME_AT_MS = 5000;

let gpWs = null;
let gpStatus = 'off'; // off | connecting | online | offline
let gpSubDay = '';
let gpKnown = {};
let gpApplying = false;
let gpRetry = null;
let gpBooted = false;
let gpLastRemoteAt = 0;
let gpTick = 0;
let gpFlushTimer = null;

function gpNow() {
  try { if (typeof nowDate === 'function') return nowDate().getTime(); } catch { /* ignore */ }
  return Date.now();
}

function globalProgressOn() {
  return !!state && state.globalProgress !== false;
}

function gpReady() {
  return !!state && globalProgressOn() && !(typeof isSetupNeeded === 'function' && isSetupNeeded());
}

function gpEnsureId() {
  if (state.gpId && /^[A-Za-z0-9]{8,32}$/.test(state.gpId)) return state.gpId;
  state.gpId = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + 'xxxxxxxx').replace(/[^a-z0-9]/g, '').slice(0, 16);
  return state.gpId;
}

function gpKey(day, half, mid) {
  return day + '|' + half + '|' + mid;
}

function gpSharable(half, mid) {
  return !!(GP_ID_RE[half] && GP_ID_RE[half].test(String(mid || '')));
}

function gpAnchorOf(half, mid) {
  const a = state.progressAnchors && state.progressAnchors[half] && state.progressAnchors[half][mid];
  if (!a || typeof a !== 'object') return null;
  const at = Number(a.at);
  if (!Number.isFinite(at)) return null;
  const cleared = !!a.cleared || a.number == null || a.number === '';
  const n = cleared ? null : Number(a.number);
  if (!cleared && !Number.isFinite(n)) return null;
  return { number: cleared ? null : Math.round(n), cleared, paused: !!a.paused, ended: !!a.ended, at, seeded: !!a.seeded };
}

function gpSig(a) {
  return a ? JSON.stringify([a.number, a.cleared, a.paused, a.ended, a.at]) : '';
}

function gpEquivalent(a, b) {
  if (!a || !b) return false;
  return a.number === b.number && !!a.cleared === !!b.cleared && !!a.paused === !!b.paused
    && !!a.ended === !!b.ended && Math.abs(Number(a.at) - Number(b.at)) < GP_SAME_AT_MS;
}

function gpEachLocal(fn) {
  for (const half of HALVES) {
    for (const m of (state.machines && state.machines[half]) || []) {
      if (gpSharable(half, m.id)) fn(half, m.id);
    }
  }
}

function gpPendingMap() {
  if (!state.gpPending || typeof state.gpPending !== 'object' || Array.isArray(state.gpPending)) state.gpPending = {};
  return state.gpPending;
}

function gpPersist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function gpSeedKnown() {
  gpKnown = {};
  const day = state.day;
  gpEachLocal((half, mid) => { gpKnown[gpKey(day, half, mid)] = gpSig(gpAnchorOf(half, mid)); });
}

/* Called from saveState(): queue any progress anchor that changed locally. */
function onGlobalProgressSaved() {
  if (gpApplying || !gpBooted || !state) return;
  if (!globalProgressOn()) return;
  const day = state.day;
  const pending = gpPendingMap();
  let added = false;
  gpEachLocal((half, mid) => {
    const key = gpKey(day, half, mid);
    const raw = state.progressAnchors && state.progressAnchors[half] && state.progressAnchors[half][mid];
    /* Local opening-number prefills stay on this phone until someone really sets a number. */
    if (raw && raw.seeded && !raw.cleared) return;
    const a = gpAnchorOf(half, mid);
    if (a && typeof isStaleProgressAt === 'function' && isStaleProgressAt(a.at, day)) return;
    const sig = gpSig(a);
    if (sig === (gpKnown[key] || '')) return;
    gpKnown[key] = sig;
    if (!a) return;
    pending[key] = { day, half, mid, anchor: a, ts: gpNow() };
    added = true;
  });
  // Drop pending items from older days.
  for (const k of Object.keys(pending)) {
    if (!pending[k] || pending[k].day !== day) { delete pending[k]; added = true; }
  }
  if (added) {
    gpPersist();
    clearTimeout(gpFlushTimer);
    gpFlushTimer = setTimeout(gpFlush, 350);
  }
}

function gpSend(msg) {
  if (!gpWs || gpWs.readyState !== 1) return false;
  try { gpWs.send(JSON.stringify(msg)); return true; } catch { return false; }
}

function gpFlush() {
  if (!gpWs || gpWs.readyState !== 1 || gpSubDay !== state.day) {
    gpConnect();
    return;
  }
  const pending = gpPendingMap();
  const keys = Object.keys(pending);
  if (!keys.length) return;
  for (const k of keys) {
    const p = pending[k];
    if (!p || p.day !== state.day) { delete pending[k]; continue; }
    const ok = gpSend({
      type: 'gp-set',
      gpId: gpEnsureId(),
      day: p.day,
      half: p.half,
      mid: p.mid,
      anchor: p.anchor,
      ts: p.ts,
      clientNow: gpNow()
    });
    if (ok) delete pending[k];
  }
  gpPersist();
}

function gpApplyEntry(half, mid, entry, serverNow) {
  if (!entry || !gpSharable(half, mid)) return false;
  const machines = (state.machines && state.machines[half]) || [];
  if (!machines.some((m) => m.id === mid)) return false;
  const day = state.day;
  const key = gpKey(day, half, mid);
  const skew = Number(serverNow) - gpNow();
  const localAt = Number(entry.at) - (Number.isFinite(skew) ? skew : 0);
  const remote = {
    number: entry.cleared ? null : Number(entry.number),
    cleared: !!entry.cleared,
    paused: !!entry.paused,
    ended: !!entry.ended,
    at: Math.round(localAt)
  };
  if (typeof isStaleProgressAt === 'function' && isStaleProgressAt(remote.at, day)) return false;
  if (state.gpIgnoreBefore && Number(remote.at) < Number(state.gpIgnoreBefore)
      && Number(entry.ts || remote.at) < Number(state.gpIgnoreBefore)) {
    return false;
  }
  const rawLocal = state.progressAnchors && state.progressAnchors[half] && state.progressAnchors[half][mid];
  const localSeeded = !!(rawLocal && rawLocal.seeded && !rawLocal.cleared);
  const localUnstarted = localSeeded || !rawLocal || rawLocal.number == null || rawLocal.cleared;
  const pend = gpPendingMap()[key];
  if (pend && !localSeeded) {
    const remoteTs = Number(entry.ts) - (Number.isFinite(skew) ? skew : 0);
    if (Number(pend.ts) > remoteTs) return false; // my unsent edit is newer
    delete gpPendingMap()[key];
  } else if (pend && localSeeded) {
    delete gpPendingMap()[key];
  }
  const local = gpAnchorOf(half, mid);
  if (!localSeeded && gpEquivalent(local, remote)) {
    gpKnown[key] = gpSig(local);
    return false;
  }
  if (!state.progressAnchors) state.progressAnchors = {};
  if (!state.progressAnchors[half]) state.progressAnchors[half] = {};
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  /* A real number from another phone replaces a local opening prefill, but
     does not start auto-advance on this phone until the user sets/starts. */
  const keepPaused = localUnstarted || localSeeded || !!remote.paused;
  state.progressAnchors[half][mid] = {
    number: remote.number,
    at: remote.at,
    paused: keepPaused,
    ended: remote.ended,
    cleared: remote.cleared
  };
  state.currentNumbers[half][mid] = remote.cleared ? null : remote.number;
  gpKnown[key] = gpSig(gpAnchorOf(half, mid));
  return true;
}

function gpAfterRemote(changed) {
  if (!changed) return;
  gpLastRemoteAt = Date.now();
  gpApplying = true;
  try { if (typeof saveState === 'function') saveState(); } finally { gpApplying = false; }
  try { if (typeof checkAlerts === 'function') checkAlerts(); } catch { /* ignore */ }
  try { if (typeof syncProgressTimer === 'function') syncProgressTimer(); } catch { /* ignore */ }
  if (typeof render === 'function') render();
}

function gpSetStatus(s) {
  if (gpStatus === s) return;
  gpStatus = s;
  const el = document.getElementById('gp-status');
  if (el) el.textContent = gpStatusLabel();
}

function gpStatusLabel() {
  if (!globalProgressOn()) return '已關閉，只用自己這支手機的進度';
  if (gpStatus === 'online') return '已連線，大家看到同一個進度';
  if (gpStatus === 'connecting') return '連線中…';
  return '目前離線，先記在這支手機，連上後會補送';
}

function gpConnect() {
  if (!gpReady()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { gpSetStatus('offline'); return; }
  if (gpWs && (gpWs.readyState === 0 || gpWs.readyState === 1)) {
    if (gpWs.readyState === 1 && gpSubDay !== state.day) gpSubscribe();
    return;
  }
  let ws;
  try {
    ws = new WebSocket(syncWsUrl());
  } catch {
    gpSetStatus('offline');
    gpScheduleRetry();
    return;
  }
  gpWs = ws;
  gpSubDay = '';
  gpSetStatus('connecting');
  ws.onopen = () => {
    if (gpWs !== ws) return;
    gpSubscribe();
  };
  ws.onmessage = (ev) => {
    if (gpWs !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !state) return;
    if (msg.type === 'gp-snap') {
      if (msg.day !== state.day) { gpSubscribe(); return; }
      gpSubDay = msg.day;
      gpSetStatus('online');
      let changed = false;
      for (const e of msg.entries || []) {
        if (e && gpApplyEntry(e.half, e.mid, e.entry, msg.serverNow)) changed = true;
      }
      gpAfterRemote(changed);
      gpFlush();
    } else if (msg.type === 'gp') {
      if (msg.day !== state.day) return;
      gpAfterRemote(gpApplyEntry(msg.half, msg.mid, msg.entry, msg.serverNow));
    } else if (msg.type === 'gp-error') {
      if (msg.entry && msg.day === state.day) {
        gpAfterRemote(gpApplyEntry(msg.half, msg.mid, msg.entry, msg.serverNow));
      }
      if (msg.error === 'rate' && typeof toast === 'function') toast('進度更新太頻繁，請稍等一下');
    }
  };
  ws.onclose = () => {
    if (gpWs === ws) gpWs = null;
    gpSubDay = '';
    if (!gpReady()) { gpSetStatus('off'); return; }
    gpSetStatus('offline');
    gpScheduleRetry();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function gpSubscribe() {
  if (!state) return;
  if (gpSubDay && gpSubDay !== state.day) gpSeedKnown();
  gpSend({ type: 'gp-sub', day: state.day, gpId: gpEnsureId() });
}

function gpScheduleRetry(ms) {
  clearTimeout(gpRetry);
  gpRetry = setTimeout(gpConnect, ms || 3000);
}

function gpDisconnect() {
  clearTimeout(gpRetry);
  const ws = gpWs;
  gpWs = null;
  gpSubDay = '';
  if (ws) {
    try { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(); } catch { /* ignore */ }
  }
  gpSetStatus('off');
}

function setGlobalProgressOn(on) {
  state.globalProgress = !!on;
  if (on) {
    gpSeedKnown();
    gpConnect();
  } else {
    gpDisconnect();
  }
}

function onAuctionDayChanged() {
  if (!state) return;
  const pending = gpPendingMap();
  for (const k of Object.keys(pending)) delete pending[k];
  gpSeedKnown();
  gpSubDay = '';
  if (gpReady()) gpSubscribe();
}

function initGlobalProgress() {
  if (!state) return;
  gpEnsureId();
  gpSeedKnown();
  gpBooted = true;
  window.addEventListener('online', () => gpConnect());
  window.addEventListener('offline', () => gpSetStatus('offline'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) gpConnect(); });
  setInterval(() => {
    if (!gpReady()) return;
    if (gpWs && gpWs.readyState === 1) {
      if (gpSubDay !== state.day) gpSubscribe();
      else if (Object.keys(gpPendingMap()).length) gpFlush();
      gpTick = (gpTick + 1) % 8;
      if (!gpTick) gpSend({ type: 'gp-ping' });
      return;
    }
    gpConnect();
  }, 3000);
  gpConnect();
}

if (typeof window !== 'undefined') {
  window.__gp = {
    status: () => gpStatus,
    day: () => gpSubDay,
    pending: () => Object.assign({}, gpPendingMap())
  };
}
