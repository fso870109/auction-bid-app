/* Shared merge helpers for 拍賣標貨助手 two-person sync. Browser + Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BidSyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOT_FIELDS = ['number', 'day', 'half', 'machineId', 'item', 'size', 'note', 'status', 'priority', 'secondMarket', 'createdAt', 'qty'];
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
        snap.kv[key] = { v: op.value, ts: ts, peer: op.peer || '' };
        return { applied: true, flash: null };
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
    kv.machines = state.machines;
    kv.customItemsByHalf = state.customItemsByHalf;
    kv.boughtHistory = state.boughtHistory;
    kv.currentNumbers = state.currentNumbers;
    return kv;
  }

  function applyKvToState(state, kvMap) {
    function val(key) {
      const e = kvMap[key];
      return e && Object.prototype.hasOwnProperty.call(e, 'v') ? e.v : undefined;
    }
    const day = val('day');
    if (day != null) state.day = day;
    const machines = val('machines');
    if (machines && typeof machines === 'object') state.machines = machines;
    const customs = val('customItemsByHalf');
    if (customs && typeof customs === 'object') state.customItemsByHalf = customs;
    const hist = val('boughtHistory');
    if (Array.isArray(hist)) {
      if (typeof mergeBoughtHistory === 'function') state.boughtHistory = mergeBoughtHistory(state.boughtHistory, hist);
      else state.boughtHistory = hist;
    }
    const nums = val('currentNumbers');
    if (nums && typeof nums === 'object') state.currentNumbers = nums;
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
    stateSliceFromSnapshot,
    fieldsChanged,
    lotsToMap,
    mapToLots,
    plansToMap,
    mapToPlans,
    clone
  };
});
