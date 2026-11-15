'use strict';

const STORAGE_KEY = 'ty-auction-bid-v1';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const DEFAULT_ITEMS_BULK = [
  '高麗菜', '大白菜', '花椰菜', '青花菜', '胡蘿蔔', '白蘿蔔', '洋蔥', '馬鈴薯', '芋頭', '薑', '蒜'
];
const DEFAULT_ITEMS_LEAFY = [
  '小白菜', '青江菜', '菠菜', '空心菜', '地瓜葉', '蔥', '芹菜', '莧菜', '奶油生菜', 'A菜', '大陸妹'
];
const DEFAULT_ITEMS_MORNING = [...DEFAULT_ITEMS_BULK, ...DEFAULT_ITEMS_LEAFY];
const DEFAULT_ITEMS_AFTERNOON = [
  '小黃瓜', '大黃瓜', '絲瓜', '苦瓜', '南瓜', '冬瓜', '胡瓜', '茄子', '番茄',
  '青椒', '彩椒', '玉米', '毛豆', '四季豆', '秋葵', '豌豆', '美人腿'
];
const DEFAULT_ITEMS = [...DEFAULT_ITEMS_MORNING, ...DEFAULT_ITEMS_AFTERNOON];

const DEFAULT_MACHINES = {
  morning: [
    { id: 'm1', name: '第一台・大宗', ranges: [{ start: 1001, end: 1999 }] },
    { id: 'm2', name: '第二台・水菜', ranges: [{ start: 3001, end: 3499 }] },
    { id: 'm3', name: '第三台', ranges: [{ start: 3500, end: 3999 }] }
  ],
  afternoon: [
    {
      id: 'a1',
      name: '第一台・瓜果',
      ranges: [
        { start: 2001, end: 2499 },
        { start: 6001, end: 6999 }
      ]
    },
    { id: 'a2', name: '第二台・瓜果', ranges: [{ start: 2500, end: 5049 }] },
    { id: 'a3', name: '第三台・瓜果', ranges: [{ start: 5050, end: 5999 }] }
  ]
};

let state;
let draftNum = '';
let draftNote = '';
let draftShowNote = false;
let draftMachineId = '';
let showMachinePicker = false;
let paddleOpen = false;
let wakeLock = null;
let toastTimer = null;
let toastMsg = '';
let modal = null;
let dupFlash = false;
let resultFilter = 'all';
let deferredInstall = null;
let editCurrent = null; // { half, machineId, value }
let draftItem = '';
let itemTargetId = null;
let itemTargetAuto = false;
let orientationLocked = false;
let ignoreItemClick = false;
let longPressTimer = null;
let showSettings = false;
let secondOpen = true;
let progressPopId = null;
let ignoreLotClick = false;
let pressOrigin = null;
let toastAction = null;
let undoStack = null;
let liveScrolls = {};
let draftPriority = 'watch';
let armTimer = null;
let dragState = null;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d}（${WEEKDAYS[dt.getDay()]}）`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function defaultCurrents(machines) {
  const out = { morning: {}, afternoon: {} };
  for (const half of ['morning', 'afternoon']) {
    for (const m of machines[half]) {
      out[half][m.id] = null;
    }
  }
  return out;
}

function defaultState() {
  const machines = structuredClone(DEFAULT_MACHINES);
  return {
    sellerCode: '',
    paddleTheme: 'yellow',
    vibrate: true,
    alertGap: 3,
    autoSave4: true,
    currentHalf: 'morning',
    tab: 'note',
    machines,
    currentNumbers: defaultCurrents(machines),
    lots: [],
    day: todayStr(),
    alerted: {},
    customItems: [],
    itemCounts: {},
    customItemsByHalf: { morning: [], afternoon: [] },
    itemCountsByHalf: { morning: {}, afternoon: {} },
    progressV2: true,
    itemsMigratedV2: true,
    lastPriority: 'watch',
    dayRules: [],
    machinesMigratedV9: true
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const merged = { ...base, ...saved };
    merged.machines = {
      morning: saved.machines?.morning || base.machines.morning,
      afternoon: saved.machines?.afternoon || base.machines.afternoon
    };
    merged.currentNumbers = {
      morning: { ...base.currentNumbers.morning, ...(saved.currentNumbers?.morning || {}) },
      afternoon: { ...base.currentNumbers.afternoon, ...(saved.currentNumbers?.afternoon || {}) }
    };
    if (!Array.isArray(merged.lots)) merged.lots = [];
    if (!merged.alerted || typeof merged.alerted !== 'object') merged.alerted = {};
    if (!Array.isArray(merged.customItems)) merged.customItems = [];
    if (!merged.itemCounts || typeof merged.itemCounts !== 'object') merged.itemCounts = {};
    migrateItemLists(merged);
    if (!Array.isArray(merged.dayRules)) merged.dayRules = [];
    if (!['must', 'watch', 'skip'].includes(merged.lastPriority)) merged.lastPriority = 'watch';
    if (!saved.machinesMigratedV9) {
      migrateMorning3500(merged);
      merged.machinesMigratedV9 = true;
    }
    for (const lot of merged.lots) {
      if (!['must', 'watch', 'skip'].includes(lot.priority)) lot.priority = 'watch';
    }
    if (/^\d{4}$/.test(String(merged.sellerCode || ''))) merged.setupDone = true;
    if (merged.tab === 'track' || merged.tab === 'result' || merged.tab === 'settings') {
      merged.tab = 'live';
    }
    if (!merged.progressV2) {
      merged.currentNumbers = defaultCurrents(merged.machines);
      merged.progressV2 = true;
    }
    return merged;
  } catch {
    return base;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('儲存失敗，空間可能不足');
  }
}

function halfLabel(half) {
  return half === 'afternoon' ? '下半場' : '上半場';
}

function machineById(id, half) {
  const h = half || state.currentHalf;
  return (
    state.machines[h].find((m) => m.id === id) ||
    state.machines.morning.find((m) => m.id === id) ||
    state.machines.afternoon.find((m) => m.id === id)
  );
}

function machineNameOf(lotOrId, half) {
  const id = typeof lotOrId === 'object' ? lotOrId.machineId : lotOrId;
  const h = typeof lotOrId === 'object' ? lotOrId.half : half;
  return machineById(id, h)?.name || '未分台';
}

function shortMachineName(name) {
  return String(name || '').replace(/第一台・|第二台・|第三台・/g, '').replace(/第一台|第二台|第三台/g, (s) => s.slice(0, 2)) || name;
}

function rangesOf(machine, num) {
  return (machine.ranges || []).filter((r) => r.start != null && num >= r.start && (r.end == null || num <= r.end));
}

function machinesMatching(num, half) {
  return state.machines[half].filter((m) => rangesOf(m, num).length > 0);
}

function detectMachineId(num, half) {
  if (draftMachineId) {
    const found = machineById(draftMachineId, half);
    if (found) return found.id;
  }
  const hits = machinesMatching(num, half);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    const width = (m) => {
      const rs = rangesOf(m, num);
      let best = Infinity;
      for (const r of rs) {
        const w = (r.end == null ? 99999 : r.end) - r.start;
        if (w < best) best = w;
      }
      return best;
    };
    const ranked = hits.slice().sort((a, b) => width(a) - width(b));
    if (width(ranked[0]) < width(ranked[1])) return ranked[0].id;
  }
  return null;
}

const PRIORITIES = ['must', 'watch', 'skip'];

function lotPriority(lot) {
  const p = lot && lot.priority;
  return PRIORITIES.includes(p) ? p : 'watch';
}

function prioLabel(p) {
  if (p === 'must') return '必標';
  if (p === 'skip') return '可不標';
  return '看價';
}

function prioShort(p) {
  if (p === 'must') return '必';
  if (p === 'skip') return '可';
  return '價';
}

function hundredBlock(num) {
  const n = Number(num);
  const start = Math.floor(n / 100) * 100;
  const end = start + 99;
  const label = `${String(start).slice(0, -2)}xx`;
  return { start, end, label };
}

function dayRulesOf(half) {
  if (!Array.isArray(state.dayRules)) state.dayRules = [];
  const h = half || state.currentHalf;
  return state.dayRules.filter((r) => r.day === state.day && r.half === h);
}

function ruleMachineId(num, half) {
  for (const r of dayRulesOf(half)) {
    if (num >= r.start && num <= r.end) return r.machineId;
  }
  return null;
}

function addRangeToMachine(machine, start, end) {
  if (!machine) return;
  machine.ranges = (machine.ranges || []).filter((r) => r.start != null);
  const covers = (machine.ranges || []).some(
    (r) => r.start <= start && (r.end == null || r.end >= end)
  );
  if (!covers) machine.ranges.push({ start, end });
  if (!machine.ranges.length) machine.ranges = [{ start, end }];
}

function subtractRangeFromMachine(machine, start, end) {
  if (!machine) return;
  const next = [];
  for (const r of machine.ranges || []) {
    if (r.start == null) continue;
    const a = r.start;
    const b = r.end == null ? Infinity : r.end;
    if (b < start || a > end) {
      next.push({ start: r.start, end: r.end });
      continue;
    }
    if (a < start) next.push({ start: a, end: start - 1 });
    if (b > end) next.push({ start: end + 1, end: r.end == null ? null : b });
  }
  machine.ranges = next.length ? next : [{ start: null, end: null }];
}

function todayLots(half) {
  const h = half || state.currentHalf;
  return state.lots
    .filter((l) => l.day === state.day && l.half === h)
    .sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
}

function lotsForMachine(machineId, half) {
  return todayLots(half).filter((l) => l.machineId === machineId && !l.secondMarket);
}

function secondLots() {
  return state.lots
    .filter((l) => l.day === state.day && l.secondMarket)
    .sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
}

function isPassed(lot, cur) {
  return !!(lot && lot.status === 'pending' && !lot.secondMarket && cur != null && lot.number < cur);
}

function isFlow(lot) {
  return !!(lot && lot.status === 'flow');
}

function columnTitle(m, half) {
  const h = half || state.currentHalf;
  const names = (state.machines[h] || []).map((x) => String(x.name || ''));
  const strip = (n) => n.replace(/^第[一二三四五]台・/, '');
  const short = strip(m.name || '');
  const unique = names.map(strip).filter((s) => s === short).length === 1;
  if (unique && short && !/^第[一二三四五]台$/.test(short)) return short;
  const head = String(m.name || '').match(/^第[一二三四五]台/);
  return (head && head[0]) || short || m.name;
}

function migrateMorning3500(merged) {
  const morning = merged.machines && merged.machines.morning;
  if (!Array.isArray(morning)) return;
  const m2 = morning.find((m) => m.id === 'm2');
  const m3 = morning.find((m) => m.id === 'm3');
  if (!m2 || !m3) return;
  const listed = (ranges) => (ranges || []).filter((r) => r.start != null);
  const m2ranges = listed(m2.ranges);
  const m3ranges = listed(m3.ranges);
  const oldWater = m2ranges.length === 1 && m2ranges[0].start === 3001 && m2ranges[0].end === 3999;
  const emptyThird = m3ranges.length === 0;
  if (!oldWater || !emptyThird) return;
  m2.ranges = [{ start: 3001, end: 3499 }];
  m3.ranges = [{ start: 3500, end: 3999 }];
  for (const lot of merged.lots || []) {
    if ((lot.half || 'morning') === 'morning' && lot.machineId === 'm2' && lot.number >= 3500 && lot.number <= 3999) {
      lot.machineId = 'm3';
    }
  }
}

function reorderMachine(half, machineId, insertIndex) {
  const arr = state.machines[half] || [];
  const from = arr.findIndex((m) => m.id === machineId);
  if (from < 0) return false;
  let to = insertIndex;
  if (to > from) to -= 1;
  to = Math.max(0, Math.min(arr.length - 1, to));
  if (to === from) return false;
  const next = arr.slice();
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  state.machines[half] = next;
  return true;
}

function columnInsertIndex(x) {
  const cols = [...document.querySelectorAll('.live-col')];
  if (!cols.length) return 0;
  for (let i = 0; i < cols.length; i++) {
    const r = cols[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return cols.length;
}

function columnLots(machineId, half) {
  return todayLots(half)
    .filter((l) => l.machineId === machineId)
    .sort((a, b) => a.number - b.number || (a.createdAt || 0) - (b.createdAt || 0));
}

function captureLiveScroll() {
  liveScrolls = {};
  document.querySelectorAll('.live-col-list').forEach((el) => {
    liveScrolls[el.dataset.id] = el.scrollTop;
  });
}

function restoreLiveScroll() {
  document.querySelectorAll('.live-col-list').forEach((el) => {
    if (liveScrolls[el.dataset.id] != null) el.scrollTop = liveScrolls[el.dataset.id];
  });
}

function snapshotLot(lot) {
  if (!lot) return null;
  return {
    id: lot.id,
    status: lot.status,
    secondMarket: !!lot.secondMarket,
    item: lot.item || '',
    priority: lotPriority(lot),
    current: currentOf(lot.machineId, lot.half),
    half: lot.half,
    machineId: lot.machineId,
    lot: { ...lot }
  };
}

function restoreCurrent(snap) {
  if (!snap) return;
  const half = snap.half || state.currentHalf;
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  state.currentNumbers[half][snap.machineId] = snap.current;
}

function offerUndo(snap, msg) {
  undoStack = snap;
  toast(msg, 2800, { label: '復原', fn: undoLast });
}

function undoLast() {
  const snap = undoStack;
  undoStack = null;
  toastMsg = '';
  toastAction = null;
  if (!snap) return;
  if (snap.kind === 'delete' && snap.lot) {
    if (!state.lots.some((l) => l.id === snap.lot.id)) state.lots.push(snap.lot);
    restoreCurrent(snap);
    saveState();
    toast('已復原');
    render();
    return;
  }
  const lot = state.lots.find((l) => l.id === snap.id);
  if (!lot) {
    toast('無法復原');
    return;
  }
  lot.status = snap.status;
  lot.secondMarket = snap.secondMarket;
  lot.item = snap.item;
  if (snap.priority) lot.priority = snap.priority;
  if (snap.machineId) lot.machineId = snap.machineId;
  restoreCurrent(snap);
  saveState();
  toast('已復原');
  render();
}

function cycleLotStatus(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotLot(lot);
  let next;
  let label;
  if (lot.status === 'flow') {
    next = 'pending';
    lot.secondMarket = false;
    label = '已取消流標';
  } else if (lot.status === 'pending') {
    next = 'won';
    lot.secondMarket = false;
    label = '已標到';
  } else if (lot.status === 'won') {
    next = 'lost';
    label = '沒標到';
  } else {
    next = 'pending';
    label = '改回未拍';
  }
  lot.status = next;
  if (next === 'won' || next === 'lost') jumpToLot(lot, { force: false });
  saveState();
  checkAlerts();
  offerUndo(snap, `${label} ${lotLabel(lot)}`);
  buzz(12);
  render();
}

function markFlow(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotLot(lot);
  lot.status = 'flow';
  lot.secondMarket = true;
  jumpToLot(lot, { force: false });
  saveState();
  checkAlerts();
  offerUndo(snap, `流標・二市 ${lotLabel(lot)}`);
  buzz(16);
  render();
}

function cancelFlow(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || lot.status !== 'flow') return;
  const snap = snapshotLot(lot);
  lot.status = 'pending';
  lot.secondMarket = false;
  saveState();
  offerUndo(snap, `已取消流標 ${lotLabel(lot)}`);
  render();
}

function openLotActions(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  modal = { type: 'lot-actions', id };
  buzz(20);
  render();
}

function openPickItemForLot(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  modal = { type: 'pick-item', id, half: lot.half || state.currentHalf };
  render();
}

function openSecondSheet() {
  modal = { type: 'second-sheet' };
  render();
}

function setLotPriority(id, prio, { fromToggle } = {}) {
  if (!PRIORITIES.includes(prio)) return;
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotLot(lot);
  lot.priority = prio;
  if (fromToggle) {
    draftPriority = prio;
    state.lastPriority = prio;
  }
  saveState();
  toast(`${lot.number}　${prioLabel(prio)}`, 1600);
  buzz(10);
  render();
}

function cycleLotPriority(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const cur = lotPriority(lot);
  const next = PRIORITIES[(PRIORITIES.indexOf(cur) + 1) % PRIORITIES.length];
  setLotPriority(id, next);
}

function setDraftPriority(prio) {
  if (!PRIORITIES.includes(prio)) return;
  draftPriority = prio;
  state.lastPriority = prio;
  saveState();
  render();
}

function isUnauctionedMust(lot) {
  if (!lot || lotPriority(lot) !== 'must') return false;
  if (lot.status !== 'pending' || lot.secondMarket) return false;
  const cur = currentOf(lot.machineId, lot.half);
  return !isPassed(lot, cur);
}

function moveLotToMachine(id, machineId) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || !machineId || lot.machineId === machineId) return false;
  const snap = snapshotLot(lot);
  snap.kind = 'move';
  const half = lot.half || state.currentHalf;
  lot.machineId = machineId;
  saveState();
  const dest = machineById(machineId, half);
  offerUndo(snap, `${lot.number} 已移到${columnTitle(dest, half) || dest?.name || '另一台'}`);
  buzz([16, 40, 24]);
  render();
  return true;
}


function recentLots() {
  return state.lots
    .filter((l) => l.day === state.day && l.half === state.currentHalf)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 8);
}

function lotLabel(lot) {
  if (!lot) return '';
  return lot.item ? `${lot.number} ${lot.item}` : String(lot.number);
}

function migrateItemLists(merged) {
  if (!merged.customItemsByHalf || typeof merged.customItemsByHalf !== 'object') {
    merged.customItemsByHalf = { morning: [], afternoon: [] };
  }
  for (const half of ['morning', 'afternoon']) {
    if (!Array.isArray(merged.customItemsByHalf[half])) merged.customItemsByHalf[half] = [];
  }
  if (!merged.itemCountsByHalf || typeof merged.itemCountsByHalf !== 'object') {
    merged.itemCountsByHalf = { morning: {}, afternoon: {} };
  }
  for (const half of ['morning', 'afternoon']) {
    if (!merged.itemCountsByHalf[half] || typeof merged.itemCountsByHalf[half] !== 'object') {
      merged.itemCountsByHalf[half] = {};
    }
  }
  if (merged.itemsMigratedV2) return;
  const old = Array.isArray(merged.customItems) ? merged.customItems : [];
  for (const name of old) {
    const n = String(name || '').trim();
    if (!n) continue;
    for (const half of ['morning', 'afternoon']) {
      if (!defaultItems(half).includes(n) && !merged.customItemsByHalf[half].includes(n)) {
        merged.customItemsByHalf[half].push(n);
      }
    }
  }
  const oldCounts = merged.itemCounts || {};
  for (const [key, val] of Object.entries(oldCounts)) {
    const n = Number(val) || 0;
    if (!n) continue;
    for (const half of ['morning', 'afternoon']) {
      if (defaultItems(half).includes(key) || merged.customItemsByHalf[half].includes(key)) {
        merged.itemCountsByHalf[half][key] = (merged.itemCountsByHalf[half][key] || 0) + n;
      }
    }
  }
  merged.itemsMigratedV2 = true;
}

function defaultItems(half) {
  return half === 'afternoon' ? DEFAULT_ITEMS_AFTERNOON : DEFAULT_ITEMS_MORNING;
}

function customItemsOf(half) {
  const h = half || state.currentHalf;
  if (!state.customItemsByHalf) state.customItemsByHalf = { morning: [], afternoon: [] };
  if (!Array.isArray(state.customItemsByHalf[h])) state.customItemsByHalf[h] = [];
  return state.customItemsByHalf[h];
}

function itemCountsOf(half) {
  const h = half || state.currentHalf;
  if (!state.itemCountsByHalf) state.itemCountsByHalf = { morning: {}, afternoon: {} };
  if (!state.itemCountsByHalf[h] || typeof state.itemCountsByHalf[h] !== 'object') {
    state.itemCountsByHalf[h] = {};
  }
  return state.itemCountsByHalf[h];
}

function itemPreferGroup(half) {
  if (half !== 'morning') return null;
  let machineId = null;
  const parsed = draftNum ? parseInt(draftNum, 10) : NaN;
  if (Number.isFinite(parsed)) machineId = detectMachineId(parsed, half);
  if (!machineId && itemTargetId) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot && lot.half === 'morning') machineId = lot.machineId;
  }
  if (!machineId) return null;
  const name = machineById(machineId, half)?.name || '';
  if (/大宗/.test(name)) return 'bulk';
  if (/水菜/.test(name)) return 'leafy';
  return null;
}

function itemGroup(name, prefer) {
  if (!prefer) return 1;
  const bulk = DEFAULT_ITEMS_BULK.includes(name);
  const leafy = DEFAULT_ITEMS_LEAFY.includes(name);
  if (prefer === 'bulk') return bulk ? 0 : 1;
  if (prefer === 'leafy') return leafy ? 0 : 1;
  return 1;
}

function allItems(half) {
  const h = half || state.currentHalf;
  const seen = new Set();
  const list = [];
  for (const name of [...customItemsOf(h), ...defaultItems(h)]) {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    list.push(n);
  }
  const counts = itemCountsOf(h);
  const customs = customItemsOf(h);
  const prefer = itemPreferGroup(h);
  list.sort((a, b) => {
    const dg = itemGroup(a, prefer) - itemGroup(b, prefer);
    if (dg) return dg;
    const dc = (counts[b] || 0) - (counts[a] || 0);
    if (dc) return dc;
    const ac = customs.includes(a);
    const bc = customs.includes(b);
    if (ac !== bc) return ac ? -1 : 1;
    return 0;
  });
  return list;
}

function isCustomItem(name, half) {
  return customItemsOf(half || state.currentHalf).includes(name);
}

function bumpItemUse(name, half) {
  if (!name) return;
  const counts = itemCountsOf(half || state.currentHalf);
  counts[name] = (counts[name] || 0) + 1;
}

function applyItemToLot(lot, name) {
  if (!lot) return;
  lot.item = name;
  bumpItemUse(name, lot.half || state.currentHalf);
  saveState();
  toast(`${lot.number}　${name}`);
  buzz(12);
}

function assignItem(name) {
  name = String(name || '').trim();
  if (!name) return;
  if (draftNum && (itemTargetAuto || !itemTargetId)) {
    draftItem = name;
    toast(`下一筆 ${draftNum} 會記成「${name}」`);
    render();
    return;
  }
  if (itemTargetId) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot) {
      applyItemToLot(lot, name);
      render();
      return;
    }
  }
  if (draftNum) {
    draftItem = name;
    toast(`下一筆 ${draftNum} 會記成「${name}」`);
    render();
    return;
  }
  toast('請先輸入或點選貨號');
}

function selectRecentForItem(id) {
  itemTargetId = id;
  itemTargetAuto = false;
  render();
}

function addCustomItem(name, half) {
  name = String(name || '').trim();
  const h = half || state.currentHalf;
  if (!name) {
    toast('請輸入品項名稱');
    return false;
  }
  if (defaultItems(h).includes(name) || customItemsOf(h).includes(name)) {
    toast('這個品項已經有了');
    return false;
  }
  customItemsOf(h).push(name);
  saveState();
  toast(`已新增「${name}」`);
  return true;
}

function ensureCustomItem(name, half) {
  name = String(name || '').trim();
  const h = half || state.currentHalf;
  if (!name) {
    toast('請輸入品項名稱');
    return '';
  }
  if (!defaultItems(h).includes(name) && !customItemsOf(h).includes(name)) {
    customItemsOf(h).push(name);
    saveState();
  }
  return name;
}

function renameCustomItem(oldName, newName, half) {
  newName = String(newName || '').trim();
  const h = half || (modal && modal.half) || state.currentHalf;
  if (!newName) return false;
  const list = customItemsOf(h);
  const i = list.indexOf(oldName);
  if (i < 0) return false;
  if (newName !== oldName && (defaultItems(h).includes(newName) || list.includes(newName))) {
    toast('這個品項已經有了');
    return false;
  }
  list[i] = newName;
  const counts = itemCountsOf(h);
  if (counts[oldName] != null) {
    counts[newName] = (counts[newName] || 0) + counts[oldName];
    delete counts[oldName];
  }
  for (const lot of state.lots) {
    if (lot.item === oldName && (!lot.half || lot.half === h)) lot.item = newName;
  }
  if (draftItem === oldName) draftItem = newName;
  saveState();
  toast(`已改成「${newName}」`);
  return true;
}

function deleteCustomItem(name, half) {
  const h = half || (modal && modal.half) || state.currentHalf;
  state.customItemsByHalf[h] = customItemsOf(h).filter((n) => n !== name);
  saveState();
  toast(`已刪「${name}」`);
}

function openItemEditor(name, half) {
  const h = half || state.currentHalf;
  if (!isCustomItem(name, h)) {
    toast('內建品項不能改，可點「＋自己輸入」或到設定新增');
    return;
  }
  modal = { type: 'edit-item', name, value: name, half: h };
  render();
}

function openTypeItem(half, lotId) {
  modal = { type: 'type-item', half: half || state.currentHalf, value: '', lotId: lotId || itemTargetId || null };
  render();
}

function currentOf(machineId, half) {
  const h = half || state.currentHalf;
  const v = state.currentNumbers[h]?.[machineId];
  return v == null || v === '' ? null : Number(v);
}

function buzz(pattern) {
  if (!state.vibrate) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

function toast(msg, ms, action) {
  toastMsg = msg;
  toastAction = action || null;
  const el = document.getElementById('toast');
  if (el) paintToast(el);
  else render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg = '';
    toastAction = null;
    const node = document.getElementById('toast');
    if (node) {
      node.classList.add('hidden');
      node.innerHTML = '';
    }
  }, ms || (action ? 2800 : 1600));
}

function paintToast(el) {
  if (!el) return;
  el.classList.toggle('hidden', !toastMsg);
  el.classList.toggle('has-action', !!(toastMsg && toastAction));
  if (!toastMsg) {
    el.innerHTML = '';
    return;
  }
  if (toastAction) {
    el.innerHTML = `<span>${escapeHtml(toastMsg)}</span><button type="button" data-act="undo">${escapeHtml(toastAction.label || '復原')}</button>`;
  } else {
    el.textContent = toastMsg;
  }
}

function isSetupNeeded() {
  return !state.setupDone;
}

/* ---------- 抄號 ---------- */
function typeDigit(d) {
  if (draftNum.length >= 4) return;
  const startingFresh = draftNum.length === 0;
  draftNum += String(d);
  showMachinePicker = false;
  dupFlash = false;
  if (startingFresh) {
    draftItem = '';
    if (itemTargetAuto) {
      itemTargetId = null;
      itemTargetAuto = false;
    }
  }
  if (state.autoSave4 && draftNum.length === 4) {
    saveLot({ fromAuto: true });
    return;
  }
  refreshNoteHead();
}

function backspace() {
  draftNum = draftNum.slice(0, -1);
  showMachinePicker = false;
  dupFlash = false;
  draftMachineId = '';
  refreshNoteHead();
}

function clearDraft() {
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftMachineId = '';
  showMachinePicker = false;
  dupFlash = false;
  refreshNoteHead();
}

function saveLot() {
  if (!draftNum) {
    toast('請先輸入貨號');
    buzz(30);
    return;
  }
  const num = parseInt(draftNum, 10);
  if (!Number.isFinite(num)) {
    toast('貨號無效');
    return;
  }
  const half = state.currentHalf;
  const dup = state.lots.find((l) => l.day === state.day && l.number === num);
  if (dup) {
    dupFlash = true;
    buzz([40, 50, 40, 50, 40]);
    toast(`${num} 已經抄過（${machineNameOf(dup)}）`);
    refreshNoteHead();
    return;
  }
  let machineId = detectMachineId(num, half);
  if (!machineId) {
    showMachinePicker = true;
    toast('請選擇台別');
    buzz(30);
    render();
    return;
  }
  commitLot(num, machineId, half);
}

function commitLot(num, machineId, half) {
  const lot = {
    id: uid(),
    day: state.day,
    half,
    machineId,
    number: num,
    note: draftNote.trim(),
    item: draftItem || '',
    status: 'pending',
    priority: PRIORITIES.includes(draftPriority) ? draftPriority : (state.lastPriority || 'watch'),
    createdAt: Date.now()
  };
  if (lot.item) bumpItemUse(lot.item);
  state.lots.push(lot);
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftMachineId = '';
  draftShowNote = false;
  showMachinePicker = false;
  dupFlash = false;
  itemTargetId = lot.id;
  itemTargetAuto = true;
  saveState();
  toast(lot.item ? `已存 ${lot.number}　${lot.item}` : `已存 ${num}　${machineNameOf(lot)}`);
  buzz(20);
  render();
}

function pickMachineForDraft(machineId) {
  draftMachineId = machineId;
  showMachinePicker = false;
  if (!draftNum) {
    render();
    return;
  }
  const num = parseInt(draftNum, 10);
  const dup = state.lots.find((l) => l.day === state.day && l.number === num);
  if (dup) {
    dupFlash = true;
    toast(`${num} 已經抄過（${machineNameOf(dup)}）`);
    render();
    return;
  }
  commitLot(num, machineId, state.currentHalf);
}

function deleteLot(id, { undoable } = {}) {
  const lot = state.lots.find((l) => l.id === id);
  const snap = lot ? { ...snapshotLot(lot), kind: 'delete' } : null;
  state.lots = state.lots.filter((l) => l.id !== id);
  saveState();
  if (undoable && snap) offerUndo(snap, lot ? `已刪 ${lot.number}` : '已刪除');
  else toast(lot ? `已刪 ${lot.number}` : '已刪除');
  render();
}

function setLotStatus(id, status) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  if (lot.status === status) {
    lot.status = 'pending';
  } else {
    lot.status = status;
    if (status === 'won') lot.secondMarket = false;
    if (status === 'won' || status === 'lost') jumpToLot(lot, { force: false });
  }
  saveState();
  checkAlerts();
  render();
}

function jumpToLot(lot, { force } = {}) {
  if (!lot) return;
  const half = lot.half || state.currentHalf;
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  const cur = state.currentNumbers[half][lot.machineId];
  if (!force && cur != null && lot.number < cur) return;
  state.currentNumbers[half][lot.machineId] = lot.number;
  saveState();
  checkAlerts();
}

function goToHere(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  jumpToLot(lot, { force: true });
  toast(`${lot.number}　已設為打到這裡`);
  render();
}

function moveToSecond(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotLot(lot);
  lot.secondMarket = true;
  secondOpen = true;
  saveState();
  offerUndo(snap, `${lotLabel(lot)} 已轉二市`);
  render();
}

function returnFromSecond(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotLot(lot);
  lot.secondMarket = false;
  if (lot.status === 'flow') lot.status = 'pending';
  saveState();
  offerUndo(snap, `${lotLabel(lot)} 已移回`);
  render();
}

/* ---------- 追蹤 ---------- */
function bumpCurrent(machineId, delta) {
  const half = state.currentHalf;
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  let cur = currentOf(machineId);
  if (cur == null) {
    const m = machineById(machineId, half);
    const start = (m?.ranges || []).find((r) => r.start != null)?.start;
    cur = start ?? 0;
  }
  const next = Math.max(0, cur + delta);
  state.currentNumbers[half][machineId] = next;
  saveState();
  checkAlerts();
  render();
}

function setCurrent(machineId, value) {
  const half = state.currentHalf;
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  const n = parseInt(value, 10);
  state.currentNumbers[half][machineId] = Number.isFinite(n) ? n : null;
  editCurrent = null;
  saveState();
  checkAlerts();
  render();
}

function checkAlerts() {
  const gap = state.alertGap || 3;
  const half = state.currentHalf;
  for (const m of state.machines[half]) {
    const cur = currentOf(m.id);
    if (cur == null) continue;
    for (const lot of lotsForMachine(m.id, half)) {
      if (lot.status !== 'pending') continue;
      const d = lot.number - cur;
      if (d >= 0 && d <= gap) {
        const key = `${state.day}:${lot.id}:${d === 0 ? 'now' : 'near'}`;
        if (!state.alerted[key]) {
          state.alerted[key] = true;
          buzz(d === 0 ? [200, 80, 200, 80, 200] : [280, 80, 280]);
          if (d === 0) toast(`就是這號！${lot.number}　${m.name}`);
          else toast(`${m.name} 還差 ${d} 號（${lot.number}）`);
          saveState();
        }
      }
    }
  }
}

/* ---------- 舉牌 ---------- */
async function enterPaddle() {
  if (isSetupNeeded()) {
    modal = null;
    render();
    toast('請先設定我的承銷人代號');
    return;
  }
  paddleOpen = true;
  render();
  const el = document.getElementById('paddle');
  try {
    if (el?.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' });
    } else if (el?.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } catch {
    /* overlay still works */
  }
  await requestWakeLock();
  await lockLandscape();
  requestAnimationFrame(() => {
    applyCssLandscapeIfNeeded();
    fitPaddleDigits();
  });
}

async function exitPaddle() {
  if (!paddleOpen && !document.fullscreenElement) {
    await unlockOrientation();
    return;
  }
  paddleOpen = false;
  await unlockOrientation();
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  } catch {
    /* ignore */
  }
  releaseWakeLock();
  render();
}

async function lockLandscape() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      await screen.orientation.lock('landscape');
      orientationLocked = true;
      document.getElementById('paddle')?.classList.remove('css-landscape');
      return true;
    }
  } catch {
    orientationLocked = false;
  }
  applyCssLandscapeIfNeeded();
  return false;
}

async function unlockOrientation() {
  try {
    if (orientationLocked && screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch {
    /* ignore */
  }
  orientationLocked = false;
  document.getElementById('paddle')?.classList.remove('css-landscape');
}

function applyCssLandscapeIfNeeded() {
  const el = document.getElementById('paddle');
  if (!el || !paddleOpen) return;
  const portrait = window.innerHeight > window.innerWidth + 24;
  // Use the actual viewport: if lock worked, the screen is already landscape.
  if (portrait) el.classList.add('css-landscape');
  else el.classList.remove('css-landscape');
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function cyclePaddleTheme() {
  const order = ['yellow', 'white', 'black-yellow'];
  const i = order.indexOf(state.paddleTheme);
  state.paddleTheme = order[(i + 1) % order.length];
  saveState();
  const el = document.getElementById('paddle');
  if (el) {
    el.classList.remove('theme-yellow', 'theme-white', 'theme-black-yellow');
    el.classList.add(`theme-${state.paddleTheme}`);
  } else {
    render();
    fitPaddleDigits();
  }
}

function fitPaddleDigits() {
  const el = document.getElementById('paddle-code');
  const box = document.getElementById('paddle-box');
  if (!el || !box) return;
  applyCssLandscapeIfNeeded();
  const w = box.clientWidth * 0.99;
  const h = box.clientHeight * 0.98;
  if (w < 20 || h < 20) return;
  el.style.whiteSpace = 'nowrap';
  el.style.lineHeight = '0.72';
  el.style.letterSpacing = '-0.06em';
  el.style.fontWeight = '900';
  el.style.fontStretch = 'condensed';
  let lo = 24;
  let hi = Math.max(w * 1.4, h * 1.6);
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollWidth <= w && el.scrollHeight <= h) lo = mid;
    else hi = mid;
  }
  el.style.fontSize = Math.floor(lo) + 'px';
}

function themeLabel(theme) {
  if (theme === 'white') return '白字黑底';
  if (theme === 'black-yellow') return '黑字黃底';
  return '黃字黑底';
}

/* ---------- 新的一天 ---------- */
function startNewDay(confirmed) {
  if (!confirmed) {
    modal = {
      type: 'confirm',
      title: '開始新的一天？',
      body: '會清空今天的抄號與標貨結果，台別號碼和承銷人代號會保留。',
      ok: '確定清空',
      cancel: '取消',
      danger: true,
      onOk: () => startNewDay(true)
    };
    render();
    return;
  }
  state.lots = [];
  state.alerted = {};
  state.day = todayStr();
  state.currentNumbers = defaultCurrents(state.machines);
  state.tab = 'note';
  modal = null;
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftMachineId = '';
  itemTargetId = null;
  itemTargetAuto = false;
  saveState();
  toast('已開始新的一天');
  render();
}

function checkNewDay() {
  const today = todayStr();
  if (state.day !== today && (state.lots || []).some((l) => l.day === state.day)) {
    modal = {
      type: 'confirm',
      title: `今天是 ${formatDateLabel(today)}`,
      body: `還留著 ${formatDateLabel(state.day)} 的抄號。要開始新的一天嗎？（設定會保留）`,
      ok: '開始新的一天',
      cancel: '先看昨天的',
      danger: false,
      onOk: () => startNewDay(true),
      onCancel: () => {
        modal = null;
        render();
      }
    };
  } else if (state.day !== today) {
    state.day = today;
    state.currentNumbers = defaultCurrents(state.machines);
    state.alerted = {};
    saveState();
  }
}

/* ---------- 分享 ---------- */
function resultText() {
  const code = state.sellerCode || '----';
  const lines = [`【${formatDateLabel(state.day)} 桃園果菜市場標貨】承銷人 ${code}`];
  let won = 0;
  let lost = 0;
  let pending = 0;
  let passed = 0;
  let flowN = 0;
  for (const half of ['morning', 'afternoon']) {
    const dayLots = todayLots(half);
    const lots = dayLots.filter((l) => !l.secondMarket);
    const hasFlow = dayLots.some((l) => l.status === 'flow');
    if (!lots.length && !hasFlow) continue;
    lines.push('', halfLabel(half));
    for (const m of state.machines[half]) {
      const group = lots.filter((l) => l.machineId === m.id);
      const flowG = dayLots.filter((l) => l.machineId === m.id && l.status === 'flow');
      if (!group.length && !flowG.length) continue;
      const cur = currentOf(m.id, half);
      const w = group.filter((l) => l.status === 'won');
      const x = group.filter((l) => l.status === 'lost');
      const over = group.filter((l) => isPassed(l, cur));
      const p = group.filter((l) => l.status === 'pending' && !isPassed(l, cur));
      won += w.length;
      lost += x.length;
      passed += over.length;
      pending += p.length;
      flowN += flowG.length;
      lines.push(m.name);
      if (w.length) lines.push(`  標到：${w.map(lotLabel).join('、')}（${w.length}）`);
      if (x.length) lines.push(`  沒標到：${x.map(lotLabel).join('、')}（${x.length}）`);
      if (flowG.length) lines.push(`  流標・二市：${flowG.map(lotLabel).join('、')}（${flowG.length}）`);
      if (over.length) lines.push(`  過號：${over.map(lotLabel).join('、')}（${over.length}）`);
      if (p.length) lines.push(`  未拍：${p.map(lotLabel).join('、')}（${p.length}）`);
      const musts = group.filter((l) => isUnauctionedMust(l));
      if (musts.length) lines.push(`  必標未拍：${musts.map(lotLabel).join('、')}（${musts.length}）`);
    }
  }
  const second = secondLots();
  const flowS = second.filter((l) => l.status === 'flow');
  const moved = second.filter((l) => l.status !== 'flow');
  if (second.length) {
    lines.push('', `二市（${second.length}）`);
    if (flowS.length) lines.push(`  流標・二市：${flowS.map(lotLabel).join('、')}（${flowS.length}）`);
    for (const l of moved) {
      const why = l.status === 'lost' ? '沒標到轉入' : '過號轉入';
      lines.push(`  ${lotLabel(l)}　${machineNameOf(l)}（${why}）`);
    }
  }
  if (won + lost + pending + passed + second.length === 0) lines.push('', '今天還沒有抄號。');
  else {
    let sum = `合計 標到 ${won}、沒標到 ${lost}`;
    if (flowS.length) sum += `、流標・二市 ${flowS.length}`;
    if (moved.length) sum += `、二市轉入 ${moved.length}`;
    if (passed) sum += `、過號 ${passed}`;
    sum += `、未拍 ${pending}`;
    if (second.length) sum += `、二市 ${second.length}`;
    lines.push('', sum);
  }
  return lines.join('\n');
}

async function shareResults() {
  const text = resultText();
  if (navigator.share) {
    try {
      await navigator.share({ text, title: '桃園果菜市場標貨' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  await copyResults(text);
}

async function copyResults(text) {
  const value = text || resultText();
  try {
    await navigator.clipboard.writeText(value);
    toast('已複製清單，可貼到 LINE');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已複製清單，可貼到 LINE');
    } catch {
      toast('複製失敗，請長按選取文字');
    }
    ta.remove();
  }
}

/* ---------- 設定編輯 ---------- */
function setSellerCode(v) {
  const digits = String(v || '').replace(/\D/g, '').slice(0, 4);
  state.sellerCode = digits;
  saveState();
}

function formatRange(m) {
  return (m.ranges || [])
    .filter((r) => r.start != null)
    .map((r) => (r.end != null ? `${r.start}–${r.end}` : `${r.start}起`))
    .join('、') || '尚未設定號碼';
}

/* ---------- Render ---------- */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const active = document.activeElement;
  const focusId = active && active.id;
  const start = active && active.selectionStart;
  const end = active && active.selectionEnd;

  if (isSetupNeeded()) {
    app.innerHTML = renderSetup();
    restoreFocus(focusId, start, end);
    return;
  }

  captureLiveScroll();
  const liveCls = state.tab === 'live' && !showSettings ? ' live-mode' : '';
  const noteCls = state.tab === 'note' && !showSettings ? ' note-mode' : '';
  app.innerHTML =
    renderHeader() +
    `<main class="main${noteCls}${liveCls}" id="main">${renderTab()}</main>` +
    renderNav() +
    (paddleOpen ? renderPaddle() : '') +
    (modal ? renderModal() : '') +
    `<div id="toast" class="toast${toastMsg ? '' : ' hidden'}"></div>`;

  paintToast(document.getElementById('toast'));
  restoreFocus(focusId, start, end);
  restoreLiveScroll();
  if (modal?.type === 'type-item') {
    const input = document.getElementById('type-item-input');
    if (input && document.activeElement !== input) {
      input.focus();
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch { /* ignore */ }
    }
  }
  if (paddleOpen) requestAnimationFrame(fitPaddleDigits);
}

function restoreFocus(focusId, start, end) {
  if (!focusId) return;
  const el = document.getElementById(focusId);
  if (!el || typeof el.focus !== 'function') return;
  el.focus();
  if (start != null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(start, end);
    } catch {
      /* ignore */
    }
  }
}

function renderHeader() {
  const half = state.currentHalf;
  return `
    <header class="header">
      <div class="header-left">
        <div class="header-date">${escapeHtml(formatDateLabel(state.day))}</div>
        <div class="header-sub">桃園果菜市場</div>
      </div>
      <div class="header-right">
        <div class="half-switch" role="tablist">
          <button type="button" data-act="half" data-v="morning" class="${half === 'morning' ? 'on' : ''}">上半場</button>
          <button type="button" data-act="half" data-v="afternoon" class="${half === 'afternoon' ? 'on' : ''}">下半場</button>
        </div>
        <button type="button" class="gear-btn${showSettings ? ' on' : ''}" data-act="settings" aria-label="設定">${showSettings ? '✕' : '⚙'}</button>
      </div>
    </header>`;
}

function renderNav() {
  const tab = showSettings ? '' : state.tab;
  return `
    <nav class="nav">
      <button type="button" class="nav-btn${tab === 'note' ? ' on' : ''}" data-act="tab" data-v="note">
        <span class="ico">✏️</span><span>抄號</span>
      </button>
      <button type="button" class="nav-btn paddle" data-act="paddle">
        <span class="ico">✋</span><span>舉牌</span>
      </button>
      <button type="button" class="nav-btn${tab === 'live' ? ' on' : ''}" data-act="tab" data-v="live">
        <span class="ico">▶</span><span>拍賣中</span>
      </button>
    </nav>`;
}

function renderTab() {
  if (showSettings) return renderSettings();
  if (state.tab === 'live') return renderLive();
  return renderNote();
}

function renderNote() {
  const num = draftNum;
  const parsed = num ? parseInt(num, 10) : null;
  let machineHint = '';
  let chipClass = 'machine-chip';
  if (parsed != null) {
    const hits = machinesMatching(parsed, state.currentHalf);
    if (draftMachineId) {
      machineHint = machineNameOf(draftMachineId, state.currentHalf);
    } else if (hits.length === 1) {
      machineHint = hits[0].name;
    } else if (hits.length > 1) {
      machineHint = '有多台符合，請選台';
      chipClass += ' warn';
    } else {
      const other = state.currentHalf === 'morning' ? 'afternoon' : 'morning';
      const otherHits = machinesMatching(parsed, other);
      if (otherHits.length) {
        machineHint = `像是${halfLabel(other)}，請選台`;
        chipClass += ' warn';
      } else {
        machineHint = '無法判斷，請選台';
        chipClass += ' warn';
      }
    }
  } else {
    machineHint = '輸入後自動判斷台別';
    chipClass += ' warn';
  }

  const recent = recentLots();
  const recentHtml = recent.length
    ? `<div class="recent-row">${recent
        .map(
          (l) => {
            const on = itemTargetId === l.id ? ' on' : '';
            const item = l.item ? `<span class="itm">${escapeHtml(l.item)}</span>` : '';
            return `<button type="button" class="recent-chip${on}" data-act="select-lot" data-id="${escapeHtml(l.id)}">
              <span>${l.number}</span>
              ${item}
              <span class="mch">${escapeHtml(shortMachineName(machineNameOf(l)))}</span>
              <span class="del" data-act="del-lot" data-id="${escapeHtml(l.id)}" aria-label="刪除 ${l.number}">×</span>
            </button>`;
          }
        )
        .join('')}</div>`
    : '';

  const selectedLot = itemTargetId ? state.lots.find((l) => l.id === itemTargetId) : null;
  const activeItem = draftNum ? draftItem : (selectedLot?.item || '');
  const itemHint = draftNum
    ? (draftItem ? `下一筆 ${draftNum} → ${draftItem}` : '可先點品項，再存這號')
    : (selectedLot ? `為 ${selectedLot.number} 選品項` : '存號後點品項，或先點上面的貨號');
  const itemPick = `<div class="item-pick-wrap">
      <div class="item-pick-label">${escapeHtml(itemHint)}</div>
      <div class="item-pick">${allItems(state.currentHalf)
        .map((name) => {
          const on = activeItem === name ? ' on' : '';
          const custom = isCustomItem(name, state.currentHalf) ? ' custom' : '';
          return `<button type="button" class="item-btn${on}${custom}" data-act="pick-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
        })
        .join('')}<button type="button" class="item-btn item-add" data-act="type-item">＋自己輸入</button></div>
    </div>`;

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
  const keypad = keys
    .map((k) => {
      if (k === '⌫') return `<button type="button" class="key muted" data-act="back">⌫</button>`;
      if (k === 'C') return `<button type="button" class="key muted" data-act="clear">清除</button>`;
      return `<button type="button" class="key" data-act="digit" data-v="${k}">${k}</button>`;
    })
    .join('');

  let picker = '';
  if (showMachinePicker || (parsed != null && !detectMachineId(parsed, state.currentHalf))) {
    picker = `<div class="machine-pick">${state.machines[state.currentHalf]
      .map(
        (m) =>
          `<button type="button" class="${draftMachineId === m.id ? 'on' : ''}" data-act="pick-machine" data-id="${m.id}">${escapeHtml(m.name)}</button>`
      )
      .join('')}</div>`;
  }

  const noteBlock = draftShowNote
    ? `<div class="remark"><input id="draft-note" data-act="draft-note" maxlength="40" placeholder="備註（選填）" value="${escapeHtml(draftNote)}" /></div>`
    : '';

  return `
    <div class="note-screen">
      <div class="note-head">
        <div class="num${num ? '' : ' empty'}${dupFlash ? ' dup-flash' : ''}">${num ? escapeHtml(num) : '----'}</div>
        <div class="${chipClass}">${escapeHtml(machineHint)}</div>
      </div>
      ${picker}
      ${recentHtml}
      <div class="note-body">
        <div class="keypad">${keypad}</div>
        ${itemPick}
      </div>
      <div class="save-row">
        <div class="prio-toggle" role="group" aria-label="標貨優先">
          ${['must', 'watch', 'skip'].map((p) => {
            const on = (draftPriority || state.lastPriority || 'watch') === p ? ' on' : '';
            return `<button type="button" class="prio-${p}${on}" data-act="set-draft-prio" data-v="${p}">${p === 'must' ? '必標' : p === 'skip' ? '可不' : '看價'}</button>`;
          }).join('')}
        </div>
        <button type="button" class="btn-save" data-act="save" ${num ? '' : 'disabled'}>存</button>
      </div>
      <div class="note-tools">
        <button type="button" class="linkish" data-act="toggle-note">${draftShowNote ? '收起備註' : '＋備註'}</button>
      </div>
      ${noteBlock}
    </div>`;
}

function refreshNoteHead() {
  if (state.tab !== 'note' || paddleOpen || modal) {
    render();
    return;
  }
  render();
}

function renderLive() {
  const half = state.currentHalf;
  const gapN = state.alertGap || 3;
  const allToday = state.lots.filter((l) => l.day === state.day);
  const second = secondLots();
  let won = 0;
  let lost = 0;
  let mustLeft = 0;
  for (const l of allToday) {
    if (l.status === 'won') won += 1;
    else if (l.status === 'lost') lost += 1;
    if (isUnauctionedMust(l)) mustLeft += 1;
  }

  const cols = state.machines[half]
    .map((m) => {
      const cur = currentOf(m.id);
      const lots = columnLots(m.id, half);
      const upcoming = lots.filter(
        (l) => l.status === 'pending' && !l.secondMarket && (cur == null || l.number >= cur)
      );
      const next = upcoming[0] || null;
      const title = columnTitle(m, half);
      const curLabel = cur == null ? '—' : String(cur);
      const pop = progressPopId === m.id
        ? `<div class="prog-pop" data-stop="1">
            <button type="button" class="step-btn" data-act="bump" data-id="${m.id}" data-d="-1">−</button>
            <span class="prog-val">${curLabel}</span>
            <button type="button" class="step-btn" data-act="bump" data-id="${m.id}" data-d="1">＋</button>
            <button type="button" class="linkish" data-act="edit-cur" data-id="${m.id}">輸入</button>
          </div>`
        : '';
      const cells = lots.length
        ? lots
            .map((l) => {
              const over = isPassed(l, cur) || (l.status === 'pending' && l.secondMarket && cur != null && l.number < cur);
              const isNext = next && l.id === next.id;
              const d = cur != null && l.status === 'pending' && !l.secondMarket ? l.number - cur : null;
              const near = d != null && d >= 0 && d <= gapN;
              const prio = lotPriority(l);
              let cls = `lot-cell prio-${prio}`;
              if (l.status === 'won') cls += ' won';
              else if (l.status === 'lost') cls += ' lost';
              else if (l.status === 'flow') cls += ' flow';
              else if (over) cls += ' passed';
              if (isNext) cls += ' next';
              if (l.status === 'lost') cls += ' strike';
              let badge = '';
              if (near && d === 0) badge = '<span class="cell-badge now">到</span>';
              else if (near && d > 0) badge = `<span class="cell-badge">差${d}</span>`;
              const er = l.secondMarket ? '<span class="er-mark">二</span>' : '';
              const item = l.item
                ? `<span class="cell-item">${escapeHtml(l.item)}</span>`
                : '<span class="cell-item dim"></span>';
              return `<button type="button" class="${cls}" data-act="cycle-lot" data-id="${escapeHtml(l.id)}">
                <span class="prio-hit" data-act="cycle-prio" data-id="${escapeHtml(l.id)}">
                  <span class="prio-bar"></span>
                  <span class="prio-tag">${prioShort(prio)}</span>
                </span>
                <span class="cell-num">${l.number}</span>
                ${item}
                <span class="cell-flags">${badge}${er}</span>
              </button>`;
            })
            .join('')
        : '<div class="col-empty">還沒抄號</div>';
      return `<section class="live-col" data-id="${m.id}">
        <div class="live-col-head">
          <div class="col-name">${escapeHtml(title)}</div>
          <button type="button" class="live-cur" data-act="toggle-progress" data-id="${m.id}">${curLabel}</button>
          ${pop}
        </div>
        <div class="live-col-list" data-id="${m.id}">${cells}</div>
      </section>`;
    })
    .join('');

  const empty = allToday.length === 0
    ? '<div class="live-empty">到「抄號」把紙上的號碼存進來，三台會並排顯示。</div>'
    : '';

  return `
    <div class="live-screen">
      <div class="live-bar">
        <div class="live-counts">
          <span class="must-count${mustLeft ? ' on' : ''}"><b>${mustLeft}</b>必標</span>
          <span><b>${won}</b>標到</span>
          <span><b>${lost}</b>沒標到</span>
          <span><b>${second.length}</b>二市</span>
        </div>
        <button type="button" class="live-sheet-btn" data-act="open-second">清單</button>
      </div>
      <div class="live-cols">${cols || '<div class="empty-hint">請先在設定裡確認三台號碼</div>'}</div>
      ${empty}
    </div>`;
}

function renderSettings() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const install = standalone
    ? ''
    : `<div class="install-hint">${
        ios
          ? 'iPhone：用 Safari 打開，點分享鈕，再選「加入主畫面」。加入後才比較接近全螢幕。'
          : 'Android：用 Chrome 打開右上角選單，選「安裝應用程式」或「加入主畫面」。安裝後舉牌可以用真正的全螢幕，螢幕也不易休眠。'
      }${deferredInstall ? '</div><button type="button" class="btn primary" style="width:100%;margin-top:8px" data-act="install">安裝到桌面</button>' : '</div>'}`;

  const halfBlocks = ['morning', 'afternoon']
    .map((half) => {
      const editors = state.machines[half]
        .map((m, mi) => {
          const ranges = (m.ranges && m.ranges.length ? m.ranges : [{ start: null, end: null }])
            .map((r, ri) => {
              return `<div class="range-line">
                <input id="r-${half}-${m.id}-${ri}-s" inputmode="numeric" pattern="[0-9]*" placeholder="起始" value="${r.start ?? ''}" data-act="range" data-half="${half}" data-id="${m.id}" data-i="${ri}" data-field="start" />
                <span class="dash">—</span>
                <input id="r-${half}-${m.id}-${ri}-e" inputmode="numeric" pattern="[0-9]*" placeholder="結束" value="${r.end ?? ''}" data-act="range" data-half="${half}" data-id="${m.id}" data-i="${ri}" data-field="end" />
                <button type="button" class="linkish" data-act="del-range" data-half="${half}" data-id="${m.id}" data-i="${ri}">刪</button>
              </div>`;
            })
            .join('');
          return `<div class="range-editor">
            <div class="name-row">
              <input id="n-${half}-${m.id}" value="${escapeHtml(m.name)}" data-act="mname" data-half="${half}" data-id="${m.id}" />
            </div>
            ${ranges}
            <button type="button" class="linkish" data-act="add-range" data-half="${half}" data-id="${m.id}">＋ 加一段號碼</button>
          </div>`;
        })
        .join('');
      return `<div class="setting-block"><h2>${halfLabel(half)}　三台號碼</h2>${editors}</div>`;
    })
    .join('');

  return `
    <div class="setting-block">
      <button type="button" class="btn primary" style="width:100%;margin-bottom:14px" data-act="settings">完成設定</button>
      <h2>我的承銷人代號</h2>
      <input id="seller-code" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${escapeHtml(state.sellerCode)}" data-act="seller" placeholder="四位數" />
      <p class="empty-hint" style="text-align:left;padding:8px 0 0">只存在這支手機，給拍賣員看的舉牌號碼。</p>
    </div>
    <div class="setting-block">
      <h2>舉牌顏色</h2>
      <div class="color-pick" style="grid-template-columns:1fr 1fr 1fr">
        <button type="button" class="swatch yellow${state.paddleTheme === 'yellow' ? ' on' : ''}" data-act="theme" data-v="yellow">黃字黑底</button>
        <button type="button" class="swatch white${state.paddleTheme === 'white' ? ' on' : ''}" data-act="theme" data-v="white">白字黑底</button>
        <button type="button" class="swatch yellow${state.paddleTheme === 'black-yellow' ? ' on' : ''}" data-act="theme" data-v="black-yellow" style="background:#ffe500;color:#000">黑字黃底</button>
      </div>
    </div>
    <div class="setting-block">
      <h2>操作</h2>
      <div class="switch-row">
        <div><div class="lbl">四碼自動存</div><div class="sub">貨號滿四碼就立刻存下，接著抄下一號</div></div>
        <button type="button" class="toggle${state.autoSave4 ? ' on' : ''}" data-act="toggle-autosave"><i></i></button>
      </div>
      <div class="switch-row">
        <div><div class="lbl">振動提醒</div><div class="sub">追蹤時還差 ${state.alertGap} 號會振動</div></div>
        <button type="button" class="toggle${state.vibrate ? ' on' : ''}" data-act="toggle-vibrate"><i></i></button>
      </div>
    </div>
    ${halfBlocks}
    ${['morning', 'afternoon'].map((half) => {
      const title = half === 'afternoon' ? '下半場品項（瓜果）' : '上半場品項（大宗、水菜）';
      const built = defaultItems(half).join('、');
      const customs = customItemsOf(half);
      const list = customs.length
        ? customs.map((n) => `<div class="custom-chip">
            <span>${escapeHtml(n)}</span>
            <button type="button" class="linkish" data-act="edit-item" data-name="${escapeHtml(n)}" data-half="${half}">改</button>
            <button type="button" class="linkish" data-act="del-item" data-name="${escapeHtml(n)}" data-half="${half}">刪</button>
          </div>`).join('')
        : '<div class="empty-hint" style="padding:8px 0">還沒有自己輸入的品項</div>';
      return `<div class="setting-block">
        <h2>${title}</h2>
        <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">內建：${escapeHtml(built)}</p>
        <div class="custom-item-row">
          <input id="new-item-${half}" maxlength="12" placeholder="例如：自己常標的菜" data-act="new-item" data-half="${half}" />
          <button type="button" class="btn primary" data-act="add-item" data-half="${half}">新增</button>
        </div>
        <div class="custom-list">${list}</div>
      </div>`;
    }).join('')}
    <div class="setting-block">
      <h2>安裝到手機</h2>
      ${install || '<p class="empty-hint" style="text-align:left;padding:0">已用主畫面開啟。</p>'}
    </div>
    <div class="setting-block">
      <button type="button" class="btn danger" style="width:100%" data-act="new-day">開始新的一天（清空抄號）</button>
    </div>
  `;
}

function renderPaddle() {
  const code = String(state.sellerCode || '----').padStart(4, '0').slice(0, 4);
  const theme = state.paddleTheme || 'yellow';
  const cssLand = window.innerHeight > window.innerWidth + 24;
  return `
    <div id="paddle" class="theme-${theme}${cssLand ? ' css-landscape' : ''}">
      <div id="paddle-stage">
        <div id="paddle-bar">
          <span>承銷人代號</span>
          <button type="button" data-act="cycle-theme">${themeLabel(theme)}</button>
        </div>
        <div id="paddle-box">
          <div id="paddle-code">${escapeHtml(code)}</div>
        </div>
        <div id="paddle-hint">點一下螢幕返回　${themeLabel(theme)}</div>
      </div>
    </div>`;
}

function renderSetup() {
  const code = state.sellerCode || '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
  const keypad = keys
    .map((k) => {
      if (k === '⌫') return `<button type="button" class="key muted" data-act="setup-back">⌫</button>`;
      if (k === 'C') return `<button type="button" class="key muted" data-act="setup-clear">清除</button>`;
      return `<button type="button" class="key" data-act="setup-digit" data-v="${k}">${k}</button>`;
    })
    .join('');
  return `
    <div class="setup">
      <div class="app-brand">桃園果菜市場</div>
      <h1>標貨助手</h1>
      <p class="lead">請輸入我的承銷人代號（四位數）。只存在這支手機，舉牌時會用最大的字顯示給拍賣員看。</p>
      <div class="lot-display">
        <div class="num${code ? '' : ' empty'}">${code ? escapeHtml(code) : '----'}</div>
      </div>
      <div class="keypad">${keypad}</div>
      <button type="button" class="btn-save" data-act="setup-ok" ${/^\d{4}$/.test(code) ? '' : 'disabled'}>開始使用</button>
    </div>`;
}

function renderModal() {
  if (!modal) return '';
  if (modal.type === 'confirm') {
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>${escapeHtml(modal.title)}</h3>
        <p>${escapeHtml(modal.body)}</p>
        <div class="sheet-actions">
          <button type="button" class="btn" data-act="modal-cancel">${escapeHtml(modal.cancel || '取消')}</button>
          <button type="button" class="btn ${modal.danger ? 'danger' : 'primary'}" data-act="modal-ok">${escapeHtml(modal.ok || '確定')}</button>
        </div>
      </div>
    </div>`;
  }
    if (modal.type === 'edit-item') {
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>編輯品項</h3>
        <input id="edit-item-name" maxlength="12" value="${escapeHtml(modal.value || modal.name || '')}" data-act="edit-item-name" />
        <div class="sheet-actions">
          <button type="button" class="btn danger" data-act="del-item-ok">刪除</button>
          <button type="button" class="btn primary" data-act="rename-item-ok">儲存</button>
        </div>
        <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="modal-cancel">取消</button>
      </div>
    </div>`;
  }
  if (modal.type === 'edit-cur' || editCurrent) {
    const ed = editCurrent;
    const m = machineById(ed.machineId);
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
    const keypad = keys
      .map((k) => {
        if (k === '⌫') return `<button type="button" class="key muted" data-act="ec-back">⌫</button>`;
        if (k === 'C') return `<button type="button" class="key muted" data-act="ec-clear">清除</button>`;
        return `<button type="button" class="key" data-act="ec-digit" data-v="${k}">${k}</button>`;
      })
      .join('');
    return `<div class="overlay" data-act="ec-cancel">
      <div class="sheet" data-stop="1">
        <h3>現在打到哪一號？</h3>
        <p>${escapeHtml(m?.name || '')}</p>
        <div class="lot-display"><div class="num${ed.value ? '' : ' empty'}">${ed.value ? escapeHtml(ed.value) : '----'}</div></div>
        <div class="keypad">${keypad}</div>
        <div class="sheet-actions">
          <button type="button" class="btn" data-act="ec-cancel">取消</button>
          <button type="button" class="btn primary" data-act="ec-ok">確定</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'lot-actions') {
    const lot = state.lots.find((l) => l.id === modal.id);
    if (!lot) return '';
    const flowBtn = lot.status === 'flow'
      ? `<button type="button" class="action-btn" data-act="cancel-flow" data-id="${escapeHtml(lot.id)}">取消流標</button>`
      : `<button type="button" class="action-btn flow" data-act="mark-flow" data-id="${escapeHtml(lot.id)}">流標・二市</button>`;
    const secondBtn = lot.status === 'flow'
      ? ''
      : lot.secondMarket
        ? `<button type="button" class="action-btn" data-act="from-second" data-id="${escapeHtml(lot.id)}">移回（取消轉二市）</button>`
        : lot.status === 'won'
          ? ''
          : `<button type="button" class="action-btn" data-act="to-second" data-id="${escapeHtml(lot.id)}">轉二市</button>`;
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet action-sheet" data-stop="1">
        <h3>${escapeHtml(lotLabel(lot))}</h3>
        <p>${escapeHtml(machineNameOf(lot))}</p>
        <div class="prio-toggle sheet-prio" role="group" aria-label="標貨優先">
          ${['must', 'watch', 'skip'].map((p) => {
            const on = lotPriority(lot) === p ? ' on' : '';
            return `<button type="button" class="prio-${p}${on}" data-act="set-prio" data-id="${escapeHtml(lot.id)}" data-v="${p}">${prioLabel(p)}</button>`;
          }).join('')}
        </div>
        ${flowBtn}
        <button type="button" class="action-btn" data-act="go-here" data-id="${escapeHtml(lot.id)}">打到這裡</button>
        ${secondBtn}
        <button type="button" class="action-btn" data-act="pick-lot-item" data-id="${escapeHtml(lot.id)}">改品項</button>
        <button type="button" class="action-btn danger" data-act="del-lot-live" data-id="${escapeHtml(lot.id)}">刪除</button>
        <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="modal-cancel">取消</button>
      </div>
    </div>`;
  }
  if (modal.type === 'pick-item') {
    const lot = state.lots.find((l) => l.id === modal.id);
    const h = modal.half || lot?.half || state.currentHalf;
    const items = allItems(h).map((name) => {
      const on = lot?.item === name ? ' on' : '';
      return `<button type="button" class="item-btn${on}" data-act="lot-item" data-id="${escapeHtml(modal.id)}" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
    }).join('');
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>改品項${lot ? `　${lot.number}` : ''}</h3>
        <div class="item-pick sheet-items">${items}<button type="button" class="item-btn item-add" data-act="type-item" data-id="${escapeHtml(modal.id || '')}" data-half="${h}">＋自己輸入</button></div>
        ${lot?.item ? `<button type="button" class="btn" style="width:100%;margin-top:8px" data-act="clear-lot-item" data-id="${escapeHtml(lot.id)}">清除品項</button>` : ''}
        <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="modal-cancel">取消</button>
      </div>
    </div>`;
  }
  if (modal.type === 'type-item') {
    const h = modal.half || state.currentHalf;
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>自己輸入品項</h3>
        <p>${halfLabel(h)}的快選清單</p>
        <input id="type-item-input" maxlength="12" placeholder="品項名稱" value="${escapeHtml(modal.value || '')}" data-act="type-item-name" autocomplete="off" />
        <div class="sheet-actions">
          <button type="button" class="btn" data-act="modal-cancel">取消</button>
          <button type="button" class="btn primary" data-act="type-item-ok">確定</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'second-sheet') {
    const second = secondLots();
    const allToday = state.lots.filter((l) => l.day === state.day);
    const won = allToday.filter((l) => l.status === 'won').length;
    const lost = allToday.filter((l) => l.status === 'lost').length;
    const list = second.length
      ? second.map((l) => {
          const tag = l.status === 'flow' ? '流標・二市' : (l.status === 'lost' ? '沒標到轉入' : '過號轉入');
          return `<div class="second-item">
            <div>
              <div class="ln">${escapeHtml(lotLabel(l))}</div>
              <div class="meta">${escapeHtml(machineNameOf(l))}　${escapeHtml(tag)}</div>
            </div>
            <button type="button" class="btn-here" data-act="from-second" data-id="${escapeHtml(l.id)}">移回</button>
          </div>`;
        }).join('')
      : '<div class="empty-hint">還沒有轉到二市的貨</div>';
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet second-sheet" data-stop="1">
        <h3>二市與今日摘要</h3>
        <div class="live-counts sheet-counts">
          <span><b>${won}</b>標到</span>
          <span><b>${lost}</b>沒標到</span>
          <span><b>${second.length}</b>二市</span>
        </div>
        <div class="second-list">${list}</div>
        <div class="share-row" style="margin-top:12px">
          <button type="button" class="btn" data-act="copy">複製文字</button>
          <button type="button" class="btn primary" data-act="share">分享</button>
        </div>
        <button type="button" class="btn" style="width:100%;margin-top:8px" data-act="modal-cancel">關閉</button>
      </div>
    </div>`;
  }
  return '';
}

/* ---------- Events ---------- */
function onClick(e) {
  const t = e.target;

  if (paddleOpen) {
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'cycle-theme') {
      e.preventDefault();
      e.stopPropagation();
      cyclePaddleTheme();
      return;
    }
    exitPaddle();
    return;
  }

  const btn = t.closest('[data-act]');
  if (t.closest('[data-stop]') && !btn) {
    e.stopPropagation();
    return;
  }
  if (progressPopId && !t.closest('.prog-pop') && !t.closest('[data-act="toggle-progress"]')) {
    progressPopId = null;
    if (!btn) {
      render();
      return;
    }
  }
  if (!btn) {
    if (t.closest('.overlay') && t.classList.contains('overlay')) {
      if (modal?.onCancel) modal.onCancel();
      else {
        modal = null;
        editCurrent = null;
        render();
      }
    }
    return;
  }

  const act = btn.dataset.act;
  const v = btn.dataset.v;

  switch (act) {
    case 'digit':
      typeDigit(v);
      buzz(8);
      break;
    case 'back':
      backspace();
      break;
    case 'clear':
      clearDraft();
      break;
    case 'save':
      saveLot();
      break;
    case 'pick-machine':
      pickMachineForDraft(btn.dataset.id);
      break;
    case 'del-lot':
      e.stopPropagation();
      deleteLot(btn.dataset.id);
      break;
    case 'select-lot':
      selectRecentForItem(btn.dataset.id);
      break;
    case 'pick-item':
      if (ignoreItemClick) {
        ignoreItemClick = false;
        break;
      }
      assignItem(btn.dataset.name);
      break;
    case 'add-item': {
      const half = btn.dataset.half || state.currentHalf;
      const input = document.getElementById('new-item-' + half) || document.getElementById('new-item');
      if (addCustomItem(input ? input.value : '', half)) {
        if (input) input.value = '';
        render();
      }
      break;
    }
    case 'edit-item':
      openItemEditor(btn.dataset.name, btn.dataset.half || state.currentHalf);
      break;
    case 'del-item':
      deleteCustomItem(btn.dataset.name, btn.dataset.half || state.currentHalf);
      render();
      break;
    case 'del-item-ok':
      if (modal?.name) deleteCustomItem(modal.name, modal.half);
      modal = null;
      render();
      break;
    case 'rename-item-ok': {
      const input = document.getElementById('edit-item-name');
      const next = input ? input.value : modal?.value;
      if (modal?.name && renameCustomItem(modal.name, next, modal.half)) {
        modal = null;
        render();
      }
      break;
    }
    case 'toggle-autosave':
      state.autoSave4 = !state.autoSave4;
      saveState();
      render();
      break;
    case 'toggle-note':
      draftShowNote = !draftShowNote;
      render();
      break;
    case 'tab':
      state.tab = v === 'track' || v === 'result' ? 'live' : v;
      showSettings = false;
      saveState();
      render();
      break;
    case 'settings':
      showSettings = !showSettings;
      render();
      break;
    case 'go-here':
      modal = null;
      goToHere(btn.dataset.id);
      break;
    case 'to-second':
      modal = modal?.type === 'second-sheet' ? modal : null;
      moveToSecond(btn.dataset.id);
      break;
    case 'from-second':
      if (modal?.type === 'lot-actions') modal = null;
      returnFromSecond(btn.dataset.id);
      break;
    case 'cycle-lot':
      if (ignoreLotClick || dragState) {
        ignoreLotClick = false;
        break;
      }
      cycleLotStatus(btn.dataset.id);
      break;
    case 'cycle-prio':
      e.stopPropagation();
      if (ignoreLotClick || dragState) {
        ignoreLotClick = false;
        break;
      }
      cycleLotPriority(btn.dataset.id);
      break;
    case 'set-draft-prio':
      setDraftPriority(v);
      buzz(8);
      break;
    case 'set-prio':
      modal = null;
      setLotPriority(btn.dataset.id, v);
      break;
    case 'undo':
      if (toastAction?.fn) toastAction.fn();
      else undoLast();
      break;
    case 'toggle-progress':
      progressPopId = progressPopId === btn.dataset.id ? null : btn.dataset.id;
      render();
      break;
    case 'mark-flow':
      modal = null;
      markFlow(btn.dataset.id);
      break;
    case 'cancel-flow':
      modal = null;
      cancelFlow(btn.dataset.id);
      break;
    case 'pick-lot-item':
      openPickItemForLot(btn.dataset.id);
      break;
    case 'lot-item': {
      const lot = state.lots.find((l) => l.id === btn.dataset.id);
      modal = null;
      if (lot) applyItemToLot(lot, btn.dataset.name);
      render();
      break;
    }
    case 'type-item':
      openTypeItem(btn.dataset.half || state.currentHalf, btn.dataset.id || null);
      break;
    case 'type-item-ok': {
      const input = document.getElementById('type-item-input');
      const half = modal?.half || state.currentHalf;
      const lotId = modal?.lotId;
      const name = ensureCustomItem(input ? input.value : '', half);
      modal = null;
      if (name) {
        const lot = lotId ? state.lots.find((l) => l.id === lotId) : null;
        if (lot) {
          applyItemToLot(lot, name);
          render();
        } else assignItem(name);
      } else render();
      break;
    }
    case 'clear-lot-item': {
      const lot = state.lots.find((l) => l.id === btn.dataset.id);
      if (lot) {
        lot.item = '';
        saveState();
        toast(`${lot.number} 已清除品項`);
      }
      modal = null;
      render();
      break;
    }
    case 'open-second':
      openSecondSheet();
      break;
    case 'del-lot-live':
      modal = null;
      deleteLot(btn.dataset.id, { undoable: true });
      break;
    case 'toggle-second':
      secondOpen = !secondOpen;
      render();
      break;
    case 'half':
      state.currentHalf = v;
      draftMachineId = '';
      showMachinePicker = false;
      progressPopId = null;
      draftItem = '';
      saveState();
      render();
      break;
    case 'paddle':
      enterPaddle();
      break;
    case 'bump':
      bumpCurrent(btn.dataset.id, Number(btn.dataset.d));
      buzz(8);
      break;
    case 'edit-cur':
      editCurrent = {
        machineId: btn.dataset.id,
        value: currentOf(btn.dataset.id) != null ? String(currentOf(btn.dataset.id)) : ''
      };
      modal = { type: 'edit-cur' };
      render();
      break;
    case 'ec-digit':
      if (editCurrent && editCurrent.value.length < 4) {
        editCurrent.value += v;
        render();
      }
      break;
    case 'ec-back':
      if (editCurrent) {
        editCurrent.value = editCurrent.value.slice(0, -1);
        render();
      }
      break;
    case 'ec-clear':
      if (editCurrent) {
        editCurrent.value = '';
        render();
      }
      break;
    case 'ec-ok':
      if (editCurrent) setCurrent(editCurrent.machineId, editCurrent.value);
      break;
    case 'ec-cancel':
      editCurrent = null;
      modal = null;
      render();
      break;
    case 'status':
      setLotStatus(btn.dataset.id, v);
      buzz(12);
      break;
    case 'filter':
      resultFilter = v;
      render();
      break;
    case 'copy':
      copyResults();
      break;
    case 'share':
      shareResults();
      break;
    case 'theme':
      state.paddleTheme = v;
      saveState();
      render();
      break;
    case 'toggle-vibrate':
      state.vibrate = !state.vibrate;
      saveState();
      render();
      break;
    case 'new-day':
      startNewDay(false);
      break;
    case 'modal-ok':
      if (modal?.onOk) modal.onOk();
      else {
        modal = null;
        render();
      }
      break;
    case 'modal-cancel':
      if (modal?.onCancel) modal.onCancel();
      else {
        modal = null;
        render();
      }
      break;
    case 'setup-digit':
      setSellerCode((state.sellerCode || '') + v);
      render();
      break;
    case 'setup-back':
      setSellerCode(String(state.sellerCode || '').slice(0, -1));
      render();
      break;
    case 'setup-clear':
      setSellerCode('');
      render();
      break;
    case 'setup-ok':
      if (/^\d{4}$/.test(state.sellerCode)) {
        state.setupDone = true;
        saveState();
        render();
      }
      break;
    case 'add-range': {
      const m = machineById(btn.dataset.id, btn.dataset.half);
      if (m) {
        m.ranges = m.ranges || [];
        m.ranges.push({ start: null, end: null });
        saveState();
        render();
      }
      break;
    }
    case 'del-range': {
      const m = machineById(btn.dataset.id, btn.dataset.half);
      if (m && m.ranges) {
        m.ranges.splice(Number(btn.dataset.i), 1);
        if (!m.ranges.length) m.ranges.push({ start: null, end: null });
        saveState();
        render();
      }
      break;
    }
    case 'install':
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall.userChoice.finally(() => {
          deferredInstall = null;
          render();
        });
      }
      break;
    case 'cycle-theme':
      cyclePaddleTheme();
      break;
    default:
      break;
  }
}

function onInput(e) {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'draft-note') {
    draftNote = el.value;
    return;
  }
  if (act === 'new-item' || act === 'edit-item-name' || act === 'type-item-name') {
    if (act === 'edit-item-name' && modal) modal.value = el.value;
    if (act === 'type-item-name' && modal) modal.value = el.value;
    return;
  }
  if (act === 'seller') {
    const digits = el.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== el.value) el.value = digits;
    state.sellerCode = digits;
    saveState();
    return;
  }
  if (act === 'mname') {
    const m = machineById(el.dataset.id, el.dataset.half);
    if (m) {
      m.name = el.value;
      saveState();
    }
    return;
  }
  if (act === 'range') {
    const m = machineById(el.dataset.id, el.dataset.half);
    if (!m) return;
    m.ranges = m.ranges || [];
    const i = Number(el.dataset.i);
    if (!m.ranges[i]) m.ranges[i] = { start: null, end: null };
    const raw = el.value.replace(/\D/g, '');
    if (raw !== el.value) el.value = raw;
    const n = raw === '' ? null : parseInt(raw, 10);
    m.ranges[i][el.dataset.field] = Number.isFinite(n) ? n : null;
    saveState();
  }
}

function onFullscreenChange() {
  if (paddleOpen && !document.fullscreenElement && !document.webkitFullscreenElement) {
    paddleOpen = false;
    unlockOrientation();
    releaseWakeLock();
    render();
  } else if (paddleOpen) {
    requestAnimationFrame(() => {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    });
  }
}

function onVisibility() {
  if (document.visibilityState === 'visible' && paddleOpen) {
    requestWakeLock();
    if (orientationLocked) lockLandscape();
    requestAnimationFrame(() => {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    });
  }
}

function syncViewportHeight() {
  const vv = window.visualViewport;
  const h = Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight);
  if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
}


const ARM_MS = 180;
const MENU_MS = 520;
const DRAG_SLOP = 10;

function clearPressTimers() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  clearTimeout(armTimer);
  armTimer = null;
}

function cleanupDrag() {
  if (dragState?.ghost) dragState.ghost.remove();
  document.querySelectorAll('.lot-cell.dragging, .lot-cell.armed, .live-col.drop-target, .live-col.dragging, .live-col.drop-before, .live-col.drop-after, .live-cols.drop-end').forEach((el) => {
    el.classList.remove('dragging', 'armed', 'drop-target', 'drop-before', 'drop-after', 'drop-end');
  });
  const capEl = dragState?.cell || dragState?.colEl;
  if (capEl && dragState?.pointerId != null) {
    try { capEl.releasePointerCapture(dragState.pointerId); } catch { /* ignore */ }
  }
  dragState = null;
}

function columnAtPoint(x, y) {
  const stack = document.elementsFromPoint(x, y) || [];
  const col = stack.find((el) => el.classList && el.classList.contains('live-col'));
  return col || null;
}

function startLotDrag(e, cell, id) {
  if (dragState) return;
  clearPressTimers();
  ignoreLotClick = true;
  const rect = cell.getBoundingClientRect();
  const ghost = cell.cloneNode(true);
  ghost.classList.add('lot-ghost');
  ghost.classList.remove('armed');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.position = 'fixed';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.margin = '0';
  ghost.style.zIndex = '2000';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  cell.classList.add('dragging');
  cell.classList.remove('armed');
  dragState = {
    kind: 'lot',
    id,
    cell,
    ghost,
    pointerId: e.pointerId,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top
  };
  try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  buzz(14);
  moveLotDrag(e);
}

function moveLotDrag(e) {
  if (!dragState) return;
  if (e.cancelable) e.preventDefault();
  const g = dragState.ghost;
  if (g) {
    g.style.left = e.clientX - dragState.grabX + 'px';
    g.style.top = e.clientY - dragState.grabY + 'px';
  }
  const col = columnAtPoint(e.clientX, e.clientY);
  document.querySelectorAll('.live-col.drop-target').forEach((el) => {
    if (el !== col) el.classList.remove('drop-target');
  });
  if (col) col.classList.add('drop-target');
}

function endLotDrag(e) {
  if (!dragState) return;
  const id = dragState.id;
  const col = columnAtPoint(e.clientX, e.clientY);
  const machineId = col?.querySelector('.live-col-list')?.dataset.id;
  cleanupDrag();
  if (machineId) moveLotToMachine(id, machineId);
  else render();
}

function startColDrag(e, col, id) {
  if (dragState) return;
  clearPressTimers();
  const rect = col.getBoundingClientRect();
  const head = col.querySelector('.live-col-head');
  const ghost = (head || col).cloneNode(true);
  ghost.querySelectorAll('.prog-pop').forEach((el) => el.remove());
  ghost.className = 'col-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.position = 'fixed';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = (head ? head.getBoundingClientRect().height : 36) + 'px';
  ghost.style.margin = '0';
  ghost.style.zIndex = '2000';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  col.classList.add('dragging');
  dragState = {
    kind: 'col',
    id,
    colEl: col,
    ghost,
    pointerId: e.pointerId,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top
  };
  try { col.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  buzz(14);
  moveColDrag(e);
}

function paintColDrop(insertAt) {
  const cols = [...document.querySelectorAll('.live-col')];
  const wrap = document.querySelector('.live-cols');
  cols.forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  if (wrap) wrap.classList.remove('drop-end');
  if (insertAt >= cols.length) {
    if (wrap) wrap.classList.add('drop-end');
    if (cols.length) cols[cols.length - 1].classList.add('drop-after');
  } else if (cols[insertAt]) {
    cols[insertAt].classList.add('drop-before');
  }
}

function moveColDrag(e) {
  if (!dragState) return;
  if (e.cancelable) e.preventDefault();
  const g = dragState.ghost;
  if (g) {
    g.style.left = e.clientX - dragState.grabX + 'px';
    g.style.top = e.clientY - dragState.grabY + 'px';
  }
  paintColDrop(columnInsertIndex(e.clientX));
}

function endColDrag(e) {
  if (!dragState) return;
  const id = dragState.id;
  const insertAt = columnInsertIndex(e.clientX);
  cleanupDrag();
  const half = state.currentHalf;
  if (reorderMachine(half, id, insertAt)) {
    saveState();
    buzz([16, 40, 24]);
    toast('已調整台的順序');
  }
  render();
}

function onPointerDown(e) {
  clearPressTimers();
  if (dragState) cleanupDrag();
  pressOrigin = { x: e.clientX, y: e.clientY };
  const itemBtn = e.target.closest('[data-act="pick-item"]');
  const cell = e.target.closest('[data-act="cycle-lot"]');
  const colHead = e.target.closest('.live-col-head');
  if (itemBtn) {
    const name = itemBtn.dataset.name;
    const half = state.currentHalf;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      ignoreItemClick = true;
      openItemEditor(name, half);
    }, 520);
    return;
  }
  if (colHead && state.tab === 'live' && !showSettings && !modal && !e.target.closest('button, .prog-pop, input')) {
    const col = colHead.closest('.live-col');
    const id = col?.dataset.id;
    if (col && id) {
      pressOrigin.colEl = col;
      pressOrigin.colId = id;
    }
    return;
  }
  if (cell && state.tab === 'live' && !showSettings && !modal) {
    const id = cell.dataset.id;
    pressOrigin.cell = cell;
    pressOrigin.id = id;
    pressOrigin.armed = false;
    armTimer = setTimeout(() => {
      armTimer = null;
      if (!pressOrigin || pressOrigin.id !== id || !cell.isConnected || dragState) return;
      pressOrigin.armed = true;
      cell.classList.add('armed');
      buzz(8);
    }, ARM_MS);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      clearTimeout(armTimer);
      armTimer = null;
      if (dragState) return;
      cell.classList.remove('armed');
      ignoreLotClick = true;
      pressOrigin = null;
      openLotActions(id);
    }, MENU_MS);
  }
}

function onPointerMove(e) {
  if (dragState) {
    if (dragState.kind === 'col') moveColDrag(e);
    else moveLotDrag(e);
    return;
  }
  if (!pressOrigin) return;
  const dx = e.clientX - pressOrigin.x;
  const dy = e.clientY - pressOrigin.y;
  const dist2 = dx * dx + dy * dy;
  if (pressOrigin.colEl && pressOrigin.colId) {
    if (dist2 > DRAG_SLOP * DRAG_SLOP && pressOrigin.colEl.isConnected) {
      startColDrag(e, pressOrigin.colEl, pressOrigin.colId);
    }
    return;
  }
  if (pressOrigin.cell && pressOrigin.id) {
    // After a short hold, any movement starts a drag. Before that, cancel and let the column scroll.
    if (dist2 > DRAG_SLOP * DRAG_SLOP) {
      if (pressOrigin.armed && pressOrigin.cell.isConnected) {
        startLotDrag(e, pressOrigin.cell, pressOrigin.id);
        return;
      }
      pressOrigin.cell.classList.remove('armed');
      clearPressTimers();
      pressOrigin = { x: pressOrigin.x, y: pressOrigin.y };
      return;
    }
    return;
  }
  if (!longPressTimer) return;
  if (dist2 > 64) clearPressTimers();
}

function onPointerUp(e) {
  if (dragState) {
    if (dragState.kind === 'col') endColDrag(e);
    else endLotDrag(e);
    pressOrigin = null;
    return;
  }
  if (pressOrigin?.cell) pressOrigin.cell.classList.remove('armed');
  clearPressTimers();
  pressOrigin = null;
}

function bind() {
  syncViewportHeight();
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 200));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => {
    if (paddleOpen) {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    }
  });
  window.addEventListener('orientationchange', () => {
    if (paddleOpen) {
      setTimeout(() => {
        applyCssLandscapeIfNeeded();
        fitPaddleDigits();
      }, 250);
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.key, #paddle, .nav, .btn-save, .mini-paddle, .step-btn, .item-btn, .recent-chip, .lot-cell, .live-col-head')) {
      e.preventDefault();
    }
  });
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const act = e.target?.dataset?.act;
    const id = e.target?.id || '';
    if (act === 'type-item-name' || id === 'type-item-input') {
      e.preventDefault();
      const half = modal?.half || state.currentHalf;
      const name = ensureCustomItem(e.target.value, half);
      modal = null;
      if (name) assignItem(name);
      else render();
      return;
    }
    if (act === 'new-item' || id.startsWith('new-item')) {
      e.preventDefault();
      const half = e.target.dataset.half || state.currentHalf;
      if (addCustomItem(e.target.value, half)) {
        e.target.value = '';
        render();
      }
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function init() {
  state = loadState();
  draftPriority = state.lastPriority || 'watch';
  checkNewDay();
  bind();
  registerSW();
  render();
}

init();
