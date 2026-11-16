/* Two-person realtime sync client for 拍賣標貨助手 */
'use strict';

const SYNC_URL = (function () {
  try {
    const host = location.hostname;
    if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:8787';
  } catch { /* ignore */ }
  return 'https://auction-bid-sync.onrender.com';
})();

let syncWs = null;
let syncStatus = 'off'; // off | connecting | online | offline | syncing
let syncTimer = null;
let syncPingTimer = null;
let syncApplying = false;
let syncSentCount = 0;
let syncConnecting = false;
let lastShared = null;
let remoteFlash = {};
let pendingJoinCode = '';
let lastSyncError = '';

function syncBase() {
  return SYNC_URL.replace(/\/$/, '');
}
function syncWsUrl(code, peer) {
  const u = syncBase().replace(/^http/, 'ws');
  return u + '/ws?room=' + encodeURIComponent(code) + '&peer=' + encodeURIComponent(peer);
}

function ensurePeerId() {
  if (!state) return 'x';
  if (state.peerId && String(state.peerId).length >= 6) return state.peerId;
  state.peerId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  return state.peerId;
}

function sharedSlice() {
  return {
    lots: (state.lots || []).map((l) => Object.assign({}, l)),
    planItems: (state.planItems || []).map((p) => Object.assign({}, p)),
    kv: BidSyncCore.kvFromState(state)
  };
}

function currentStatus() {
  if (!state || !state.syncRoom) return 'off';
  if (!navigator.onLine) return 'offline';
  if (syncStatus === 'connecting') return 'connecting';
  if ((state.syncQueue || []).length) return 'syncing';
  return syncStatus;
}

function syncStatusLabel() {
  const s = currentStatus();
  if (s === 'online') return '已同步';
  if (s === 'connecting') return '連線中';
  if (s === 'syncing') return '同步中';
  if (s === 'offline') return '離線';
  if (s === 'off') return '';
  return '離線';
}

function setSyncStatus(s) {
  if (syncStatus === s && document.getElementById('sync-pill')) {
    const el = document.getElementById('sync-pill');
    if (el) {
      el.className = 'sync-pill ' + currentStatus();
      el.textContent = syncStatusLabel();
      el.hidden = !state.syncRoom;
    }
    return;
  }
  syncStatus = s;
  const el = document.getElementById('sync-pill');
  if (el) {
    el.className = 'sync-pill ' + currentStatus();
    el.textContent = syncStatusLabel();
    el.hidden = !state.syncRoom;
  }
}

function writeStampsToState(next) {
  const nextLots = BidSyncCore.lotsToMap(next.lots);
  for (const lot of state.lots || []) {
    const n = nextLots[lot.id];
    if (!n) continue;
    if (n.fieldTs) lot.fieldTs = n.fieldTs;
    if (n.updatedAt) lot.updatedAt = n.updatedAt;
    if (n.updatedBy) lot.updatedBy = n.updatedBy;
  }
  const nextPlans = BidSyncCore.plansToMap(next.planItems);
  for (const p of state.planItems || []) {
    const n = nextPlans[p.id];
    if (!n) continue;
    if (n.fieldTs) p.fieldTs = n.fieldTs;
    if (n.updatedAt) p.updatedAt = n.updatedAt;
    if (n.updatedBy) p.updatedBy = n.updatedBy;
  }
}

function onLocalStateSaved() {
  if (syncApplying || !state || !state.syncRoom) return;
  if (typeof BidSyncCore === 'undefined') return;
  const now = Date.now();
  if (!state.syncKvTs) state.syncKvTs = {};
  const prev = lastShared || { lots: [], planItems: [], kv: {} };
  const next = sharedSlice();
  for (const key of Object.keys(next.kv)) {
    if (JSON.stringify(prev.kv ? prev.kv[key] : undefined) !== JSON.stringify(next.kv[key])) {
      state.syncKvTs[key] = now;
    }
  }
  next.kv = BidSyncCore.kvFromState(state);
  const ops = BidSyncCore.diffState(prev, next, ensurePeerId(), now);
  writeStampsToState(next);
  lastShared = sharedSlice();
  if (!ops.length) return;
  if (!Array.isArray(state.syncQueue)) state.syncQueue = [];
  state.syncQueue.push.apply(state.syncQueue, ops);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  flushSync();
}

function flushSync() {
  if (!state || !state.syncRoom) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (!syncWs || syncWs.readyState !== 1) {
    connectSync();
    return;
  }
  const q = state.syncQueue || [];
  if (!q.length) { setSyncStatus('online'); return; }
  if (syncSentCount) return;
  setSyncStatus('syncing');
  syncSentCount = q.length;
  try {
    syncWs.send(JSON.stringify({ type: 'ops', ops: q.slice() }));
  } catch {
    syncSentCount = 0;
    setSyncStatus('offline');
  }
}

function applySnapshot(snap, flash) {
  if (!snap || typeof BidSyncCore === 'undefined') return;
  syncApplying = true;
  try {
    const slice = BidSyncCore.stateSliceFromSnapshot(snap);
    state.lots = slice.lots;
    state.planItems = slice.planItems;
    if (slice.tombstones) state.syncTombstones = slice.tombstones;
    BidSyncCore.applyKvToState(state, snap.kv || {});
    if (flash && flash.length) {
      const now = Date.now();
      for (const id of flash) remoteFlash[id] = now + 2200;
    }
    lastShared = sharedSlice();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  } finally {
    syncApplying = false;
  }
  if (typeof render === 'function') render();
}

function applyRemoteOps(ops, flashes, from) {
  if (!ops || !ops.length || typeof BidSyncCore === 'undefined') return;
  syncApplying = true;
  try {
    const snap = BidSyncCore.snapshotFromState(state);
    const result = BidSyncCore.applyOps(snap, ops);
    state.lots = BidSyncCore.mapToLots(snap.lots);
    state.planItems = BidSyncCore.mapToPlans(snap.planItems);
    state.syncTombstones = snap.tombstones;
    BidSyncCore.applyKvToState(state, snap.kv);
    const ids = (flashes && flashes.length) ? flashes : result.flashes;
    if (from && from !== ensurePeerId() && ids && ids.length) {
      const now = Date.now();
      for (const id of ids) remoteFlash[id] = now + 2200;
    }
    lastShared = sharedSlice();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  } finally {
    syncApplying = false;
  }
  if (typeof render === 'function') render();
}

async function ensureRoomOnServer() {
  if (!state || !state.syncRoom) return false;
  const code = state.syncRoom;
  try {
    const res = await fetch(syncBase() + '/api/rooms/' + code, { signal: AbortSignal.timeout(15000) });
    if (res.ok) return true;
    if (res.status !== 404) return false;
    const snap = stampedSnapshot();
    const cr = await fetch(syncBase() + '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, snapshot: snap }),
      signal: AbortSignal.timeout(20000)
    });
    return cr.ok;
  } catch {
    return false;
  }
}

function stampedSnapshot() {
  const snap = BidSyncCore.snapshotFromState(state);
  const now = Date.now();
  const peer = ensurePeerId();
  for (const lot of Object.values(snap.lots)) {
    if (!lot.updatedAt) BidSyncCore.stamp(lot, BidSyncCore.LOT_FIELDS, now, peer);
  }
  for (const p of Object.values(snap.planItems)) {
    if (!p.updatedAt) BidSyncCore.stamp(p, BidSyncCore.PLAN_FIELDS, now, peer);
  }
  for (const key of Object.keys(snap.kv)) {
    if (!snap.kv[key].ts) {
      snap.kv[key].ts = now;
      snap.kv[key].peer = peer;
    }
  }
  return snap;
}

function startSyncPing(ws) {
  clearInterval(syncPingTimer);
  syncPingTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
  }, 25000);
}

function connectSync() {
  if (!state || !state.syncRoom) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (syncWs && syncWs.readyState === 1) return;
  if (syncWs && syncWs.readyState === 0) {
    if (!syncWs._openedAt) syncWs._openedAt = Date.now();
    if (Date.now() - syncWs._openedAt < 4000) return;
    try { syncWs.close(); } catch { /* ignore */ }
    syncWs = null;
  }
  if (syncConnecting) return;
  syncConnecting = true;
  setSyncStatus('connecting');
  ensureRoomOnServer().catch(() => false).finally(() => {
    syncConnecting = false;
    if (!state || !state.syncRoom) return;
    if (!navigator.onLine) { setSyncStatus('offline'); return; }
    if (syncWs && syncWs.readyState === 1) return;
    openSyncSocket();
  });
}

function openSyncSocket() {
  let ws;
  try {
    ws = new WebSocket(syncWsUrl(state.syncRoom, ensurePeerId()));
  } catch (err) {
    setSyncStatus('offline');
    scheduleReconnect();
    return;
  }
  syncWs = ws;
  syncSentCount = 0;
  ws.onopen = () => {
    if (syncWs !== ws) return;
    startSyncPing(ws);
    setSyncStatus((state.syncQueue || []).length ? 'syncing' : 'online');
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'hello' && msg.snapshot) {
      syncApplying = true;
      try {
        const incoming = msg.snapshot;
        const localSnap = BidSyncCore.snapshotFromState(state);
        const remoteOps = BidSyncCore.snapshotToOps(incoming);
        const { flashes } = BidSyncCore.applyOps(localSnap, remoteOps);
        if (state.syncQueue && state.syncQueue.length) {
          BidSyncCore.applyOps(localSnap, state.syncQueue);
        }
        state.lots = BidSyncCore.mapToLots(localSnap.lots);
        state.planItems = BidSyncCore.mapToPlans(localSnap.planItems);
        state.syncTombstones = localSnap.tombstones;
        BidSyncCore.applyKvToState(state, localSnap.kv);
        lastShared = sharedSlice();
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
        if (flashes && flashes.length) {
          const now = Date.now();
          for (const id of flashes) remoteFlash[id] = now + 2200;
        }
      } finally {
        syncApplying = false;
      }
      if (typeof render === 'function') render();
      flushSync();
    } else if (msg.type === 'ops') {
      applyRemoteOps(msg.ops, msg.flashes, msg.from);
    } else if (msg.type === 'ack') {
      const sent = syncSentCount || (Array.isArray(state.syncQueue) ? state.syncQueue.length : 0);
      if (Array.isArray(state.syncQueue) && sent) {
        state.syncQueue = state.syncQueue.slice(sent);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
      }
      syncSentCount = 0;
      if ((state.syncQueue || []).length) flushSync();
      else setSyncStatus('online');
    }
  };
  ws.onclose = (ev) => {
    if (syncWs === ws) syncWs = null;
    syncSentCount = 0;
    clearInterval(syncPingTimer);
    if (state && state.syncRoom) {
      setSyncStatus('offline');
      if (ev && ev.code === 4404) {
        ensureRoomOnServer().finally(() => scheduleReconnect());
      } else {
        scheduleReconnect();
      }
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* ignore */ }
  };
}

function closeSyncSocket() {
  clearInterval(syncPingTimer);
  clearTimeout(syncTimer);
  syncSentCount = 0;
  const ws = syncWs;
  syncWs = null;
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; } catch { /* ignore */ }
    try { if (ws.readyState === 0 || ws.readyState === 1) ws.close(); } catch { /* ignore */ }
  }
}

function scheduleReconnect() {
  clearTimeout(syncTimer);
  if (!state || !state.syncRoom) return;
  syncTimer = setTimeout(connectSync, 2000);
}

async function createSyncRoom() {
  lastSyncError = '';
  try {
    const res = await fetch(syncBase() + '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: stampedSnapshot() })
    });
    const data = await res.json();
    if (!res.ok || !data.code) throw new Error(data.error || '建立房間失敗');
    state.syncRoom = data.code;
    state.syncQueue = [];
    lastShared = sharedSlice();
    syncApplying = true;
    try { saveState(); } finally { syncApplying = false; }
    connectSync();
    toast('已建立房間 ' + data.code);
    render();
  } catch (err) {
    lastSyncError = err.message || '建立房間失敗';
    toast(lastSyncError + '。若第一次連線，伺服器可能要醒一下再試。');
    render();
  }
}

async function joinSyncRoom(code) {
  lastSyncError = '';
  code = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code)) {
    toast('請輸入 6 位數房號');
    return;
  }
  try {
    const res = await fetch(syncBase() + '/api/rooms/' + code + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: stampedSnapshot() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加入失敗');
    state.syncRoom = code;
    if (data.snapshot) {
      syncApplying = true;
      try {
        const localSnap = BidSyncCore.snapshotFromState(state);
        BidSyncCore.applyOps(localSnap, BidSyncCore.snapshotToOps(data.snapshot));
        state.lots = BidSyncCore.mapToLots(localSnap.lots);
        state.planItems = BidSyncCore.mapToPlans(localSnap.planItems);
        state.syncTombstones = localSnap.tombstones;
        BidSyncCore.applyKvToState(state, localSnap.kv);
      } finally {
        syncApplying = false;
      }
    }
    lastShared = sharedSlice();
    state.syncQueue = [];
    syncApplying = true;
    try { saveState(); } finally { syncApplying = false; }
    connectSync();
    toast('已加入房間 ' + code);
    render();
  } catch (err) {
    lastSyncError = err.message || '加入失敗';
    toast(lastSyncError + '。若第一次連線，伺服器可能要醒一下再試。');
    render();
  }
}

function leaveSyncRoom() {
  const code = state.syncRoom;
  state.syncRoom = '';
  state.syncQueue = [];
  lastShared = null;
  syncSentCount = 0;
  closeSyncSocket();
  syncStatus = 'off';
  syncApplying = true;
  try { saveState(); } finally { syncApplying = false; }
  toast(code ? ('已離開房間 ' + code + '，這個手機的資料還在') : '已離開');
  render();
}

function roomShareUrl() {
  if (!state || !state.syncRoom) return '';
  const base = (location.origin || 'https://auction-bid-app.onrender.com') + (location.pathname || '/');
  return base.replace(/\/?$/, '/') + '?room=' + state.syncRoom;
}

function copyRoomLink() {
  const url = roomShareUrl();
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('已複製邀請連結')).catch(() => toast(url));
  } else toast(url);
}

function copyRoomCode() {
  if (!state.syncRoom) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(state.syncRoom).then(() => toast('已複製房號 ' + state.syncRoom)).catch(() => toast(state.syncRoom));
  } else toast(state.syncRoom);
}

function renderSyncSettings() {
  const joined = !!(state && state.syncRoom);
  if (!joined) {
    return `<div class="setting-block" id="sync-settings">
      <h2>兩人同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">兩支手機看同一份抄號、標到和備註，不用再口頭對。沒加入房間時，這個手機還是只存在自己這裡、離線也能用。</p>
      <button type="button" class="btn primary" style="width:100%;margin-bottom:8px" data-act="sync-create">建立房間</button>
      <div class="custom-item-row">
        <input id="sync-join-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6 位數房號" value="${escapeHtml(pendingJoinCode)}" data-act="sync-join-input" />
        <button type="button" class="btn" data-act="sync-join">加入</button>
      </div>
      ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    </div>`;
  }
  return `<div class="setting-block" id="sync-settings">
    <h2>兩人同步</h2>
    <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">這個房間兩支手機都可以改抄號、標到、流標、優先、備註和移台。離線先記在手機裡，連上再同步。舉牌用的承銷人代號只存在自己手機。</p>
    <div class="sync-code-box">
      <div class="sync-code-label">房號</div>
      <div class="sync-code">${escapeHtml(state.syncRoom)}</div>
      <div class="sync-pill ${currentStatus()}" style="position:static;margin:8px auto 0">${escapeHtml(syncStatusLabel())}</div>
    </div>
    <div class="row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
      <button type="button" class="btn" data-act="sync-copy-code">複製房號</button>
      <button type="button" class="btn" data-act="sync-copy-link">複製邀請連結</button>
    </div>
    <p class="empty-hint" style="text-align:left;padding:8px 0 0;line-height:1.45;word-break:break-all">${escapeHtml(roomShareUrl())}</p>
    <button type="button" class="btn danger" style="width:100%;margin-top:8px" data-act="sync-leave">離開房間</button>
  </div>`;
}

function renderSyncPill() {
  if (!state || !state.syncRoom) return '';
  return `<button type="button" class="sync-pill ${currentStatus()}" id="sync-pill" data-act="settings">${escapeHtml(syncStatusLabel())}</button>`;
}

function lotHasRemoteFlash(id) {
  return !!(remoteFlash[id] && remoteFlash[id] > Date.now());
}

function initSync() {
  if (!state) return;
  const before = state.peerId;
  ensurePeerId();
  if (!Array.isArray(state.syncQueue)) state.syncQueue = [];
  if (state.peerId !== before) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }
  window.addEventListener('online', () => {
    if (!state.syncRoom) return;
    closeSyncSocket();
    connectSync();
  });
  window.addEventListener('offline', () => {
    if (!state.syncRoom) return;
    setSyncStatus('offline');
    closeSyncSocket();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.syncRoom) connectSync();
  });
  const params = new URLSearchParams(location.search || '');
  const q = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);
  if (/^\d{6}$/.test(q) && state.syncRoom !== q) {
    pendingJoinCode = q;
    if (!state.syncRoom) {
      joinSyncRoom(q);
    }
  } else if (state.syncRoom) {
    connectSync();
  }
  setInterval(() => {
    const now = Date.now();
    let expired = false;
    for (const id of Object.keys(remoteFlash)) {
      if (remoteFlash[id] <= now) { delete remoteFlash[id]; expired = true; }
    }
    if (expired && typeof render === 'function') render();
  }, 800);
}

function handleSyncAction(act, v, ev) {
  if (act === 'sync-create') { createSyncRoom(); return true; }
  if (act === 'sync-join') {
    const input = document.getElementById('sync-join-code');
    joinSyncRoom((input && input.value) || pendingJoinCode);
    return true;
  }
  if (act === 'sync-leave') { leaveSyncRoom(); return true; }
  if (act === 'sync-copy-code') { copyRoomCode(); return true; }
  if (act === 'sync-copy-link') { copyRoomLink(); return true; }
  return false;
}

function handleSyncInput(el, act) {
  if (act === 'sync-join-input' || el.id === 'sync-join-code') {
    pendingJoinCode = String(el.value || '').replace(/\D/g, '').slice(0, 6);
    if (el.value !== pendingJoinCode) el.value = pendingJoinCode;
    return true;
  }
  return false;
}
