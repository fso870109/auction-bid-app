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
let syncStatus = 'off'; // off | connecting | online | offline | syncing | pending
let syncTimer = null;
let syncPingTimer = null;
let syncApplying = false;
let syncSentCount = 0;
let syncConnecting = false;
let lastShared = null;
let remoteFlash = {};
let pendingJoinCode = '';
let lastSyncError = '';
let shownJoinRequestId = '';

function syncBase() {
  return SYNC_URL.replace(/\/$/, '');
}
function syncWsUrl() {
  return syncBase().replace(/^http/, 'ws') + '/ws';
}

function isSyncSecret(code) {
  return /^[A-Za-z0-9_-]{22,64}$/.test(String(code || ''));
}
function isLegacyRoom(code) {
  return /^\d{6}$/.test(String(code || ''));
}
function normalizeInvite(raw) {
  let s = String(raw || '').trim();
  try {
    if (/^https?:\/\//i.test(s) || /[?&]room=/.test(s)) {
      const u = new URL(s, location.origin || 'https://auction-bid-app.onrender.com');
      if (u.searchParams.get('room')) s = u.searchParams.get('room');
    }
  } catch { /* ignore */ }
  return s.replace(/\s+/g, '');
}

function ensurePeerId() {
  if (!state) return 'x';
  if (state.peerId && String(state.peerId).length >= 6) return state.peerId;
  state.peerId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return state.peerId;
}

function ensureDeviceId() {
  if (!state) return 'x';
  if (state.syncDeviceId && /^[A-Za-z0-9_-]{8,64}$/.test(state.syncDeviceId)) return state.syncDeviceId;
  const seed = (ensurePeerId() + Math.random().toString(36).slice(2, 10)).replace(/[^A-Za-z0-9_-]/g, '');
  state.syncDeviceId = (seed + 'xxxxxxxx').slice(0, 16);
  return state.syncDeviceId;
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
  if (isLegacyRoom(state.syncRoom)) return 'offline';
  if (state.syncPending) return 'pending';
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
  if (s === 'pending') return '等待核准';
  if (s === 'offline') return '離線';
  if (s === 'off') return '';
  return '離線';
}

function paintSyncDot(el) {
  if (!el) return;
  const label = syncStatusLabel();
  el.className = 'sync-dot ' + currentStatus();
  el.hidden = !state.syncRoom;
  el.setAttribute('aria-label', label);
  el.title = label;
  if (!el.querySelector('i')) el.innerHTML = '<i></i>';
}

function setSyncStatus(s) {
  if (syncStatus !== s) syncStatus = s;
  paintSyncDot(document.getElementById('sync-pill'));
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

function persistSyncState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function applyMembership(data) {
  if (!data) return;
  if (data.code) state.syncRoom = data.code;
  if (data.label) state.syncLabel = data.label;
  if (data.deviceId) state.syncDeviceId = data.deviceId;
  if (data.deviceToken) state.syncDeviceToken = data.deviceToken;
  if (data.restoreToken) state.syncRestoreToken = data.restoreToken;
  if (data.role) state.syncRole = data.role;
  if (data.status === 'pending') state.syncPending = true;
  else if (data.status === 'approved' || data.role) state.syncPending = false;
  if (Array.isArray(data.devices)) state.syncDevices = data.devices;
  if (Array.isArray(data.pending)) state.syncJoinRequests = data.pending;
}

function clearMembership() {
  state.syncRoom = '';
  state.syncLabel = '';
  state.syncDeviceToken = '';
  state.syncRestoreToken = '';
  state.syncRole = '';
  state.syncPending = false;
  state.syncDevices = [];
  state.syncJoinRequests = [];
  state.syncQueue = [];
  lastShared = null;
  syncSentCount = 0;
  shownJoinRequestId = '';
}

function onLocalStateSaved() {
  if (syncApplying || !state || !state.syncRoom || state.syncPending) return;
  if (isLegacyRoom(state.syncRoom)) return;
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
  persistSyncState();
  flushSync();
}

function flushSync() {
  if (!state || !state.syncRoom || state.syncPending) return;
  if (isLegacyRoom(state.syncRoom) || !state.syncDeviceToken) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (!syncWs || syncWs.readyState !== 1 || !syncWs._authed) {
    connectSync();
    return;
  }
  const q = state.syncQueue || [];
  if (!q.length) { setSyncStatus('online'); return; }
  if (syncSentCount) return;
  setSyncStatus('syncing');
  syncSentCount = q.length;
  try {
    syncWs.send(JSON.stringify({
      type: 'ops',
      ops: q.slice(),
      deviceId: state.syncDeviceId,
      token: state.syncDeviceToken
    }));
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
    persistSyncState();
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
    if (from && from !== ensureDeviceId() && from !== ensurePeerId() && ids && ids.length) {
      const now = Date.now();
      for (const id of ids) remoteFlash[id] = now + 2200;
    }
    lastShared = sharedSlice();
    persistSyncState();
  } finally {
    syncApplying = false;
  }
  if (typeof applyPlanProgressFromLots === 'function') {
    const ev = applyPlanProgressFromLots();
    if (ev && ev.length) {
      persistSyncState();
      if (typeof onLocalStateSaved === 'function') onLocalStateSaved();
      const msg = ev.map(formatPlanEvent).filter(Boolean)[0];
      if (msg && typeof toast === 'function') toast(msg);
    }
  }
  if (typeof render === 'function') render();
}

function mergeSnapshotOnHello(incoming) {
  if (!incoming || typeof BidSyncCore === 'undefined') return;
  syncApplying = true;
  try {
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
    persistSyncState();
    if (flashes && flashes.length) {
      const now = Date.now();
      for (const id of flashes) remoteFlash[id] = now + 2200;
    }
  } finally {
    syncApplying = false;
  }
  if (typeof applyPlanProgressFromLots === 'function') {
    const ev = applyPlanProgressFromLots();
    if (ev && ev.length) {
      persistSyncState();
      if (typeof onLocalStateSaved === 'function') onLocalStateSaved();
    }
  }
  if (typeof render === 'function') render();
}

async function ensureRoomOnServer() {
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom)) return false;
  if (!state.syncDeviceId || !state.syncDeviceToken) return false;
  try {
    const res = await fetch(syncBase() + '/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: state.syncRoom,
        deviceId: state.syncDeviceId,
        deviceToken: state.syncDeviceToken,
        snapshot: stampedSnapshot()
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      applyMembership(data);
      persistSyncState();
      return true;
    }
    if (res.status === 429) {
      lastSyncError = data.error || '請稍後再試';
      return false;
    }
    if (state.syncRestoreToken && (state.syncRole === 'owner' || !state.syncRole)) {
      const cr = await fetch(syncBase() + '/api/rooms/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: state.syncRoom,
          deviceId: state.syncDeviceId,
          deviceToken: state.syncDeviceToken,
          restoreToken: state.syncRestoreToken,
          label: state.syncLabel,
          snapshot: stampedSnapshot()
        }),
        signal: AbortSignal.timeout(20000)
      });
      const rd = await cr.json().catch(() => ({}));
      if (cr.ok) {
        applyMembership(rd);
        persistSyncState();
        return true;
      }
    }
    return false;
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
    try {
      ws.send(JSON.stringify({
        type: 'ping',
        deviceId: state && state.syncDeviceId,
        token: state && state.syncDeviceToken
      }));
    } catch { /* ignore */ }
  }, 25000);
}

function connectSync() {
  if (!state || !state.syncRoom) return;
  if (isLegacyRoom(state.syncRoom)) { setSyncStatus('offline'); return; }
  if (!state.syncDeviceToken) return;
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
  setSyncStatus(state.syncPending ? 'pending' : 'connecting');
  ensureRoomOnServer().catch(() => false).finally(() => {
    syncConnecting = false;
    if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom)) return;
    if (!navigator.onLine) { setSyncStatus('offline'); return; }
    if (syncWs && syncWs.readyState === 1) return;
    openSyncSocket();
  });
}

function openSyncSocket() {
  let ws;
  try {
    ws = new WebSocket(syncWsUrl());
  } catch (err) {
    setSyncStatus('offline');
    scheduleReconnect();
    return;
  }
  syncWs = ws;
  ws._openedAt = Date.now();
  ws._authed = false;
  syncSentCount = 0;
  ws.onopen = () => {
    if (syncWs !== ws) return;
    startSyncPing(ws);
    try {
      ws.send(JSON.stringify({
        type: 'auth',
        code: state.syncRoom,
        deviceId: state.syncDeviceId,
        token: state.syncDeviceToken
      }));
    } catch { /* ignore */ }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'hello') {
      if (msg.status === 'pending') {
        state.syncPending = true;
        if (msg.label) state.syncLabel = msg.label;
        persistSyncState();
        setSyncStatus('pending');
        if (typeof render === 'function') render();
        return;
      }
      ws._authed = true;
      state.syncPending = false;
      applyMembership({
        label: msg.label,
        role: msg.role,
        status: 'approved',
        devices: msg.devices,
        pending: msg.pending
      });
      persistSyncState();
      if (msg.snapshot) mergeSnapshotOnHello(msg.snapshot);
      else if (typeof render === 'function') render();
      if (msg.pending && msg.pending.length && state.syncRole === 'owner') {
        maybePromptJoin(msg.pending[0]);
      }
      setSyncStatus((state.syncQueue || []).length ? 'syncing' : 'online');
      syncSentCount = 0;
      flushSync();
    } else if (msg.type === 'approved') {
      ws._authed = true;
      state.syncPending = false;
      applyMembership({ status: 'approved', role: msg.role || 'member', devices: msg.devices });
      persistSyncState();
      if (msg.snapshot) mergeSnapshotOnHello(msg.snapshot);
      toast('已加入房間' + (state.syncLabel ? ' ' + state.syncLabel : ''));
      setSyncStatus((state.syncQueue || []).length ? 'syncing' : 'online');
      syncSentCount = 0;
      flushSync();
    } else if (msg.type === 'ops') {
      applyRemoteOps(msg.ops, msg.flashes, msg.from);
    } else if (msg.type === 'ack') {
      const sent = syncSentCount || (Array.isArray(state.syncQueue) ? state.syncQueue.length : 0);
      if (Array.isArray(state.syncQueue) && sent) {
        state.syncQueue = state.syncQueue.slice(sent);
        persistSyncState();
      }
      syncSentCount = 0;
      if ((state.syncQueue || []).length) flushSync();
      else setSyncStatus('online');
    } else if (msg.type === 'join-request') {
      if (!Array.isArray(state.syncJoinRequests)) state.syncJoinRequests = [];
      if (msg.request && !state.syncJoinRequests.some((r) => r.requestId === msg.request.requestId)) {
        state.syncJoinRequests.push(msg.request);
        persistSyncState();
      }
      maybePromptJoin(msg.request);
      if (typeof render === 'function') render();
    } else if (msg.type === 'devices') {
      if (Array.isArray(msg.devices)) state.syncDevices = msg.devices;
      if (Array.isArray(msg.pending)) state.syncJoinRequests = msg.pending;
      persistSyncState();
      if (typeof render === 'function') render();
    } else if (msg.type === 'rejected' || msg.type === 'kicked' || msg.type === 'left') {
      ws._gone = true;
      const reason = msg.type === 'rejected' ? '加入申請未通過' : (msg.type === 'kicked' ? '已從房間移除' : '已離開房間');
      closeSyncSocket();
      clearMembership();
      syncStatus = 'off';
      syncApplying = true;
      try { saveState(); } finally { syncApplying = false; }
      toast(reason + '。這個手機的資料還在。');
      if (typeof render === 'function') render();
    } else if (msg.type === 'error') {
      lastSyncError = msg.error || '同步失敗';
    }
  };
  ws.onclose = (ev) => {
    if (syncWs === ws) syncWs = null;
    syncSentCount = 0;
    clearInterval(syncPingTimer);
    if (ws._gone) return;
    if (state && state.syncRoom && !isLegacyRoom(state.syncRoom)) {
      setSyncStatus(state.syncPending ? 'pending' : 'offline');
      if (ev && ev.code === 4408) {
        lastSyncError = '請稍後再試';
        scheduleReconnect(8000);
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

function scheduleReconnect(ms) {
  clearTimeout(syncTimer);
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom)) return;
  syncTimer = setTimeout(connectSync, ms || 2000);
}

function maybePromptJoin(request) {
  if (!request || !request.requestId) return;
  if (state.syncRole !== 'owner') return;
  if (shownJoinRequestId === request.requestId) return;
  if (modal && modal.type && modal.type !== 'confirm') {
    toast('有人要加入房間，請到設定處理');
    return;
  }
  if (modal && modal.type === 'confirm' && modal._syncRequestId) return;
  shownJoinRequestId = request.requestId;
  modal = {
    type: 'confirm',
    title: '有人要加入房間？',
    body: '另一支裝置想加入你的房間' + (state.syncLabel ? '（' + state.syncLabel + '）' : '') + '。一個房間最多兩支手機。允許後就可以一起看、一起改抄號和備註。',
    ok: '允許加入',
    cancel: '拒絕',
    _syncRequestId: request.requestId,
    onOk: () => {
      modal = null;
      approveJoin(request.requestId, true);
    },
    onCancel: () => {
      modal = null;
      approveJoin(request.requestId, false);
    }
  };
  if (typeof render === 'function') render();
}

async function approveJoin(requestId, accept) {
  lastSyncError = '';
  try {
    const res = await fetch(syncBase() + '/api/rooms/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: state.syncRoom,
        deviceId: state.syncDeviceId,
        deviceToken: state.syncDeviceToken,
        requestId,
        accept: !!accept
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '處理失敗');
    applyMembership(data);
    persistSyncState();
    toast(accept ? '已允許加入' : '已拒絕加入');
    render();
  } catch (err) {
    lastSyncError = err.message || '處理失敗';
    toast(lastSyncError);
    render();
  }
}

async function kickDevice(targetDeviceId) {
  lastSyncError = '';
  try {
    const res = await fetch(syncBase() + '/api/rooms/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: state.syncRoom,
        deviceId: state.syncDeviceId,
        deviceToken: state.syncDeviceToken,
        targetDeviceId
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '無法移除');
    applyMembership(data);
    persistSyncState();
    toast('已移除那支手機');
    render();
  } catch (err) {
    lastSyncError = err.message || '無法移除';
    toast(lastSyncError);
    render();
  }
}

async function createSyncRoom() {
  lastSyncError = '';
  try {
    const res = await fetch(syncBase() + '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: stampedSnapshot(), deviceId: ensureDeviceId() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.code) throw new Error(data.error || '建立房間失敗');
    applyMembership(data);
    state.syncQueue = [];
    lastShared = sharedSlice();
    syncApplying = true;
    try { saveState(); } finally { syncApplying = false; }
    connectSync();
    toast('已建立房間' + (data.label ? ' ' + data.label : '') + '，請把邀請給另一支手機');
    render();
  } catch (err) {
    lastSyncError = err.message || '建立房間失敗';
    toast(lastSyncError + '。若第一次連線，伺服器可能要醒一下再試。');
    render();
  }
}

async function joinSyncRoom(code) {
  lastSyncError = '';
  code = normalizeInvite(code);
  if (isLegacyRoom(code)) {
    lastSyncError = '舊的 6 位數房號已無法加入，請請對方更新邀請。';
    toast(lastSyncError);
    render();
    return;
  }
  if (!isSyncSecret(code)) {
    toast('請貼上完整邀請碼或邀請連結');
    return;
  }
  try {
    const res = await fetch(syncBase() + '/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId: ensureDeviceId(),
        snapshot: stampedSnapshot()
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error(data.error || '請稍後再試');
    if (!res.ok) throw new Error(data.error || '無法加入這個房間');
    applyMembership(data);
    if (data.status === 'pending') {
      lastShared = sharedSlice();
      syncApplying = true;
      try { saveState(); } finally { syncApplying = false; }
      connectSync();
      toast('已送出加入申請，等待對方核准');
      render();
      return;
    }
    if (data.snapshot) mergeSnapshotOnHello(data.snapshot);
    lastShared = sharedSlice();
    state.syncQueue = [];
    syncApplying = true;
    try { saveState(); } finally { syncApplying = false; }
    connectSync();
    toast('已加入房間' + (data.label ? ' ' + data.label : ''));
    render();
  } catch (err) {
    lastSyncError = err.message || '加入失敗';
    toast(lastSyncError + (/無法加入|請稍後/.test(lastSyncError) ? '' : '。若第一次連線，伺服器可能要醒一下再試。'));
    render();
  }
}

function leaveSyncRoom() {
  const code = state.syncRoom;
  const label = state.syncLabel;
  const payload = {
    code,
    deviceId: state.syncDeviceId,
    deviceToken: state.syncDeviceToken
  };
  closeSyncSocket();
  if (isSyncSecret(code) && payload.deviceToken) {
    fetch(syncBase() + '/api/rooms/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }
  clearMembership();
  syncStatus = 'off';
  syncApplying = true;
  try { saveState(); } finally { syncApplying = false; }
  toast(code ? ('已離開房間' + (label ? ' ' + label : '') + '，這個手機的資料還在') : '已離開');
  render();
}

function roomShareUrl() {
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom)) return '';
  const base = (location.origin || 'https://auction-bid-app.onrender.com') + (location.pathname || '/');
  return base.replace(/\/?$/, '/') + '?room=' + encodeURIComponent(state.syncRoom);
}

function copyRoomLink() {
  const url = roomShareUrl();
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('已複製邀請連結')).catch(() => toast(url));
  } else toast(url);
}

function copyRoomCode() {
  if (!state.syncRoom || isLegacyRoom(state.syncRoom)) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(state.syncRoom).then(() => toast('已複製邀請碼')).catch(() => toast(state.syncRoom));
  } else toast(state.syncRoom);
}

function paintSyncQr() {
  const el = document.getElementById('sync-qr');
  if (!el) return;
  const url = roomShareUrl();
  if (!url || typeof qrcode !== 'function') {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createSvgTag(5, 2);
    el.hidden = false;
    const svg = el.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', '196');
      svg.setAttribute('height', '196');
    }
  } catch {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function renderSyncSettings() {
  const joined = !!(state && state.syncRoom);
  if (!joined) {
    return `<div class="setting-block" id="sync-settings">
      <h2>兩人同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">兩支手機看同一份抄號、標到和備註，不用再口頭對。建立房間後，用「複製邀請連結」或畫面中的 QR 碼分享給另一支手機。加入時請貼上完整邀請碼或連結。沒加入房間時，這個手機還是只存在自己這裡、離線也能用。</p>
      <button type="button" class="btn primary" style="width:100%;margin-bottom:8px" data-act="sync-create">建立房間</button>
      <textarea id="sync-join-code" class="sync-join-input" rows="2" placeholder="貼上邀請碼或邀請連結" data-act="sync-join-input">${escapeHtml(pendingJoinCode)}</textarea>
      <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="sync-join">加入</button>
      ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    </div>`;
  }
  if (isLegacyRoom(state.syncRoom)) {
    return `<div class="setting-block" id="sync-settings">
      <h2>兩人同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45;color:#f0c35a">舊的 6 位數房號已無法讓新手機加入。請由其中一支手機點「更新邀請」，再把新的連結或 QR 碼傳給另一支手機。</p>
      <div class="sync-code-box">
        <div class="sync-code-label">舊房號</div>
        <div class="sync-code">${escapeHtml(state.syncRoom)}</div>
      </div>
      <button type="button" class="btn primary" style="width:100%;margin-top:10px" data-act="sync-upgrade">更新邀請</button>
      <button type="button" class="btn danger" style="width:100%;margin-top:8px" data-act="sync-leave">離開舊房間</button>
      ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    </div>`;
  }
  if (state.syncPending) {
    return `<div class="setting-block" id="sync-settings">
      <h2>兩人同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">已送出加入申請，等待房間建立者在他的手機上允許。最多兩支手機同時使用。</p>
      <div class="sync-code-box">
        <div class="sync-code-label">房間</div>
        <div class="sync-code">${escapeHtml(state.syncLabel || '……')}</div>
        <div class="sync-pill pending" style="position:static;margin:8px auto 0">${escapeHtml(syncStatusLabel())}</div>
      </div>
      <button type="button" class="btn danger" style="width:100%;margin-top:8px" data-act="sync-leave">取消申請</button>
      ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    </div>`;
  }
  const devices = (state.syncDevices || []).map((d) => {
    const name = d.isMe ? '這支手機' : '另一支手機';
    const role = d.role === 'owner' ? ' · 建立者' : '';
    const kick = state.syncRole === 'owner' && !d.isMe
      ? `<button type="button" class="btn danger sync-kick-btn" data-act="sync-kick" data-v="${escapeHtml(d.deviceId)}">移除</button>`
      : '';
    return `<div class="sync-device">${escapeHtml(name + role)}${kick}</div>`;
  }).join('');
  const pending = (state.syncJoinRequests || []).map((r) =>
    `<div class="sync-pending">
      <span>有裝置想加入</span>
      <button type="button" class="btn primary" data-act="sync-approve" data-v="${escapeHtml(r.requestId)}">允許</button>
      <button type="button" class="btn danger" data-act="sync-reject" data-v="${escapeHtml(r.requestId)}">拒絕</button>
    </div>`
  ).join('');
  return `<div class="setting-block" id="sync-settings">
    <h2>兩人同步</h2>
    <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">兩支手機都可以改抄號、標到和備註。離線先記在手機，連上再同步。承銷人代號只留在自己手機；第三支要先經你允許。</p>
    <div class="sync-code-box">
      <div class="sync-code-label">房間</div>
      <div class="sync-code">${escapeHtml(state.syncLabel || '')}</div>
      <div class="sync-qr" id="sync-qr" aria-label="邀請 QR 碼"></div>
      <div class="sync-pill ${currentStatus()}" style="position:static;margin:8px auto 0">${escapeHtml(syncStatusLabel())}</div>
    </div>
    <p class="empty-hint" style="text-align:left;padding:10px 0 0;line-height:1.45">另一支手機掃描上面的 QR 碼，或打開邀請連結即可加入。請妥善保管邀請，知道連結的人才能申請加入。</p>
    <div class="row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
      <button type="button" class="btn primary" data-act="sync-copy-link">複製邀請連結</button>
      <button type="button" class="btn" data-act="sync-copy-code">複製邀請碼</button>
    </div>
    <p class="sync-secret">${escapeHtml(state.syncRoom)}</p>
    <p class="empty-hint" style="text-align:left;padding:4px 0 0;line-height:1.45;word-break:break-all">${escapeHtml(roomShareUrl())}</p>
    <h3 class="sync-sub">已加入的手機</h3>
    <div class="sync-devices">${devices || '<div class="sync-device">這支手機 · 建立者</div>'}</div>
    ${pending}
    ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    <button type="button" class="btn danger" style="width:100%;margin-top:8px" data-act="sync-leave">離開房間</button>
  </div>`;
}

function renderSyncPill() {
  if (!state || !state.syncRoom) return '';
  const label = syncStatusLabel();
  return `<button type="button" class="sync-dot ${currentStatus()}" id="sync-pill" data-act="settings" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i></i></button>`;
}

function lotHasRemoteFlash(id) {
  return !!(remoteFlash[id] && remoteFlash[id] > Date.now());
}

function initSync() {
  if (!state) return;
  const before = state.peerId + '|' + (state.syncDeviceId || '');
  ensurePeerId();
  ensureDeviceId();
  if (!Array.isArray(state.syncQueue)) state.syncQueue = [];
  if (!Array.isArray(state.syncDevices)) state.syncDevices = [];
  if (!Array.isArray(state.syncJoinRequests)) state.syncJoinRequests = [];
  if (state.peerId + '|' + state.syncDeviceId !== before) persistSyncState();
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
  const q = normalizeInvite(params.get('room') || '');
  if (isLegacyRoom(q)) {
    lastSyncError = '舊的 6 位數房號已無法加入，請請對方更新邀請。';
    if (isSyncSecret(state.syncRoom)) connectSync();
  } else if (isSyncSecret(q) && state.syncRoom !== q) {
    pendingJoinCode = q;
    if (!state.syncRoom || isLegacyRoom(state.syncRoom)) {
      joinSyncRoom(q);
    }
  } else if (isSyncSecret(state.syncRoom)) {
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
  setInterval(() => {
    if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom) || !state.syncDeviceToken) return;
    if (!navigator.onLine) return;
    if (syncWs && syncWs.readyState === 0) return;
    if (syncWs && syncWs.readyState === 1 && syncWs._authed) {
      if ((state.syncQueue || []).length && !syncSentCount) flushSync();
      return;
    }
    if (syncWs && syncWs.readyState === 1 && !syncWs._authed && syncWs._openedAt && Date.now() - syncWs._openedAt > 8000) {
      closeSyncSocket();
    }
    connectSync();
  }, 3000);
}

function handleSyncAction(act, v, ev) {
  if (act === 'sync-create' || act === 'sync-upgrade') { createSyncRoom(); return true; }
  if (act === 'sync-join') {
    const input = document.getElementById('sync-join-code');
    joinSyncRoom((input && input.value) || pendingJoinCode);
    return true;
  }
  if (act === 'sync-leave') { leaveSyncRoom(); return true; }
  if (act === 'sync-copy-code') { copyRoomCode(); return true; }
  if (act === 'sync-copy-link') { copyRoomLink(); return true; }
  if (act === 'sync-approve') { approveJoin(v, true); return true; }
  if (act === 'sync-reject') { approveJoin(v, false); return true; }
  if (act === 'sync-kick') { kickDevice(v); return true; }
  return false;
}

function handleSyncInput(el, act) {
  if (act === 'sync-join-input' || el.id === 'sync-join-code') {
    pendingJoinCode = String(el.value || '').trim();
    return true;
  }
  return false;
}
