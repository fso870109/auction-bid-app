'use strict';

const STORAGE_KEY = 'ty-auction-bid-v1';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const DEFAULT_ITEMS = [
  '高麗菜', '小白菜', '青江菜', '菠菜', '空心菜', '地瓜葉', '大白菜',
  '花椰菜', '青花菜', '蔥', '蒜', '薑', '胡蘿蔔', '白蘿蔔',
  '小黃瓜', '大黃瓜', '絲瓜', '苦瓜', '南瓜', '冬瓜', '茄子', '番茄', '青椒'
];

const DEFAULT_MACHINES = {
  morning: [
    { id: 'm1', name: '第一台・大宗', ranges: [{ start: 1001, end: 1999 }] },
    { id: 'm2', name: '第二台・水菜', ranges: [{ start: 3001, end: 3999 }] },
    { id: 'm3', name: '第三台', ranges: [{ start: null, end: null }] }
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
    itemCounts: {}
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
  return null;
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

function allItems() {
  const seen = new Set();
  const list = [];
  for (const name of [...(state.customItems || []), ...DEFAULT_ITEMS]) {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    list.push(n);
  }
  const counts = state.itemCounts || {};
  list.sort((a, b) => {
    const dc = (counts[b] || 0) - (counts[a] || 0);
    if (dc) return dc;
    const ac = (state.customItems || []).includes(a);
    const bc = (state.customItems || []).includes(b);
    if (ac !== bc) return ac ? -1 : 1;
    return 0;
  });
  return list;
}

function isCustomItem(name) {
  return (state.customItems || []).includes(name);
}

function bumpItemUse(name) {
  if (!name) return;
  if (!state.itemCounts) state.itemCounts = {};
  state.itemCounts[name] = (state.itemCounts[name] || 0) + 1;
}

function applyItemToLot(lot, name) {
  if (!lot) return;
  lot.item = name;
  bumpItemUse(name);
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

function addCustomItem(name) {
  name = String(name || '').trim();
  if (!name) {
    toast('請輸入品項名稱');
    return false;
  }
  if (DEFAULT_ITEMS.includes(name) || (state.customItems || []).includes(name)) {
    toast('這個品項已經有了');
    return false;
  }
  state.customItems = state.customItems || [];
  state.customItems.push(name);
  saveState();
  toast(`已新增「${name}」`);
  return true;
}

function renameCustomItem(oldName, newName) {
  newName = String(newName || '').trim();
  if (!newName) return false;
  const i = (state.customItems || []).indexOf(oldName);
  if (i < 0) return false;
  if (newName !== oldName && (DEFAULT_ITEMS.includes(newName) || state.customItems.includes(newName))) {
    toast('這個品項已經有了');
    return false;
  }
  state.customItems[i] = newName;
  if (state.itemCounts && state.itemCounts[oldName] != null) {
    state.itemCounts[newName] = (state.itemCounts[newName] || 0) + state.itemCounts[oldName];
    delete state.itemCounts[oldName];
  }
  for (const lot of state.lots) {
    if (lot.item === oldName) lot.item = newName;
  }
  if (draftItem === oldName) draftItem = newName;
  saveState();
  toast(`已改成「${newName}」`);
  return true;
}

function deleteCustomItem(name) {
  state.customItems = (state.customItems || []).filter((n) => n !== name);
  saveState();
  toast(`已刪「${name}」`);
}

function openItemEditor(name) {
  if (!isCustomItem(name)) {
    toast('內建品項不能改，可在設定新增自己的');
    return;
  }
  modal = { type: 'edit-item', name, value: name };
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

function toast(msg, ms) {
  toastMsg = msg;
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    render();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg = '';
    const t = document.getElementById('toast');
    if (t) t.classList.add('hidden');
  }, ms || 1600);
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

function deleteLot(id) {
  const lot = state.lots.find((l) => l.id === id);
  state.lots = state.lots.filter((l) => l.id !== id);
  saveState();
  toast(lot ? `已刪 ${lot.number}` : '已刪除');
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
  lot.secondMarket = true;
  secondOpen = true;
  saveState();
  toast(`${lotLabel(lot)} 已轉二市`);
  render();
}

function returnFromSecond(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  lot.secondMarket = false;
  saveState();
  toast(`${lotLabel(lot)} 已移回`);
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
  for (const half of ['morning', 'afternoon']) {
    const lots = todayLots(half).filter((l) => !l.secondMarket);
    if (!lots.length) continue;
    lines.push('', halfLabel(half));
    for (const m of state.machines[half]) {
      const group = lots.filter((l) => l.machineId === m.id);
      if (!group.length) continue;
      const cur = currentOf(m.id, half);
      const w = group.filter((l) => l.status === 'won');
      const x = group.filter((l) => l.status === 'lost');
      const over = group.filter((l) => isPassed(l, cur));
      const p = group.filter((l) => l.status === 'pending' && !isPassed(l, cur));
      won += w.length;
      lost += x.length;
      passed += over.length;
      pending += p.length;
      lines.push(m.name);
      if (w.length) lines.push(`  標到：${w.map(lotLabel).join('、')}（${w.length}）`);
      if (x.length) lines.push(`  沒標到：${x.map(lotLabel).join('、')}（${x.length}）`);
      if (over.length) lines.push(`  過號：${over.map(lotLabel).join('、')}（${over.length}）`);
      if (p.length) lines.push(`  未拍：${p.map(lotLabel).join('、')}（${p.length}）`);
    }
  }
  const second = secondLots();
  if (second.length) {
    lines.push('', `二市（${second.length}）`);
    for (const l of second) {
      lines.push(`  ${lotLabel(l)}　${machineNameOf(l)}`);
    }
  }
  if (won + lost + pending + passed + second.length === 0) lines.push('', '今天還沒有抄號。');
  else {
    let sum = `合計 標到 ${won}、沒標到 ${lost}`;
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

  app.innerHTML =
    renderHeader() +
    `<main class="main${state.tab === 'note' && !showSettings ? ' note-mode' : ''}" id="main">${renderTab()}</main>` +
    renderNav() +
    (paddleOpen ? renderPaddle() : '') +
    (modal ? renderModal() : '') +
    `<div id="toast" class="toast${toastMsg ? '' : ' hidden'}">${escapeHtml(toastMsg)}</div>`;

  restoreFocus(focusId, start, end);
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
      <div class="item-pick">${allItems()
        .map((name) => {
          const on = activeItem === name ? ' on' : '';
          const custom = isCustomItem(name) ? ' custom' : '';
          return `<button type="button" class="item-btn${on}${custom}" data-act="pick-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
        })
        .join('')}</div>
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
      <button type="button" class="btn-save" data-act="save" ${num ? '' : 'disabled'}>存</button>
      <div class="note-tools">
        <button type="button" class="auto" data-act="toggle-autosave">
          <span class="toggle${state.autoSave4 ? ' on' : ''}"><i></i></span>
          四碼自動存
        </button>
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
  let pending = 0;
  let passed = 0;
  for (const l of allToday) {
    if (l.secondMarket) continue;
    if (l.status === 'won') won += 1;
    else if (l.status === 'lost') lost += 1;
    else if (isPassed(l, currentOf(l.machineId, l.half))) passed += 1;
    else pending += 1;
  }

  const cards = state.machines[half]
    .map((m) => {
      const cur = currentOf(m.id);
      const lots = lotsForMachine(m.id, half);
      const upcoming = lots.filter((l) => l.status === 'pending' && (cur == null || l.number >= cur));
      const next = upcoming.slice().sort((a, b) => a.number - b.number)[0];
      const dist = next && cur != null ? next.number - cur : null;
      const isNow = dist === 0;
      const isNear = dist != null && dist > 0 && dist <= gapN;
      const cardClass = isNow ? 'machine-card now' : isNear ? 'machine-card alert' : 'machine-card';

      const rank = (l) => {
        if (l.status === 'pending' && !isPassed(l, cur)) return 0;
        if (l.status === 'won' || l.status === 'lost') return 1;
        return 2;
      };
      const sorted = lots.slice().sort((a, b) => rank(a) - rank(b) || a.number - b.number);

      const list = sorted.length
        ? sorted
            .map((l) => {
              const over = isPassed(l, cur);
              const isNext = next && l.id === next.id;
              const now = isNext && isNow;
              let cls = 'lot-item';
              if (now) cls += ' now';
              else if (isNext) cls += ' next';
              if (over) cls += ' passed';
              const d = cur != null ? l.number - cur : null;
              let gap = '';
              if (l.status === 'won') gap = '<span class="status-pill won">標到</span>';
              else if (l.status === 'lost') gap = '<span class="status-pill lost">沒標到</span>';
              else if (over) gap = '<span class="status-pill pending">過號</span>';
              else if (d === 0) gap = '<span class="gap-tag now">就是這號！</span>';
              else if (d != null && d > 0) gap = `<span class="gap-tag">還差 ${d} 號</span>`;
              const bits = [l.item, l.note].filter(Boolean).map(escapeHtml);
              const meta = bits.length ? bits.join('　') : '';
              const canSecond = over || l.status === 'lost';
              return `<div class="${cls}">
                <div class="lot-top">
                  <div>
                    <div class="ln">${l.number}${gap}</div>
                    <div class="meta">${meta || '&nbsp;'}</div>
                  </div>
                </div>
                <div class="result-actions">
                  <button type="button" class="btn-won${l.status === 'won' ? ' on' : ''}" data-act="status" data-id="${escapeHtml(l.id)}" data-v="won">標到</button>
                  <button type="button" class="btn-lost${l.status === 'lost' ? ' on' : ''}" data-act="status" data-id="${escapeHtml(l.id)}" data-v="lost">沒標到</button>
                </div>
                <div class="lot-more">
                  <button type="button" class="btn-here" data-act="go-here" data-id="${escapeHtml(l.id)}">打到這裡</button>
                  ${canSecond ? `<button type="button" class="btn-second" data-act="to-second" data-id="${escapeHtml(l.id)}">轉二市</button>` : ''}
                </div>
              </div>`;
            })
            .join('')
        : `<div class="empty-hint">這台還沒有抄號</div>`;

      const curLabel = cur == null ? '尚未開始' : String(cur);
      return `<section class="${cardClass}">
        <div class="title">
          <span>${escapeHtml(m.name)}</span>
          <span class="ranges">${escapeHtml(formatRange(m))}</span>
        </div>
        <div class="cur-row mini">
          <button type="button" class="step-btn" data-act="bump" data-id="${m.id}" data-d="-1">−</button>
          <button type="button" class="cur-num" data-act="edit-cur" data-id="${m.id}">${curLabel}</button>
          <button type="button" class="step-btn" data-act="bump" data-id="${m.id}" data-d="1">＋</button>
        </div>
        <div class="lot-list">${list}</div>
      </section>`;
    })
    .join('');

  const secondList = second.length
    ? second
        .map((l) => `<div class="second-item">
          <div>
            <div class="ln">${escapeHtml(lotLabel(l))}</div>
            <div class="meta">${escapeHtml(machineNameOf(l))}${l.half ? '　' + halfLabel(l.half) : ''}</div>
          </div>
          <button type="button" class="btn-here" data-act="from-second" data-id="${escapeHtml(l.id)}">移回</button>
        </div>`)
        .join('')
    : '<div class="empty-hint">還沒有轉到二市的貨</div>';

  const hasLots = allToday.length > 0;
  return `
    ${cards || '<div class="empty-hint">請先在設定裡確認三台號碼</div>'}
    ${hasLots ? `<div class="summary">
      <div class="h-label">今日統計（上、下半場合計）</div>
      <div class="totals">
        <div class="tot"><b>${won}</b><span>標到</span></div>
        <div class="tot"><b>${lost}</b><span>沒標到</span></div>
        <div class="tot"><b>${passed}</b><span>過號</span></div>
        <div class="tot"><b>${pending}</b><span>未拍</span></div>
      </div>
      <div class="share-row">
        <button type="button" class="btn" data-act="copy">複製文字</button>
        <button type="button" class="btn primary" data-act="share">分享</button>
      </div>
    </div>` : '<div class="empty-hint">到「抄號」輸入貨號後，來這裡點標到或沒標到。</div>'}
    <section class="second-section">
      <button type="button" class="second-toggle" data-act="toggle-second">
        <span>二市${second.length ? `（${second.length}）` : ''}</span>
        <span class="muted">${secondOpen ? '收合' : '展開'}</span>
      </button>
      ${secondOpen ? secondList : ''}
    </section>
  `;
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
    <div class="setting-block">
      <h2>自訂品項</h2>
      <p class="empty-hint" style="text-align:left;padding:0 0 8px">加在快選列前面。長按快選鈕也可改名或刪除。</p>
      <div class="custom-item-row">
        <input id="new-item" maxlength="12" placeholder="例如：玉米筍" data-act="new-item" />
        <button type="button" class="btn primary" data-act="add-item">新增</button>
      </div>
      <div class="custom-list">${
        (state.customItems || []).length
          ? state.customItems
              .map(
                (n) => `<div class="custom-chip">
                  <span>${escapeHtml(n)}</span>
                  <button type="button" class="linkish" data-act="edit-item" data-name="${escapeHtml(n)}">改</button>
                  <button type="button" class="linkish" data-act="del-item" data-name="${escapeHtml(n)}">刪</button>
                </div>`
              )
              .join('')
          : '<div class="empty-hint" style="padding:8px 0">還沒有自訂品項</div>'
      }</div>
    </div>
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
      const input = document.getElementById('new-item');
      if (addCustomItem(input ? input.value : '')) {
        if (input) input.value = '';
        render();
      }
      break;
    }
    case 'edit-item':
      openItemEditor(btn.dataset.name);
      break;
    case 'del-item':
      deleteCustomItem(btn.dataset.name);
      render();
      break;
    case 'del-item-ok':
      if (modal?.name) deleteCustomItem(modal.name);
      modal = null;
      render();
      break;
    case 'rename-item-ok': {
      const input = document.getElementById('edit-item-name');
      const next = input ? input.value : modal?.value;
      if (modal?.name && renameCustomItem(modal.name, next)) {
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
      goToHere(btn.dataset.id);
      break;
    case 'to-second':
      moveToSecond(btn.dataset.id);
      break;
    case 'from-second':
      returnFromSecond(btn.dataset.id);
      break;
    case 'toggle-second':
      secondOpen = !secondOpen;
      render();
      break;
    case 'half':
      state.currentHalf = v;
      draftMachineId = '';
      showMachinePicker = false;
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
  if (act === 'new-item' || act === 'edit-item-name') {
    if (act === 'edit-item-name' && modal) modal.value = el.value;
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

function bind() {
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
    if (e.target.closest('.key, #paddle, .nav, .btn-save, .mini-paddle, .step-btn, .item-btn, .recent-chip')) {
      e.preventDefault();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-act="pick-item"]');
    if (!btn) return;
    clearTimeout(longPressTimer);
    const name = btn.dataset.name;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      ignoreItemClick = true;
      openItemEditor(name);
    }, 520);
  });
  document.addEventListener('pointerup', () => clearTimeout(longPressTimer));
  document.addEventListener('pointercancel', () => clearTimeout(longPressTimer));
  document.addEventListener('pointermove', (e) => {
    if (!longPressTimer) return;
    // cancel if finger drifts
    if (e.movementX * e.movementX + e.movementY * e.movementY > 64) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target?.dataset?.act === 'new-item' || e.target?.id === 'new-item')) {
      e.preventDefault();
      if (addCustomItem(e.target.value)) {
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
  checkNewDay();
  bind();
  registerSW();
  render();
}

init();
