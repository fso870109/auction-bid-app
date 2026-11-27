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
let syncNeedJoin = false;
let syncSeq = 0;          // v112: id of the ops batch waiting for its ack
let syncSentSeq = 0;
let syncLastRemoteAt = 0; // last time another phone's change reached this phone
let syncServerVersion = '';
let syncReconciledAt = 0;
let syncApplying = false;
let syncSentCount = 0;
let syncConnecting = false;
let lastShared = null;
let remoteFlash = {};
let pendingJoinCode = '';
let lastSyncError = '';
let shownJoinRequestId = '';
/* v107 liveness: a phone that slept or switched Wi-Fi/4G can keep a socket that
   still says OPEN but never delivers anything. Track the last frame we got and
   probe/replace silent sockets, so the other phone's entries keep arriving. */
let syncLastRxAt = 0;       // last frame from the server on the current socket
let syncLastOkAt = 0;       // last time we were confirmed in sync (hello / ack / ops / pong)
let syncProbeTimer = null;
let syncHiddenAt = 0;
let syncTickTimer = null;
const SYNC_PING_MS = 5000;
const SYNC_SILENT_MS = 20000;
const SYNC_PROBE_MS = 2000;
const SYNC_CHUNK_OPS = 120;
const SYNC_CHUNK_BYTES = 180 * 1024;

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

const SYNC_NAME_MAX = 20;

function normalizeSyncName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
  if ([...s].length > SYNC_NAME_MAX) s = [...s].slice(0, SYNC_NAME_MAX).join('').trim();
  return s;
}

function currentSyncName() {
  return normalizeSyncName(state && state.syncDisplayName);
}

function devicePublicName(d) {
  const n = normalizeSyncName(d && d.name);
  if (n) return d && d.isMe ? n + '（這支手機）' : n;
  return d && d.isMe ? '這支手機' : '另一支手機';
}

function openSyncNamePrompt(opts) {
  opts = opts || {};
  modal = {
    type: 'sync-name',
    reason: opts.reason || 'join',
    pendingCode: opts.code || '',
    value: currentSyncName() || '',
    canSkip: opts.reason === 'existing',
    title: opts.reason === 'create' ? '建立房間前，請先留下你的名稱' : (opts.reason === 'existing' ? '請先設定你的名稱' : '加入前請輸入你的名稱'),
    body: opts.reason === 'existing'
      ? '這樣房間裡的人才能認出是誰。名稱只在同一個房間裡顯示。'
      : '請輸入你自己的名稱，讓對方知道是誰加入。最多 20 個字。'
  };
  if (typeof render === 'function') render();
  requestAnimationFrame(() => {
    const el = document.getElementById('sync-name-input');
    if (el) {
      try { el.focus(); if (el.value) el.select(); } catch { /* ignore */ }
    }
  });
}

function renderSyncNameModal() {
  if (!modal || modal.type !== 'sync-name') return '';
  const skip = modal.canSkip
    ? `<button type="button" class="btn" data-act="sync-name-skip">稍後</button>`
    : `<button type="button" class="btn" data-act="sync-name-cancel">取消</button>`;
  const okLabel = modal.reason === 'create' ? '建立房間' : (modal.reason === 'existing' ? '儲存名稱' : '加入');
  return `<div class="overlay center">
    <div class="sheet sync-name-sheet" data-stop="1">
      <h3>${escapeHtml(modal.title || '請輸入你的名稱')}</h3>
      <p>${escapeHtml(modal.body || '')}</p>
      <label class="sync-name-label" for="sync-name-input">我的名稱</label>
      <input id="sync-name-input" class="sync-name-input" maxlength="20" autocomplete="name" enterkeyhint="done" value="${escapeHtml(modal.value || '')}" data-act="sync-name-input" placeholder="例如：小美" />
      <div class="sheet-actions">
        ${skip}
        <button type="button" class="btn primary" data-act="sync-name-ok">${okLabel}</button>
      </div>
    </div>
  </div>`;
}

function maybePromptMissingName() {
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom) || state.syncPending) return;
  if (currentSyncName()) return;
  if (state.syncNamePrompted) return;
  if (modal) return;
  state.syncNamePrompted = true;
  persistSyncState();
  openSyncNamePrompt({ reason: 'existing' });
}

async function saveSyncDisplayName(raw, opts) {
  opts = opts || {};
  const name = normalizeSyncName(raw);
  if (!name) {
    toast('請先輸入你的名稱');
    return false;
  }
  state.syncDisplayName = name;
  state.syncNamePrompted = true;
  persistSyncState();
  if (state.syncRoom && isSyncSecret(state.syncRoom) && state.syncDeviceToken && !opts.skipServer) {
    try {
      const res = await fetch(syncBase() + '/api/rooms/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: state.syncRoom,
          deviceId: state.syncDeviceId,
          deviceToken: state.syncDeviceToken,
          name
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) applyMembership(data);
    } catch { /* keep local name even if the server is waking */ }
  }
  return true;
}

function submitSyncNamePrompt() {
  if (!modal || modal.type !== 'sync-name') return;
  const el = document.getElementById('sync-name-input');
  const raw = el ? el.value : modal.value;
  const name = normalizeSyncName(raw);
  if (!name) {
    toast('請先輸入你的名稱');
    return;
  }
  const reason = modal.reason;
  const code = modal.pendingCode;
  modal = null;
  saveSyncDisplayName(name, { skipServer: reason === 'join' || reason === 'create' }).then((ok) => {
    if (!ok) return;
    if (reason === 'create') createSyncRoom();
    else if (reason === 'join') joinSyncRoom(code || pendingJoinCode, { hasName: true });
    else {
      toast('已儲存名稱 ' + name);
      if (typeof render === 'function') render();
    }
  });
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

/* v107: what this phone had already shared (or queued) when the App opened.
   Without it the first save after a reload re-sent every row and stamped every
   setting as brand new, which could overwrite the other phone's newer values. */
function captureSyncBaseline() {
  if (!state || !state.syncRoom || typeof BidSyncCore === 'undefined') return;
  try { lastShared = sharedSlice(); } catch { lastShared = null; }
  syncLastOkAt = Number(state.syncLastOkAt) || 0;
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

function syncAgoText() {
  if (!syncLastOkAt) return '';
  const sec = Math.max(0, Math.round((Date.now() - syncLastOkAt) / 1000));
  if (sec < 10) return '剛剛';
  if (sec < 60) return sec + ' 秒前';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分前';
  try {
    const d = new Date(syncLastOkAt);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch { return ''; }
}

/* v114: browser network errors are English ("Failed to fetch", "Load failed").
   Say in plain Chinese what is going on. */
function friendlySyncError(err, fallback) {
  const msg = String((err && err.message) || '');
  const name = String((err && err.name) || '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return '沒有網路，請確認有訊號再試';
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(msg)) {
    return '同步伺服器沒回應（可能在睡覺，約 1 分鐘會醒），請等一下再按一次';
  }
  if (/failed to fetch|load failed|networkerror|network request failed|network error|fetch/i.test(msg)) {
    return '連不上同步伺服器（可能在睡覺，約 1 分鐘會醒），請等一下再按一次';
  }
  if (msg && /[\u4e00-\u9fff]/.test(msg)) return msg;
  return fallback;
}

/* v114: when sync is not working, say why and how many lots wait on this phone. */
let syncBadSince = 0;
let syncBannerShown = '';
let syncBannerTimer = 0;
function syncPendingCount() {
  const q = (state && state.syncQueue) || [];
  const ids = new Set();
  for (const op of q) if (op && op.id) ids.add((op.kind || '') + ':' + op.id);
  return ids.size || q.length;
}
function syncBannerText() {
  if (!state || !state.syncRoom || state.syncPending || isLegacyRoom(state.syncRoom)) return '';
  const s = currentStatus();
  if (s === 'online' || s === 'off' || s === 'pending') { syncBadSince = 0; return ''; }
  if (s === 'syncing' && syncWs && syncWs.readyState === 1) return '';
  if (!syncBadSince) syncBadSince = Date.now();
  const n = syncPendingCount();
  // Short enough for one line on a 320 px phone; the count is what matters.
  if (!navigator.onLine) return n ? `沒有網路，號碼先存手機（待送 ${n} 筆）` : '沒有網路，抄的號會先存在手機';
  if (Date.now() - syncBadSince < 5000) return '';
  return n ? `同步伺服器喚醒中，約 1 分鐘（待送 ${n} 筆）` : '同步伺服器喚醒中，約 1 分鐘，號碼先存手機';
}
function renderSyncBanner() {
  const t = syncBannerText();
  syncBannerShown = t;
  if (!t) return '';
  return `<div class="sync-banner${navigator.onLine ? '' : ' no-net'}" data-act="settings" role="status">${escapeHtml(t)}</div>`;
}
function refreshSyncBanner() {
  const t = syncBannerText();
  if (t !== syncBannerShown && typeof render === 'function') render();
  if (syncBadSince && !syncBannerTimer) {
    syncBannerTimer = setTimeout(() => { syncBannerTimer = 0; refreshSyncBanner(); }, 5200);
  }
}

function syncShortLabel() {
  const s = currentStatus();
  if (s !== 'online' && s !== 'off' && s !== 'pending') {
    const n = syncPendingCount();
    if (n) return '待送' + n;
  }
  if (s === 'online') return '同步';
  if (s === 'connecting' || s === 'syncing') return '連線';
  if (s === 'pending') return '等待';
  if (s === 'off') return '';
  return '離線';
}

function syncDetailLabel() {
  const base = syncStatusLabel();
  const ago = syncAgoText();
  return ago ? base + '・最後同步 ' + ago : base;
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

let syncPillCompact = false;

/* Show the word next to the dot only when the 場次 switch still fits. */
function fitSyncPill(el) {
  if (!el || el.hidden) return;
  const hs = document.querySelector('.header .half-switch');
  if (!hs) return;
  const clips = () => [...hs.querySelectorAll('button')].some((b) => b.scrollWidth > b.clientWidth + 0.5);
  el.classList.remove('compact');
  let compact = clips();
  if (compact) el.classList.add('compact');
  syncPillCompact = compact;
}

function paintSyncDot(el) {
  if (!el) return;
  const label = syncDetailLabel();
  el.className = 'sync-dot ' + currentStatus() + (syncPillCompact ? ' compact' : '');
  el.hidden = !state.syncRoom;
  el.setAttribute('aria-label', label);
  el.title = label;
  let i = el.querySelector('i');
  let b = el.querySelector('b');
  if (!i || !b) { el.innerHTML = '<i></i><b></b>'; b = el.querySelector('b'); }
  const t = syncShortLabel();
  if (b.textContent !== t) b.textContent = t;
  fitSyncPill(el);
  const det = document.getElementById('sync-detail-status');
  if (det) {
    det.className = 'sync-pill ' + currentStatus();
    det.textContent = label;
  }
}

function setSyncStatus(s) {
  if (syncStatus !== s) syncStatus = s;
  paintSyncDot(document.getElementById('sync-pill'));
  try { refreshSyncBanner(); } catch { /* ignore */ }
}

function markSyncOk() {
  syncLastOkAt = Date.now();
  try { state.syncLastOkAt = syncLastOkAt; } catch { /* ignore */ }
}

/* Lamport-style clock: never stamp a local edit older than anything we have
   already seen from the room, so a phone whose clock runs a few minutes slow
   still wins with its newer edit instead of being silently ignored. */
function syncNow() {
  const seen = Number(state && state.syncClockSeen) || 0;
  return Math.max(Date.now(), seen + 1);
}

function noteSeenTs(ts) {
  const n = Number(ts) || 0;
  if (!state || !n || n > Date.now() + 7 * 24 * 3600 * 1000) return;
  if (n > (Number(state.syncClockSeen) || 0)) state.syncClockSeen = n;
}

function noteSeenOps(ops) {
  for (const op of ops || []) {
    if (!op) continue;
    noteSeenTs(op.ts);
    if (op.payload) {
      noteSeenTs(op.payload.updatedAt);
      const ft = op.payload.fieldTs;
      if (ft && typeof ft === 'object') for (const k of Object.keys(ft)) noteSeenTs(ft[k]);
    }
  }
}

function noteSeenSnapshot(snap) {
  if (!snap) return;
  noteSeenTs(snap.rev);
  for (const l of Object.values(snap.lots || {})) noteSeenTs(l && l.updatedAt);
  for (const p of Object.values(snap.planItems || {})) noteSeenTs(p && p.updatedAt);
  for (const e of Object.values(snap.kv || {})) noteSeenTs(e && e.ts);
}

function syncKvTsFromSnap(kv) {
  if (!kv || !state) return;
  if (!state.syncKvTs || typeof state.syncKvTs !== 'object') state.syncKvTs = {};
  for (const key of Object.keys(kv)) {
    const t = Number(kv[key] && kv[key].ts) || 0;
    if (t > (Number(state.syncKvTs[key]) || 0)) state.syncKvTs[key] = t;
  }
}

/* Merge queued ops so a long offline stretch doesn't grow into a message the
   server refuses: keep only the newest upsert per row and newest kv per key. */
function compactSyncQueue(q) {
  if (!Array.isArray(q) || q.length < 2) return q || [];
  const lastIdx = {};
  q.forEach((op, i) => {
    if (!op) return;
    let k = '';
    if (op.kind === 'kv') k = 'kv:' + op.key;
    else if (op.kind === 'lot-upsert' || op.kind === 'lot-delete') k = 'lot:' + (op.id || (op.payload && op.payload.id));
    else if (op.kind === 'plan-upsert' || op.kind === 'plan-delete') k = 'plan:' + (op.id || (op.payload && op.payload.id));
    if (k) lastIdx[k] = i;
  });
  return q.filter((op, i) => {
    if (!op) return false;
    let k = '';
    if (op.kind === 'kv') k = 'kv:' + op.key;
    else if (op.kind === 'lot-upsert' || op.kind === 'lot-delete') k = 'lot:' + (op.id || (op.payload && op.payload.id));
    else if (op.kind === 'plan-upsert' || op.kind === 'plan-delete') k = 'plan:' + (op.id || (op.payload && op.payload.id));
    // A kv blob is a whole value, so the last one is enough. Row upserts carry
    // the full row with per-field stamps, so the last one also covers earlier ones.
    return !k || lastIdx[k] === i;
  });
}

function utf8Len(str) {
  // v112: count real bytes (a Chinese character is 3 bytes on the wire), so a batch
  // never goes over the server's frame limit.
  try { return new Blob([str]).size; } catch { return str.length * 3; }
}

/* v113: which kind of phone this is, shown next to its version in 同步檢查. */
function syncPlatform() {
  try {
    const ua = navigator.userAgent || '';
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    let os = /iPhone|iPod/.test(ua) ? 'iPhone' : (/iPad/.test(ua) || iPadOS) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows|Macintosh|Linux/.test(ua) ? '電腦' : '其他';
    const m = /OS (\d+)[_.](\d+)/.exec(ua);
    if ((os === 'iPhone' || os === 'iPad') && m) os += ' iOS ' + m[1] + '.' + m[2];
    const a = /Android (\d+)/.exec(ua);
    if (os === 'Android' && a) os += ' ' + a[1];
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    return os + (standalone ? ' · 主畫面App' : ' · 瀏覽器');
  } catch { return ''; }
}

function syncAppVersion() {
  return typeof APP_VERSION === 'string' ? APP_VERSION : '';
}

function nextSyncChunk(q) {
  const out = [];
  let bytes = 0;
  for (const op of q) {
    const n = utf8Len(JSON.stringify(op));
    if (out.length && (out.length >= SYNC_CHUNK_OPS || bytes + n > SYNC_CHUNK_BYTES)) break;
    out.push(op);
    bytes += n;
  }
  return out;
}

function syncSocketAlive() {
  return !!(syncWs && syncWs.readyState === 1 && syncWs._authed);
}

function forceReconnect(why) {
  closeSyncSocket();
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom)) return;
  setSyncStatus('connecting');
  connectSync();
}

/* Ask the server for a pong; if nothing comes back quickly the socket is dead. */
function probeSync(timeoutMs) {
  if (syncProbeTimer && syncWs && syncWs._probeWs === syncWs) return; // one probe at a time
  clearTimeout(syncProbeTimer);
  syncProbeTimer = null;
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom) || !state.syncDeviceToken) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (!syncSocketAlive()) { connectSync(); return; }
  const ws = syncWs;
  const sentAt = Date.now();
  try {
    ws.send(JSON.stringify({ type: 'ping', deviceId: state.syncDeviceId, token: state.syncDeviceToken }));
  } catch {
    forceReconnect('send');
    return;
  }
  ws._probeWs = ws;
  syncProbeTimer = setTimeout(() => {
    syncProbeTimer = null;
    ws._probeWs = null;
    if (syncWs !== ws) return;
    if ((ws._lastRx || 0) < sentAt) forceReconnect('probe');
  }, timeoutMs || SYNC_PROBE_MS);
}

/* Coming back from the background / screen-off / network change. */
function onSyncResume() {
  if (!state || !state.syncRoom || isLegacyRoom(state.syncRoom) || !state.syncDeviceToken) return;
  const away = syncHiddenAt ? Date.now() - syncHiddenAt : 0;
  syncHiddenAt = 0;
  if (!syncSocketAlive()) {
    if (syncWs && syncWs.readyState === 1 && Date.now() - (syncWs._openedAt || 0) > 3000) closeSyncSocket();
    connectSync();
    return;
  }
  // Away long enough for the network to have dropped us: start a fresh socket.
  // The hello snapshot brings in everything the other phone entered meanwhile.
  if (away > 15000) { forceReconnect('resume'); return; }
  probeSync(SYNC_PROBE_MS);
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
  if (typeof writeStateSoon === 'function') writeStateSoon();
  else { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }
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

/* v109: diffState compares every field of every lot with JSON.stringify, which on
   a day with thousands of saved lots cost ~25 ms (phone speed) on every tap. Lots
   and plan rows that did not change at all are taken out of both sides first
   (a === b is checked before the old JSON compare), so the result is the same
   op list, found by looking at only the few rows that did change. */
function sameFieldValues(a, b, fields) {
  for (const f of fields) {
    const x = a[f];
    const y = b[f];
    if (x === y) continue;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}
function slimList(prevList, nextList, fields) {
  const byId = new Map();
  for (const it of prevList || []) {
    if (it && it.id) byId.set(it.id, it);
  }
  const same = new Set();
  const nextOut = [];
  for (const it of nextList || []) {
    if (!it || !it.id) { nextOut.push(it); continue; }
    const a = byId.get(it.id);
    if (a && sameFieldValues(a, it, fields)) same.add(it.id);
    else nextOut.push(it);
  }
  const prevOut = (prevList || []).filter((it) => !(it && it.id && same.has(it.id)));
  return { prev: prevOut, next: nextOut };
}
function slimForDiff(prev, next) {
  if (!BidSyncCore.LOT_FIELDS || !BidSyncCore.PLAN_FIELDS) return { prev, next };
  const lots = slimList(prev.lots, next.lots, BidSyncCore.LOT_FIELDS);
  const plans = slimList(prev.planItems, next.planItems, BidSyncCore.PLAN_FIELDS);
  return {
    prev: Object.assign({}, prev, { lots: lots.prev, planItems: plans.prev }),
    next: Object.assign({}, next, { lots: lots.next, planItems: plans.next })
  };
}

function onLocalStateSaved() {
  if (syncApplying || !state || !state.syncRoom || state.syncPending) return;
  if (isLegacyRoom(state.syncRoom)) return;
  if (typeof BidSyncCore === 'undefined') return;
  const now = syncNow();
  if (!state.syncKvTs) state.syncKvTs = {};
  const prev = lastShared || { lots: [], planItems: [], kv: {} };
  const next = sharedSlice();
  for (const key of Object.keys(next.kv)) {
    if (JSON.stringify(prev.kv ? prev.kv[key] : undefined) !== JSON.stringify(next.kv[key])) {
      state.syncKvTs[key] = now;
    }
  }
  next.kv = BidSyncCore.kvFromState(state);
  const slim = slimForDiff(prev, next);
  const ops = BidSyncCore.diffState(slim.prev, slim.next, ensurePeerId(), now);
  writeStampsToState(next);
  if (!state.syncTombstones || typeof state.syncTombstones !== 'object') {
    state.syncTombstones = { lots: {}, plan: {} };
  }
  if (!state.syncTombstones.lots || typeof state.syncTombstones.lots !== 'object') state.syncTombstones.lots = {};
  if (!state.syncTombstones.plan || typeof state.syncTombstones.plan !== 'object') state.syncTombstones.plan = {};
  for (const op of ops) {
    if (op && op.kind === 'lot-delete' && op.id) state.syncTombstones.lots[op.id] = op.ts;
    if (op && op.kind === 'plan-delete' && op.id) state.syncTombstones.plan[op.id] = op.ts;
  }
  lastShared = sharedSlice();
  if (!ops.length) return;
  if (!Array.isArray(state.syncQueue)) state.syncQueue = [];
  state.syncQueue.push.apply(state.syncQueue, ops);
  noteSeenTs(now);
  if (!syncSentCount) state.syncQueue = compactSyncQueue(state.syncQueue);
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
  if (!syncSentCount) state.syncQueue = compactSyncQueue(state.syncQueue || []);
  const q = state.syncQueue || [];
  if (!q.length) { setSyncStatus('online'); return; }
  if (syncSentCount) {
    // An ack that never comes means the socket is dead; don't wait forever.
    if (syncWs._sentAt && Date.now() - syncWs._sentAt > 6000) forceReconnect('ack');
    return;
  }
  setSyncStatus('syncing');
  const chunk = nextSyncChunk(q);
  syncSentCount = chunk.length;
  syncSentSeq = ++syncSeq;
  syncWs._sentAt = Date.now();
  try {
    syncWs.send(JSON.stringify({
      type: 'ops',
      ops: chunk,
      seq: syncSentSeq,
      appVersion: syncAppVersion(),
      deviceId: state.syncDeviceId,
      token: state.syncDeviceToken
    }));
  } catch {
    syncSentCount = 0;
    syncSentSeq = 0;
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
    if (typeof ensureAutoAnchors === "function") ensureAutoAnchors();
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

/* v114: a teammate typing fast sends a batch every ~100 ms. Applying and repainting
   each one kept this phone busy ~74% of the time (taps felt slow during a burst).
   Collect what arrives in 150 ms and apply it in one go, one repaint. */
const REMOTE_BATCH_MS = 150;
let remoteBuf = null;
let remoteBufTimer = 0;
function queueRemoteOps(ops, flashes, from) {
  if (!ops || !ops.length) return;
  if (!remoteBuf) remoteBuf = { ops: [], flashes: [], from: '' };
  for (const op of ops) remoteBuf.ops.push(op);
  const foreign = from && from !== ensureDeviceId() && from !== ensurePeerId();
  if (foreign) {
    remoteBuf.from = from;
    if (Array.isArray(flashes)) for (const id of flashes) remoteBuf.flashes.push(id);
  }
  if (!remoteBufTimer) remoteBufTimer = setTimeout(flushRemoteOps, REMOTE_BATCH_MS);
}
function flushRemoteOps() {
  if (remoteBufTimer) { clearTimeout(remoteBufTimer); remoteBufTimer = 0; }
  const buf = remoteBuf;
  remoteBuf = null;
  if (!buf || !buf.ops.length) return;
  applyRemoteOps(buf.ops, buf.flashes.length ? buf.flashes : null, buf.from);
}

function applyRemoteOps(ops, flashes, from) {
  if (!ops || !ops.length || typeof BidSyncCore === 'undefined') return;
  syncApplying = true;
  let prevIdsForToast = null;
  try {
    noteSeenOps(ops);
    prevIdsForToast = new Set((state.lots || []).map((l) => l && l.id));
    const snap = BidSyncCore.snapshotFromState(state);
    const result = BidSyncCore.applyOps(snap, ops);
    // Nothing in the batch changed our data (an echo or an old op): no need to
    // rebuild the lot list or repaint the screen.
    if (!result.applied) return;
    syncKvTsFromSnap(snap.kv);
    state.lots = BidSyncCore.mapToLots(snap.lots);
    state.planItems = BidSyncCore.mapToPlans(snap.planItems);
    state.syncTombstones = snap.tombstones;
    BidSyncCore.applyKvToState(state, snap.kv);
    if (typeof ensureAutoAnchors === "function") ensureAutoAnchors();
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
  if (from && from !== ensureDeviceId() && from !== ensurePeerId() && prevIdsForToast) noteRemoteElsewhere(prevIdsForToast);
  if (typeof render === 'function') render();
}

/* v112: a teammate's new lot in another 場次 (or another day) is not on this screen;
   say so instead of letting it look like nothing came in. */
let elsewhereToastAt = 0;
function noteRemoteElsewhere(prevIds) {
  if (typeof toast !== 'function' || typeof halfLabel !== 'function') return;
  const fresh = (state.lots || []).filter((l) => l && !prevIds.has(l.id));
  if (!fresh.length) return;
  const otherHalf = {};
  let otherDay = '';
  for (const l of fresh) {
    if (l.day && l.day !== state.day) { otherDay = l.day; continue; }
    if (l.half && l.half !== state.currentHalf) otherHalf[l.half] = (otherHalf[l.half] || 0) + 1;
  }
  const now = Date.now();
  if (now - elsewhereToastAt < 4000) return;
  const halves = Object.keys(otherHalf);
  if (halves.length) {
    elsewhereToastAt = now;
    toast('隊友在' + halves.map((h) => halfLabel(h) + ' 抄了 ' + otherHalf[h] + ' 筆').join('、') + '（切到該場次看）');
  } else if (otherDay) {
    elsewhereToastAt = now;
    toast('隊友抄的是 ' + otherDay + ' 的號，和這支日期不同');
  }
}

function mergeSnapshotOnHello(incoming) {
  if (!incoming || typeof BidSyncCore === 'undefined') return;
  syncApplying = true;
  try {
    noteSeenSnapshot(incoming);
    const localSnap = BidSyncCore.snapshotFromState(state);
    const remoteOps = BidSyncCore.snapshotToOps(incoming);
    const { flashes } = BidSyncCore.applyOps(localSnap, remoteOps);
    if (state.syncQueue && state.syncQueue.length) {
      BidSyncCore.applyOps(localSnap, state.syncQueue);
    }
    syncKvTsFromSnap(localSnap.kv);
    state.lots = BidSyncCore.mapToLots(localSnap.lots);
    state.planItems = BidSyncCore.mapToPlans(localSnap.planItems);
    state.syncTombstones = localSnap.tombstones;
    BidSyncCore.applyKvToState(state, localSnap.kv);
    if (typeof ensureAutoAnchors === "function") ensureAutoAnchors();
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

/* v112: after logging in, send the server everything this phone has that the
   server is missing or has older. Before v110 the big join upload did this on every
   connect; v110 dropped that upload, so a lot that once missed its live send stayed
   on one phone forever (各自抄各自的). Merging is per field by time, so this is safe
   to repeat. */
function syncRecordDiffers(a, b, fields) {
  if (!a || !b) return true;
  for (const f of fields) {
    const x = a[f];
    const y = b[f];
    if (x === y) continue;
    if ((x == null || x === '') && (y == null || y === '')) continue;
    if (JSON.stringify(x) !== JSON.stringify(y)) return true;
    if (JSON.stringify((a.fieldTs || {})[f]) !== JSON.stringify((b.fieldTs || {})[f])) return true;
  }
  return false;
}
function reconcileWithServer(incoming) {
  if (!incoming || typeof BidSyncCore === 'undefined' || !state || !state.syncRoom) return 0;
  const local = stampedSnapshot();
  const peer = ensurePeerId();
  const now = Date.now();
  const ops = [];
  const inLots = incoming.lots || {};
  const inPlans = incoming.planItems || {};
  const inTomb = incoming.tombstones || {};
  const inKv = incoming.kv || {};
  for (const [id, lot] of Object.entries(local.lots || {})) {
    if (!syncRecordDiffers(inLots[id], lot, BidSyncCore.LOT_FIELDS)) continue;
    ops.push({ kind: 'lot-upsert', ts: Number(lot.updatedAt) || now, peer: lot.updatedBy || peer, payload: lot });
  }
  for (const [id, item] of Object.entries(local.planItems || {})) {
    if (!syncRecordDiffers(inPlans[id], item, BidSyncCore.PLAN_FIELDS)) continue;
    ops.push({ kind: 'plan-upsert', ts: Number(item.updatedAt) || now, peer: item.updatedBy || peer, payload: item });
  }
  const lt = local.tombstones || {};
  for (const [id, ts] of Object.entries(lt.lots || {})) {
    if (inLots[id] && !(inTomb.lots || {})[id]) ops.push({ kind: 'lot-delete', ts: Number(ts) || now, peer, id });
  }
  for (const [id, ts] of Object.entries(lt.plan || {})) {
    if (inPlans[id] && !(inTomb.plan || {})[id]) ops.push({ kind: 'plan-delete', ts: Number(ts) || now, peer, id });
  }
  for (const [key, e] of Object.entries(local.kv || {})) {
    const r = inKv[key];
    if (!e) continue;
    if (!r || (Number(e.ts) || 0) > (Number(r.ts) || 0)) {
      ops.push({ kind: 'kv', ts: Number(e.ts) || now, peer: e.peer || peer, key, value: e.v });
    }
  }
  syncReconciledAt = now;
  if (!ops.length) return 0;
  if (!Array.isArray(state.syncQueue)) state.syncQueue = [];
  state.syncQueue.push.apply(state.syncQueue, ops);
  if (!syncSentCount) state.syncQueue = compactSyncQueue(state.syncQueue);
  persistSyncState();
  return ops.length;
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
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      applyMembership(data);
      persistSyncState();
      syncNeedJoin = false;
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
        signal: AbortSignal.timeout(8000)
      });
      const rd = await cr.json().catch(() => ({}));
      if (cr.ok) {
        applyMembership(rd);
        persistSyncState();
        syncNeedJoin = false;
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
    if (syncWs !== ws || !ws._authed) return;
    if (document.hidden) return;
    probeSync(SYNC_PROBE_MS + 1500);
  }, SYNC_PING_MS);
}

function connectSync() {
  if (!state || !state.syncRoom) return;
  if (isLegacyRoom(state.syncRoom)) { setSyncStatus('offline'); return; }
  if (!state.syncDeviceToken) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (syncWs && syncWs.readyState === 1 && !syncWs._authed && Date.now() - (syncWs._openedAt || 0) > 5000) {
    // Opened but the server never answered our login: that socket is dead.
    closeSyncSocket();
  }
  if (syncWs && syncWs.readyState === 1) return;
  if (syncWs && syncWs.readyState === 0) {
    if (!syncWs._openedAt) syncWs._openedAt = Date.now();
    if (Date.now() - syncWs._openedAt < 4000) return;
    try { syncWs.close(); } catch { /* ignore */ }
    syncWs = null;
  }
  if (syncConnecting) return;
  setSyncStatus(state.syncPending ? 'pending' : 'connecting');
  /* v110: a phone that has already been in this room just logs in on the socket.
     The big "join" upload (the whole snapshot) is only needed when the server does
     not know this device (login refused) or the phone never connected; doing it on
     every connect made the dot sit on yellow while a large upload crawled or stalled. */
  if (state.syncLastOkAt && !syncNeedJoin && !state.syncPending) {
    openSyncSocket();
    return;
  }
  syncConnecting = true;
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
  syncSentSeq = 0;
  ws.onopen = () => {
    if (syncWs !== ws) return;
    startSyncPing(ws);
    try {
      ws.send(JSON.stringify({
        type: 'auth',
        code: state.syncRoom,
        deviceId: state.syncDeviceId,
        token: state.syncDeviceToken,
        appVersion: syncAppVersion(),
        platform: syncPlatform(),
        name: currentSyncName()
      }));
    } catch { /* ignore */ }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    ws._lastRx = Date.now();
    if (syncWs === ws) syncLastRxAt = ws._lastRx;
    if (ws._probeWs === ws && syncProbeTimer) {
      // Any frame proves the socket is alive; the probe is answered.
      clearTimeout(syncProbeTimer);
      syncProbeTimer = null;
      ws._probeWs = null;
    }
    if (ws._authed && (msg.type === 'pong' || msg.type === 'ops' || msg.type === 'ack')) {
      markSyncOk();
      if (msg.type === 'pong') paintSyncDot(document.getElementById('sync-pill'));
    }
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
      markSyncOk();
      persistSyncState();
      syncServerVersion = msg.serverVersion || '';
      maybeWarnOldPeer();
      if (msg.snapshot) {
        flushRemoteOps();
        mergeSnapshotOnHello(msg.snapshot);
        reconcileWithServer(msg.snapshot);
      } else if (typeof render === 'function') render();
      if (msg.pending && msg.pending.length && state.syncRole === 'owner') {
        maybePromptJoin(msg.pending[0]);
      }
      setSyncStatus((state.syncQueue || []).length ? 'syncing' : 'online');
      flushSync();
    } else if (msg.type === 'approved') {
      ws._authed = true;
      state.syncPending = false;
      applyMembership({ status: 'approved', role: msg.role || 'member', devices: msg.devices });
      markSyncOk();
      persistSyncState();
      if (msg.snapshot) {
        flushRemoteOps();
        mergeSnapshotOnHello(msg.snapshot);
        reconcileWithServer(msg.snapshot);
      }
      toast('已加入房間' + (state.syncLabel ? ' ' + state.syncLabel : ''));
      setSyncStatus((state.syncQueue || []).length ? 'syncing' : 'online');
      flushSync();
    } else if (msg.type === 'ops') {
      if (msg.from && msg.from !== state.syncDeviceId) syncLastRemoteAt = Date.now();
      queueRemoteOps(msg.ops, msg.flashes, msg.from);
    } else if (msg.type === 'ack') {
      /* v112: only drop the batch this ack is for. The old code dropped the whole
         queue when an extra ack came in (e.g. a batch sent twice on login), so lots
         typed in that moment never reached the other phone. */
      if (msg.seq != null && msg.seq !== syncSentSeq) return;
      if (!syncSentCount) return;
      const sent = syncSentCount;
      if (Array.isArray(state.syncQueue) && sent) {
        state.syncQueue = state.syncQueue.slice(sent);
        persistSyncState();
      }
      syncSentCount = 0;
      syncSentSeq = 0;
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
      if (Array.isArray(msg.devices)) {
        state.syncDevices = msg.devices;
        maybeWarnOldPeer();
      }
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
    if (syncWs !== ws) return; // an old socket closing must not touch the new one
    syncWs = null;
    syncSentCount = 0;
    syncSentSeq = 0;
    clearInterval(syncPingTimer);
    if (ws._gone) return;
    if (state && state.syncRoom && !isLegacyRoom(state.syncRoom)) {
      setSyncStatus(state.syncPending ? 'pending' : 'offline');
      if (ev && ev.code === 4403) syncNeedJoin = true; // server does not know us: join again
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
  clearTimeout(syncProbeTimer);
  syncProbeTimer = null;
  clearTimeout(syncTimer);
  syncSentCount = 0;
  syncSentSeq = 0;
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
    title: request.name ? (normalizeSyncName(request.name) + ' 想加入房間？') : '有人要加入房間？',
    body: (request.name ? (normalizeSyncName(request.name) + ' 想加入你的房間') : '另一支裝置想加入你的房間') + (state.syncLabel ? '（' + state.syncLabel + '）' : '') + '。允許後就可以一起看、一起改抄號和備註。',
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
    lastSyncError = friendlySyncError(err, '處理失敗');
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
    lastSyncError = friendlySyncError(err, '無法移除');
    toast(lastSyncError);
    render();
  }
}

async function createSyncRoom() {
  lastSyncError = '';
  if (!currentSyncName()) {
    openSyncNamePrompt({ reason: 'create' });
    return;
  }
  try {
    const res = await fetch(syncBase() + '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: stampedSnapshot(), deviceId: ensureDeviceId(), name: currentSyncName() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.code) throw new Error(data.error || '建立房間失敗');
    applyMembership(data);
    state.syncQueue = [];
    lastShared = sharedSlice();
    syncApplying = true;
    try { saveState(); } finally { syncApplying = false; }
    connectSync();
    toast('已建立房間' + (data.label ? ' ' + data.label : '') + '，請把邀請給隊友的手機');
    render();
  } catch (err) {
    lastSyncError = friendlySyncError(err, '建立房間失敗');
    toast(lastSyncError + (/伺服器|網路/.test(lastSyncError) ? '' : '。若第一次連線，伺服器可能要醒一下再試。'));
    render();
  }
}

async function joinSyncRoom(code, opts) {
  lastSyncError = '';
  opts = opts || {};
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
  if (!opts.hasName && !currentSyncName()) {
    pendingJoinCode = code;
    openSyncNamePrompt({ reason: 'join', code });
    return;
  }
  try {
    const res = await fetch(syncBase() + '/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId: ensureDeviceId(),
        snapshot: stampedSnapshot(),
        name: currentSyncName()
      }),
      signal: AbortSignal.timeout(8000)
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
    lastSyncError = friendlySyncError(err, '加入失敗');
    toast(lastSyncError + (/無法加入|請稍後|伺服器|網路/.test(lastSyncError) ? '' : '。若第一次連線，伺服器可能要醒一下再試。'));
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
      <h2>團隊同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">團隊的手機看同一份抄號、標到和備註，不用再口頭對。建立房間後，用「複製邀請連結」或畫面中的 QR 碼分享給隊友的手機。加入時要先輸入自己的名稱。沒加入房間時，這個手機還是只存在自己這裡、離線也能用。</p>
      <label class="sync-name-label" for="sync-settings-name">我的名稱</label>
      <input id="sync-settings-name" class="sync-name-input" maxlength="20" autocomplete="name" value="${escapeHtml(currentSyncName())}" data-act="sync-name-input" placeholder="例如：小美" />
      <button type="button" class="btn primary" style="width:100%;margin:10px 0 8px" data-act="sync-create">建立房間</button>
      <textarea id="sync-join-code" class="sync-join-input" rows="2" placeholder="貼上邀請碼或邀請連結" data-act="sync-join-input">${escapeHtml(pendingJoinCode)}</textarea>
      <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="sync-join">加入</button>
      ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    </div>`;
  }
  if (isLegacyRoom(state.syncRoom)) {
    return `<div class="setting-block" id="sync-settings">
      <h2>團隊同步</h2>
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
      <h2>團隊同步</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">已送出加入申請，等待房間建立者在他的手機上允許。</p>
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
    const name = devicePublicName(d);
    const role = d.role === 'owner' ? ' · 建立者' : '';
    const me = d.isMe || d.deviceId === state.syncDeviceId;
    const kick = state.syncRole === 'owner' && !me
      ? `<button type="button" class="btn danger sync-kick-btn" data-act="sync-kick" data-v="${escapeHtml(d.deviceId)}">移除</button>`
      : '';
    const online = me ? syncSocketAlive() : !!d.online;
    const ver = (me ? syncAppVersion() : (d.appVersion || '')) + ((me ? syncPlatform() : (d.platform || '')) ? '・' + (me ? syncPlatform() : d.platform) : '');
    const old = !me && peerVersionTooOld(d);
    const seen = !online && d.lastSeen ? '，最後上線 ' + syncClock(d.lastSeen) : '';
    return `<div class="sync-device${old ? ' old' : ''}"><span class="sync-dev-main"><span><i class="sync-dev-dot ${online ? 'on' : 'off'}"></i>${escapeHtml(name + role + (me && !/這支/.test(name) ? '（這支）' : ''))}</span><small>${escapeHtml((online ? '在線' : '離線') + ' · ' + (ver || '版本不明') + seen)}${old ? '<b>　版本太舊，請更新（看下面步驟）</b>' : ''}</small></span>${kick}</div>`;
  }).join('');
  const pending = (state.syncJoinRequests || []).map((r) =>
    `<div class="sync-pending">
      <span>${escapeHtml(normalizeSyncName(r.name) ? normalizeSyncName(r.name) + ' 想加入' : '有裝置想加入')}</span>
      <button type="button" class="btn primary" data-act="sync-approve" data-v="${escapeHtml(r.requestId)}">允許</button>
      <button type="button" class="btn danger" data-act="sync-reject" data-v="${escapeHtml(r.requestId)}">拒絕</button>
    </div>`
  ).join('');
  return `<div class="setting-block" id="sync-settings">
    <h2>團隊同步</h2>
    <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">房間裡每支手機抄的號、標到和備註，大家都看得到、都能改。離線先記在手機，連上再同步。承銷人代號只留在自己手機；第三支起要先經你允許。</p>
    <label class="sync-name-label" for="sync-settings-name">我的名稱</label>
    <div class="sync-name-row">
      <input id="sync-settings-name" class="sync-name-input" maxlength="20" autocomplete="name" value="${escapeHtml(currentSyncName())}" data-act="sync-name-input" placeholder="例如：小美" />
      <button type="button" class="btn primary sync-name-save" data-act="sync-name-save">儲存</button>
    </div>
    <div class="sync-code-box">
      <div class="sync-code-label">房間</div>
      <div class="sync-code">${escapeHtml(state.syncLabel || '')}</div>
      <div class="sync-qr" id="sync-qr" aria-label="邀請 QR 碼"></div>
      <div class="sync-pill ${currentStatus()}" id="sync-detail-status" style="position:static;margin:8px auto 0">${escapeHtml(syncDetailLabel())}</div>
    </div>
    <p class="empty-hint" style="text-align:left;padding:10px 0 0;line-height:1.45">隊友的手機掃描上面的 QR 碼，或打開邀請連結即可加入。請妥善保管邀請，知道連結的人才能申請加入。</p>
    <div class="row-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
      <button type="button" class="btn primary" data-act="sync-copy-link">複製邀請連結</button>
      <button type="button" class="btn" data-act="sync-copy-code">複製邀請碼</button>
    </div>
    <p class="sync-secret">${escapeHtml(state.syncRoom)}</p>
    <p class="empty-hint" style="text-align:left;padding:4px 0 0;line-height:1.45;word-break:break-all">${escapeHtml(roomShareUrl())}</p>
    <h3 class="sync-sub">已加入的手機</h3>
    <div class="sync-devices">${devices || '<div class="sync-device">這支手機 · 建立者</div>'}</div>
    ${renderSyncDiag()}
    ${pending}
    ${lastSyncError ? `<p class="empty-hint" style="text-align:left;color:#ff8a8a">${escapeHtml(lastSyncError)}</p>` : ''}
    <button type="button" class="btn danger" style="width:100%;margin-top:8px" data-act="sync-leave">離開房間</button>
  </div>`;
}

let oldPeerWarnedAt = 0;
function maybeWarnOldPeer() {
  const old = syncPeersTooOld();
  if (!old.length || Date.now() - oldPeerWarnedAt < 60000) return;
  oldPeerWarnedAt = Date.now();
  if (typeof toast === 'function') toast('對方版本太舊，請他更新（' + old.map(devicePublicName).join('、') + '）：設定 → 檢查更新');
}

function syncClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function versionNum(v) {
  const m = /^v(\d+)/.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
}

// A teammate's phone that is online but runs a version older than v112 (or one that
// does not tell its version at all, i.e. v111 and older).
function peerVersionTooOld(d) {
  if (!d || d.isMe || d.deviceId === state.syncDeviceId || !d.online) return false;
  return versionNum(d.appVersion) < 112;
}

function syncPeersTooOld() {
  return (state && Array.isArray(state.syncDevices) ? state.syncDevices : []).filter(peerVersionTooOld);
}

/* v112: 設定→同步 diagnostic, so it is plain whether both phones really share one room. */
function renderSyncDiag() {
  const room = String(state.syncRoom || '');
  const shortCode = room ? room.slice(0, 4) + '…' + room.slice(-4) : '—';
  const peers = (state.syncDevices || []).filter((d) => !(d.isMe || d.deviceId === state.syncDeviceId));
  const onlinePeers = peers.filter((d) => d.online).length;
  const q = (state.syncQueue || []).length;
  const rows = [
    ['房間', (state.syncLabel || '') + '（' + shortCode + '）'],
    ['連線', syncSocketAlive() ? '已連上' : '未連上'],
    ['隊友在線', peers.length ? onlinePeers + ' / ' + peers.length + ' 支' : '還沒有隊友加入'],
    ['最後收到隊友資料', syncLastRemoteAt ? syncClock(syncLastRemoteAt) : '這次開啟後還沒有'],
    ['最後和伺服器通訊', syncLastRxAt ? syncClock(syncLastRxAt) : '—'],
    ['待送出', q ? q + ' 筆' : '沒有'],
    ['這支版本', syncAppVersion() + (syncServerVersion ? '（伺服器 ' + syncServerVersion + '）' : '')]
  ];
  const steps = `<ol class="sync-steps">
          <li>打開 App 的「設定」（右上齒輪），按最上面的「<b>檢查更新</b>」，等它重開。</li>
          <li>還是舊版：從螢幕底部往上滑，把 App <b>完全滑掉</b>，再點主畫面圖示打開，做兩次。</li>
          <li>iPhone 還是舊版：先看這裡「待送出」是<b>沒有</b>（號碼都送出去了），再長按主畫面圖示刪掉，用 <b>Safari</b> 打開 App 網址，按分享鈕「加入主畫面」，打開後用邀請碼重新加入房間。</li>
        </ol>
        <p class="sync-steps-note">設定最上面的大字是版本號，和這支（${escapeHtml(syncAppVersion())}）一樣就好了。</p>`;
  const old = syncPeersTooOld();
  const warn = old.length
    ? `<div class="sync-warn"><p>${escapeHtml(old.map(devicePublicName).join('、'))} 的版本太舊，請在那支手機照做：</p>${steps}</div>`
    : `<div class="sync-howto"><button type="button" class="btn sync-howto-btn" data-act="sync-howto">${syncHowtoOpen ? '▾' : '▸'} 手機版本太舊、更新不了怎麼辦</button>${syncHowtoOpen ? steps : ''}</div>`;
  return `<h3 class="sync-sub">同步檢查</h3>
    <div class="sync-diag">${rows.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>${warn}`;
}

function renderSyncPill() {
  if (!state || !state.syncRoom) return '';
  const label = syncDetailLabel();
  try { requestAnimationFrame(() => paintSyncDot(document.getElementById('sync-pill'))); } catch { /* ignore */ }
  return `<button type="button" class="sync-dot ${currentStatus()}${syncPillCompact ? ' compact' : ''}" id="sync-pill" data-act="settings" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i></i><b>${escapeHtml(syncShortLabel())}</b></button>`;
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
    if (!state.syncRoom) return;
    if (document.hidden) { if (!syncHiddenAt) syncHiddenAt = Date.now(); return; }
    onSyncResume();
  });
  window.addEventListener('resize', () => paintSyncDot(document.getElementById('sync-pill')));
  window.addEventListener('pageshow', () => { if (state.syncRoom) onSyncResume(); });
  window.addEventListener('focus', () => { if (state.syncRoom && !document.hidden) onSyncResume(); });
  window.addEventListener('pagehide', () => { if (!syncHiddenAt) syncHiddenAt = Date.now(); });
  const params = new URLSearchParams(location.search || '');
  const q = normalizeInvite(params.get('room') || '');
  if (isLegacyRoom(q)) {
    lastSyncError = '舊的 6 位數房號已無法加入，請請對方更新邀請。';
    if (isSyncSecret(state.syncRoom)) connectSync();
  } else if (isSyncSecret(q) && state.syncRoom !== q) {
    pendingJoinCode = q;
    if (!state.syncRoom || isLegacyRoom(state.syncRoom)) {
      openSyncNamePrompt({ reason: 'join', code: q });
    }
  } else if (isSyncSecret(state.syncRoom)) {
    connectSync();
    maybePromptMissingName();
  }
  setInterval(() => {
    if (document.hidden) return; // v114: no repaint work in the background
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
    paintSyncDot(document.getElementById('sync-pill'));
    if (syncWs && syncWs.readyState === 1 && syncWs._authed) {
      // Timers barely run while the screen is off; a long gap means we slept.
      const gap = syncTickTimer ? Date.now() - syncTickTimer : 0;
      syncTickTimer = Date.now();
      if (gap > 15000) { forceReconnect('slept'); return; }
      if (document.hidden) return;
      if (Date.now() - (syncWs._lastRx || syncWs._openedAt || 0) > SYNC_SILENT_MS) { forceReconnect('silent'); return; }
      if ((state.syncQueue || []).length) flushSync();
      return;
    }
    syncTickTimer = Date.now();
    if (syncWs && syncWs.readyState === 1 && !syncWs._authed && syncWs._openedAt && Date.now() - syncWs._openedAt > 8000) {
      closeSyncSocket();
    }
    connectSync();
  }, 3000);
}

let syncHowtoOpen = false;
function handleSyncAction(act, v, ev) {
  if (act === 'sync-howto') { syncHowtoOpen = !syncHowtoOpen; if (typeof render === 'function') render(); return true; }
  if (act === 'sync-create' || act === 'sync-upgrade') { createSyncRoom(); return true; }
  if (act === 'sync-join') {
    const input = document.getElementById('sync-join-code');
    joinSyncRoom((input && input.value) || pendingJoinCode);
    return true;
  }
  if (act === 'sync-name-ok') { submitSyncNamePrompt(); return true; }
  if (act === 'sync-name-cancel') {
    modal = null;
    if (typeof render === 'function') render();
    return true;
  }
  if (act === 'sync-name-skip') {
    if (modal && modal.type === 'sync-name') {
      state.syncNamePrompted = true;
      persistSyncState();
    }
    modal = null;
    if (typeof render === 'function') render();
    return true;
  }
  if (act === 'sync-name-save') {
    const input = document.getElementById('sync-settings-name') || document.getElementById('sync-name-input');
    saveSyncDisplayName(input && input.value).then((ok) => {
      if (ok) {
        toast('已儲存名稱 ' + currentSyncName());
        if (typeof render === 'function') render();
      }
    });
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
  if (act === 'sync-name-input' || el.id === 'sync-name-input' || el.id === 'sync-settings-name') {
    const val = el.value;
    if (modal && modal.type === 'sync-name') modal.value = val;
    state.syncDisplayName = normalizeSyncName(val);
    return true;
  }
  return false;
}
