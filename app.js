'use strict';

const STORAGE_KEY = 'ty-auction-bid-v1';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const HALVES = ['fruit', 'morning', 'afternoon'];
const HALF_LABELS = { fruit: '水果場', morning: '上半場', afternoon: '下半場' };
const SESSION_MACHINE_MAX = { fruit: 2, morning: 3, afternoon: 3 };
const GROUP_RANK = {
  fruit: { '水果': 0 },
  morning: { '大宗': 0, '水菜': 1 },
  afternoon: { '瓜果': 0, '醃製': 1 }
};
/* Official items below this 桃農 12-month volume (kg) are hidden from the
   default item grid. Search, custom items, and previously used items stay. */
const VOLUME_GRID_MIN = 500;
const ITEM_SIZES = ['大', '中', '小'];
const MUSHROOM_CROPS = ['金絲菇', '杏鮑菇', '其他菇類', '鴻喜菇', '濕木耳', '濕香菇', '洋菇', '秀珍菇', '草菇', '珊瑚菇', '蠔菇', '巴西蘑菇', '松茸', '柳松菇', '猴頭菇'];
const GOURD_FROM_BULK_CROPS = ['芋', '大蒜', '青花苔', '薑', '甘藷', '馬鈴薯', '薯蕷', '豆薯', '菊芋'];
const GOURD_FROM_BULK_V21_CROPS = ['花椰菜', '球莖甘藍', '竹筍', '萵苣莖', '蓮藕', '蘆筍', '牛蒡'];
let itemQuery = '';
let variantPick = null; // crop official name when variant sheet is open
let itemPickScroll = 0;
let resetItemPickScroll = false;

function catalogHalfKey(half) {
  if (half === 'afternoon') return 'a';
  if (half === 'fruit') return 'f';
  return 'm';
}

function isHalf(half) {
  return HALVES.includes(half);
}

function catalogCrops(half) {
  const key = catalogHalfKey(half);
  return (typeof ITEM_CATALOG !== 'undefined' ? ITEM_CATALOG : []).filter((c) => c.h === key);
}

function catalogNameSet(half) {
  const set = new Set();
  for (const c of catalogCrops(half)) {
    set.add(c.n);
    set.add(c.l);
    for (const a of c.a || []) set.add(a);
    for (const v of c.s || []) {
      set.add(v.n);
      set.add(v.l);
      for (const a of v.a || []) set.add(a);
    }
  }
  return set;
}

function findCrop(name, half) {
  if (!name) return null;
  const pools = half ? catalogCrops(half) : (typeof ITEM_CATALOG !== 'undefined' ? ITEM_CATALOG : []);
  const exacts = pools.filter((c) => c.n === name || c.l === name);
  if (exacts.length) {
    exacts.sort((a, b) => (b.v || 0) - (a.v || 0));
    return exacts[0];
  }
  for (const c of pools) {
    if ((c.a || []).includes(name)) return c;
    if (name.startsWith(c.n + '-')) return c;
    for (const v of c.s || []) {
      if (v.n === name || v.l === name || (v.a || []).includes(name)) return c;
    }
  }
  return null;
}

function itemDisplayName(name) {
  if (!name) return '';
  const crop = findCrop(name);
  if (!crop) return name;
  const v = (crop.s || []).find((x) => x.n === name || x.l === name || (x.a || []).includes(name));
  if (!v || v.n === crop.n || v.l === crop.l || v.l === '其他') return crop.l;
  return crop.l + ' ' + v.l;
}

function itemCellName(name) {
  if (!name) return '';
  const crop = findCrop(name);
  if (!crop) return name;
  const v = (crop.s || []).find((x) => x.n === name || x.l === name || (x.a || []).includes(name));
  if (v && v.l && v.l !== '其他' && v.n !== crop.n && v.l !== crop.l) return v.l;
  return crop.l;
}

function itemIsActive(crop, stored) {
  if (!stored) return false;
  if (stored === crop.l || stored === crop.n || (crop.a || []).includes(stored)) return true;
  if (typeof stored === 'string' && stored.startsWith(crop.n + '-')) return true;
  return (crop.s || []).some((v) => v.n === stored || v.l === stored || (v.a || []).includes(stored));
}

function cropMatchesQuery(crop, q) {
  q = String(q || '').trim();
  if (!q) return true;
  const fields = [crop.n, crop.l, ...(crop.a || [])];
  for (const v of crop.s || []) {
    fields.push(v.n, v.l, ...(v.a || []));
  }
  if (q.length >= 2) return fields.some((f) => f && String(f).includes(q));
  return fields.some((f) => f === q || (f && String(f).startsWith(q)));
}

function dedupeCrops(list) {
  const best = new Map();
  for (const c of list) {
    const key = c.n || c.l;
    const prev = best.get(key);
    if (!prev || (c.v || 0) > (prev.v || 0)) best.set(key, c);
  }
  return [...best.values()];
}

function cropShownOnGrid(crop, counts) {
  if ((crop.v || 0) >= VOLUME_GRID_MIN) return true;
  const used = (counts && (counts[crop.l] || counts[crop.n])) || 0;
  return used > 0;
}

function itemNeedsSize(name) {
  if (!name) return false;
  const crop = findCrop(name);
  if (crop) return crop.n === '番茄' || crop.n === '小番茄';
  return String(name).includes('番茄');
}

function sizeLabel(size) {
  return ITEM_SIZES.includes(size) ? size : '';
}

function visibleCrops(half, q) {
  const h = half || (state && state.currentHalf) || 'morning';
  const counts = itemCountsOf(h);
  const prefer = itemPreferGroup(h);
  const ranks = Object.assign({}, GROUP_RANK[h] || GROUP_RANK.morning);
  if (prefer === 'leafy') {
    ranks['水菜'] = 0;
    ranks['大宗'] = 1;
  }
  let list = dedupeCrops(catalogCrops(h).filter((c) => cropMatchesQuery(c, q)));
  if (!String(q || '').trim()) {
    list = list.filter((c) => cropShownOnGrid(c, counts));
  }
  list.sort((a, b) => {
    const ga = ranks[a.g] ?? 9;
    const gb = ranks[b.g] ?? 9;
    if (ga !== gb) return ga - gb;
    const za = a.v > 0 ? 0 : 1;
    const zb = b.v > 0 ? 0 : 1;
    if (za !== zb) return za - zb;
    if (b.v !== a.v) return b.v - a.v;
    const ca = counts[a.l] || counts[a.n] || 0;
    const cb = counts[b.l] || counts[b.n] || 0;
    if (cb !== ca) return cb - ca;
    return String(a.l).localeCompare(String(b.l), 'zh-Hant');
  });
  return list;
}

function halfFromCatalogKey(k) {
  if (k === 'a') return 'afternoon';
  if (k === 'f') return 'fruit';
  return 'morning';
}

function catalogCounts() {
  const tally = { fruit: {}, morning: {}, afternoon: {} };
  for (const c of (typeof ITEM_CATALOG !== 'undefined' ? ITEM_CATALOG : [])) {
    const half = halfFromCatalogKey(c.h);
    tally[half][c.g] = (tally[half][c.g] || 0) + 1;
  }
  return tally;
}

function catalogSummary(half) {
  const counts = itemCountsOf(half);
  const crops = dedupeCrops(catalogCrops(half));
  const groups = half === 'fruit' ? ['水果']
    : half === 'afternoon' ? ['瓜果', '醃製']
    : ['大宗', '水菜'];
  const shown = crops.filter((c) => cropShownOnGrid(c, counts));
  const hidden = crops.length - shown.length;
  const tally = {};
  for (const c of shown) tally[c.g] = (tally[c.g] || 0) + 1;
  const parts = groups.map((g) => `${g} ${tally[g] || 0}`);
  const hideHint = hidden
    ? `，另有 ${hidden} 項冷門品項已從按鈕拿掉，可搜尋`
    : '';
  return `按鈕顯示 ${parts.join('、')}，共 ${shown.length} 項${hideHint}。依桃農近一年交易量排序（不到 ${VOLUME_GRID_MIN} 公斤的不出現在選單）。品種只列出交易量大的分支，其餘可搜尋。`;
}

function variantCount(crop) {
  return (crop.s || []).length;
}

function usefulVariant(v, crop) {
  return !!(v && !v.imp && v.l !== '其他' && v.n !== crop.n && v.l !== crop.l);
}

/* Keep only high-volume branches (桃農 AMIS). Low-volume ones stay searchable. */
function significantVariants(crop) {
  const useful = (crop.s || []).filter((v) => usefulVariant(v, crop));
  const maxV = useful.reduce((m, v) => Math.max(m, Number(v.v) || 0), 0);
  const cropV = Number(crop.v) || 0;
  return useful.filter((v) => {
    const vv = Number(v.v) || 0;
    if (vv < VOLUME_GRID_MIN) return false;
    if (vv >= 20000) return true;
    if (maxV > 0 && vv >= maxV * 0.1 && vv >= 5000) return true;
    if (cropV > 0 && vv >= cropV * 0.1) return true;
    return false;
  });
}

function variantMatchesQuery(v, q) {
  q = String(q || '').trim();
  if (!q) return false;
  const fields = [v.n, v.l, ...(v.a || [])];
  if (q.length >= 2) return fields.some((f) => f && String(f).includes(q));
  return fields.some((f) => f === q || (f && String(f).startsWith(q)));
}

function pickerVariants(crop, q) {
  const sig = significantVariants(crop);
  q = String(q || '').trim();
  if (!q) return sig;
  const extra = (crop.s || []).filter((v) => usefulVariant(v, crop) && variantMatchesQuery(v, q));
  const seen = new Set(sig.map((v) => v.n));
  const out = sig.slice();
  for (const v of extra) {
    if (!seen.has(v.n)) out.push(v);
  }
  return out;
}

function shouldOpenVariants(crop, q) {
  return pickerVariants(crop, q).length > 1;
}

function renderItemPicker(half, opts) {
  opts = opts || {};
  const h = half || state.currentHalf;
  const active = opts.active || '';
  const lotId = opts.lotId || '';
  const inSheet = !!opts.inSheet;
  const searchId = inSheet ? 'sheet-item-search' : 'item-search';
  const q = itemQuery;
  const counts = itemCountsOf(h);

  const builtSet = catalogNameSet(h);
  const customs = customItemsOf(h)
    .map((n) => String(n || '').trim())
    .filter((n) => n && !builtSet.has(n))
    .filter((n) => {
      if (!q) return true;
      if (q.length >= 2) return n.includes(q);
      return n === q || n.startsWith(q);
    });
  customs.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b, 'zh-Hant'));

  const crops = visibleCrops(h, q);
  const parts = [];
  if (customs.length) {
    parts.push('<div class="item-group-h">自己輸入</div>');
    for (const name of customs) {
      const on = active === name ? ' on' : '';
      const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
      parts.push(
        `<button type="button" class="item-btn custom${on}" data-act="pick-item" data-name="${escapeHtml(name)}"${lotAttr}>${escapeHtml(name)}</button>`
      );
    }
  }

  let lastGroup = null;
  for (const crop of crops) {
    if (crop.g !== lastGroup) {
      lastGroup = crop.g;
      parts.push(`<div class="item-group-h">${escapeHtml(crop.g)}</div>`);
    }
    const on = itemIsActive(crop, active) ? ' on' : '';
    const badge = shouldOpenVariants(crop, q) ? '<span class="var-n">▾</span>' : '';
    const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
    parts.push(
      `<button type="button" class="item-btn${on}" data-act="pick-crop" data-crop="${escapeHtml(crop.n)}"${lotAttr}>${escapeHtml(crop.l)}${badge}</button>`
    );
    if (q) {
      for (const v of (crop.s || [])) {
        if (!usefulVariant(v, crop) || !variantMatchesQuery(v, q)) continue;
        const von = active === v.n || active === v.l || (v.a || []).includes(active) ? ' on' : '';
        const vlabel = (v.imp ? '進口 ' : '') + (v.l || v.n);
        parts.push(
          `<button type="button" class="item-btn${von}" data-act="pick-item" data-name="${escapeHtml(v.n)}"${lotAttr}>${escapeHtml(vlabel)}</button>`
        );
      }
    }
  }
  if (!crops.length && !customs.length) {
    parts.push('<div class="item-group-h">沒有符合的品項</div>');
  }
  const addLot = lotId ? ` data-id="${escapeHtml(lotId)}" data-half="${h}"` : '';
  parts.push(`<button type="button" class="item-btn item-add" data-act="type-item"${addLot}>＋自己輸入</button>`);

  let sheet = '';
  if (variantPick) {
    const crop = catalogCrops(h).find((c) => c.n === variantPick) || findCrop(variantPick, h);
    if (crop) {
      const vars = pickerVariants(crop, q);
      const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
      const vBtns = [
        `<button type="button" class="item-btn${active === crop.l || active === crop.n ? ' on' : ''}" data-act="pick-item" data-name="${escapeHtml(crop.l)}"${lotAttr}>不指定品種</button>`
      ];
      for (const v of vars) {
        const on = active === v.n || active === v.l || (v.a || []).includes(active) ? ' on' : '';
        const imp = v.imp ? ' imp' : '';
        let label = v.l || '';
        if (v.imp) {
          const rest = String(label).replace(/^進口\s*/, '');
          label = rest ? '進口 ' + rest : '進口';
        }
        vBtns.push(
          `<button type="button" class="item-btn${on}${imp}" data-act="pick-item" data-name="${escapeHtml(v.n)}"${lotAttr}>${escapeHtml(label)}</button>`
        );
      }
      sheet = `<div class="var-sheet">
        <div class="var-sheet-head">
          <button type="button" class="var-back" data-act="close-vars">返回</button>
          <div class="var-title">${escapeHtml(crop.l)}</div>
        </div>
        <div class="var-sheet-list">${vBtns.join('')}</div>
      </div>`;
    }
  }

  const hintOpt = opts.hint != null
    ? `<div class="item-pick-label">${escapeHtml(opts.hint)}</div>`
    : '';
  return `<div class="item-pick-wrap${inSheet ? ' in-sheet' : ''}">
      ${hintOpt}
      <input id="${searchId}" class="item-search" type="search" enterkeyhint="search" placeholder="搜尋品項" value="${escapeHtml(q)}" data-act="item-search" autocomplete="off" />
      <div class="item-pick${inSheet ? ' sheet-items' : ''}">${parts.join('')}</div>
      ${sheet}
    </div>`;
}

const DEFAULT_MACHINES = {
  fruit: [
    { id: 'f1', name: '第一台', ranges: [] }
  ],
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
let draftSize = '';
let draftMachineId = '';
let planOpen = false;
let planHistoryPushed = false;
let planDraft = '';
let planQty = 1;
let planPickOpen = false;
let planAddTarget = 'tomorrow';
let lastPlanWon = {};
let lastPlanEvents = [];
let planProgressLock = false;
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

function addDaysIso(iso, n) {
  const [y, m, d] = String(iso || todayStr()).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function tomorrowStr(from) {
  return addDaysIso(from || todayStr(), 1);
}

function normalizePlanItems(list) {
  if (!Array.isArray(list)) return [];
  const today = todayStr();
  const cut = addDaysIso(today, -14);
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text || '').trim();
    if (!text) continue;
    const qtyNum = parseInt(raw.qty, 10);
    const item = {
      id: raw.id || uid(),
      text,
      forDay: raw.forDay || today,
      done: !!raw.done,
      doneOn: raw.doneOn || '',
      createdOn: raw.createdOn || raw.forDay || today,
      qty: Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(99, qtyNum) : 1,
      doneBy: raw.doneBy === 'manual' || raw.doneBy === 'auto' ? raw.doneBy : '',
      lockCount: Number(raw.lockCount) || 0
    };
    if (item.done && item.doneOn && item.doneOn < cut) continue;
    out.push(item);
  }
  return out;
}

function lotPlanText(lot) {
  if (!lot || !lot.item) return '';
  const name = itemDisplayName(lot.item);
  const size = itemNeedsSize(lot.item) && sizeLabel(lot.size) ? ' ' + lot.size : '';
  return String(name + size).trim();
}

function planQtyOf(p) {
  const n = parseInt(p && p.qty, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(99, n) : 1;
}

function parsePlanItemText(text) {
  let raw = String(text || '').trim().replace(/\s+/g, ' ');
  let size = '';
  let name = raw;
  const paren = raw.match(/^(.*?)[（(]\s*([大中小])\s*[）)]\s*$/);
  if (paren && String(paren[1] || '').trim()) {
    name = paren[1].trim();
    size = paren[2];
  } else {
    const spaced = raw.match(/^(.*)\s([大中小])\s*$/);
    if (spaced && String(spaced[1] || '').trim()) {
      name = spaced[1].trim();
      size = spaced[2];
    }
  }
  return { name, size, raw };
}

function findVariety(crop, name) {
  if (!crop || !name) return null;
  const n = String(name).trim();
  return (crop.s || []).find((x) => (
    x.n === n || x.l === n || (x.a || []).includes(n)
  )) || null;
}

function resolvePlanName(name) {
  const n = String(name || '').trim();
  if (!n) return { level: 'exact', exact: '', crop: null, variety: null };
  const cropExact = findCrop(n);
  if (cropExact && (cropExact.n === n || cropExact.l === n || (cropExact.a || []).includes(n))) {
    return { level: 'crop', crop: cropExact, variety: null };
  }
  const crop = findCrop(n);
  if (crop) {
    const variety = findVariety(crop, n);
    if (variety && usefulVariant(variety, crop)) {
      return { level: 'variety', crop, variety };
    }
    if (crop.n === n || crop.l === n || (crop.a || []).includes(n) || (n.startsWith(crop.n + '-') && !variety)) {
      return { level: 'crop', crop, variety: null };
    }
    if (variety) return { level: 'crop', crop, variety: null };
  }
  const parts = n.split(/\s+/);
  if (parts.length >= 2) {
    const head = findCrop(parts[0]);
    const rest = parts.slice(1).join(' ');
    if (head) {
      const variety = findVariety(head, rest) || findVariety(head, head.n + '-' + rest) || findVariety(head, n);
      if (variety && usefulVariant(variety, head)) return { level: 'variety', crop: head, variety };
    }
  }
  return { level: 'exact', exact: n, crop: null, variety: null };
}

function resolveLotItem(item) {
  const name = String(item || '').trim();
  if (!name) return { crop: null, variety: null };
  const crop = findCrop(name);
  if (crop) {
    let variety = findVariety(crop, name);
    if (!variety && name.startsWith(crop.n + '-')) {
      variety = findVariety(crop, name.slice(crop.n.length + 1));
    }
    if (!variety && name.startsWith(crop.l + '-')) {
      variety = findVariety(crop, name.slice(crop.l.length + 1)) || findVariety(crop, crop.n + '-' + name.slice(crop.l.length + 1));
    }
    for (const a of crop.a || []) {
      if (!variety && name.startsWith(a + '-')) {
        variety = findVariety(crop, name.slice(a.length + 1)) || findVariety(crop, crop.n + '-' + name.slice(a.length + 1));
      }
    }
    return { crop, variety };
  }
  const dash = name.indexOf('-');
  if (dash > 0) {
    const head = name.slice(0, dash);
    const rest = name.slice(dash + 1);
    const c = findCrop(head);
    if (c && (c.n === head || c.l === head || (c.a || []).includes(head))) {
      const variety = findVariety(c, rest) || findVariety(c, c.n + '-' + rest);
      return { crop: c, variety };
    }
  }
  return { crop: null, variety: null };
}

function planLotMatchScore(plan, lot) {
  if (!plan || !lot || !lot.item) return 0;
  const parsed = parsePlanItemText(plan.text);
  const resolved = resolvePlanName(parsed.name);
  const lotRes = resolveLotItem(lot.item);
  const crop = lotRes.crop;
  const variety = lotRes.variety;
  const lotSize = itemNeedsSize(lot.item) || (crop && itemNeedsSize(crop.n)) || (crop && itemNeedsSize(crop.l)) ? sizeLabel(lot.size) : '';
  if (parsed.size) {
    if (lotSize !== parsed.size) return 0;
  }
  if (resolved.level === 'variety' && resolved.crop && resolved.variety) {
    if (!crop || crop.n !== resolved.crop.n) return 0;
    if (!variety || variety.n !== resolved.variety.n) return 0;
    return parsed.size ? 40 : 30;
  }
  if (resolved.level === 'crop' && resolved.crop) {
    if (!crop || crop.n !== resolved.crop.n) return 0;
    return parsed.size ? 20 : 10;
  }
  const exacts = [itemDisplayName(lot.item), lot.item, itemCellName(lot.item), lotPlanText(lot)]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (exacts.some((s) => s === parsed.name || s === parsed.raw)) return parsed.size ? 25 : 15;
  return 0;
}

function todayWonLots() {
  const today = todayStr();
  const day = (state && state.day) || today;
  return (state.lots || []).filter((l) => l.status === 'won' && l.item && (l.day === today || l.day === day));
}

function autoManagedPlans() {
  const today = todayStr();
  return (state.planItems || []).filter((p) => {
    if (!p || p.forDay > today) return false;
    if (p.done && p.doneOn && p.doneOn < today && p.forDay < today) return false;
    return true;
  });
}

function assignWonToPlans() {
  const plans = autoManagedPlans();
  const lots = todayWonLots();
  const map = new Map();
  for (const p of plans) map.set(p.id, []);
  for (const lot of lots) {
    let best = null;
    let bestScore = 0;
    for (const p of plans) {
      const s = planLotMatchScore(p, lot);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      } else if (s === bestScore && s > 0 && best) {
        const needB = Math.max(0, planQtyOf(best) - map.get(best.id).length);
        const needP = Math.max(0, planQtyOf(p) - map.get(p.id).length);
        if (needP > 0 && needB === 0) best = p;
      }
    }
    if (best && bestScore > 0) map.get(best.id).push(lot.id);
  }
  return map;
}

function formatPlanEvent(ev) {
  if (!ev) return '';
  if (ev.kind === 'done') return '備註：' + ev.text + ' 已完成 ✓';
  if (ev.kind === 'progress') return '備註：' + ev.text + ' 還差 ' + ev.remain + ' 件';
  return '';
}

function latestPlanToast() {
  const msg = lastPlanEvents.map(formatPlanEvent).filter(Boolean)[0] || '';
  lastPlanEvents = [];
  return msg;
}

function withPlanToast(base) {
  const note = latestPlanToast();
  if (!base) return note;
  return note ? base + '\n' + note : base;
}

function applyPlanProgressFromLots(opts) {
  opts = opts || {};
  if (!state || !Array.isArray(state.planItems)) return lastPlanEvents;
  const today = todayStr();
  const assigned = assignWonToPlans();
  const events = [];
  for (const p of autoManagedPlans()) {
    const won = (assigned.get(p.id) || []).length;
    const qty = planQtyOf(p);
    const complete = won >= qty;
    const prev = lastPlanWon[p.id] || 0;
    if (p.doneBy === 'manual' && p.done) {
      lastPlanWon[p.id] = won;
      continue;
    }
    if (p.doneBy === 'manual' && !p.done) {
      const lock = Number(p.lockCount) || 0;
      if (complete && won > lock) {
        p.done = true;
        p.doneOn = today;
        p.doneBy = 'auto';
        p.lockCount = 0;
        events.push({ kind: 'done', text: p.text, won, qty });
      } else if (won > prev && !complete) {
        events.push({ kind: 'progress', text: p.text, remain: Math.max(0, qty - won), won, qty });
      }
      lastPlanWon[p.id] = won;
      continue;
    }
    if (complete && !p.done) {
      p.done = true;
      p.doneOn = today;
      p.doneBy = 'auto';
      events.push({ kind: 'done', text: p.text, won, qty });
    } else if (!complete && p.done && p.doneBy === 'auto') {
      p.done = false;
      p.doneOn = '';
      p.doneBy = '';
    } else if (!complete && !p.done && won > prev) {
      events.push({ kind: 'progress', text: p.text, remain: Math.max(0, qty - won), won, qty });
    }
    lastPlanWon[p.id] = won;
  }
  if (events.length) lastPlanEvents = events;
  if (opts.toast && events.length && typeof toast === 'function') {
    const msg = formatPlanEvent(events[0]);
    if (msg) toast(msg);
  }
  return events;
}

function normalizeBoughtHistory(list) {
  if (!Array.isArray(list)) return [];
  const cut = addDaysIso(todayStr(), -14);
  const byDay = new Map();
  for (const raw of list) {
    if (!raw || !raw.day || raw.day < cut) continue;
    const items = [];
    for (const it of raw.items || []) {
      const text = String(it.text || it.name || '').trim();
      const count = Number(it.count) || 0;
      if (!text || count < 1) continue;
      items.push({ text, count });
    }
    if (!items.length) continue;
    byDay.set(raw.day, { day: raw.day, items });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function rememberBoughtLots(lots) {
  if (!state) return;
  if (!Array.isArray(state.boughtHistory)) state.boughtHistory = [];
  const daysInLots = new Set();
  const groups = {};
  for (const l of lots || []) {
    if (l.status !== 'won' || !l.item) continue;
    const text = lotPlanText(l);
    if (!text) continue;
    const day = l.day || state.day;
    daysInLots.add(day);
    if (!groups[day]) groups[day] = {};
    groups[day][text] = (groups[day][text] || 0) + 1;
  }
  const byDay = new Map((state.boughtHistory || []).map((h) => [h.day, h]));
  for (const day of daysInLots) {
    const items = Object.entries(groups[day]).map(([text, count]) => ({ text, count }));
    byDay.set(day, { day, items });
  }
  state.boughtHistory = normalizeBoughtHistory([...byDay.values()]);
}

function boughtCountsByDay() {
  const map = new Map();
  for (const h of state.boughtHistory || []) {
    const inner = new Map();
    for (const it of h.items || []) inner.set(it.text, it.count);
    map.set(h.day, inner);
  }
  const daysWithLots = new Set((state.lots || []).map((l) => l.day).filter(Boolean));
  for (const day of daysWithLots) {
    const inner = new Map();
    for (const l of state.lots || []) {
      if (l.day !== day || l.status !== 'won' || !l.item) continue;
      const text = lotPlanText(l);
      if (!text) continue;
      inner.set(text, (inner.get(text) || 0) + 1);
    }
    if (inner.size) map.set(day, inner);
    else map.delete(day);
  }
  return map;
}

function planQuickPicks() {
  const today = todayStr();
  const byDay = boughtCountsByDay();
  const days = [...byDay.keys()].sort().reverse();
  const primary = days.find((d) => d < today) || days.find((d) => d === today) || days[0] || '';
  const counts = new Map();
  if (primary) {
    for (const [text, n] of byDay.get(primary)) counts.set(text, (counts.get(text) || 0) + n);
  }
  const usedPrimary = counts.size > 0;
  if (!usedPrimary) {
    for (const day of days) {
      for (const [text, n] of byDay.get(day)) counts.set(text, (counts.get(text) || 0) + n);
    }
  }
  let source = 'none';
  let label = '最近買過';
  if (usedPrimary && primary === addDaysIso(today, -1)) {
    source = 'yesterday';
    label = '昨天買過';
  } else if (usedPrimary && primary === today) {
    source = 'today';
    label = '今天買過';
  } else if (usedPrimary) {
    source = 'recent';
    const [y, m, d] = primary.split('-').map(Number);
    label = `${m}/${d} 買過`;
  }
  if (!counts.size) {
    const seen = new Set();
    const planned = (state.planItems || []).slice().reverse();
    for (const p of planned) {
      const text = String(p.text || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      counts.set(text, 1);
      if (counts.size >= 24) break;
    }
    if (counts.size) {
      source = 'planned';
      label = '最近預計';
    }
  }
  const chips = [...counts.entries()].map(([text, count]) => ({
    text,
    count,
    vol: itemVolume(text)
  }));
  chips.sort((a, b) => b.count - a.count || b.vol - a.vol || a.text.localeCompare(b.text, 'zh-Hant'));
  return { source, label, day: primary || '', chips: chips.slice(0, 24) };
}

function planTargetDay(which) {
  const today = todayStr();
  return (which || planAddTarget) === 'today' ? today : tomorrowStr(today);
}

function activePlanItems() {
  const today = todayStr();
  const forDay = planTargetDay();
  return (state.planItems || []).filter((p) => !p.done && (forDay === today ? p.forDay <= today : p.forDay > today));
}

function planHasText(text) {
  const t = String(text || '').trim();
  return activePlanItems().some((p) => p.text === t);
}

function addPlanText(text, which) {
  const value = String(text || '').trim();
  if (!value) return false;
  const today = todayStr();
  const target = which || planAddTarget || 'tomorrow';
  const forDay = planTargetDay(target);
  if (!Array.isArray(state.planItems)) state.planItems = [];
  if ((state.planItems || []).some((p) => !p.done && p.text === value && p.forDay === forDay)) return false;
  state.planItems.push({
    id: uid(),
    text: value,
    forDay,
    done: false,
    doneOn: '',
    createdOn: today,
    qty: planQtyOf({ qty: planQty }),
    doneBy: '',
    lockCount: 0
  });
  planQty = 1;
  saveState();
  return true;
}

function togglePlanPick(text) {
  const value = String(text || '').trim();
  if (!value) return;
  const today = todayStr();
  const forDay = planTargetDay();
  if (!Array.isArray(state.planItems)) state.planItems = [];
  const existing = state.planItems.find((p) => !p.done && p.text === value && (forDay === today ? p.forDay <= today : p.forDay > today));
  if (existing) {
    state.planItems = state.planItems.filter((p) => p.id !== existing.id);
    saveState();
    render();
    return;
  }
  addPlanText(value);
  render();
}

function planSuggestList(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const seen = new Set();
  const out = [];
  const halves = HALVES;
  for (const half of halves) {
    for (const crop of visibleCrops(half, q)) {
      const label = crop.l || crop.n;
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function openPlan() {
  if (planOpen) return;
  planOpen = true;
  planPickOpen = false;
  planAddTarget = 'tomorrow';
  try {
    history.pushState({ auctionPlan: true }, '');
    planHistoryPushed = true;
  } catch {
    planHistoryPushed = false;
  }
  render();
}

function closePlan(fromPop) {
  if (!planOpen) return;
  planOpen = false;
  if (!fromPop && planHistoryPushed) {
    planHistoryPushed = false;
    try { history.back(); } catch { /* ignore */ }
  } else {
    planHistoryPushed = false;
  }
  render();
}

function onPlanPopState() {
  if (planOpen) closePlan(true);
}

function addPlanItem(which) {
  const text = String(planDraft || '').trim();
  if (!text) {
    toast('請先輸入預計要批的品項或備註');
    return;
  }
  const today = todayStr();
  const forDay = which === 'today' ? today : tomorrowStr(today);
  if (!Array.isArray(state.planItems)) state.planItems = [];
  state.planItems.push({
    id: uid(),
    text,
    forDay,
    done: false,
    doneOn: '',
    createdOn: today,
    qty: planQtyOf({ qty: planQty }),
    doneBy: '',
    lockCount: 0
  });
  planDraft = '';
  planQty = 1;
  saveState();
  toast(which === 'today' ? '已加入今日預計' : '已加入明日預計，明天還在');
  render();
}

function setPlanDone(id, done) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) return;
  item.done = !!done;
  item.doneOn = item.done ? todayStr() : '';
  item.doneBy = 'manual';
  item.lockCount = item.done ? 0 : planWonCount(item);
  saveState();
  render();
}

function planWonCount(plan) {
  if (!plan) return 0;
  const map = assignWonToPlans();
  return (map.get(plan.id) || []).length;
}

function bumpPlanQty(id, delta) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) return;
  item.qty = Math.max(1, Math.min(99, planQtyOf(item) + delta));
  saveState();
  render();
}

function bumpDraftQty(delta) {
  planQty = Math.max(1, Math.min(99, (parseInt(planQty, 10) || 1) + delta));
  render();
}

function deletePlanItem(id) {
  state.planItems = (state.planItems || []).filter((p) => p.id !== id);
  saveState();
  render();
}

function planTodayCount() {
  const today = todayStr();
  return (state.planItems || []).filter((p) => !p.done && p.forDay <= today).length;
}

function renderSizeChips(current, opts) {
  opts = opts || {};
  const act = opts.lotId ? 'set-size' : 'set-draft-size';
  const lotAttr = opts.lotId ? ` data-id="${escapeHtml(opts.lotId)}"` : '';
  const cls = opts.sheet ? 'size-chips sheet-size' : 'size-chips';
  return `<div class="${cls}" role="group" aria-label="大小">
    <span class="size-lbl">大小</span>
    ${ITEM_SIZES.map((s) => {
      const on = current === s ? ' on' : '';
      return `<button type="button" class="size-chip${on}" data-act="${act}" data-v="${s}"${lotAttr}>${s}</button>`;
    }).join('')}
  </div>`;
}

function renderPlanScreen() {
  if (!planOpen) return '';
  const today = todayStr();
  const items = state.planItems || [];
  const todayItems = items.filter((p) => !p.done && p.forDay <= today);
  const tomorrowItems = items.filter((p) => !p.done && p.forDay > today);
  const doneItems = items.filter((p) => p.done).slice().reverse().slice(0, 20);
  const wonMap = assignWonToPlans();
  const row = (p, kind) => {
    const qty = planQtyOf(p);
    const won = kind === 'tomorrow' ? 0 : (wonMap.get(p.id) || []).length;
    const remain = Math.max(0, qty - won);
    let remainHtml = '';
    if (kind !== 'tomorrow' && qty > 1) {
      remainHtml = p.done && remain === 0
        ? `<span class="plan-remain ok">已完成<span class="plan-frac">${qty} 件</span></span>`
        : `<span class="plan-remain">還差 ${remain} 件<span class="plan-frac">${Math.min(won, qty)}/${qty}</span></span>`;
    }
    const qtyCtrl = `<span class="plan-qty-mini">
        <button type="button" class="plan-qty-btn" data-act="plan-item-qty-dec" data-id="${escapeHtml(p.id)}" aria-label="減少件數">−</button>
        <span class="plan-qty-val">${qty}</span>
        <button type="button" class="plan-qty-btn" data-act="plan-item-qty-inc" data-id="${escapeHtml(p.id)}" aria-label="增加件數">＋</button>
      </span>`;
    return `<div class="plan-row${kind === 'done' ? ' done' : ''}">
      <button type="button" class="plan-check${p.done ? ' on' : ''}" data-act="${p.done ? 'plan-undone' : 'plan-done'}" data-id="${escapeHtml(p.id)}" aria-label="${p.done ? '取消完成' : '完成'}">${p.done ? '✓' : ''}</button>
      <div class="plan-main">
        <div class="plan-text">${escapeHtml(p.text)}</div>
        ${remainHtml}
      </div>
      ${qtyCtrl}
      <button type="button" class="plan-del" data-act="plan-del" data-id="${escapeHtml(p.id)}" aria-label="刪除">刪</button>
    </div>`;
  };
  const section = (title, hint, list, kind) => {
    const target = kind === 'today' || kind === 'tomorrow';
    const on = target && planAddTarget === kind ? ' on' : '';
    const headAct = target ? ` data-act="plan-target" data-v="${kind}"` : '';
    return `<section class="plan-sec${on}">
      <h2${headAct} class="${target ? 'plan-target' : ''}${on}">${title}${list.length ? `<span>${list.length}</span>` : ''}${target && planAddTarget === kind ? '<em>點選加入到這</em>' : ''}</h2>
      ${hint ? `<p class="plan-hint">${hint}</p>` : ''}
      ${list.length ? list.map((p) => row(p, kind)).join('') : '<div class="plan-empty">還沒有項目</div>'}
    </section>`;
  };
  const picks = planQuickPicks();
  const suggest = planSuggestList(planDraft);
  const pickChips = picks.chips.map((c) => {
    const on = planHasText(c.text) ? ' on' : '';
    return `<button type="button" class="plan-pick${on}" data-act="plan-pick" data-v="${escapeHtml(c.text)}">${escapeHtml(c.text)}${c.count > 1 ? `<span>${c.count}</span>` : ''}</button>`;
  }).join('');
  const pickBar = picks.chips.length
    ? `<div class="plan-picks${planPickOpen ? ' open' : ''}">
        <button type="button" class="plan-picks-toggle" data-act="toggle-plan-picks">${planPickOpen ? '收起' : '＋'}${escapeHtml(picks.label)} <span>${picks.chips.length}</span></button>
        ${planPickOpen ? `<div class="plan-pick-tray">${pickChips}</div>` : ''}
      </div>`
    : `<div class="plan-picks muted"><div class="plan-picks-toggle dim">還沒有買過的紀錄（標到後會出現快選）</div></div>`;
  const suggestBox = suggest.length
    ? `<div class="plan-suggest">${suggest.map((s) => `<button type="button" class="plan-suggest-item" data-act="plan-suggest" data-v="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`
    : '';
  return `<div class="plan-screen" id="plan-screen">
    <header class="plan-bar">
      <button type="button" class="plan-back" data-act="close-plan">返回</button>
      <h1>備註</h1>
      <span class="plan-bar-spacer"></span>
    </header>
    <div class="plan-body">
      ${section('今日預計', '昨天先記下、今天要批的會留在這裡。開始新的一天也不會清掉。點標題可改成加到今日。', todayItems, 'today')}
      ${section('明日預計', '先記下來，明天會自動變成今日預計。點標題可改成加到明日。', tomorrowItems, 'tomorrow')}
      ${doneItems.length ? section('已完成', '', doneItems, 'done') : ''}
    </div>
    <div class="plan-add">
      ${pickBar}
      <div class="plan-input-wrap">
        <input id="plan-input" maxlength="40" placeholder="輸入或搜尋品項，例如：高麗菜" value="${escapeHtml(planDraft)}" data-act="plan-draft" autocomplete="off" />
        ${suggestBox}
      </div>
      <div class="plan-add-btns">
        <div class="plan-qty" aria-label="件數">
          <button type="button" class="plan-qty-btn" data-act="plan-qty-dec" aria-label="減少件數">−</button>
          <span class="plan-qty-val">${planQtyOf({ qty: planQty })}</span>
          <span class="plan-qty-unit">件</span>
          <button type="button" class="plan-qty-btn" data-act="plan-qty-inc" aria-label="增加件數">＋</button>
        </div>
        <button type="button" class="btn${planAddTarget === 'today' ? ' primary' : ''}" data-act="plan-add" data-v="today">加入今日</button>
        <button type="button" class="btn${planAddTarget === 'tomorrow' ? ' primary' : ''}" data-act="plan-add" data-v="tomorrow">加入明日</button>
      </div>
    </div>
    <div class="plan-footer">
      <button type="button" class="plan-back-lg" data-act="close-plan">返回</button>
    </div>
  </div>`;
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
  const out = { fruit: {}, morning: {}, afternoon: {} };
  for (const half of HALVES) {
    out[half] = {};
    for (const m of machines[half] || []) {
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
    currentHalf: 'fruit',
    tab: 'note',
    machines,
    currentNumbers: defaultCurrents(machines),
    lots: [],
    day: todayStr(),
    alerted: {},
    customItems: [],
    itemCounts: {},
    customItemsByHalf: { fruit: [], morning: [], afternoon: [] },
    itemCountsByHalf: { fruit: {}, morning: {}, afternoon: {} },
    progressV2: true,
    itemsMigratedV2: true,
    lastPriority: 'watch',
    dayRules: [],
    machinesMigratedV9: true,
    itemsMigratedV17: true,
    itemsMigratedV21: true,
    planItems: [],
    boughtHistory: [],
    syncRoom: '',
    syncLabel: '',
    peerId: '',
    syncDeviceId: '',
    syncDeviceToken: '',
    syncRestoreToken: '',
    syncRole: '',
    syncPending: false,
    syncDevices: [],
    syncJoinRequests: [],
    syncQueue: [],
    syncKvTs: {},
    syncTombstones: { lots: {}, plan: {} }
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const merged = { ...base, ...saved };
    merged.machines = {};
    merged.currentNumbers = {};
    for (const half of HALVES) {
      const savedMachines = saved.machines && Array.isArray(saved.machines[half]) ? saved.machines[half] : null;
      merged.machines[half] = savedMachines && savedMachines.length
        ? savedMachines
        : structuredClone(base.machines[half]);
      if (half === 'fruit' && merged.machines.fruit.length > 2) {
        merged.machines.fruit = merged.machines.fruit.slice(0, 2);
      }
      if (!merged.machines[half].length) {
        merged.machines[half] = structuredClone(base.machines[half]);
      }
      merged.currentNumbers[half] = {
        ...(base.currentNumbers[half] || {}),
        ...((saved.currentNumbers && saved.currentNumbers[half]) || {})
      };
    }
    if (!isHalf(merged.currentHalf)) merged.currentHalf = 'fruit';
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
    if (!saved.itemsMigratedV17) {
      migrateItemsV17(merged);
    }
    if (!saved.itemsMigratedV21) {
      migrateItemsV21(merged);
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
    merged.planItems = normalizePlanItems(merged.planItems);
    merged.boughtHistory = normalizeBoughtHistory(merged.boughtHistory);
    const roomCode = String(merged.syncRoom || '');
    const isSecret = /^[A-Za-z0-9_-]{22,64}$/.test(roomCode);
    const isLegacy = /^\d{6}$/.test(roomCode);
    if (!isSecret && !isLegacy) merged.syncRoom = '';
    if (typeof merged.syncLabel !== 'string') merged.syncLabel = '';
    if (typeof merged.peerId !== 'string') merged.peerId = '';
    if (typeof merged.syncDeviceId !== 'string') merged.syncDeviceId = '';
    if (typeof merged.syncDeviceToken !== 'string') merged.syncDeviceToken = '';
    if (typeof merged.syncRestoreToken !== 'string') merged.syncRestoreToken = '';
    if (merged.syncRole !== 'owner' && merged.syncRole !== 'member') merged.syncRole = '';
    merged.syncPending = !!merged.syncPending;
    if (!Array.isArray(merged.syncDevices)) merged.syncDevices = [];
    if (!Array.isArray(merged.syncJoinRequests)) merged.syncJoinRequests = [];
    if (!Array.isArray(merged.syncQueue)) merged.syncQueue = [];
    if (!merged.syncKvTs || typeof merged.syncKvTs !== 'object') merged.syncKvTs = {};
    if (!merged.syncTombstones || typeof merged.syncTombstones !== 'object') {
      merged.syncTombstones = { lots: {}, plan: {} };
    } else {
      if (!merged.syncTombstones.lots || typeof merged.syncTombstones.lots !== 'object') merged.syncTombstones.lots = {};
      if (!merged.syncTombstones.plan || typeof merged.syncTombstones.plan !== 'object') merged.syncTombstones.plan = {};
    }
    return merged;
  } catch {
    return base;
  }
}

function saveState() {
  if (!planProgressLock) {
    planProgressLock = true;
    try { applyPlanProgressFromLots(); } finally { planProgressLock = false; }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('儲存失敗，空間可能不足');
  }
  if (typeof onLocalStateSaved === 'function') onLocalStateSaved();
}

function halfLabel(half) {
  return HALF_LABELS[half] || '上半場';
}

function machineById(id, half) {
  const h = half || state.currentHalf;
  const pools = [state.machines[h] || []];
  for (const k of HALVES) {
    if (k !== h) pools.push(state.machines[k] || []);
  }
  for (const list of pools) {
    const found = list.find((m) => m.id === id);
    if (found) return found;
  }
  return null;
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
  const list = (state.machines[half] || []);
  if (list.length === 1) return list[0].id;
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

function addSessionMachine(half) {
  const h = half || state.currentHalf;
  if (!isHalf(h)) return;
  const list = state.machines[h] || (state.machines[h] = []);
  const max = SESSION_MACHINE_MAX[h] || 3;
  if (list.length >= max) {
    toast(`這場最多 ${max} 台`);
    return;
  }
  const idBase = h === 'fruit' ? 'f' : h === 'morning' ? 'm' : 'a';
  let n = list.length + 1;
  let id = idBase + n;
  while (list.some((m) => m.id === id)) {
    n += 1;
    id = idBase + n;
  }
  const ordinal = ['', '一', '二', '三', '四'][list.length + 1] || String(list.length + 1);
  const name = '第' + ordinal + '台';
  list.push({ id, name, ranges: [] });
  if (!state.currentNumbers[h]) state.currentNumbers[h] = {};
  state.currentNumbers[h][id] = null;
  saveState();
  toast(`已加上${name}`);
  render();
}

function removeSessionMachine(half, machineId) {
  const h = half || state.currentHalf;
  const list = state.machines[h] || [];
  if (list.length <= 1) {
    toast('至少要留一台');
    return;
  }
  const idx = machineId ? list.findIndex((m) => m.id === machineId) : list.length - 1;
  if (idx < 0) return;
  const [gone] = list.splice(idx, 1);
  const keep = list[0];
  for (const lot of state.lots || []) {
    if (lot.half === h && lot.machineId === gone.id) lot.machineId = keep.id;
  }
  if (state.currentNumbers[h]) delete state.currentNumbers[h][gone.id];
  saveState();
  toast(`已移除${gone.name}`);
  render();
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
  rememberBoughtLots(state.lots);
  saveState();
  checkAlerts();
  offerUndo(snap, withPlanToast(`${label} ${lotLabel(lot)}`));
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
  offerUndo(snap, withPlanToast(`流標・二市 ${lotLabel(lot)}`));
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
  itemQuery = '';
  variantPick = null;
  resetItemPickScroll = true;
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
  if (!lot.item) return String(lot.number);
  const size = itemNeedsSize(lot.item) && sizeLabel(lot.size) ? ' ' + lot.size : '';
  return `${lot.number} ${itemDisplayName(lot.item)}${size}`;
}

function migrateItemLists(merged) {
  if (!merged.customItemsByHalf || typeof merged.customItemsByHalf !== 'object') {
    merged.customItemsByHalf = { fruit: [], morning: [], afternoon: [] };
  }
  for (const half of HALVES) {
    if (!Array.isArray(merged.customItemsByHalf[half])) merged.customItemsByHalf[half] = [];
  }
  if (!merged.itemCountsByHalf || typeof merged.itemCountsByHalf !== 'object') {
    merged.itemCountsByHalf = { fruit: {}, morning: {}, afternoon: {} };
  }
  for (const half of HALVES) {
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

function officialNameSet(cropNames) {
  const names = new Set(cropNames);
  const catalog = typeof ITEM_CATALOG !== 'undefined' ? ITEM_CATALOG : [];
  for (const c of catalog) {
    if (!cropNames.includes(c.n)) continue;
    names.add(c.n);
    names.add(c.l);
    for (const a of c.a || []) names.add(a);
    for (const v of c.s || []) {
      names.add(v.n);
      names.add(v.l);
      for (const a of v.a || []) names.add(a);
    }
  }
  return names;
}

function moveCustomsAndCounts(merged, fromHalf, toHalf, names) {
  if (!merged.customItemsByHalf || typeof merged.customItemsByHalf !== 'object') {
    merged.customItemsByHalf = { fruit: [], morning: [], afternoon: [] };
  }
  if (!Array.isArray(merged.customItemsByHalf[fromHalf])) merged.customItemsByHalf[fromHalf] = [];
  if (!Array.isArray(merged.customItemsByHalf[toHalf])) merged.customItemsByHalf[toHalf] = [];
  if (!merged.itemCountsByHalf || typeof merged.itemCountsByHalf !== 'object') {
    merged.itemCountsByHalf = { fruit: {}, morning: {}, afternoon: {} };
  }
  if (!merged.itemCountsByHalf[fromHalf] || typeof merged.itemCountsByHalf[fromHalf] !== 'object') {
    merged.itemCountsByHalf[fromHalf] = {};
  }
  if (!merged.itemCountsByHalf[toHalf] || typeof merged.itemCountsByHalf[toHalf] !== 'object') {
    merged.itemCountsByHalf[toHalf] = {};
  }
  const destOfficial = catalogNameSet(toHalf);
  const fromCust = merged.customItemsByHalf[fromHalf];
  const toCust = merged.customItemsByHalf[toHalf];
  const keep = [];
  for (const raw of fromCust) {
    const n = String(raw || '').trim();
    if (!n) continue;
    if (names.has(n)) {
      if (!destOfficial.has(n) && !toCust.includes(n)) toCust.push(n);
      continue;
    }
    keep.push(n);
  }
  merged.customItemsByHalf[fromHalf] = keep;
  const fromCounts = merged.itemCountsByHalf[fromHalf];
  const toCounts = merged.itemCountsByHalf[toHalf];
  for (const [key, val] of Object.entries(fromCounts)) {
    if (!names.has(key)) continue;
    toCounts[key] = (toCounts[key] || 0) + (Number(val) || 0);
    delete fromCounts[key];
  }
}

function migrateItemsV17(merged) {
  moveCustomsAndCounts(merged, 'afternoon', 'morning', officialNameSet(MUSHROOM_CROPS));
  moveCustomsAndCounts(merged, 'morning', 'afternoon', officialNameSet(GOURD_FROM_BULK_CROPS));
  merged.itemsMigratedV17 = true;
}

function migrateItemsV21(merged) {
  moveCustomsAndCounts(merged, 'morning', 'afternoon', officialNameSet(GOURD_FROM_BULK_V21_CROPS));
  merged.itemsMigratedV21 = true;
}

function defaultItems(half) {
  const h = half || (typeof state !== 'undefined' && state.currentHalf) || 'morning';
  return Array.from(catalogNameSet(h));
}

function itemVolume(name) {
  const crop = findCrop(name);
  if (!crop) return 0;
  if (crop.l === name || crop.n === name || (crop.a || []).includes(name)) return Number(crop.v || 0);
  const v = (crop.s || []).find((x) => x.n === name || x.l === name || (x.a || []).includes(name));
  return Number((v && v.v) || crop.v || 0);
}

function customItemsOf(half) {
  const h = half || state.currentHalf;
  if (!state.customItemsByHalf) state.customItemsByHalf = { fruit: [], morning: [], afternoon: [] };
  if (!Array.isArray(state.customItemsByHalf[h])) state.customItemsByHalf[h] = [];
  return state.customItemsByHalf[h];
}

function itemCountsOf(half) {
  const h = half || state.currentHalf;
  if (!state.itemCountsByHalf) state.itemCountsByHalf = { fruit: {}, morning: {}, afternoon: {} };
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
  const crop = findCrop(name);
  const g = crop ? crop.g : '';
  const leafy = g === '水菜';
  const bulk = g === '大宗';
  if (prefer === 'bulk') return bulk ? 0 : leafy ? 1 : 2;
  if (prefer === 'leafy') return leafy ? 0 : bulk ? 1 : 2;
  if (bulk) return 0;
  if (leafy) return 1;
  const ranks = GROUP_RANK.afternoon;
  return ranks[g] != null ? ranks[g] + 2 : 9;
}

function allItems(half) {
  const h = half || state.currentHalf;
  const builtSet = catalogNameSet(h);
  const customs = customItemsOf(h)
    .map((n) => String(n || '').trim())
    .filter((n) => n && !builtSet.has(n));
  return [...customs, ...visibleCrops(h, '').map((c) => c.l)];
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
  if (!itemNeedsSize(name)) lot.size = '';
  bumpItemUse(name, lot.half || state.currentHalf);
  saveState();
  toast(withPlanToast(`${lot.number}　${name}`));
  buzz(12);
}

function setLotSize(id, size) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || !itemNeedsSize(lot.item)) return;
  const next = sizeLabel(size);
  lot.size = lot.size === next ? '' : next;
  saveState();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
  render();
}

function cycleLotSize(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || !itemNeedsSize(lot.item)) return;
  const i = ITEM_SIZES.indexOf(lot.size);
  lot.size = ITEM_SIZES[(i + 1) % ITEM_SIZES.length];
  saveState();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
  render();
}

function setDraftSize(size) {
  const next = sizeLabel(size);
  if (itemTargetId) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot && itemNeedsSize(lot.item || draftItem)) {
      lot.size = lot.size === next ? '' : next;
      saveState();
      render();
      return;
    }
  }
  draftSize = draftSize === next ? '' : next;
  render();
}

function assignItem(name) {
  name = String(name || '').trim();
  if (!name) return;
  if (!itemNeedsSize(name)) draftSize = '';
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
    el.innerHTML = `<span>${escapeHtml(toastMsg).replace(/\n/g, '<br>')}</span><button type="button" data-act="undo">${escapeHtml(toastAction.label || '復原')}</button>`;
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
    draftSize = '';
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
  draftSize = '';
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
    size: itemNeedsSize(draftItem) ? sizeLabel(draftSize) : '',
    status: 'pending',
    priority: PRIORITIES.includes(draftPriority) ? draftPriority : (state.lastPriority || 'watch'),
    createdAt: Date.now()
  };
  if (lot.item) bumpItemUse(lot.item);
  state.lots.push(lot);
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftSize = '';
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
  const base = lot ? `已刪 ${lot.number}` : '已刪除';
  if (undoable && snap) offerUndo(snap, withPlanToast(base));
  else toast(withPlanToast(base) || base);
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
  rememberBoughtLots(state.lots);
  saveState();
  checkAlerts();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
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
  if (planOpen) closePlan();
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
  if (document.fonts && !fitPaddleDigits._armed) {
    fitPaddleDigits._armed = true;
    Promise.resolve(document.fonts.load('800 200px "Paddle Inter"'))
      .then(() => document.fonts.ready)
      .then(() => { if (paddleOpen) fitPaddleDigits(); })
      .catch(() => {});
  }
  applyCssLandscapeIfNeeded();
  const w = box.clientWidth * 0.96;
  const h = box.clientHeight * 0.94;
  if (w < 20 || h < 20) return;
  el.style.whiteSpace = 'nowrap';
  el.style.lineHeight = '0.82';
  el.style.letterSpacing = '0.04em';
  el.style.fontWeight = '800';
  el.style.fontFamily = '"Paddle Inter", Inter, sans-serif';
  el.style.webkitTextStroke = '0';
  let lo = 24;
  let hi = Math.max(w * 1.35, h * 1.5);
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
      body: state.syncRoom
        ? '會清空今天的抄號與標貨結果。房間裡兩支手機的抄號都會一起清空。預計備註會保留，台別號碼和承銷人代號也會保留。'
        : '會清空今天的抄號與標貨結果。預計備註會保留，台別號碼和承銷人代號也會保留。',
      ok: '確定清空',
      cancel: '取消',
      danger: true,
      onOk: () => startNewDay(true)
    };
    render();
    return;
  }
  rememberBoughtLots(state.lots);
  state.lots = [];
  state.alerted = {};
  state.day = todayStr();
  state.currentNumbers = defaultCurrents(state.machines);
  state.tab = 'note';
  state.currentHalf = 'fruit';
  showSettings = false;
  modal = null;
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftSize = '';
  draftMachineId = '';
  itemTargetId = null;
  itemTargetAuto = false;
  saveState();
  toast('已開始新的一天，預計備註還在，先從水果場開始');
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
    state.currentHalf = 'fruit';
    saveState();
  }
}

/* ---------- 分享 ---------- */
function resultText() {
  const code = state.sellerCode || '----';
  const lines = [`【${formatDateLabel(state.day)} 拍賣標貨助手】承銷人 ${code}`];
  let won = 0;
  let lost = 0;
  let pending = 0;
  let passed = 0;
  let flowN = 0;
  for (const half of HALVES) {
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
      await navigator.share({ text, title: '拍賣標貨助手' });
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


function captureItemPickScroll() {
  const el = document.querySelector('.item-pick-wrap:not(.in-sheet) .item-pick, .item-pick-wrap.in-sheet .item-pick');
  if (el && !resetItemPickScroll) itemPickScroll = el.scrollTop;
}

function restoreItemPickScroll() {
  const el = document.querySelector('.item-pick-wrap:not(.in-sheet) .item-pick, .item-pick-wrap.in-sheet .item-pick');
  if (!el) return;
  if (resetItemPickScroll) {
    el.scrollTop = 0;
    itemPickScroll = 0;
    resetItemPickScroll = false;
    return;
  }
  el.scrollTop = itemPickScroll;
}

/* ---------- Render ---------- */
function fitLotCellNames() {
  document.querySelectorAll('.lot-cell .cell-item-name').forEach((el) => {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize) || 11;
    const min = 8;
    while (size > min && el.scrollWidth > el.clientWidth + 0.5) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  });
}

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
  captureItemPickScroll();
  const liveCls = state.tab === 'live' && !showSettings ? ' live-mode' : '';
  const noteCls = state.tab === 'note' && !showSettings ? ' note-mode' : '';
  app.innerHTML =
    renderHeader() +
    `<main class="main${noteCls}${liveCls}" id="main">${renderTab()}</main>` +
    renderNav() +
    (paddleOpen ? renderPaddle() : '') +
    (modal ? renderModal() : '') +
    renderPlanScreen() +
    `<div id="toast" class="toast${toastMsg ? '' : ' hidden'}"></div>`;

  paintToast(document.getElementById('toast'));
  restoreFocus(focusId, start, end);
  restoreLiveScroll();
  restoreItemPickScroll();
  if (modal?.type === 'type-item') {
    const input = document.getElementById('type-item-input');
    if (input && document.activeElement !== input) {
      input.focus();
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch { /* ignore */ }
    }
  }
  if (state.tab === 'live' && !showSettings) requestAnimationFrame(fitLotCellNames);
  if (paddleOpen) requestAnimationFrame(fitPaddleDigits);
  if (typeof paintSyncQr === 'function') requestAnimationFrame(paintSyncQr);
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
        <img class="app-logo" src="icons/icon-192.png" alt="拍賣標貨助手" width="24" height="24" />
        <div class="header-date">${escapeHtml(formatDateLabel(state.day))}</div>
      </div>
      <div class="header-right">
        <div class="half-switch" role="tablist">
          ${HALVES.map((h) => `<button type="button" data-act="half" data-v="${h}" class="sess-${h}${half === h ? ' on' : ''}">${halfLabel(h)}</button>`).join('')}
        </div>
        ${typeof renderSyncPill === 'function' ? renderSyncPill() : ''}
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
      const other = HALVES.find((h) => h !== state.currentHalf && machinesMatching(parsed, h).length);
      if (other) {
        machineHint = `像是${halfLabel(other)}，請選台`;
        chipClass += ' warn';
      } else {
        machineHint = '無法判斷，請選台';
        chipClass += ' warn';
      }
    }
  } else {
    const list = state.machines[state.currentHalf] || [];
    const hasRanges = list.some((m) => (m.ranges || []).some((r) => r.start != null));
    if (!hasRanges && list.length === 1) {
      machineHint = `會存到${list[0].name}`;
    } else if (!hasRanges) {
      machineHint = '這場還沒設號碼區間，請選台';
      chipClass += ' warn';
    } else {
      machineHint = '輸入後自動判斷台別';
      chipClass += ' warn';
    }
  }

  const recent = recentLots();
  const recentHtml = recent.length
    ? `<div class="recent-row">${recent
        .map(
          (l) => {
            const on = itemTargetId === l.id ? ' on' : '';
            const item = l.item ? `<span class="itm">${escapeHtml(itemDisplayName(l.item))}</span>` : '';
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
  const itemPick = renderItemPicker(state.currentHalf, { active: activeItem, hint: itemHint });

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

  const sizeItem = (itemTargetId && state.lots.find((l) => l.id === itemTargetId)?.item) || draftItem;
  const sizeLot = itemTargetId ? state.lots.find((l) => l.id === itemTargetId) : null;
  const sizeBlock = itemNeedsSize(sizeItem)
    ? renderSizeChips(sizeLot && itemNeedsSize(sizeLot.item) ? sizeLot.size : draftSize, { lotId: sizeLot && itemNeedsSize(sizeLot.item) ? sizeLot.id : '' })
    : '';
  const planN = planTodayCount();

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
      ${sizeBlock}
      <div class="note-tools">
        <button type="button" class="linkish plan-open-btn" data-act="open-plan">備註${planN ? `<span class="plan-count">${planN}</span>` : ''}</button>
      </div>
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
              if (typeof lotHasRemoteFlash === 'function' && lotHasRemoteFlash(l.id)) cls += ' remote-flash';
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
              const size = itemNeedsSize(l.item) && l.item
                ? `<span class="size-badge${sizeLabel(l.size) ? ' on s-' + l.size : ' empty'}" data-act="cycle-size" data-id="${escapeHtml(l.id)}">${sizeLabel(l.size) || '規'}</span>`
                : '';
              const item = l.item
                ? `<span class="cell-item"><span class="cell-item-name">${escapeHtml(itemCellName(l.item))}</span></span>`
                : '<span class="cell-item dim"></span>';
              return `<button type="button" class="${cls}" data-act="cycle-lot" data-id="${escapeHtml(l.id)}">
                <span class="prio-hit" data-act="cycle-prio" data-id="${escapeHtml(l.id)}">
                  <span class="prio-bar"></span>
                  <span class="prio-tag">${prioShort(prio)}</span>
                </span>
                <span class="cell-main">
                  <span class="cell-top">
                    <span class="cell-num">${l.number}</span>
                    <span class="cell-end">${size}<span class="cell-flags">${badge}${er}</span></span>
                  </span>
                  ${item}
                </span>
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
    ? '<div class="live-empty">到「抄號」把紙上的號碼存進來，各台會並排顯示。</div>'
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
        ${half === 'fruit' && (state.machines.fruit || []).length < 2
          ? '<button type="button" class="live-sheet-btn" data-act="add-machine" data-half="fruit">＋第二台</button>'
          : ''}
        <button type="button" class="live-sheet-btn" data-act="open-second">清單</button>
      </div>
      <div class="live-cols" data-n="${(state.machines[half] || []).length}">${cols || '<div class="empty-hint">請先在設定裡確認台別</div>'}</div>
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

  const halfBlocks = HALVES
    .map((half) => {
      const list = state.machines[half] || [];
      const editors = list
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
          const removeBtn = half === 'fruit' && list.length > 1
            ? `<button type="button" class="linkish" data-act="remove-machine" data-half="${half}" data-id="${m.id}">移除此台</button>`
            : '';
          return `<div class="range-editor">
            <div class="name-row">
              <input id="n-${half}-${m.id}" value="${escapeHtml(m.name)}" data-act="mname" data-half="${half}" data-id="${m.id}" />
            </div>
            ${ranges}
            <button type="button" class="linkish" data-act="add-range" data-half="${half}" data-id="${m.id}">＋ 加一段號碼</button>
            ${removeBtn}
          </div>`;
        })
        .join('');
      const addBtn = half === 'fruit' && list.length < 2
        ? '<button type="button" class="btn" style="width:100%;margin-top:8px" data-act="add-machine" data-half="fruit">＋加第二台</button>'
        : '';
      const sub = half === 'fruit'
        ? '<p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">這場通常 1–2 台，號碼區間先留空，抄號時再選台，之後可在這裡補上。</p>'
        : '';
      const heading = half === 'fruit' ? `${halfLabel(half)}　台別（1–2 台）` : `${halfLabel(half)}　三台號碼`;
      return `<div class="setting-block"><h2>${heading}</h2>${sub}${editors}${addBtn}</div>`;
    })
    .join('');

  return `
    <div class="setting-block">
      <button type="button" class="btn primary" style="width:100%;margin-bottom:14px" data-act="settings">完成設定</button>
      <h2>我的承銷人代號</h2>
      <input id="seller-code" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${escapeHtml(state.sellerCode)}" data-act="seller" placeholder="四位數" />
      <p class="empty-hint" style="text-align:left;padding:8px 0 0">只存在這支手機，給拍賣員看的舉牌號碼。</p>
    </div>
    ${typeof renderSyncSettings === 'function' ? renderSyncSettings() : ''}
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
    ${HALVES.map((half) => {
      const title = half === 'fruit' ? '水果場品項（水果）'
        : half === 'afternoon' ? '下半場品項（瓜果、醃製；芋頭、蒜、青花、花椰菜、竹筍、蓮藕等屬瓜果）'
        : '上半場品項（大宗、水菜；香菇類屬大宗第一台）';
      const built = catalogSummary(half);
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
      <img class="setup-logo" src="icons/icon-192.png" alt="" width="96" height="96" />
      <h1>拍賣標貨助手</h1>
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
        ${itemNeedsSize(lot.item) ? renderSizeChips(lot.size || '', { lotId: lot.id, sheet: true }) : ''}
        <div class="move-lot-row">
          <div class="move-lot-label">移到別台</div>
          ${state.machines[lot.half || state.currentHalf].filter((m) => m.id !== lot.machineId).map((m) =>
            `<button type="button" class="action-btn" data-act="move-lot" data-id="${escapeHtml(lot.id)}" data-v="${escapeHtml(m.id)}">移到${escapeHtml(columnTitle(m, lot.half || state.currentHalf))}</button>`
          ).join('')}
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
    const picker = renderItemPicker(h, { active: lot?.item || '', lotId: modal.id || '', inSheet: true });
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>改品項${lot ? `　${lot.number}` : ''}</h3>
        ${picker}
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

  if (typeof handleSyncAction === 'function' && handleSyncAction(act, v, e)) return;

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
      variantPick = null;
      if (btn.dataset.id) {
        const lot = state.lots.find((l) => l.id === btn.dataset.id);
        if (lot) {
          if (modal?.type === 'pick-item') modal = null;
          applyItemToLot(lot, btn.dataset.name);
          render();
          break;
        }
      }
      assignItem(btn.dataset.name);
      break;
    case 'pick-crop': {
      if (ignoreItemClick) {
        ignoreItemClick = false;
        break;
      }
      const crop = findCrop(btn.dataset.crop, state.currentHalf) || findCrop(btn.dataset.crop);
      if (!crop) break;
      if (!shouldOpenVariants(crop, itemQuery)) {
        variantPick = null;
        const only = (crop.s || []).find((v) => !v.imp && v.l !== '其他' && v.n !== crop.n);
        const name = crop.l;
        if (btn.dataset.id) {
          const lot = state.lots.find((l) => l.id === btn.dataset.id);
          if (lot) {
            if (modal?.type === 'pick-item') modal = null;
            applyItemToLot(lot, name);
            render();
            break;
          }
        }
        assignItem(name);
        break;
      }
      variantPick = crop.n;
      render();
      break;
    }
    case 'close-vars':
      variantPick = null;
      render();
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
    case 'open-plan':
      openPlan();
      break;
    case 'close-plan':
      closePlan();
      break;
    case 'plan-add':
      planAddTarget = v === 'today' ? 'today' : 'tomorrow';
      addPlanItem(planAddTarget);
      break;
    case 'plan-target':
      planAddTarget = v === 'today' ? 'today' : 'tomorrow';
      render();
      break;
    case 'toggle-plan-picks':
      planPickOpen = !planPickOpen;
      render();
      break;
    case 'plan-pick':
      togglePlanPick(v);
      break;
    case 'plan-suggest':
      planDraft = '';
      addPlanText(v);
      render();
      break;
    case 'plan-done':
      setPlanDone(btn.dataset.id, true);
      break;
    case 'plan-undone':
      setPlanDone(btn.dataset.id, false);
      break;
    case 'plan-del':
      deletePlanItem(btn.dataset.id);
      break;
    case 'plan-qty-inc':
      bumpDraftQty(1);
      break;
    case 'plan-qty-dec':
      bumpDraftQty(-1);
      break;
    case 'plan-item-qty-inc':
      bumpPlanQty(btn.dataset.id, 1);
      break;
    case 'plan-item-qty-dec':
      bumpPlanQty(btn.dataset.id, -1);
      break;
    case 'set-draft-size':
      setDraftSize(v);
      buzz(8);
      break;
    case 'set-size':
      setLotSize(btn.dataset.id, v);
      buzz(8);
      break;
    case 'cycle-size':
      e.stopPropagation();
      if (ignoreLotClick || dragState) {
        ignoreLotClick = false;
        break;
      }
      cycleLotSize(btn.dataset.id);
      buzz(8);
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
    case 'move-lot':
      modal = null;
      moveLotToMachine(btn.dataset.id, v);
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
    case 'add-machine':
      addSessionMachine(btn.dataset.half || state.currentHalf);
      break;
    case 'remove-machine':
      removeSessionMachine(btn.dataset.half || state.currentHalf, btn.dataset.id);
      break;
    case 'half':
      if (!isHalf(v)) break;
      state.currentHalf = v;
      draftMachineId = '';
      showMachinePicker = false;
      progressPopId = null;
      draftItem = '';
      draftSize = '';
      itemQuery = '';
      variantPick = null;
      resetItemPickScroll = true;
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
  if (typeof handleSyncInput === 'function' && handleSyncInput(el, act)) return;
  if (act === 'item-search') {
    itemQuery = el.value;
    resetItemPickScroll = true;
    render();
    return;
  }
  if (act === 'draft-note') {
    draftNote = el.value;
    return;
  }
  if (act === 'plan-draft' || el.id === 'plan-input') {
    planDraft = el.value;
    render();
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


const HOLD_MS = 350;
const ITEM_HOLD_MS = 520;
const DRAG_SLOP = 12;

function eventPoint(e) {
  const tch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  if (tch) return { x: tch.clientX, y: tch.clientY, id: tch.identifier };
  return { x: e.clientX, y: e.clientY, id: e.pointerId };
}

function clearPressTimers() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  clearTimeout(armTimer);
  armTimer = null;
}

function cancelPress() {
  if (pressOrigin?.cell) pressOrigin.cell.classList.remove('armed');
  clearPressTimers();
  pressOrigin = null;
}

function lockLists() {
  document.documentElement.classList.add('is-dragging');
  document.querySelectorAll('.live-col-list').forEach((el) => {
    el.style.overflow = 'hidden';
  });
}

function cleanupDrag() {
  document.documentElement.classList.remove('is-dragging');
  document.querySelectorAll('.live-col-list').forEach((el) => {
    el.style.overflow = '';
  });
  if (dragState?.ghost) dragState.ghost.remove();
  document.querySelectorAll('.lot-cell.dragging, .lot-cell.armed, .live-col.drop-target, .live-col.dragging, .live-col.drop-before, .live-col.drop-after, .live-cols.drop-end').forEach((el) => {
    el.classList.remove('dragging', 'armed', 'drop-target', 'drop-before', 'drop-after', 'drop-end');
  });
  const capEl = dragState?.cell || dragState?.colEl;
  if (capEl && dragState?.pointerId != null && capEl.releasePointerCapture) {
    try { capEl.releasePointerCapture(dragState.pointerId); } catch { /* ignore */ }
  }
  dragState = null;
}

function columnAtPoint(x, y) {
  const stack = document.elementsFromPoint(x, y) || [];
  const col = stack.find((el) => el.classList && el.classList.contains('live-col'));
  return col || null;
}

function makeGhost(src, rect, className) {
  const ghost = src.cloneNode(true);
  ghost.classList.add(className);
  ghost.classList.remove('armed', 'dragging');
  ghost.querySelectorAll('.prog-pop').forEach((el) => el.remove());
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
  return ghost;
}

function maybeCapture(el) {
  if (pressOrigin?.pointerCap != null && el && el.setPointerCapture) {
    try { el.setPointerCapture(pressOrigin.pointerCap); return pressOrigin.pointerCap; } catch { /* ignore */ }
  }
  return null;
}

function startLotDrag(pt, cell, id) {
  if (dragState) return;
  clearPressTimers();
  ignoreLotClick = true;
  const rect = cell.getBoundingClientRect();
  const ghost = makeGhost(cell, rect, 'lot-ghost');
  cell.classList.add('dragging');
  cell.classList.remove('armed');
  lockLists();
  const cap = maybeCapture(cell);
  dragState = {
    kind: 'lot',
    id,
    cell,
    ghost,
    fromId: cell.closest('.live-col')?.dataset.id,
    pointerId: cap,
    grabX: pt.x - rect.left,
    grabY: pt.y - rect.top,
    startX: pt.x,
    startY: pt.y,
    lastX: pt.x,
    lastY: pt.y,
    moved: false
  };
  buzz(14);
  moveLotDrag(pt);
}

function moveLotDrag(pt) {
  if (!dragState) return;
  dragState.lastX = pt.x;
  dragState.lastY = pt.y;
  const dx = pt.x - dragState.startX;
  const dy = pt.y - dragState.startY;
  if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) dragState.moved = true;
  const g = dragState.ghost;
  if (g) {
    g.style.left = pt.x - dragState.grabX + 'px';
    g.style.top = pt.y - dragState.grabY + 'px';
  }
  const col = columnAtPoint(pt.x, pt.y);
  document.querySelectorAll('.live-col.drop-target').forEach((el) => {
    if (el !== col) el.classList.remove('drop-target');
  });
  if (col) col.classList.add('drop-target');
}

function endLotDrag(pt) {
  if (!dragState) return;
  const id = dragState.id;
  const fromId = dragState.fromId;
  const moved = dragState.moved;
  const x = pt && pt.x != null ? pt.x : dragState.lastX;
  const y = pt && pt.y != null ? pt.y : dragState.lastY;
  const col = columnAtPoint(x, y);
  const machineId = col?.dataset.id || col?.querySelector('.live-col-list')?.dataset.id;
  cleanupDrag();
  if (moved && machineId && machineId !== fromId) {
    moveLotToMachine(id, machineId);
  } else if (!moved) {
    openLotActions(id);
  } else {
    render();
  }
}

function startColDrag(pt, col, id) {
  if (dragState) return;
  clearPressTimers();
  const rect = col.getBoundingClientRect();
  const head = col.querySelector('.live-col-head');
  const headRect = head ? head.getBoundingClientRect() : rect;
  const ghost = makeGhost(head || col, {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: headRect.height
  }, 'col-ghost');
  col.classList.add('dragging');
  lockLists();
  const cap = maybeCapture(col);
  dragState = {
    kind: 'col',
    id,
    colEl: col,
    ghost,
    pointerId: cap,
    grabX: pt.x - rect.left,
    grabY: pt.y - rect.top,
    startX: pt.x,
    startY: pt.y,
    lastX: pt.x,
    lastY: pt.y,
    moved: false
  };
  buzz(14);
  moveColDrag(pt);
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

function moveColDrag(pt) {
  if (!dragState) return;
  dragState.lastX = pt.x;
  dragState.lastY = pt.y;
  const dx = pt.x - dragState.startX;
  const dy = pt.y - dragState.startY;
  if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) dragState.moved = true;
  const g = dragState.ghost;
  if (g) {
    g.style.left = pt.x - dragState.grabX + 'px';
    g.style.top = pt.y - dragState.grabY + 'px';
  }
  paintColDrop(columnInsertIndex(pt.x));
}

function endColDrag(pt) {
  if (!dragState) return;
  const id = dragState.id;
  const moved = dragState.moved;
  const x = pt && pt.x != null ? pt.x : dragState.lastX;
  const insertAt = columnInsertIndex(x);
  cleanupDrag();
  if (moved && reorderMachine(state.currentHalf, id, insertAt)) {
    saveState();
    buzz([16, 40, 24]);
    toast('已調整台的順序');
  }
  render();
}

function onPressStart(e, pt) {
  clearPressTimers();
  if (dragState) cleanupDrag();
  const target = e.target && e.target.nodeType === 1 ? e.target : document.elementFromPoint(pt.x, pt.y);
  pressOrigin = { x: pt.x, y: pt.y, pointerCap: e.pointerId };
  const itemBtn = target && target.closest && target.closest('[data-act="pick-item"]');
  const cell = target && target.closest && target.closest('[data-act="cycle-lot"]');
  const colHead = target && target.closest && target.closest('.live-col-head');
  if (itemBtn) {
    const name = itemBtn.dataset.name;
    const half = state.currentHalf;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      ignoreItemClick = true;
      openItemEditor(name, half);
    }, ITEM_HOLD_MS);
    return;
  }
  if (colHead && state.tab === 'live' && !showSettings && !modal && !(target.closest && target.closest('button, .prog-pop, input'))) {
    const col = colHead.closest('.live-col');
    const id = col && col.dataset.id;
    if (col && id) {
      pressOrigin.colEl = col;
      pressOrigin.colId = id;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!pressOrigin || pressOrigin.colId !== id || !col.isConnected || dragState) return;
        startColDrag({ x: pressOrigin.x, y: pressOrigin.y, id: pt.id }, col, id);
      }, HOLD_MS);
    }
    return;
  }
  if (cell && state.tab === 'live' && !showSettings && !modal) {
    const id = cell.dataset.id;
    pressOrigin.cell = cell;
    pressOrigin.id = id;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pressOrigin || pressOrigin.id !== id || !cell.isConnected || dragState) return;
      cell.classList.add('armed');
      startLotDrag({ x: pressOrigin.x, y: pressOrigin.y, id: pt.id }, cell, id);
    }, HOLD_MS);
  }
}

function onPressMove(e, pt) {
  if (dragState) {
    if (e.cancelable) e.preventDefault();
    if (dragState.kind === 'col') moveColDrag(pt);
    else moveLotDrag(pt);
    return;
  }
  if (!pressOrigin) return;
  const dx = pt.x - pressOrigin.x;
  const dy = pt.y - pressOrigin.y;
  const dist2 = dx * dx + dy * dy;
  if (pressOrigin.colEl && pressOrigin.colId) {
    if (dist2 > DRAG_SLOP * DRAG_SLOP && pressOrigin.colEl.isConnected) {
      if (e.cancelable) e.preventDefault();
      startColDrag(pt, pressOrigin.colEl, pressOrigin.colId);
    }
    return;
  }
  if (pressOrigin.cell && pressOrigin.id) {
    // Before the hold finishes, cancel and let the column scroll.
    if (dist2 > DRAG_SLOP * DRAG_SLOP) {
      pressOrigin.cell.classList.remove('armed');
      clearPressTimers();
      pressOrigin = { x: pressOrigin.x, y: pressOrigin.y };
    }
    return;
  }
  if (!longPressTimer) return;
  if (dist2 > 64) clearPressTimers();
}

function onPressEnd(e, pt) {
  if (dragState) {
    if (e.cancelable) e.preventDefault();
    if (dragState.kind === 'col') endColDrag(pt);
    else endLotDrag(pt);
    pressOrigin = null;
    return;
  }
  cancelPress();
}

function onTouchStart(e) {
  if (e.touches && e.touches.length > 1) {
    if (dragState) cleanupDrag();
    cancelPress();
    return;
  }
  onPressStart(e, eventPoint(e));
}

function onTouchMove(e) {
  onPressMove(e, eventPoint(e));
}

function onTouchEnd(e) {
  onPressEnd(e, eventPoint(e));
}

function onTouchCancel(e) {
  if (dragState) {
    const pt = { x: dragState.lastX, y: dragState.lastY };
    if (dragState.kind === 'col') endColDrag(pt);
    else endLotDrag(pt);
    pressOrigin = null;
    return;
  }
  cancelPress();
}

function onPointerDown(e) {
  if (e.pointerType === 'touch') return;
  onPressStart(e, eventPoint(e));
}

function onPointerMove(e) {
  if (e.pointerType === 'touch') return;
  onPressMove(e, eventPoint(e));
}

function onPointerUp(e) {
  if (e.pointerType === 'touch') return;
  onPressEnd(e, eventPoint(e));
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
  window.addEventListener('popstate', onPlanPopState);
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
    if (dragState || e.target.closest('.key, #paddle, .nav, .btn-save, .mini-paddle, .step-btn, .item-btn, .recent-chip, .lot-cell, .live-col, .live-col-head, .prio-hit')) {
      e.preventDefault();
    }
  });
  document.addEventListener('selectstart', (e) => {
    if (dragState || e.target.closest('.lot-cell, .live-col-head, .live-col-list')) e.preventDefault();
  });
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: false });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });
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
    if (act === 'plan-draft' || id === 'plan-input') {
      e.preventDefault();
      planDraft = e.target.value;
      addPlanItem(planAddTarget || 'tomorrow');
      return;
    }
    if (act === 'sync-join-input' || id === 'sync-join-code') {
      e.preventDefault();
      if (typeof joinSyncRoom === 'function') joinSyncRoom(e.target.value);
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
  applyPlanProgressFromLots();
  lastPlanEvents = [];
  draftPriority = state.lastPriority || 'watch';
  checkNewDay();
  bind();
  registerSW();
  if (typeof initSync === 'function') initSync();
  render();
}

init();
