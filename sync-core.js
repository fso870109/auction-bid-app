/* Shared merge helpers for 拍賣標貨助手 two-person sync. Browser + Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BidSyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOT_FIELDS = ['number', 'day', 'half', 'machineId', 'item', 'size', 'note', 'status', 'priority', 'secondMarket', 'createdAt', 'qty', 'subCode'];
  const PLAN_FIELDS = ['text', 'forDay', 'done', 'doneOn', 'createdOn', 'qty', 'doneBy', 'lockCount'];

  function emptySnapshot() {
    return {
      lots: {},
      planItems: {},
      tombstones: { lots: {}, plan: {} },
      kv: {},
      rev: 0
    };
  }

  function tsOf(obj, field) {
    if (!obj) return 0;
    if (obj.fieldTs && Object.prototype.hasOwnProperty.call(obj.fieldTs, field) && obj.fieldTs[field] != null) {
      return Number(obj.fieldTs[field]) || 0;
    }
    // Only use the record clock for legacy rows that have no per-field stamps.
    if (obj.fieldTs && Object.keys(obj.fieldTs).length) return 0;
    return Number(obj.updatedAt) || 0;
  }

  function mergeRecord(local, remote, fields) {
    if (!remote) return local || null;
    if (!local) return clone(remote);
    const out = clone(local);
    if (!out.fieldTs) out.fieldTs = {};
    const rTs = remote.fieldTs || {};
    for (const f of fields) {
      const lt = tsOf(local, f);
      const rt = tsOf(remote, f);
      if (rt > lt) {
        out[f] = remote[f];
        out.fieldTs[f] = rt;
      }
    }
    const lu = Number(local.updatedAt) || 0;
    const ru = Number(remote.updatedAt) || 0;
    if (ru > lu) {
      out.updatedAt = remote.updatedAt;
      if (remote.updatedBy) out.updatedBy = remote.updatedBy;
    }
    return out;
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function fieldsChanged(a, b, fields) {
    if (!a && !b) return false;
    if (!a || !b) return true;
    for (const f of fields) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) return true;
    }
    return false;
  }

  function anchorAt(a) {
    if (!a || typeof a !== 'object') return -1;
    const n = Number(a.at);
    return Number.isFinite(n) ? n : -1;
  }

  function pickNewerAnchor(local, remote) {
    const a = local && typeof local === 'object' ? local : null;
    const b = remote && typeof remote === 'object' ? remote : null;
    if (!a) return b;
    if (!b) return a;
    // A stale auto 到尾 freeze must not snap back a later manual ＋ past the cap.
    const aN = a.number == null || a.number === '' ? null : Number(a.number);
    const bN = b.number == null || b.number === '' ? null : Number(b.number);
    if (a.ended && !b.ended && bN != null && aN != null && bN > aN) return b;
    if (b.ended && !a.ended && aN != null && bN != null && aN > bN) return a;
    const atA = anchorAt(a);
    const atB = anchorAt(b);
    if (atB > atA) return b;
    if (atA > atB) return a;
    if ((bN || 0) !== (aN || 0)) return (bN || 0) > (aN || 0) ? b : a;
    return a;
  }

  function mergeProgressAnchors(local, remote) {
    if (!remote || typeof remote !== 'object') return local && typeof local === 'object' ? local : remote;
    if (!local || typeof local !== 'object') return remote;
    const out = {};
    const halves = new Set([].concat(Object.keys(local), Object.keys(remote)));
    halves.forEach(function (h) {
      out[h] = {};
      const l = local[h] && typeof local[h] === 'object' ? local[h] : {};
      const r = remote[h] && typeof remote[h] === 'object' ? remote[h] : {};
      const ids = new Set([].concat(Object.keys(l), Object.keys(r)));
      ids.forEach(function (id) {
        out[h][id] = pickNewerAnchor(l[id], r[id]);
      });
    });
    return out;
  }

  function mergeByMachineTs(local, remote) {
    if (!remote || typeof remote !== 'object') return local && typeof local === 'object' ? clone(local) : remote;
    if (!local || typeof local !== 'object') return clone(remote);
    const out = {};
    const halves = new Set([].concat(Object.keys(local), Object.keys(remote)));
    halves.forEach(function (h) {
      out[h] = {};
      const l = local[h] && typeof local[h] === 'object' ? local[h] : {};
      const r = remote[h] && typeof remote[h] === 'object' ? remote[h] : {};
      const ids = new Set([].concat(Object.keys(l), Object.keys(r)));
      ids.forEach(function (id) {
        const a = l[id];
        const b = r[id];
        if (a == null && b == null) {
          out[h][id] = null;
          return;
        }
        if (a == null) { out[h][id] = (b && typeof b === 'object') ? clone(b) : b; return; }
        if (b == null) { out[h][id] = (a && typeof a === 'object') ? clone(a) : a; return; }
        const atA = (typeof a === 'object' && a) ? (Number(a.ts) || 0) : 0;
        const atB = (typeof b === 'object' && b) ? (Number(b.ts) || 0) : 0;
        out[h][id] = atB > atA
          ? ((typeof b === 'object') ? clone(b) : b)
          : ((typeof a === 'object') ? clone(a) : a);
      });
    });
    return out;
  }

  const MACHINE_TS_KEYS = { seriesPath: 1, seriesPlans: 1, machineMerges: 1 };

  function mergeCurrentNumbers(local, remote, anchors) {
    const out = {};
    const halves = new Set();
    if (local && typeof local === 'object') Object.keys(local).forEach(function (h) { halves.add(h); });
    if (remote && typeof remote === 'object') Object.keys(remote).forEach(function (h) { halves.add(h); });
    if (anchors && typeof anchors === 'object') Object.keys(anchors).forEach(function (h) { halves.add(h); });
    halves.forEach(function (h) {
      out[h] = Object.assign({}, (local && local[h]) || {}, (remote && remote[h]) || {});
      const anch = anchors && anchors[h];
      if (anch && typeof anch === 'object') {
        Object.keys(anch).forEach(function (id) {
          const a = anch[id];
          if (!a || typeof a !== 'object') return;
          if (a.cleared || a.number == null || a.number === '') out[h][id] = null;
          else if (Number.isFinite(Number(a.number))) out[h][id] = Number(a.number);
        });
      }
    });
    return out;
  }

  function applyOp(snap, op) {
    if (!op || !op.kind) return { applied: false, flash: null };
    const ts = Number(op.ts) || 0;
    snap.rev = Math.max(Number(snap.rev) || 0, ts);
    if (op.kind === 'lot-upsert') {
      const lot = op.payload;
      if (!lot || !lot.id) return { applied: false, flash: null };
      const tomb = Number(snap.tombstones.lots[lot.id]) || 0;
      if (tomb && tomb >= ts && tomb >= (Number(lot.updatedAt) || 0)) return { applied: false, flash: null };
      const prev = snap.lots[lot.id];
      const merged = mergeRecord(prev, lot, LOT_FIELDS);
      const changed = fieldsChanged(prev, merged, LOT_FIELDS);
      snap.lots[lot.id] = merged;
      if (tomb && Math.max(ts, Number(merged.updatedAt) || 0) > tomb) delete snap.tombstones.lots[lot.id];
      return { applied: changed, flash: changed && op.peer ? lot.id : null };
    }
    if (op.kind === 'lot-delete') {
      const id = op.id || (op.payload && op.payload.id);
      if (!id) return { applied: false, flash: null };
      const prev = snap.lots[id];
      const prevTs = prev ? (Number(prev.updatedAt) || 0) : 0;
      const tomb = Number(snap.tombstones.lots[id]) || 0;
      if (ts >= prevTs && ts >= tomb) {
        delete snap.lots[id];
        snap.tombstones.lots[id] = ts;
        return { applied: true, flash: op.peer ? id : null };
      }
      return { applied: false, flash: null };
    }
    if (op.kind === 'plan-upsert') {
      const item = op.payload;
      if (!item || !item.id) return { applied: false, flash: null };
      const tomb = Number(snap.tombstones.plan[item.id]) || 0;
      if (tomb && tomb >= ts && tomb >= (Number(item.updatedAt) || 0)) return { applied: false, flash: null };
      const prev = snap.planItems[item.id];
      const merged = mergeRecord(prev, item, PLAN_FIELDS);
      const changed = fieldsChanged(prev, merged, PLAN_FIELDS);
      snap.planItems[item.id] = merged;
      if (tomb && Math.max(ts, Number(merged.updatedAt) || 0) > tomb) delete snap.tombstones.plan[item.id];
      return { applied: changed, flash: null };
    }
    if (op.kind === 'plan-delete') {
      const id = op.id || (op.payload && op.payload.id);
      if (!id) return { applied: false, flash: null };
      const prev = snap.planItems[id];
      const prevTs = prev ? (Number(prev.updatedAt) || 0) : 0;
      const tomb = Number(snap.tombstones.plan[id]) || 0;
      if (ts >= prevTs && ts >= tomb) {
        delete snap.planItems[id];
        snap.tombstones.plan[id] = ts;
        return { applied: true, flash: null };
      }
      return { applied: false, flash: null };
    }
    if (op.kind === 'kv') {
      const key = op.key;
      if (!key) return { applied: false, flash: null };
      const cur = snap.kv[key];
      const curTs = cur ? Number(cur.ts) || 0 : 0;
      if (ts > curTs) {
        let value = op.value;
        if (key === 'progressAnchors' && cur && cur.v && typeof cur.v === 'object' && value && typeof value === 'object') {
          value = mergeProgressAnchors(cur.v, value);
        }
        if (MACHINE_TS_KEYS[key] && cur && cur.v && typeof cur.v === 'object' && value && typeof value === 'object') {
          value = mergeByMachineTs(cur.v, value);
        }
        snap.kv[key] = { v: value, ts: ts, peer: op.peer || '' };
        return { applied: true, flash: null };
      }
      // Even a stale-ts blob can carry a newer per-machine anchor; merge those in.
      if (key === 'progressAnchors' && cur && cur.v && typeof cur.v === 'object' && op.value && typeof op.value === 'object') {
        const merged = mergeProgressAnchors(cur.v, op.value);
        if (JSON.stringify(merged) !== JSON.stringify(cur.v)) {
          snap.kv[key] = { v: merged, ts: curTs, peer: cur.peer || op.peer || '' };
          return { applied: true, flash: null };
        }
      }
      if (MACHINE_TS_KEYS[key] && cur && cur.v && typeof cur.v === 'object' && op.value && typeof op.value === 'object') {
        const merged = mergeByMachineTs(cur.v, op.value);
        if (JSON.stringify(merged) !== JSON.stringify(cur.v)) {
          snap.kv[key] = { v: merged, ts: curTs, peer: cur.peer || op.peer || '' };
          return { applied: true, flash: null };
        }
      }
      return { applied: false, flash: null };
    }
    return { applied: false, flash: null };
  }

  function applyOps(snap, ops) {
    const flashes = [];
    let applied = 0;
    for (const op of ops || []) {
      const r = applyOp(snap, op);
      if (r.applied) applied += 1;
      if (r.flash) flashes.push(r.flash);
    }
    return { applied, flashes };
  }

  function lotsToMap(list) {
    const map = {};
    for (const l of list || []) {
      if (l && l.id) map[l.id] = l;
    }
    return map;
  }

  function mapToLots(map) {
    return Object.values(map || {}).sort((a, b) => {
      const da = String(a.day || '');
      const db = String(b.day || '');
      if (da !== db) return da.localeCompare(db);
      return (Number(a.number) || 0) - (Number(b.number) || 0) || String(a.id).localeCompare(String(b.id));
    });
  }

  function plansToMap(list) {
    const map = {};
    for (const p of list || []) {
      if (p && p.id) map[p.id] = p;
    }
    return map;
  }

  function mapToPlans(map) {
    return Object.values(map || []);
  }

  function stamp(obj, fields, ts, peer) {
    ts = ts || Date.now();
    if (!obj.fieldTs) obj.fieldTs = {};
    for (const f of fields) obj.fieldTs[f] = ts;
    obj.updatedAt = ts;
    if (peer) obj.updatedBy = peer;
    return ts;
  }

  function diffState(prev, next, peer, ts) {
    ts = ts || Date.now();
    const ops = [];
    prev = prev || { lots: [], planItems: [], kv: {} };
    const prevLots = lotsToMap(prev.lots);
    const nextLots = lotsToMap(next.lots);
    for (const id of Object.keys(nextLots)) {
      const a = prevLots[id];
      const b = nextLots[id];
      if (!a) {
        ops.push({ kind: 'lot-upsert', ts: b.updatedAt || ts, peer, payload: b });
        continue;
      }
      let changed = false;
      const payload = Object.assign({}, b);
      const fieldTs = Object.assign({}, b.fieldTs || {});
      for (const f of LOT_FIELDS) {
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
          changed = true;
          fieldTs[f] = ts;
        }
      }
      if (changed) {
        payload.fieldTs = fieldTs;
        payload.updatedAt = ts;
        payload.updatedBy = peer;
        b.fieldTs = fieldTs;
        b.updatedAt = ts;
        b.updatedBy = peer;
        ops.push({ kind: 'lot-upsert', ts, peer, payload });
      }
    }
    for (const id of Object.keys(prevLots)) {
      if (!nextLots[id]) ops.push({ kind: 'lot-delete', ts, peer, id });
    }
    const prevPlans = plansToMap(prev.planItems);
    const nextPlans = plansToMap(next.planItems);
    for (const id of Object.keys(nextPlans)) {
      const a = prevPlans[id];
      const b = nextPlans[id];
      if (!a) {
        ops.push({ kind: 'plan-upsert', ts: b.updatedAt || ts, peer, payload: b });
        continue;
      }
      let changed = false;
      const payload = Object.assign({}, b);
      const fieldTs = Object.assign({}, b.fieldTs || {});
      for (const f of PLAN_FIELDS) {
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
          changed = true;
          fieldTs[f] = ts;
        }
      }
      if (changed) {
        payload.fieldTs = fieldTs;
        payload.updatedAt = ts;
        payload.updatedBy = peer;
        b.fieldTs = fieldTs;
        b.updatedAt = ts;
        b.updatedBy = peer;
        ops.push({ kind: 'plan-upsert', ts, peer, payload });
      }
    }
    for (const id of Object.keys(prevPlans)) {
      if (!nextPlans[id]) ops.push({ kind: 'plan-delete', ts, peer, id });
    }
    const prevKv = prev.kv || {};
    const nextKv = next.kv || {};
    for (const key of Object.keys(nextKv)) {
      if (JSON.stringify(prevKv[key]) !== JSON.stringify(nextKv[key])) {
        ops.push({ kind: 'kv', ts, peer, key, value: nextKv[key] });
      }
    }
    return ops;
  }

  function kvFromState(state) {
    const kv = {};
    kv.day = state.day;
    kv.dayCutoffHour = state.dayCutoffHour;
    kv.lotsPerMin = state.lotsPerMin;
    // Clone object values so lastShared is a true snapshot. In-place edits
    // (setProgress, writeAnchor, machine lists) must still diff and emit kv ops.
    kv.machines = clone(state.machines);
    kv.customItemsByHalf = clone(state.customItemsByHalf);
    kv.boughtHistory = clone(state.boughtHistory);
    kv.currentNumbers = clone(state.currentNumbers);
    kv.progressAnchors = clone(state.progressAnchors);
    kv.seriesPath = clone(state.seriesPath);
    kv.seriesPlans = clone(state.seriesPlans);
    kv.machineMerges = clone(state.machineMerges);
    kv.autoAdvance = state.autoAdvance !== false;
    return kv;
  }

  function applyKvToState(state, kvMap) {
    function val(key) {
      const e = kvMap[key];
      return e && Object.prototype.hasOwnProperty.call(e, 'v') ? e.v : undefined;
    }
    const day = val('day');
    if (day != null) state.day = day;
    const cutoff = val('dayCutoffHour');
    if (cutoff != null) {
      const h = Number(cutoff);
      if (Number.isFinite(h) && h >= 0 && h <= 23) state.dayCutoffHour = Math.floor(h);
    }
    const rate = val('lotsPerMin');
    if (rate != null) {
      const n = Number(rate);
      if (Number.isFinite(n) && n >= 1 && n <= 12) state.lotsPerMin = Math.round(n * 10) / 10;
    }
    const machines = val('machines');
    if (machines && typeof machines === 'object') state.machines = machines;
    const customs = val('customItemsByHalf');
    if (customs && typeof customs === 'object') state.customItemsByHalf = customs;
    const hist = val('boughtHistory');
    if (Array.isArray(hist)) {
      if (typeof mergeBoughtHistory === 'function') state.boughtHistory = mergeBoughtHistory(state.boughtHistory, hist);
      else state.boughtHistory = hist;
    }
    const anchors = val('progressAnchors');
    if (anchors && typeof anchors === 'object') {
      state.progressAnchors = mergeProgressAnchors(state.progressAnchors, anchors);
    }
    const nums = val('currentNumbers');
    if (nums && typeof nums === 'object' || state.progressAnchors) {
      state.currentNumbers = mergeCurrentNumbers(state.currentNumbers, nums && typeof nums === 'object' ? nums : {}, state.progressAnchors);
    }
    const autoAdv = val('autoAdvance');
    if (typeof autoAdv === 'boolean') state.autoAdvance = autoAdv;
    const path = val('seriesPath');
    if (path && typeof path === 'object') {
      state.seriesPath = mergeByMachineTs(state.seriesPath, path);
    }
    const plans = val('seriesPlans');
    if (plans && typeof plans === 'object') {
      state.seriesPlans = mergeByMachineTs(state.seriesPlans, plans);
    }
    const merges = val('machineMerges');
    if (merges && typeof merges === 'object') {
      state.machineMerges = mergeByMachineTs(state.machineMerges, merges);
    }
  }

  function snapshotToOps(snap) {
    const ops = [];
    snap = snap || emptySnapshot();
    for (const lot of mapToLots(snap.lots || {})) {
      ops.push({ kind: 'lot-upsert', ts: Number(lot.updatedAt) || 1, peer: lot.updatedBy || '', payload: lot });
    }
    for (const [id, ts] of Object.entries((snap.tombstones && snap.tombstones.lots) || {})) {
      ops.push({ kind: 'lot-delete', ts: Number(ts) || 1, id });
    }
    for (const item of mapToPlans(snap.planItems || {})) {
      ops.push({ kind: 'plan-upsert', ts: Number(item.updatedAt) || 1, peer: item.updatedBy || '', payload: item });
    }
    for (const [id, ts] of Object.entries((snap.tombstones && snap.tombstones.plan) || {})) {
      ops.push({ kind: 'plan-delete', ts: Number(ts) || 1, id });
    }
    for (const [key, e] of Object.entries(snap.kv || {})) {
      if (!e) continue;
      ops.push({ kind: 'kv', ts: Number(e.ts) || 1, peer: e.peer || '', key, value: e.v });
    }
    return ops;
  }

  function snapshotFromState(state) {
    const snap = emptySnapshot();
    snap.lots = lotsToMap(state.lots);
    snap.planItems = plansToMap(state.planItems);
    const kv = kvFromState(state);
    const meta = (state.syncKvTs && typeof state.syncKvTs === 'object') ? state.syncKvTs : {};
    for (const key of Object.keys(kv)) {
      snap.kv[key] = { v: kv[key], ts: Number(meta[key]) || Number(state.updatedAt) || 0, peer: state.peerId || '' };
    }
    if (state.syncTombstones) snap.tombstones = clone(state.syncTombstones);
    return snap;
  }

  function stateSliceFromSnapshot(snap) {
    return {
      lots: mapToLots(snap.lots),
      planItems: mapToPlans(snap.planItems),
      kv: snap.kv,
      tombstones: snap.tombstones
    };
  }

  return {
    LOT_FIELDS,
    PLAN_FIELDS,
    emptySnapshot,
    mergeRecord,
    applyOp,
    applyOps,
    stamp,
    diffState,
    kvFromState,
    applyKvToState,
    snapshotFromState,
    snapshotToOps,
    pickNewerAnchor,
    mergeProgressAnchors,
    mergeCurrentNumbers,
    mergeByMachineTs,
    stateSliceFromSnapshot,
    fieldsChanged,
    lotsToMap,
    mapToLots,
    plansToMap,
    mapToPlans,
    clone
  };
});
