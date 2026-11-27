'use strict';

const STORAGE_KEY = 'ty-auction-bid-v1';
const APP_VERSION = 'v114';
var lastAutoUpdateCheck = 0;
var updateInfo = { latest: '', checkedAt: 0, checkedLabel: '', busy: false };
const PURCHASE_WINDOW_DAYS = 30;
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
const TOMATO_SIZES = ['2L', 'L', 'M', 'S', '2S', '3S'];
const TOMATO_SIZE_FROM_OLD = { '大': 'L', '中': 'M', '小': 'S' };
const MUSHROOM_CROPS = ['金絲菇', '杏鮑菇', '其他菇類', '鴻喜菇', '濕木耳', '濕香菇', '洋菇', '秀珍菇', '草菇', '珊瑚菇', '蠔菇', '巴西蘑菇', '松茸', '柳松菇', '猴頭菇'];
const GOURD_FROM_BULK_CROPS = ['芋', '大蒜', '青花苔', '薑', '甘藷', '薯蕷', '豆薯', '菊芋'];
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

const ITEM_CANON_V85 = {
  '碗豆': '豌豆',
  '碗豆苗': '豌豆苗',
  '豌豆-豌豆苗': '豌豆苗',
  '豌豆 豌豆苗': '豌豆苗',
  '碗豆-豌豆苗': '豌豆苗',
  '碗豆 豌豆苗': '豌豆苗',
  '豌豆-進口豌豆苗': '進口豌豆苗',
  '碗豆-進口豌豆苗': '進口豌豆苗'
};

function canonicalItemName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return ITEM_CANON_V85[raw] || raw;
}

function findCropRaw(name, half) {
  name = canonicalItemName(name);
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

function isPromoVariety(crop, variety) {
  if (!crop || !variety) return false;
  return GRID_PROMOTIONS.some((p) => (
    p.cropN === crop.n && (p.varN === variety.n || p.l === variety.l || p.varN === variety.srcN)
  ));
}

const LEGACY_ITEM_DISPLAY = {
  '茭白筍': '美人腿',
  '茭白筍-帶殼': '美人腿 帶殼',
  '茭白筍-去殼': '美人腿 去殼',
  '茭白筍-進口': '進口美人腿'
};

/* Everyday names for varieties that stay in a parent sheet (not grid promotions). */
const EVERYDAY_VARIETY_LABELS = [
  { l: '紅椒', cropN: '甜椒', varN: '甜椒-彩椒紅色', a: ['彩椒紅色'] },
  { l: '黃椒', cropN: '甜椒', varN: '甜椒-彩椒黃色', a: ['彩椒黃色'] }
];

function everydayItemLabel(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n === '圓絲瓜') return n;
  const promo = GRID_PROMOTIONS.find((p) => p.l === n || p.varN === n);
  if (promo) return promo.l;
  const named = EVERYDAY_VARIETY_LABELS.find((p) => p.l === n || p.varN === n || (p.a || []).includes(n));
  return named ? named.l : '';
}

function itemDisplayNameRaw(name) {
  if (!name) return '';
  name = canonicalItemName(name);
  if (LEGACY_ITEM_DISPLAY[name]) return LEGACY_ITEM_DISPLAY[name];
  const everyday = everydayItemLabel(name);
  if (everyday) return everyday;
  const crop = findCrop(name);
  if (!crop) return name;
  if (name === crop.n || name === crop.l) return crop.l;
  const exactVar = (crop.s || []).find((x) => x.n === name || x.l === name);
  if (exactVar && exactVar.l && exactVar.l !== '其他' && exactVar.n !== crop.n && exactVar.l !== crop.l) {
    const label = everydayItemLabel(exactVar.n) || everydayItemLabel(exactVar.l);
    if (label) return label;
    return crop.l + ' ' + exactVar.l;
  }
  const aliased = (crop.s || []).find((x) => (x.a || []).includes(name));
  if (aliased && (aliased.n === crop.n || aliased.l === crop.l || aliased.l === '其他')) {
    if (name === '圓絲瓜') return name;
    return crop.l;
  }
  if (aliased && aliased.l && aliased.l !== '其他') {
    const label = everydayItemLabel(aliased.n) || everydayItemLabel(aliased.l) || everydayItemLabel(name);
    if (label) return label;
    return crop.l + ' ' + aliased.l;
  }
  return crop.l;
}

function itemCellName(name) {
  if (!name) return '';
  name = canonicalItemName(name);
  if (LEGACY_ITEM_DISPLAY[name]) return LEGACY_ITEM_DISPLAY[name];
  const everyday = everydayItemLabel(name);
  if (everyday) return everyday;
  const crop = findCrop(name);
  if (!crop) return name;
  if (name === crop.n || name === crop.l) return crop.l;
  const exactVar = (crop.s || []).find((x) => x.n === name || x.l === name);
  if (exactVar && exactVar.l && exactVar.l !== '其他' && exactVar.n !== crop.n && exactVar.l !== crop.l) {
    return everydayItemLabel(exactVar.n) || everydayItemLabel(exactVar.l) || exactVar.l;
  }
  if (name === '圓絲瓜') return name;
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
  if (crop.n && String(crop.n).startsWith('敏豆-')) fields.push('敏豆');
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
  if (!crop || crop.legacy) return false;
  if (isHiddenGridParent(crop)) return false;
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

function isTomatoCrop(name) {
  if (!name) return false;
  const crop = findCrop(name);
  if (crop) return crop.n === '番茄';
  const s = String(name);
  return s.includes('番茄') && !s.includes('小番茄');
}

function sizesForItem(name) {
  return isTomatoCrop(name) ? TOMATO_SIZES : ITEM_SIZES;
}

function normalizeSize(size, name) {
  if (size == null || size === '') return '';
  const raw = String(size).trim();
  if (!raw) return '';
  if (isTomatoCrop(name)) {
    if (TOMATO_SIZE_FROM_OLD[raw]) return TOMATO_SIZE_FROM_OLD[raw];
    return TOMATO_SIZES.includes(raw) ? raw : '';
  }
  return ITEM_SIZES.includes(raw) ? raw : '';
}

function sizeLabel(size, name) {
  return normalizeSize(size, name);
}

function defaultSizeForItem(name) {
  return isTomatoCrop(name) ? 'M' : '';
}

const GRID_PROMOTIONS = [
  { l: '甜豆', cropN: '豌豆', varN: '豌豆-甜豌豆' },
  { l: '紅花', cropN: '豌豆', varN: '豌豆-紅花' },
  { l: '荷蘭豆', cropN: '豌豆', varN: '豌豆-白花' },
  { l: '芥藍芽', cropN: '芥藍菜', varN: '芥藍菜-芥藍芽' }
];

/* Parents whose everyday varieties are already top-level buttons. Hidden
   from the grid; search still lists the individual variety buttons. */
const HIDDEN_GRID_PARENTS = new Set(['豌豆']);

function isHiddenGridParent(crop) {
  return !!(crop && !crop.promo && (HIDDEN_GRID_PARENTS.has(crop.n) || HIDDEN_GRID_PARENTS.has(crop.l)));
}

function cropParentNameMatchesQuery(crop, q) {
  q = String(q || '').trim();
  if (!crop || !q) return false;
  const fields = [crop.n, crop.l, ...(crop.a || [])];
  return fields.some((f) => f && (q.length >= 2 ? String(f).includes(q) : f === q || String(f).startsWith(q)));
}

function promotionCrops(half, q, counts) {
  const h = half || (state && state.currentHalf) || 'morning';
  const out = [];
  for (const p of GRID_PROMOTIONS) {
    const crop = findCrop(p.cropN);
    if (!crop) continue;
    if (halfFromCatalogKey(crop.h) !== h) continue;
    const v = (crop.s || []).find((x) => x.n === p.varN);
    if (!v) continue;
    const promo = {
      n: p.l,
      l: p.l,
      g: crop.g,
      h: crop.h,
      v: Number(v.v) || 0,
      s: [],
      a: [...new Set([v.l, v.n, ...(v.a || []), p.l])],
      promo: true,
      promoCrop: crop.n,
      promoVar: v.n
    };
    const qq = String(q || '').trim();
    if (qq && !cropMatchesQuery(promo, q) && !cropParentNameMatchesQuery(crop, q)) continue;
    if (!qq && !cropShownOnGrid(promo, counts)) continue;
    out.push(promo);
  }
  return out;
}

function isImportPotato(crop) {
  return !!(crop && (crop.n === '馬鈴薯-進口' || crop.l === '進口馬鈴薯'));
}

function itemSortVolume(crop) {
  if (isImportPotato(crop)) {
    const potato = typeof findCrop === 'function' ? findCrop('馬鈴薯') : null;
    return Number((potato && potato.v) || crop.v || 0);
  }
  return Number((crop && crop.v) || 0);
}

function itemSortTie(crop) {
  if (isImportPotato(crop)) return 1;
  if (crop && (crop.n === '馬鈴薯' || crop.l === '馬鈴薯')) return 0;
  return 0;
}


function emptyItemOrderMap() {
  return { fruit: {}, morning: {}, afternoon: {} };
}

function normalizeItemOrderMap(raw) {
  const out = emptyItemOrderMap();
  if (!raw || typeof raw !== 'object') return out;
  for (const half of HALVES) {
    const src = raw[half];
    out[half] = {};
    if (!src || typeof src !== 'object') continue;
    for (const [group, arr] of Object.entries(src)) {
      if (!group || !Array.isArray(arr)) continue;
      const seen = new Set();
      const list = [];
      for (const name of arr) {
        const n = String(name || '').trim();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        list.push(n);
      }
      if (list.length) out[half][group] = list;
    }
  }
  return out;
}

function ensureItemOrderMap() {
  if (!state.itemOrderByHalf) state.itemOrderByHalf = emptyItemOrderMap();
  for (const half of HALVES) {
    if (!state.itemOrderByHalf[half] || typeof state.itemOrderByHalf[half] !== 'object') {
      state.itemOrderByHalf[half] = {};
    }
  }
  return state.itemOrderByHalf;
}

function itemOrderOf(half, group) {
  const map = ensureItemOrderMap();
  const h = half || (state && state.currentHalf) || 'morning';
  const list = map[h] && map[h][group];
  return Array.isArray(list) ? list : [];
}

function mergeSavedNameOrder(defaultNames, saved) {
  if (!saved || !saved.length) return defaultNames.slice();
  const current = defaultNames.map((n) => String(n));
  const currentSet = new Set(current);
  const kept = saved.filter((n) => currentSet.has(n));
  if (!kept.length) return current;
  const keptSet = new Set(kept);
  const result = kept.slice();
  for (const name of current) {
    if (keptSet.has(name)) continue;
    const volIdx = current.indexOf(name);
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      if (current.indexOf(result[i]) > volIdx) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, name);
  }
  return result;
}

function applySavedItemOrder(list, half) {
  if (!list || !list.length) return list;
  const groups = [];
  const buckets = new Map();
  for (const crop of list) {
    const g = crop.g || '';
    if (!buckets.has(g)) {
      buckets.set(g, []);
      groups.push(g);
    }
    buckets.get(g).push(crop);
  }
  const out = [];
  for (const g of groups) {
    const bucket = buckets.get(g);
    const byLabel = new Map();
    for (const crop of bucket) {
      if (!byLabel.has(crop.l)) byLabel.set(crop.l, crop);
    }
    const defaultNames = bucket.map((c) => c.l);
    const ordered = mergeSavedNameOrder(defaultNames, itemOrderOf(half, g));
    const used = new Set();
    for (const name of ordered) {
      const crop = byLabel.get(name);
      if (!crop || used.has(crop)) continue;
      used.add(crop);
      out.push(crop);
    }
    for (const crop of bucket) {
      if (!used.has(crop)) out.push(crop);
    }
  }
  return out;
}

function applySavedNameList(names, half, group, cmp) {
  const def = names.slice();
  if (typeof cmp === 'function') def.sort(cmp);
  return mergeSavedNameOrder(def, itemOrderOf(half, group));
}

function setItemOrder(half, group, names) {
  const map = ensureItemOrderMap();
  const h = half || state.currentHalf;
  if (!map[h]) map[h] = {};
  const seen = new Set();
  const list = [];
  for (const name of names || []) {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    list.push(n);
  }
  if (list.length) map[h][group] = list;
  else delete map[h][group];
}

function renameItemOrderKey(half, oldName, newName) {
  const map = ensureItemOrderMap();
  const groups = map[half || state.currentHalf];
  if (!groups) return;
  for (const arr of Object.values(groups)) {
    if (!Array.isArray(arr)) continue;
    const i = arr.indexOf(oldName);
    if (i >= 0) arr[i] = newName;
  }
}

function removeItemOrderKey(half, name) {
  const map = ensureItemOrderMap();
  const groups = map[half || state.currentHalf];
  if (!groups) return;
  for (const group of Object.keys(groups)) {
    const arr = groups[group];
    if (!Array.isArray(arr)) continue;
    groups[group] = arr.filter((n) => n !== name);
    if (!groups[group].length) delete groups[group];
  }
}

function itemOrderHasCustom(half, group) {
  const map = ensureItemOrderMap();
  if (!half) {
    return HALVES.some((h) => Object.keys(map[h] || {}).length);
  }
  if (!group) return Object.keys(map[half] || {}).length > 0;
  return !!(map[half] && Array.isArray(map[half][group]) && map[half][group].length);
}

const ITEM_ORDER_SECTIONS = [
  { half: 'fruit', group: '水果', label: '水果場・水果' },
  { half: 'fruit', group: '自己輸入', label: '水果場・自己輸入' },
  { half: 'morning', group: '大宗', label: '上半場・大宗' },
  { half: 'morning', group: '水菜', label: '上半場・水菜' },
  { half: 'morning', group: '自己輸入', label: '上半場・自己輸入' },
  { half: 'afternoon', group: '瓜果', label: '下半場・瓜果' },
  { half: 'afternoon', group: '醃製', label: '下半場・醃製' },
  { half: 'afternoon', group: '自己輸入', label: '下半場・自己輸入' }
];

function resetItemOrder(half, group) {
  const map = ensureItemOrderMap();
  if (!half) {
    state.itemOrderByHalf = emptyItemOrderMap();
    saveState();
    toast('已恢復全部交易量排序');
    return;
  }
  if (!map[half]) map[half] = {};
  if (group) {
    delete map[half][group];
    saveState();
    toast('已恢復' + group + '交易量排序');
    return;
  }
  map[half] = {};
  saveState();
  toast('已恢復交易量排序');
}

function renderItemOrderSettings() {
  const rows = ITEM_ORDER_SECTIONS.map((s) => {
    const on = itemOrderHasCustom(s.half, s.group);
    return `<div class="item-order-row">
      <div class="lbl">${escapeHtml(s.label)}${on ? '<span class="item-order-flag">已調整</span>' : ''}</div>
      <button type="button" class="btn" data-act="reset-item-order" data-half="${s.half}" data-group="${escapeHtml(s.group)}" ${on ? '' : 'disabled'}>恢復</button>
    </div>`;
  }).join('');
  const any = itemOrderHasCustom();
  return `<div class="setting-block item-order-block">
    <h2>品項按鈕順序</h2>
    <p class="sub">在抄號長按約 0.4 秒後拖曳，可改同一個分類裡的按鈕位置。會同步到隊友的手機。還沒拖過的新品項會依交易量插入。</p>
    <button type="button" class="btn item-order-reset-all" data-act="reset-item-order" ${any ? '' : 'disabled'}>全部恢復交易量排序</button>
    ${rows}
  </div>`;
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
  let list = dedupeCrops(catalogCrops(h).filter((c) => !c.legacy && cropMatchesQuery(c, q)));
  if (!String(q || '').trim()) {
    list = list.filter((c) => cropShownOnGrid(c, counts));
  }
  list = list.concat(promotionCrops(h, q, counts));
  /* Official buttons are one merged list per section, strictly by 桃農
     12-month volume (high first). Usage counts must not change this order. */
  list.sort((a, b) => {
    const ga = ranks[a.g] ?? 9;
    const gb = ranks[b.g] ?? 9;
    if (ga !== gb) return ga - gb;
    const va = itemSortVolume(a);
    const vb = itemSortVolume(b);
    const za = va > 0 ? 0 : 1;
    const zb = vb > 0 ? 0 : 1;
    if (za !== zb) return za - zb;
    if (vb !== va) return vb - va;
    const ta = itemSortTie(a);
    const tb = itemSortTie(b);
    if (ta !== tb) return ta - tb;
    return String(a.l).localeCompare(String(b.l), 'zh-Hant');
  });
  if (!String(q || '').trim()) list = applySavedItemOrder(list, h);
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
  const crops = dedupeCrops(catalogCrops(half)).filter((c) => !c.legacy);
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

function pinnedPickerVariants(crop) {
  const out = [];
  if (!crop) return out;
  if (crop.n === '絲瓜') {
    const main = (crop.s || []).find((v) => v.n === '絲瓜' && !v.imp);
    if (main) {
      out.push(Object.assign({}, main, {
        n: '圓絲瓜',
        l: '圓絲瓜',
        a: [...new Set([...(main.a || []), '圓絲瓜', '絲瓜'])]
      }));
    }
    const long = (crop.s || []).find((v) => v.n === '絲瓜-長絲瓜' || v.l === '長絲瓜');
    if (long) out.push(long);
  }
  if (crop.n === '蕨菜' || crop.l === '過貓') {
    const shan = (crop.s || []).find((v) => v.n === '蕨菜-山蘇' || v.l === '山蘇');
    if (shan) out.push(shan);
  }
  if (crop.n === '豌豆') {
    const sweet = (crop.s || []).find((v) => v.n === '豌豆-甜豌豆' || v.l === '甜豌豆');
    if (sweet) {
      out.push(Object.assign({}, sweet, {
        n: '甜豆',
        l: '甜豆',
        srcN: sweet.n,
        a: [...new Set([...(sweet.a || []), '甜豆', '甜豌豆'])]
      }));
    }
    const dutch = (crop.s || []).find((v) => v.n === '豌豆-白花' || v.l === '白花');
    if (dutch) {
      out.push(Object.assign({}, dutch, {
        n: '荷蘭豆',
        l: '荷蘭豆',
        srcN: dutch.n,
        a: [...new Set([...(dutch.a || []), '荷蘭豆', '白花'])]
      }));
    }
  }
  if (crop.n === '芥藍菜' || crop.l === '芥藍') {
    const sprout = (crop.s || []).find((v) => v.n === '芥藍菜-芥藍芽' || v.l === '芥藍芽');
    if (sprout) {
      out.push(Object.assign({}, sprout, {
        n: '芥藍芽',
        l: '芥藍芽',
        srcN: sprout.n,
        a: [...new Set([...(sprout.a || []), '芥藍芽'])]
      }));
    }
  }
  if (crop.n === '甜椒' || crop.l === '甜椒') {
    for (const named of EVERYDAY_VARIETY_LABELS.filter((p) => p.cropN === '甜椒')) {
      const src = (crop.s || []).find((v) => v.n === named.varN || v.l === named.l || (v.a || []).includes(named.l));
      if (!src) continue;
      out.push(Object.assign({}, src, {
        n: named.l,
        l: named.l,
        srcN: src.n,
        a: [...new Set([...(src.a || []), named.l, ...(named.a || [])])]
      }));
    }
    const mixed = (crop.s || []).find((v) => v.n === '甜椒-彩色種' || v.l === '彩色種');
    if (mixed) out.push(mixed);
  }
  return out;
}

function pickerVariants(crop, q) {
  const pinned = pinnedPickerVariants(crop);
  const sig = significantVariants(crop);
  const seen = new Set(pinned.flatMap((v) => [v.n, v.srcN].filter(Boolean)));
  const out = pinned.slice();
  for (const v of sig) {
    if (!seen.has(v.n)) {
      out.push(v);
      seen.add(v.n);
    }
  }
  q = String(q || '').trim();
  if (q) {
    const extra = (crop.s || []).filter((v) => (
      (usefulVariant(v, crop) || pinned.some((p) => p.n === v.n)) && variantMatchesQuery(v, q)
    ));
    for (const v of extra) {
      if (!seen.has(v.n)) {
        out.push(v);
        seen.add(v.n);
      }
    }
  }
  return out;
}

function shouldListSearchVariety(crop, v, q) {
  q = String(q || '').trim();
  if (!crop || !v || !q) return false;
  if (GRID_PROMOTIONS.some((p) => p.cropN === crop.n && (p.varN === v.n || p.l === v.l || (v.a || []).includes(p.l)))) return false;
  const varHit = variantMatchesQuery(v, q);
  const parentNameHit = cropParentNameMatchesQuery(crop, q);
  if (isHiddenGridParent(crop) && (parentNameHit || cropMatchesQuery(crop, q))) {
    const fields = [v.l, ...(v.a || [])];
    const labelHit = fields.some((f) => f && (q.length >= 2 ? String(f).includes(q) : f === q || String(f).startsWith(q)));
    if (labelHit) return true;
    /* Searching 豌豆/碗豆 also lists leftover ≥500 varieties (imports). */
    if (parentNameHit) return (Number(v.v) || 0) >= VOLUME_GRID_MIN;
    return false;
  }
  return usefulVariant(v, crop) && varHit;
}

function shouldOpenVariants(crop, q) {
  const vars = pickerVariants(crop, q);
  if (vars.length > 1) return true;
  if (pinnedPickerVariants(crop).length && vars.length >= 1) return true;
  return false;
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
  let customs = customItemsOf(h)
    .map((n) => String(n || '').trim())
    .filter((n) => n && !builtSet.has(n))
    .filter((n) => {
      if (!q) return true;
      if (q.length >= 2) return n.includes(q);
      return n === q || n.startsWith(q);
    });
  if (!String(q || '').trim()) {
    customs = applySavedNameList(customs, h, '自己輸入', (a, b) => (itemSessionScore(b, h) - itemSessionScore(a, h)) || a.localeCompare(b, 'zh-Hant'));
  } else {
    customs.sort((a, b) => (itemSessionScore(b, h) - itemSessionScore(a, h)) || a.localeCompare(b, 'zh-Hant'));
  }

  const crops = visibleCrops(h, q);
  const parts = [];
  if (customs.length) {
    parts.push('<div class="item-group-h">自己輸入</div>');
    for (const name of customs) {
      const on = active === name ? ' on' : '';
      const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
      const need = needBadgeHtml([name]);
      parts.push(
        `<button type="button" class="item-btn custom${on}${need.cls}" data-act="pick-item" data-name="${escapeHtml(name)}" data-group="自己輸入"${lotAttr}>${escapeHtml(name)}${need.html}</button>`
      );
    }
  }

  let lastGroup = null;
  for (const crop of crops) {
    if (crop.g !== lastGroup) {
      lastGroup = crop.g;
      parts.push(`<div class="item-group-h">${escapeHtml(crop.g)}</div>`);
    }
    if (crop.promo) {
      const on = active === crop.l || active === crop.n ? ' on' : '';
      const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
      const need = needBadgeHtml([crop.l, crop.n, crop.promoVar]);
      parts.push(
        `<button type="button" class="item-btn${on}${need.cls}${peelClass(crop.l)}" data-act="pick-item" data-name="${escapeHtml(crop.l)}" data-group="${escapeHtml(crop.g || '')}"${lotAttr}>${escapeHtml(crop.l)}${need.html}</button>`
      );
      continue;
    }
    const lotAttr = lotId ? ` data-id="${escapeHtml(lotId)}"` : '';
    if (!isHiddenGridParent(crop)) {
      const on = itemIsActive(crop, active) ? ' on' : '';
      const badge = shouldOpenVariants(crop, q) ? '<span class="var-n">▾</span>' : '';
      const need = needBadgeHtml([crop.l, crop.n]);
      parts.push(
        `<button type="button" class="item-btn${on}${need.cls}${peelClass(crop.n)}" data-act="pick-crop" data-crop="${escapeHtml(crop.n)}" data-name="${escapeHtml(crop.l)}" data-group="${escapeHtml(crop.g || '')}"${lotAttr}>${escapeHtml(crop.l)}${badge}${need.html}</button>`
      );
    }
    if (q) {
      for (const v of (crop.s || [])) {
        if (!shouldListSearchVariety(crop, v, q)) continue;
        const von = active === v.n || active === v.l || (v.a || []).includes(active) ? ' on' : '';
        const baseLabel = v.l || v.n;
        const vlabel = (v.imp && baseLabel && !String(baseLabel).startsWith('進口')) ? ('進口 ' + baseLabel) : baseLabel;
        const vneed = needBadgeHtml([v.n, v.l, vlabel]);
        parts.push(
          `<button type="button" class="item-btn${von}${vneed.cls}${peelClass(v.n)}" data-act="pick-item" data-name="${escapeHtml(v.n)}" data-group="${escapeHtml(crop.g || '')}"${lotAttr}>${escapeHtml(vlabel)}${vneed.html}</button>`
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
        `<button type="button" class="item-btn${active === crop.l || active === crop.n ? ' on' : ''}${peelClass(crop.n)}" data-act="pick-item" data-name="${escapeHtml(crop.l)}"${lotAttr}>不指定品種</button>`
      ];
      for (const v of vars) {
        const on = active === v.n || active === v.l || (v.a || []).includes(active) ? ' on' : '';
        const imp = v.imp ? ' imp' : '';
        let label = v.l || '';
        if (v.imp) {
          const rest = String(label).replace(/^進口\s*/, '');
          label = rest ? '進口 ' + rest : '進口';
        }
        const vneed = needBadgeHtml([v.n, v.l, label, crop.l, crop.n]);
        vBtns.push(
          `<button type="button" class="item-btn${on}${imp}${vneed.cls}${peelClass(v.n)}" data-act="pick-item" data-name="${escapeHtml(v.n)}"${lotAttr}>${escapeHtml(label)}${vneed.html}</button>`
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
      <div class="item-search-wrap">${iconSvg('search')}<input id="${searchId}" class="item-search" type="search" enterkeyhint="search" placeholder="搜尋品項" value="${escapeHtml(q)}" data-act="item-search" autocomplete="off" /></div>
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
  /* 下半場 瓜果: every 台 runs on its own and jumps to its next segment at the tail.
     第一台 starts at 50xx (not fixed, e.g. 5001 or 5150) then 6001.
     第二台 starts at 2500, at its tail jumps to 5001.
     第三台 starts at 2000/2001, at its tail jumps to 6001.
     5xxx is shared by 第一台 and 第二台, 6xxx by 第一台 and 第三台, so the 台
     always comes from the one picked, never from the number alone. */
  afternoon: [
    {
      id: 'a1',
      name: '第一台・瓜果',
      ranges: [
        { start: 5001, end: 5999 },
        { start: 6001, end: 6999 }
      ]
    },
    {
      id: 'a2',
      name: '第二台・瓜果',
      ranges: [
        { start: 2500, end: 4999 },
        { start: 5001, end: 5999 }
      ]
    },
    {
      id: 'a3',
      name: '第三台・瓜果',
      ranges: [
        { start: 2000, end: 2499 },
        { start: 6001, end: 6999 }
      ]
    }
  ]
};

const OLD_AFTERNOON_DEFAULT_RANGES = {
  a1: [[2001, 2499], [6001, 6999]],
  a2: [[2500, 5049]],
  a3: [[5050, 5999]]
};

/* Move 下半場 台別 to the real mechanism, but only for people who still have
   the old built-in numbers. Anything they typed in themselves stays as it is. */
function migrateAfternoonV96(merged) {
  const list = merged && merged.machines && merged.machines.afternoon;
  if (!Array.isArray(list)) return false;
  const key = (m) => JSON.stringify(((m && m.ranges) || [])
    .filter((r) => r && r.start != null)
    .map((r) => [Number(r.start), r.end == null ? null : Number(r.end)]));
  const ids = Object.keys(OLD_AFTERNOON_DEFAULT_RANGES);
  if (list.length !== ids.length) return false;
  for (const id of ids) {
    const m = list.find((x) => x && x.id === id);
    if (!m || key(m) !== JSON.stringify(OLD_AFTERNOON_DEFAULT_RANGES[id])) return false;
  }
  for (const m of list) {
    const fresh = DEFAULT_MACHINES.afternoon.find((x) => x.id === m.id);
    if (fresh) m.ranges = structuredClone(fresh.ranges);
  }
  return true;
}

function afternoonRangeKey(m) {
  return JSON.stringify(((m && m.ranges) || [])
    .filter((r) => r && r.start != null)
    .map((r) => [Number(r.start), r.end == null ? null : Number(r.end)]));
}

function afternoonRangesAreDefault() {
  const list = state && state.machines && state.machines.afternoon;
  if (!Array.isArray(list)) return false;
  for (const fresh of DEFAULT_MACHINES.afternoon) {
    const m = list.find((x) => x && x.id === fresh.id);
    if (!m || afternoonRangeKey(m) !== afternoonRangeKey(fresh)) return false;
  }
  return list.length === DEFAULT_MACHINES.afternoon.length;
}

/* Old 下半場 scheme: a1 was 20xx then 60xx, a2 a 25xx–50xx block, a3 a 50xx–5999 block.
   Also treat near-defaults (a3 starting 5050/50xx, a2 start like 5030) as the old scheme. */
function afternoonLooksLikeOldScheme(list) {
  if (!Array.isArray(list) || list.length !== 3) return false;
  const by = (id) => list.find((x) => x && x.id === id);
  const a1 = by('a1');
  const a2 = by('a2');
  const a3 = by('a3');
  if (!a1 || !a2 || !a3) return false;
  if (afternoonRangeKey(a1) === afternoonRangeKey(DEFAULT_MACHINES.afternoon[0])
    && afternoonRangeKey(a2) === afternoonRangeKey(DEFAULT_MACHINES.afternoon[1])
    && afternoonRangeKey(a3) === afternoonRangeKey(DEFAULT_MACHINES.afternoon[2])) {
    return false;
  }
  const starts = (m) => ((m.ranges || []).filter((r) => r && r.start != null).map((r) => Number(r.start)));
  const ends = (m) => ((m.ranges || []).filter((r) => r && r.end != null).map((r) => Number(r.end)));
  const a1s = starts(a1);
  const a2s = starts(a2);
  const a3s = starts(a3);
  const a1e = ends(a1);
  const a2e = ends(a2);
  const a3e = ends(a3);
  const a1old = a1s.some((n) => n >= 2000 && n <= 2499) && a1s.some((n) => n >= 6000 && n <= 6099)
    && !a1s.some((n) => n >= 5001 && n <= 5200);
  const a2old = a2s.length >= 1 && a2s[0] >= 2500 && a2s[0] <= 5099
    && (a2e.length === 0 || a2e[0] >= 4999 && a2e[0] <= 5999)
    && !a2s.some((n) => n >= 2000 && n <= 2499);
  const a3old = a3s.length >= 1 && a3s[0] >= 5000 && a3s[0] <= 5199
    && (a3e.length === 0 || a3e[0] === 5999)
    && !a3s.some((n) => n >= 2000 && n <= 2499);
  return a1old && a2old && a3old;
}

function applyAfternoonDefaultRanges(list) {
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (const m of list) {
    const fresh = DEFAULT_MACHINES.afternoon.find((x) => x.id === m.id);
    if (fresh && afternoonRangeKey(m) !== afternoonRangeKey(fresh)) {
      m.ranges = structuredClone(fresh.ranges);
      changed = true;
    }
  }
  return changed;
}

function migrateAfternoonV98(merged) {
  const list = merged && merged.machines && merged.machines.afternoon;
  if (!afternoonLooksLikeOldScheme(list)) return false;
  return applyAfternoonDefaultRanges(list);
}

function auctionDayStartMs(day) {
  const iso = String(day || (state && state.day) || '');
  const p = iso.split('-').map(Number);
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return 0;
  const cutoff = (typeof dayCutoffHour === 'function') ? dayCutoffHour() : 15;
  const d = new Date(p[0], p[1] - 1, p[2]);
  if (cutoff > 0) {
    d.setDate(d.getDate() - 1);
    d.setHours(cutoff, 0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function isStaleProgressAt(at, day) {
  const t = Number(at);
  if (!Number.isFinite(t)) return true;
  const start = auctionDayStartMs(day);
  return start > 0 && t < start;
}

function resetHalfProgress(half) {
  if (!state) return;
  if (!state.currentNumbers) state.currentNumbers = {};
  if (!state.progressAnchors) state.progressAnchors = {};
  if (!state.seriesPath) state.seriesPath = {};
  state.currentNumbers[half] = defaultCurrents(state.machines)[half];
  state.progressAnchors[half] = defaultAnchors(state.machines)[half];
  state.seriesPath[half] = defaultSeriesPath(state.machines)[half];
}

/* First v98 open of an auction day with no 抄號 yet: drop leftover/auto-advanced
   numbers (and stale shared progress) so prefills can apply. */
function cleanNewDayProgressIfNeeded() {
  if (!state) return false;
  const day = state.day;
  if (!day) return false;
  if (state.v98ProgressCleaned === day) return false;
  const hasLots = (state.lots || []).some((l) => l && l.day === day);
  if (hasLots) {
    state.v98ProgressCleaned = day;
    return false;
  }
  state.currentNumbers = defaultCurrents(state.machines);
  state.progressAnchors = defaultAnchors(state.machines);
  state.seriesPath = defaultSeriesPath(state.machines);
  state.seriesPlans = defaultSeriesPlans(state.machines);
  state.machineMerges = defaultMachineMerges(state.machines);
  state.gpIgnoreBefore = Date.now();
  state.v98ProgressCleaned = day;
  applyFixedStartPrefills();
  if (typeof gpSeedKnown === 'function') gpSeedKnown();
  if (typeof syncProgressTimer === 'function') syncProgressTimer();
  return true;
}

function adoptNewAfternoonRanges() {
  if (!state || !state.machines) return false;
  if (afternoonRangesAreDefault()) {
    toast('已經是新的下半場號碼');
    return false;
  }
  applyAfternoonDefaultRanges(state.machines.afternoon);
  resetHalfProgress('afternoon');
  applyFixedStartPrefills();
  state.gpIgnoreBefore = Date.now();
  if (typeof gpSeedKnown === 'function') gpSeedKnown();
  if (typeof syncProgressTimer === 'function') syncProgressTimer();
  saveState();
  toast('已改成新的下半場號碼。第二台 2500，第三台 2000，第一台先留空');
  render();
  return true;
}

let state;
let draftNum = '';
let draftNote = '';
let draftShowNote = false;
let draftSize = '';
let draftMachineId = '';
let planOpen = false;
let planHistoryPushed = false;
let paddleHistoryPushed = false;
let planDraft = '';
let planQty = 1;
let planPickOpen = false;
let planAddTarget = 'today';
let planGridTab = 'bulk';
let planGridOpen = false;
let planVariantPick = null;
let planGridScroll = 0;
let planBodyScroll = 0;
let sumBodyScroll = 0;
let pageScrollY = 0;
let mainScrollTop = 0;
let mainScrollKey = '';
let lastPaintHtml = { header: '', nav: '', main: '', paddle: '', modal: '', plan: '', sum: '' };
let planUndo = null;
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
let editStart = null; // { half, machineId, value, jumpValue, focus }
let draftItem = '';
let itemLocked = false;
let rangeMode = false;
let rangeStart = '';
let rangeEnd = '';
let rangeFocus = 'start';
const RANGE_MAX = 50;
let itemTargetId = null;
let itemTargetAuto = false;
let orientationLocked = false;
let ignoreItemClick = false;
let ignoreRecentClick = false;
let ignoreHoldClick = false;
let showDaySummary = false;
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

const DEFAULT_DAY_CUTOFF_HOUR = 15;
const DEFAULT_LOTS_PER_MIN = 4;
const PROGRESS_MIN = 1;
const PROGRESS_MAX = 9999;
let clockNow = null;
let pendingDayRollover = false;

function nowDate() {
  return clockNow instanceof Date && !Number.isNaN(clockNow.getTime())
    ? new Date(clockNow.getTime())
    : new Date();
}

function setAuctionNow(value) {
  if (value == null || value === '') {
    clockNow = null;
    return null;
  }
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  clockNow = Number.isNaN(d.getTime()) ? null : d;
  return clockNow;
}

function calendarDayStr(d) {
  d = d || nowDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayCutoffHour() {
  const h = Number(state && state.dayCutoffHour);
  if (Number.isFinite(h) && h >= 0 && h <= 23) return Math.floor(h);
  return DEFAULT_DAY_CUTOFF_HOUR;
}

function todayStr(d) {
  d = d || nowDate();
  const cutoff = (typeof state === 'undefined' || !state) ? DEFAULT_DAY_CUTOFF_HOUR : dayCutoffHour();
  if (cutoff > 0 && d.getHours() >= cutoff) {
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return calendarDayStr(next);
  }
  return calendarDayStr(d);
}

function cutoffHourLabel(h) {
  h = Number(h);
  if (!Number.isFinite(h)) h = DEFAULT_DAY_CUTOFF_HOUR;
  h = Math.max(0, Math.min(23, Math.floor(h)));
  if (h === 0) return '午夜 0 點';
  if (h === 12) return '中午 12 點';
  if (h < 12) return '上午 ' + h + ' 點';
  return '下午 ' + (h - 12) + ' 點';
}

function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d}（${WEEKDAYS[dt.getDay()]}）`;
}

function thumbHand() {
  return state && state.thumbHand === 'right' ? 'right' : 'left';
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

function isBeforeDayCutoff(d) {
  d = d || nowDate();
  return todayStr(d) === calendarDayStr(d);
}

function defaultPlanAddTarget() {
  return 'today';
}

/* Before the auction-day cutoff, a same-calendar-day 明日 備註 is usually
   a leftover from the old noon default. After cutoff, 明日 is the day after
   the upcoming auction, so leave it alone. */
function promoteMisfiledTomorrowPlans() {
  if (!state || !Array.isArray(state.planItems) || !isBeforeDayCutoff()) return false;
  const today = todayStr();
  const tomo = tomorrowStr(today);
  let changed = false;
  for (const p of state.planItems) {
    if (!p || p.done) continue;
    if (p.forDay !== tomo) continue;
    if (p.createdOn && p.createdOn !== today) continue;
    p.forDay = today;
    changed = true;
  }
  return changed;
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
      lockCount: Number(raw.lockCount) || 0,
      purpose: raw.purpose === 'delivery' ? 'delivery' : 'retail'
    };
    if (item.done && item.doneOn && item.doneOn < cut) continue;
    out.push(item);
  }
  return out;
}

function lotPlanText(lot) {
  if (!lot || !lot.item) return '';
  const name = itemDisplayName(lot.item);
  const size = itemNeedsSize(lot.item) && sizeLabel(lot.size, lot.item) ? ' ' + sizeLabel(lot.size, lot.item) : '';
  return String(name + size).trim();
}

function planQtyOf(p) {
  const n = parseInt(p && p.qty, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(99, n) : 1;
}

function planPurposeOf(p) {
  return p && p.purpose === 'delivery' ? 'delivery' : 'retail';
}

function planPurposeLabel(p) {
  return planPurposeOf(p) === 'delivery' ? '交貨' : '零賣';
}

function togglePlanPurpose(id) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) return;
  const snap = snapshotPlanItems();
  item.purpose = planPurposeOf(item) === 'delivery' ? 'retail' : 'delivery';
  saveState();
  offerPlanUndo(snap, `${item.text}　改為${planPurposeLabel(item)}`);
  buzz(24);
  render();
}

function bestMatchingOpenPlan(item, size) {
  if (!item) return null;
  const lot = { item, size: size || '' };
  const today = todayStr();
  const plans = (state.planItems || []).filter((p) => p && !p.done && p.forDay <= today);
  let best = null;
  let bestScore = 0;
  for (const p of plans) {
    const sc = planLotMatchScore(p, lot);
    if (sc > bestScore) {
      bestScore = sc;
      best = p;
    } else if (sc === bestScore && sc > 0 && best && planPurposeOf(p) === 'delivery' && planPurposeOf(best) !== 'delivery') {
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

function applyPlanPurposeToLot(lot) {
  if (!lot || !lot.item) return;
  const plan = bestMatchingOpenPlan(lot.item, lot.size);
  if (plan && planPurposeOf(plan) === 'delivery') lot.priority = 'skip';
}

function applyPlanPurposeToDraft(item, size) {
  const plan = bestMatchingOpenPlan(item, size);
  if (plan && planPurposeOf(plan) === 'delivery') {
    draftPriority = 'skip';
    state.lastPriority = 'skip';
  }
}

function lotQty(lot) {
  const n = parseInt(lot && lot.qty, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(99, n) : 1;
}

function planWonPieces(p, wonMap) {
  const ids = (wonMap && p && wonMap.get(p.id)) || [];
  const byId = wonMap && wonMap._byId;
  let n = 0;
  for (const id of ids) {
    const lot = byId ? byId.get(id) : (state.lots || []).find((l) => l.id === id);
    n += lotQty(lot);
  }
  return n;
}

function parsePlanItemText(text) {
  let raw = String(text || '').trim().replace(/\s+/g, ' ');
  let size = '';
  let name = raw;
  const sizeBit = '(2L|2S|3S|L|M|S|[大中小])';
  const paren = raw.match(new RegExp('^(.*?)[（(]\\s*' + sizeBit + '\\s*[）)]\\s*$'));
  if (paren && String(paren[1] || '').trim()) {
    name = paren[1].trim();
    size = paren[2];
  } else {
    const spaced = raw.match(new RegExp('^(.*)\\s' + sizeBit + '\\s*$'));
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


/* 下半場 瓜果 buttons: typical peel/skin color. Only 瓜果, not 醃製. */
const GOURD_PEEL_CROP = {
  '花椰菜': 'cream',
  '甘藷': 'copper',
  '馬鈴薯': 'tan',
  '青花苔': 'darkGreen',
  '球莖甘藍': 'paleGreen',
  '結頭菜': 'paleGreen',
  '大蒜': 'white',
  '芋': 'tan',
  '竹筍': 'paleYellow',
  '薑': 'tan',
  '萵苣莖': 'paleGreen',
  'A菜心': 'paleGreen',
  '萵筍': 'paleGreen',
  '大心菜': 'paleGreen',
  '菜心': 'paleGreen',
  '薯蕷': 'tan',
  '山藥': 'tan',
  '豆薯': 'tan',
  '蓮藕': 'tan',
  '蘆筍': 'green',
  '牛蒡': 'tan',
  '菊芋': 'tan',
  '玉米': 'yellow',
  '番茄': 'red',
  '小黃瓜': 'green',
  '南瓜': 'orange',
  '絲瓜': 'green',
  '苦瓜': 'paleGreen',
  '茄子': 'purple',
  '甜椒': 'green',
  '紅椒': 'red',
  '黃椒': 'yellow',
  '扁蒲': 'paleGreen',
  '蒲仔': 'paleGreen',
  '胡瓜': 'green',
  '大黃瓜': 'green',
  '冬瓜': 'darkGreen',
  '敏豆': 'green',
  '隼人瓜': 'paleGreen',
  '佛手瓜': 'paleGreen',
  '菜豆': 'green',
  '美人腿': 'cream',
  '辣椒': 'chili',
  '豌豆': 'green',
  '豌豆苗': 'green',
  '甜豆': 'green',
  '紅花': 'red',
  '荷蘭豆': 'green',
  '四季豆': 'green',
  '醜豆': 'green',
  '翼豆': 'green',
  '粉豆': 'pink',
  '青豆': 'green',
  '進口敏豆': 'green',
  '蓮子': 'cream',
  '秋葵': 'green',
  '毛豆': 'green',
  '萊豆': 'green',
  '皇帝豆': 'green',
  '落花生': 'tan',
  '花生': 'tan',
  '虎豆': 'brown',
  '金針花': 'orange',
  '越瓜': 'paleGreen',
  '鵲豆': 'brown',
  '洛神花': 'crimson',
  '花豆': 'brick',
  '石蓮花': 'sage',
  '藤川七': 'green',
  '其他花類': 'lilac',
  '樊花': 'lilac',
  '瓊花': 'lilac',
  '百果': 'lilac',
  '蠶豆': 'green'
};

const GOURD_PEEL_VARIANT = {
  '甘藷-臺農66號': 'copper',
  '甘藷-臺農57號': 'gold',
  '甘藷-芋仔甘薯': 'purple',
  '甘藷-芋仔甘藷': 'purple',
  '大蒜-蒜苔': 'paleGreen',
  '大蒜-蔥蒜': 'paleGreen',
  '薑-嫩薑': 'pink',
  '薑-粉薑': 'pink',
  '薑-老薑': 'brown',
  '薑-薑黃': 'gold',
  '薯蕷-白薯蕷': 'cream',
  '薯蕷-白薯蕷人參': 'cream',
  '薯蕷-紅薯蕷': 'copper',
  '蓮藕-蓮子': 'cream',
  '蘆筍-綠蘆筍': 'green',
  '蘆筍-白蘆筍': 'cream',
  '玉米-糯米黑': 'darkViolet',
  '玉米-白龍王': 'white',
  '玉米-超甜白': 'white',
  '玉米-糯米白': 'white',
  '玉米-白玉米': 'white',
  '玉米-玉米筍': 'paleYellow',
  '玉米-玉米筍 帶殼': 'paleGreen',
  '番茄-牛蕃茄': 'red',
  '番茄-黑柿': 'blackRed',
  '番茄-粉柿': 'pink',
  '南瓜-青如意': 'green',
  '南瓜-栗子小黑': 'darkViolet',
  '南瓜-東昇': 'orange',
  '苦瓜-白大米': 'paleGreen',
  '苦瓜-青大米': 'green',
  '苦瓜-翠綠': 'green',
  '苦瓜-山苦瓜': 'darkGreen',
  '茄子-胭脂茄': 'crimson',
  '甜椒-青椒': 'green',
  '甜椒-彩色種': 'orange',
  '甜椒-水果彩椒': 'orange',
  '甜椒-彩椒橘色': 'orange',
  '甜椒-彩椒紅色': 'red',
  '紅椒': 'red',
  '彩椒紅色': 'red',
  '甜椒-彩椒黃色': 'yellow',
  '黃椒': 'yellow',
  '彩椒黃色': 'yellow',
  '甜椒-彩椒其他': 'orange',
  '甜椒-新香': 'green',
  '冬瓜-白皮': 'white',
  '冬瓜-青皮': 'darkGreen',
  '冬瓜-毛瓜': 'paleGreen',
  '敏豆-白豆': 'white',
  '敏豆-粉豆': 'pink',
  '敏豆-醜豆': 'green',
  '敏豆-翼豆': 'green',
  '敏豆-青豆': 'green',
  '菜豆-青色': 'green',
  '菜豆-紅色': 'red',
  '菜豆-白色': 'white',
  '辣椒-朝天椒': 'chili',
  '辣椒-糯米椒': 'paleYellow',
  '辣椒-紅小': 'red',
  '辣椒-青小': 'green',
  '辣椒-青龍': 'green',
  '辣椒-雞心': 'red',
  '越瓜-青色': 'paleGreen',
  '越瓜-白色': 'white',
  '絲瓜-白瓜': 'white',
  '絲瓜-角瓜': 'green',
  '絲瓜-長絲瓜': 'green',
  '花椰菜-青梗': 'cream',
  '花椰菜-白梗': 'cream',
  '竹筍-烏殼綠': 'paleYellow',
  '竹筍-麻竹筍': 'paleYellow',
  '竹筍-綠竹筍': 'paleYellow',
  '竹筍-去殼': 'paleYellow',
  '竹筍-孟宗筍': 'paleYellow',
  '竹筍-桂竹筍': 'paleYellow',
  '竹筍-箭竹筍': 'paleYellow',
  '青花苔-青花筍': 'darkGreen'
};



const FRUIT_PEEL_CROP = {
  '雜柑': 'lemon',
  '木瓜': 'amber',
  '番石榴': 'paleGreen',
  '紅龍果': 'magenta',
  '西瓜': 'darkGreen',
  '香蕉': 'yellow',
  '小番茄': 'red',
  '鳳梨': 'gold',
  '柚子': 'paleYellow',
  '洋香瓜': 'tan',
  '酪梨': 'darkGreen',
  '百香果': 'darkViolet',
  '梨': 'tan',
  '栗子': 'brown',
  '芒果': 'copper',
  '椪柑': 'orange',
  '甜瓜': 'paleYellow',
  '葡萄': 'purple',
  '椰子': 'green',
  '黃金果': 'gold',
  '桶柑': 'orange',
  '茂谷柑': 'orange',
  '草莓': 'red',
  '桃子': 'pink',
  '波蘿蜜': 'paleGreen',
  '釋迦': 'green',
  '柿子': 'orange',
  '李': 'red',
  '佛利蒙柑': 'orange',
  '甜橙': 'orange',
  '棗子': 'green',
  '梅': 'paleGreen',
  '榴槤蜜': 'brown',
  '葡萄柚': 'paleYellow',
  '紅毛丹': 'red',
  '蛋黃果': 'gold',
  '珍珠柑': 'orange',
  '龍眼': 'tan',
  '蘋果': 'red',
  '枇杷': 'orange',
  '柑橘': 'orange',
  '荔枝': 'red',
  '紅柑': 'orange',
  '橄欖': 'darkGreen',
  '樹葡萄': 'darkViolet',
  '蓮霧': 'red',
  '虎頭柑': 'orange',
  '楊梅': 'crimson',
  '甘蔗': 'green',
  '奇異果': 'brown',
  '山竹': 'darkViolet',
  '桑椹': 'darkViolet',
  '楊桃': 'paleYellow',
  '榴槤': 'brown',
  '櫻桃': 'red',
  '海梨': 'tan',
  '溫州柑': 'orange',
  '石榴': 'crimson',
  '艷陽柑': 'orange',
  '藍莓': 'darkViolet',
  '蜜棗': 'paleGreen',
  '西施柚': 'paleYellow',
  '香櫞': 'paleYellow',
  '香瓜梨': 'cream'
};

const FRUIT_PEEL_VARIANT = {
  '雜柑-無子檸檬': 'lemon',
  '雜柑-桔子': 'orange',
  '雜柑-檸檬': 'lemon',
  '雜柑-黃金檸檬': 'gold',
  '雜柑-金棗': 'gold',
  '木瓜-青木瓜': 'paleGreen',
  '木瓜-網室紅肉': 'amber',
  '木瓜-一般紅肉': 'amber',
  '木瓜-日昇種': 'amber',
  '番石榴-珍珠芭': 'paleGreen',
  '番石榴-帝王芭': 'paleGreen',
  '番石榴-紅心芭': 'paleGreen',
  '番石榴-水晶無子': 'paleGreen',
  '番石榴-世紀芭': 'paleGreen',
  '番石榴-水晶無仔': 'paleGreen',
  '紅龍果-紅肉': 'magenta',
  '紅龍果-白肉': 'magenta',
  '紅龍果-雙色': 'magenta',
  '西瓜-甜美人': 'darkGreen',
  '西瓜-黃肉': 'darkGreen',
  '西瓜-鳳光英妙': 'darkGreen',
  '西瓜-大西瓜': 'darkGreen',
  '西瓜-無子西瓜': 'darkGreen',
  '西瓜-黑美人': 'darkGreen',
  '西瓜-紅肉': 'darkGreen',
  '西瓜-秀鈴': 'darkGreen',
  '香蕉-旦蕉': 'yellow',
  '香蕉-越旦': 'yellow',
  '香蕉-芭蕉': 'yellowGreen',
  '小番茄-聖女': 'red',
  '小番茄-玉女': 'red',
  '小番茄-一般': 'red',
  '小番茄-嬌女': 'red',
  '鳳梨-金鑽鳳梨': 'gold',
  '鳳梨-牛奶鳳梨': 'cream',
  '鳳梨-甜蜜蜜': 'gold',
  '鳳梨-蘋果鳳梨': 'gold',
  '鳳梨-西瓜鳳梨': 'gold',
  '柚子-文旦': 'paleYellow',
  '柚子-西施柚': 'paleYellow',
  '柚子-白柚': 'cream',
  '柚子-紅柚': 'pink',
  '洋香瓜-新疆': 'gold',
  '洋香瓜-新彊': 'gold',
  '洋香瓜-網狀綠肉': 'tan',
  '洋香瓜-阿露斯': 'tan',
  '洋香瓜-網狀紅肉': 'tan',
  '洋香瓜-網狀白肉': 'tan',
  '洋香瓜-光面綠肉': 'paleGreen',
  '洋香瓜-光面白肉': 'cream',
  '洋香瓜-光面紅肉': 'gold',
  '芒果-愛文': 'red',
  '芒果-芒果青': 'green',
  '芒果-金煌': 'yellowGreen',
  '芒果-夏雪': 'paleYellow',
  '芒果-玉文': 'red',
  '芒果-西施': 'yellowGreen',
  '芒果-凱特': 'green',
  '芒果-本島': 'green',
  '芒果-聖心': 'red',
  '芒果-黑香金興': 'brown',
  '芒果-黑香、金興': 'brown',
  '梨-寶島甘露梨': 'tan',
  '梨-雪梨': 'cream',
  '梨-豐水梨': 'tan',
  '梨-4029梨': 'tan',
  '梨-新興梨': 'tan',
  '梨-橫山梨': 'tan',
  '梨-蜜梨': 'cream',
  '梨-世紀梨': 'tan',
  '梨-幸水梨': 'tan',
  '梨-秋水梨': 'tan',
  '梨-鳥梨': 'tan',
  '蘋果-金冠': 'gold',
  '蘋果-五爪': 'red',
  '蘋果-惠': 'red',
  '蘋果-秋香': 'yellowGreen',
  '蘋果-富士進口': 'red',
  '蘋果-紅玉(進口)': 'red',
  '蘋果-金冠(進口)': 'gold',
  '蘋果-陸奧(進口)': 'yellowGreen',
  '李-紅肉李': 'red',
  '李-黃肉李': 'gold',
  '李-加州李': 'darkViolet',
  '李-桃接李': 'red',
  '甜橙-柳橙': 'orange',
  '甜橙-紅肉柳橙': 'brick',
  '甜橙-晚崙西亞': 'orange',
  '葡萄柚-白肉': 'paleYellow',
  '葡萄柚-紅寶石': 'pink',
  '葡萄柚-紅肉': 'pink',
  '蓮霧-紅蓮霧': 'red',
  '蓮霧-翠玉': 'green',
  '蓮霧-黑糖芭比': 'blackRed',
  '蓮霧-子彈型': 'red',
  '蓮霧-巴掌蓮霧': 'red',
  '荔枝-玉荷包': 'pink',
  '荔枝-黑葉': 'blackRed',
  '荔枝-竹葉黑': 'blackRed',
  '荔枝-桂味': 'red',
  '荔枝-糯米': 'red',
  '釋迦-鳳梨釋迦': 'green',
  '柿子-甜柿': 'orange',
  '柿子-柿餅': 'orange',
  '柿子-水柿': 'orange',
  '柿子-秋柿': 'orange',
  '柿子-筆柿': 'orange',
  '柿子-紅柿': 'orange',
  '桃子-甜桃': 'pink',
  '桃子-水蜜桃': 'pink',
  '桃子-早桃': 'pink',
  '甘蔗-帶皮': 'green',
  '甘蔗-削皮': 'cream',
  '楊桃-紅龍': 'gold',
  '楊桃-軟枝、蜜絲': 'paleYellow',
  '楊桃-馬來亞種': 'paleYellow',
  '葡萄-巨峰': 'purple',
  '葡萄-無子': 'green',
  '葡萄-意大利': 'green',
  '葡萄-蜜紅': 'red',
  '紅柑-美女柑': 'orange',
  '香櫞-佛手': 'paleYellow',
  '香瓜梨-人蔘果': 'cream',
  '龍眼-粉殼': 'tan',
  '龍眼-龍眼肉': 'cream',
  '蛋黃果-仙桃': 'gold'
};


const LEAFY_PEEL_CROP = {
  '萵苣菜': 'paleGreen',
  '大陸妹': 'paleGreen',
  '青蔥': 'midGreen',
  '蔥': 'midGreen',
  '小白菜': 'midGreen',
  '甘藷葉': 'green',
  '地瓜葉': 'green',
  '芥菜': 'paleGreen',
  '菠菜': 'darkGreen',
  '蕹菜': 'midGreen',
  '空心菜': 'midGreen',
  '芹菜': 'paleGreen',
  '青江白菜': 'paleGreen',
  '青江菜': 'paleGreen',
  '芥藍菜': 'darkGreen',
  '芥藍': 'darkGreen',
  '芥藍芽': 'youngGreen',
  '茼蒿': 'midGreen',
  '油菜': 'midGreen',
  '韭菜': 'darkGreen',
  '莧菜': 'paleGreen',
  '九層塔': 'midGreen',
  '芫荽': 'midGreen',
  '香菜': 'midGreen',
  '皇宮菜': 'green',
  '紅鳳菜': 'purple',
  '蕨菜': 'darkGreen',
  '過貓': 'darkGreen',
  '海菜': 'paleGreen',
  '水蓮': 'paleGreen',
  '茴香': 'midGreen',
  '巴西利': 'darkGreen',
  '菾菜': 'green',
  '塌棵菜': 'darkGreen',
  '羅勒': 'midGreen',
  '黑甜仔菜': 'darkViolet',
  '人參葉': 'midGreen',
  '珍珠菜': 'paleGreen',
  '薺菜': 'midGreen',
  '藤三七': 'green',
  '西洋菜': 'midGreen',
  '豬母菜': 'green',
  '香椿': 'copper'
};

const LEAFY_PEEL_VARIANT = {
  '芥藍菜-芥藍芽': 'youngGreen',
  '芥藍芽': 'youngGreen',
  '萵苣菜-油麥菜': 'paleGreen',
  '萵苣菜-結球萵': 'white',
  '萵苣菜-進口結球萵': 'white',
  '萵苣菜-本島圓葉': 'midGreen',
  '萵苣菜-本島尖葉': 'midGreen',
  '萵苣菜-進口本島圓葉': 'midGreen',
  '萵苣菜-進口本島尖葉': 'midGreen',
  '萵苣菜-蘿美': 'midGreen',
  '萵苣菜-進口蘿美': 'midGreen',
  '萵苣菜-水耕': 'paleGreen',
  '萵苣菜-紅捲': 'crimson',
  '萵苣菜-綠捲': 'green',
  '萵苣菜-紅捲、綠捲': 'pink',
  '萵苣菜-廣東菜': 'paleGreen',
  '萵苣菜-廣東萵': 'paleGreen',
  '萵苣菜-進口廣東萵': 'paleGreen',
  '萵苣菜-進口油麥菜': 'paleGreen',
  '青蔥-粉蔥': 'midGreen',
  '青蔥-北蔥': 'midGreen',
  '青蔥-大蔥': 'midGreen',
  '青蔥-日蔥': 'midGreen',
  '青蔥-進口蔥': 'midGreen',
  '青蔥-紅蔥頭': 'crimson',
  '青蔥-珠蔥': 'white',
  '小白菜-蚵仔白': 'midGreen',
  '小白菜-土白菜': 'midGreen',
  '小白菜-奶油白': 'paleGreen',
  '小白菜-水耕': 'paleGreen',
  '芥菜-大芥菜': 'paleGreen',
  '芥菜-翡翠娃娃菜': 'paleGreen',
  '芥菜-芥菜仁': 'cream',
  '芥菜-小芥菜': 'midGreen',
  '芥菜-水耕': 'paleGreen',
  '芹菜-白梗': 'paleGreen',
  '芹菜-西洋芹菜': 'midGreen',
  '芹菜-芹菜管': 'paleGreen',
  '芹菜-青梗': 'green',
  '芹菜-山芹菜': 'darkGreen',
  '芹菜-水耕': 'paleGreen',
  '油菜-小松菜': 'darkGreen',
  '油菜-油菜花': 'yellow',
  '韭菜-青頭': 'darkGreen',
  '韭菜-韭菜花': 'paleYellow',
  '韭菜-白頭': 'paleGreen',
  '韭菜-韭菜黃': 'paleYellow',
  '莧菜-白莧菜': 'paleGreen',
  '莧菜-紅莧菜': 'crimson',
  '莧菜-水耕': 'paleGreen',
  '紅鳳菜-白鳳菜': 'paleGreen',
  '蕨菜-過貓': 'green',
  '蕨菜-山蘇': 'darkGreen',
  '海菜-水蓮': 'paleGreen',
  '海菜-海帶': 'brown',
  '海菜-龍鬚菜': 'green'
};


const BULK_PEEL_CROP = {
  '甘藍': 'paleGreen',
  '高麗菜': 'paleGreen',
  '包心白菜': 'cream',
  '大白菜': 'cream',
  '蘿蔔': 'white',
  '白蘿蔔': 'white',
  '胡蘿蔔': 'orange',
  '洋蔥': 'goldenBrown',
  '大心菜': 'midGreen',
  '香茅': 'paleYellow',
  '晚香玉筍': 'cream',
  '百合': 'white',
  '金針筍': 'paleYellow',
  '半天筍': 'paleYellow',
  '半天花': 'paleYellow',
  '慈菇': 'tan',
  '馬鈴薯': 'tan',
  '進口馬鈴薯': 'tan',
  '馬鈴薯-進口': 'tan',
  '甘蔗筍': 'paleYellowGreen',
  '芽菜類': 'cream',
  '草石蠶': 'beige',
  '荸薺': 'brown',
  '菱角': 'purpleBlack',
  '蕎頭': 'white',
  '金絲菇': 'white',
  '金針菇': 'white',
  '杏鮑菇': 'beige',
  '其他菇類': 'brown',
  '鴻喜菇': 'tan',
  '濕木耳': 'darkBrown',
  '木耳': 'darkBrown',
  '濕香菇': 'brown',
  '香菇': 'brown',
  '洋菇': 'cream',
  '秀珍菇': 'beige',
  '草菇': 'brown',
  '珊瑚菇': 'white',
  '蠔菇': 'beige',
  '巴西蘑菇': 'brown',
  '松茸': 'brown',
  '柳松菇': 'amber',
  '猴頭菇': 'cream'
};

const BULK_PEEL_VARIANT = {
  '甘藍-初秋': 'paleGreen',
  '甘藍-改良尖': 'paleGreen',
  '甘藍-改良種': 'paleGreen',
  '甘藍-進口初秋': 'paleGreen',
  '甘藍-進口改良種': 'paleGreen',
  '甘藍-進口改良尖': 'paleGreen',
  '甘藍-紫色': 'purple',
  '甘藍-進口紫色': 'purple',
  '甘藍-甘藍芽': 'paleYellowGreen',
  '甘藍-進口甘藍芽': 'paleYellowGreen',
  '甘藍-甘藍心': 'cream',
  '甘藍-進口甘藍心': 'cream',
  '甘藍-甜甘藍': 'paleGreen',
  '包心白菜-包白': 'cream',
  '包心白菜-進口包白': 'cream',
  '包心白菜-包頭蓮': 'paleYellowGreen',
  '包心白菜-進口包頭蓮': 'paleYellowGreen',
  '包心白菜-冬白芽': 'cream',
  '包心白菜-天津白': 'cream',
  '包心白菜-進口天津白': 'cream',
  '包心白菜-大土': 'cream',
  '包心白菜-成功白': 'cream',
  '蘿蔔-矸仔': 'white',
  '蘿蔔-白玉': 'white',
  '蘿蔔-甜菜根': 'crimson',
  '蘿蔔-櫻桃': 'red',
  '蘿蔔-青色': 'green',
  '胡蘿蔔-清洗': 'orange',
  '胡蘿蔔-未洗': 'orange',
  '洋蔥-本產': 'goldenBrown',
  '洋蔥-進口': 'goldenBrown',
  '洋蔥-紫洋蔥': 'purple',
  '紫洋蔥': 'purple',
  '大心菜-帶葉': 'midGreen',
  '芽菜類-綠豆芽': 'cream',
  '芽菜類-黃豆芽': 'paleYellow',
  '芽菜類-苜蓿芽': 'paleGreen',
  '芽菜類-蘿蔔嬰': 'paleGreen',
  '芽菜類-豌豆芽': 'midGreen',
  '草石蠶-冬蟲夏草': 'brown',
  '菱角-生菱角': 'purpleBlack',
  '菱角-去殼': 'cream',
  '菱角-熟菱角': 'brown',
  '金絲菇-金針菇': 'white',
  '金絲菇-盒裝': 'white',
  '杏鮑菇-盒裝': 'beige',
  '鴻喜菇-盒裝': 'tan',
  '濕木耳-盒裝': 'darkBrown',
  '洋菇-盒裝': 'cream',
  '蠔菇-鮑魚菇': 'beige',
  '秀珍菇-盒裝': 'beige',
  '珊瑚菇-盒裝': 'white',
  '巴西蘑菇-盒裝': 'brown',
  '松茸-盒裝': 'brown',
  '柳松菇-盒裝': 'amber',
  '猴頭菇-盒裝': 'cream'
};

function isPeelCrop(crop) {
  if (!crop) return false;
  if (crop.h === 'a' && crop.g === '瓜果') return true;
  if (crop.h === 'f' && (crop.g === '水果' || !crop.g)) return true;
  if (crop.g === '水菜' || crop.g === '大宗') return true;
  return false;
}

function peelHintFromLabel(label) {
  const s = String(label || '');
  if (!s || /^其他/.test(s)) return '';
  if (/黑|紫/.test(s)) return 'darkViolet';
  if (/粉/.test(s)) return 'pink';
  if (/橘|橙/.test(s)) return 'orange';
  if (/黃/.test(s)) return 'gold';
  if (/紅/.test(s)) return 'red';
  if (/白/.test(s)) return 'white';
  if (/青|綠/.test(s)) return 'green';
  return '';
}

function peelVariantTone(key) {
  if (!key) return '';
  return GOURD_PEEL_VARIANT[key] || FRUIT_PEEL_VARIANT[key] || LEAFY_PEEL_VARIANT[key] || BULK_PEEL_VARIANT[key] || '';
}

function peelCropTone(crop) {
  if (!crop) return '';
  return GOURD_PEEL_CROP[crop.n] || FRUIT_PEEL_CROP[crop.n] || LEAFY_PEEL_CROP[crop.n] || BULK_PEEL_CROP[crop.n]
    || GOURD_PEEL_CROP[crop.l] || FRUIT_PEEL_CROP[crop.l] || LEAFY_PEEL_CROP[crop.l] || BULK_PEEL_CROP[crop.l] || '';
}

function peelToneOf(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const parsed = (typeof parsePlanItemText === 'function') ? parsePlanItemText(raw) : { name: raw };
  const key = parsed.name || raw;
  const everyday = (typeof everydayItemLabel === 'function') ? everydayItemLabel(key) || everydayItemLabel(raw) : '';
  if (everyday) {
    const everydayTone = GOURD_PEEL_CROP[everyday] || FRUIT_PEEL_CROP[everyday]
      || LEAFY_PEEL_CROP[everyday] || BULK_PEEL_CROP[everyday];
    if (everydayTone) return everydayTone;
  }
  const mapped = peelVariantTone(key) || peelVariantTone(raw);
  if (mapped) {
    const cropGuess = (typeof findCrop === 'function') ? (findCrop(key) || findCrop(raw)) : null;
    if (cropGuess && !isPeelCrop(cropGuess)) return '';
    return mapped;
  }
  const lot = (typeof resolveLotItem === 'function') ? resolveLotItem(key) : null;
  let crop = lot && lot.crop;
  let variety = lot && lot.variety;
  if (!crop && typeof findCrop === 'function') crop = findCrop(key);
  if (!crop && typeof resolvePlanName === 'function') {
    const resolved = resolvePlanName(key);
    crop = resolved && resolved.crop;
    variety = variety || (resolved && resolved.variety);
  }
  if (!isPeelCrop(crop)) return '';
  if (variety && usefulVariant(variety, crop)) {
    const vn = variety.n;
    const vl = variety.l;
    const fromVar = peelVariantTone(vn) || peelVariantTone(vl);
    if (fromVar) return fromVar;
    const hinted = peelHintFromLabel(vl);
    if (hinted) return hinted;
  }
  return peelCropTone(crop);
}

function peelClass(name) {
  const tone = peelToneOf(name);
  return tone ? ` peel peel-${tone}` : '';
}

function resolveLotItem(item) {
  const name = canonicalItemName(item);
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

/* Plan rows added from the 備註 variety sheet only keep the bare variety label
   (白梗, 小葉 …), and several crops share one label. Compare plan and lot on
   those labels too, so a 白梗 plan row still counts a 芹菜-白梗 lot. */
function foldPlanText(s) {
  return String(s || '').trim().replace(/湿/g, '濕').replace(/\s+/g, ' ');
}

function lotMatchLabels(lot, lotRes) {
  const out = new Set();
  const add = (v) => {
    const t = foldPlanText(v);
    if (t) out.add(t);
  };
  add(itemDisplayName(lot.item));
  add(lot.item);
  add(itemCellName(lot.item));
  add(lotPlanText(lot));
  const v = lotRes && lotRes.variety;
  if (v) {
    add(v.n);
    add(v.l);
    for (const a of v.a || []) add(a);
  }
  return out;
}

/* v109: the score only depends on the plan text and the lot's item+size, and
   the catalog never changes while the app runs, so remember it. Matching every
   won lot against every plan row used to cost ~150 ms per call on a busy day. */
const planScoreMemo = new Map();
function planLotMatchScore(plan, lot) {
  if (!plan || !lot || !lot.item) return 0;
  const key = String(plan.text) + '\u0001' + String(lot.item) + '\u0001' + String(lot.size || '');
  let hit = planScoreMemo.get(key);
  if (hit === undefined) {
    if (planScoreMemo.size > 20000) planScoreMemo.clear();
    hit = planLotMatchScoreRaw(plan, lot);
    planScoreMemo.set(key, hit);
  }
  return hit;
}

function planLotMatchScoreRaw(plan, lot) {
  if (!plan || !lot || !lot.item) return 0;
  const parsed = parsePlanItemText(foldPlanText(plan.text));
  const lotItem = foldPlanText(lot.item);
  const resolved = resolvePlanName(parsed.name);
  const lotRes = resolveLotItem(lotItem);
  const crop = lotRes.crop;
  const variety = lotRes.variety;
  const lotSize = itemNeedsSize(lot.item) || (crop && itemNeedsSize(crop.n)) || (crop && itemNeedsSize(crop.l)) ? sizeLabel(lot.size, lot.item) : '';
  if (parsed.size) {
    if (normalizeSize(parsed.size, lot.item) !== lotSize) return 0;
  }
  if (resolved.level === 'variety' && resolved.crop && resolved.variety) {
    if (crop && crop.n === resolved.crop.n && variety && variety.n === resolved.variety.n) {
      return parsed.size ? 40 : 30;
    }
  } else if (resolved.level === 'crop' && resolved.crop) {
    if (crop && crop.n === resolved.crop.n && !(variety && isPromoVariety(crop, variety))) {
      return parsed.size ? 20 : 10;
    }
  }
  const labels = lotMatchLabels(lot, lotRes);
  if (labels.has(parsed.name) || labels.has(parsed.raw)) return parsed.size ? 25 : 15;
  return 0;
}

function todayWonLots() {
  const today = todayStr();
  const day = (state && state.day) || today;
  /* v114: only today's 標到 count toward 今日預計 / 買超過 (yesterday's used to be
     added too, so 買超過 could show more pieces than were bought today). */
  return (state.lots || []).filter((l) => (
    isWon(l) && l.item && (l.day === today || l.day === day)
  ));
}

function autoManagedPlans() {
  const today = todayStr();
  return (state.planItems || []).filter((p) => {
    if (!p || p.forDay > today) return false;
    if (p.done && p.doneOn && p.doneOn < today && p.forDay < today) return false;
    return true;
  });
}

let planAssignCache = null; // { sig, map, badges, badgesToday }
let renderPassActive = false;

/* Everything assignWonToPlans / planRemainBadgeMap read, as one short string.
   Same string => same answer, so the heavy work can be skipped. */
function planAssignSignature() {
  const today = todayStr();
  const day = (state && state.day) || today;
  const parts = [today, day];
  for (const l of state.lots || []) {
    if (!l || !l.item || !(l.status === 'won' || l.status === 'moved')) continue;
    if (l.day !== today && l.day !== day) continue;
    parts.push(l.id, l.item, l.size || '', l.qty == null ? '' : l.qty);
  }
  parts.push('|');
  for (const p of state.planItems || []) {
    if (!p) continue;
    parts.push(p.id, p.text, p.qty == null ? '' : p.qty, p.forDay || '', p.done ? 1 : 0, p.doneOn || '');
  }
  return parts.join('\u0002');
}

function assignWonToPlans() {
  const sig = planAssignSignature();
  if (planAssignCache && planAssignCache.sig === sig) return planAssignCache.map;
  const plans = autoManagedPlans();
  const lots = todayWonLots();
  const map = new Map();
  const byId = new Map();
  for (const l of lots) byId.set(l.id, l);
  for (const p of plans) map.set(p.id, []);
  const have = (id) => map.get(id).reduce((sum, lid) => sum + lotQty(byId.get(lid)), 0);
  for (const lot of lots) {
    let best = null;
    let bestScore = 0;
    for (const p of plans) {
      const sc = planLotMatchScore(p, lot);
      if (sc > bestScore) {
        bestScore = sc;
        best = p;
      } else if (sc === bestScore && sc > 0 && best) {
        const needB = Math.max(0, planQtyOf(best) - have(best.id));
        const needP = Math.max(0, planQtyOf(p) - have(p.id));
        if (needP > 0 && needB === 0) best = p;
      }
    }
    if (best && bestScore > 0) map.get(best.id).push(lot.id);
  }
  map._byId = byId;
  planAssignCache = { sig, map, badges: null, badgesToday: '', renderPass: 0 };
  return map;
}


let renderPassId = 0;
function planRemainBadgeMap() {
  /* Inside one render() nothing changes, so every item button can share one map. */
  if (renderPassActive && planAssignCache && planAssignCache.badges && planAssignCache.renderPass === renderPassId) {
    return planAssignCache.badges;
  }
  const wonMap = assignWonToPlans();
  const today = todayStr();
  if (planAssignCache && planAssignCache.badges && planAssignCache.badgesToday === today) {
    if (renderPassActive) planAssignCache.renderPass = renderPassId;
    return planAssignCache.badges;
  }
  const map = {};
  for (const p of state.planItems || []) {
    if (!p || p.done || p.forDay > today) continue;
    const remain = Math.max(0, planQtyOf(p) - planWonPieces(p, wonMap));
    if (remain <= 0) continue;
    const parsed = parsePlanItemText(p.text);
    const resolved = resolvePlanName(parsed.name);
    const keys = new Set([p.text, parsed.name, parsed.raw]);
    if (resolved.crop) {
      keys.add(resolved.crop.l);
      keys.add(resolved.crop.n);
    }
    if (resolved.variety) {
      keys.add(resolved.variety.l);
      keys.add(resolved.variety.n);
    }
    for (const key of keys) {
      const k = String(key || '').trim();
      if (!k) continue;
      map[k] = (map[k] || 0) + remain;
    }
  }
  if (planAssignCache) {
    planAssignCache.badges = map;
    planAssignCache.badgesToday = today;
    if (renderPassActive) planAssignCache.renderPass = renderPassId;
  }
  return map;
}

function needBadgeHtml(keys) {
  const map = planRemainBadgeMap();
  let remain = 0;
  for (const k of keys || []) {
    const n = map[String(k || '').trim()] || 0;
    if (n > remain) remain = n;
  }
  if (remain <= 0) return { cls: '', html: '' };
  return { cls: ' has-need', html: `<span class="need-badge">差${remain}</span>` };
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
  return note ? base + '　' + note : base;
}

function applyPlanProgressFromLots(opts) {
  opts = opts || {};
  if (!state || !Array.isArray(state.planItems)) return lastPlanEvents;
  const promoted = promoteMisfiledTomorrowPlans();
  const today = todayStr();
  const assigned = assignWonToPlans();
  const events = [];
  let changed = promoted;
  for (const p of autoManagedPlans()) {
    const won = planWonPieces(p, assigned);
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
        changed = true;
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
      changed = true;
      events.push({ kind: 'done', text: p.text, won, qty });
    } else if (!complete && p.done && p.doneBy === 'auto') {
      p.done = false;
      p.doneOn = '';
      p.doneBy = '';
      changed = true;
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
  events.changed = changed;
  return events;
}

function normalizeBoughtHistory(list) {
  if (!Array.isArray(list)) return [];
  const cut = addDaysIso(todayStr(), -PURCHASE_WINDOW_DAYS);
  const byDay = new Map();
  for (const raw of list) {
    if (!raw || !raw.day || raw.day < cut) continue;
    const items = [];
    for (const it of raw.items || []) {
      const rawText = String(it.text || it.name || '').trim();
      const text = (typeof canonicalItemKey === 'function' ? canonicalItemKey(rawText) : rawText) || rawText;
      const count = Number(it.count) || 0;
      if (!text || count < 1) continue;
      const half = it.half || (typeof halfOfItemName === 'function' ? halfOfItemName(text) : '') || '';
      items.push(half ? { text, count, half } : { text, count });
    }
    if (!items.length) continue;
    const merged = new Map();
    for (const it of items) {
      const k = (it.half || '') + '\t' + it.text;
      const prev = merged.get(k);
      if (prev) prev.count += it.count;
      else merged.set(k, { text: it.text, count: it.count, ...(it.half ? { half: it.half } : {}) });
    }
    const prevDay = byDay.get(raw.day);
    if (prevDay && Array.isArray(prevDay.items)) {
      for (const it of prevDay.items) {
        const k = (it.half || '') + '\t' + it.text;
        const prev = merged.get(k);
        if (prev) prev.count = Math.max(prev.count, it.count);
        else merged.set(k, { text: it.text, count: it.count, ...(it.half ? { half: it.half } : {}) });
      }
    }
    byDay.set(raw.day, { day: raw.day, items: [...merged.values()] });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function mergeBoughtHistory(a, b) {
  return normalizeBoughtHistory([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

function rememberBoughtLots(lots) {
  if (!state) return;
  if (!Array.isArray(state.boughtHistory)) state.boughtHistory = [];
  const daysInLots = new Set();
  const groups = {};
  for (const l of lots || []) {
    if (!isWon(l) || !l.item) continue;
    const text = canonicalItemKey(l.item) || lotPlanText(l);
    if (!text) continue;
    const day = l.day || state.day;
    const half = l.half || halfOfItemName(l.item) || '';
    daysInLots.add(day);
    if (!groups[day]) groups[day] = {};
    const id = (half || '') + '\t' + text;
    const prev = groups[day][id] || { text, count: 0, ...(half ? { half } : {}) };
    prev.count += 1;
    groups[day][id] = prev;
  }
  const byDay = new Map((state.boughtHistory || []).map((h) => [h.day, h]));
  for (const day of daysInLots) {
    const items = Object.values(groups[day]);
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
      if (l.day !== day || !isWon(l) || !l.item) continue;
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


const PLAN_GRID_TABS = [
  { id: 'fruit', label: '水果場', half: 'fruit', groups: null },
  { id: 'bulk', label: '大宗', half: 'morning', groups: ['大宗'] },
  { id: 'leafy', label: '水菜', half: 'morning', groups: ['水菜'] },
  { id: 'gourd', label: '瓜果', half: 'afternoon', groups: ['瓜果', '醃製'] }
];

function snapshotPlanItems() {
  return (state.planItems || []).map((p) => Object.assign({}, p));
}

function offerPlanUndo(snap, msg) {
  planUndo = snap;
  toast(msg, 2800, { label: '復原', fn: undoPlanLast });
}

function undoPlanLast() {
  const snap = planUndo;
  planUndo = null;
  toastMsg = '';
  toastAction = null;
  if (!snap) return;
  const now = Date.now();
  const peer = typeof ensurePeerId === 'function' ? ensurePeerId() : (state && state.peerId) || '';
  const restored = (snap || []).map((p) => Object.assign({}, p));
  if (!state.syncTombstones || typeof state.syncTombstones !== 'object') {
    state.syncTombstones = { lots: {}, plan: {} };
  }
  if (!state.syncTombstones.plan || typeof state.syncTombstones.plan !== 'object') state.syncTombstones.plan = {};
  for (const item of restored) {
    if (!item || !item.id) continue;
    delete state.syncTombstones.plan[item.id];
    if (typeof BidSyncCore !== 'undefined' && BidSyncCore.stamp) {
      BidSyncCore.stamp(item, BidSyncCore.PLAN_FIELDS, now, peer);
    } else {
      item.updatedAt = now;
      if (peer) item.updatedBy = peer;
    }
  }
  state.planItems = restored;
  saveState();
  toast('已復原');
  buzz(24);
  render();
}

function parsePlanDraft(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { text: '', qty: 1, explicit: false };
  const m = raw.match(/^(.*?)(?:\s*[x×*]\s*|\s+)(\d{1,2})$/);
  if (m && String(m[1]).trim()) {
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 99) {
      return { text: m[1].trim(), qty: n, explicit: true };
    }
  }
  return { text: raw, qty: 1, explicit: false };
}

function findPlanOnTarget(text, which) {
  const value = String(text || '').trim();
  if (!value) return null;
  const today = todayStr();
  const target = which || planAddTarget || defaultPlanAddTarget();
  return (state.planItems || []).find((p) => (
    !p.done && p.text === value && (target === 'today' ? p.forDay <= today : p.forDay > today)
  )) || null;
}

function planQtyOnTarget(text, which) {
  const item = findPlanOnTarget(text, which);
  return item ? planQtyOf(item) : 0;
}

function planCountBadge(text) {
  const n = planQtyOnTarget(text);
  if (n <= 0) return { cls: '', html: '', n: 0 };
  return { cls: ' has-plan-qty', html: `<span class="plan-grid-badge">×${n}</span>`, n };
}

function addOrBumpPlanItem(text, which, opts) {
  opts = opts || {};
  const parsed = opts.parsed || {
    text: String(text || '').trim(),
    qty: opts.qty != null ? opts.qty : 1,
    explicit: !!opts.explicit || opts.qty != null
  };
  const value = String(parsed.text || '').trim();
  if (!value) return false;
  const today = todayStr();
  const target = which || planAddTarget || defaultPlanAddTarget();
  const forDay = planTargetDay(target);
  if (!Array.isArray(state.planItems)) state.planItems = [];
  const existing = findPlanOnTarget(value, target);
  const snap = snapshotPlanItems();
  if (existing) {
    if (parsed.explicit) {
      if (parsed.qty <= 0) {
        state.planItems = state.planItems.filter((p) => p.id !== existing.id);
        saveState();
        offerPlanUndo(snap, `已刪除 ${value}`);
        buzz(24);
        render();
        return true;
      }
      existing.qty = Math.min(99, parsed.qty);
      saveState();
      offerPlanUndo(snap, `${value}　${existing.qty} 件`);
      buzz(24);
      render();
      return true;
    }
    existing.qty = Math.min(99, planQtyOf(existing) + 1);
    saveState();
    toast(`${value} +1（共${existing.qty}件）`);
    buzz(24);
    render();
    revealPlanRow(value);
    return true;
  }
  if (parsed.explicit && parsed.qty <= 0) {
    toast('沒有這個品項');
    return false;
  }
  const qty = parsed.explicit ? Math.min(99, Math.max(1, parsed.qty)) : 1;
  state.planItems.push({
    id: uid(),
    text: value,
    forDay,
    done: false,
    doneOn: '',
    createdOn: today,
    qty,
    doneBy: '',
    lockCount: 0,
    purpose: 'retail'
  });
  saveState();
  if (parsed.explicit) {
    toast(`${value}　${qty} 件`);
  } else {
    toast(`${value} +1（共${qty}件）`);
  }
  buzz(24);
  render();
  revealPlanRow(value);
  return true;
}

function revealPlanRow(text) {
  const want = String(text || '').trim();
  if (!want) return;
  requestAnimationFrame(() => {
    const nodes = document.querySelectorAll('.plan-row .plan-text');
    for (const n of nodes) {
      if ((n.textContent || '').trim() === want) {
        const row = n.closest('.plan-row');
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  });
}

function planGridCrops(tabId) {
  const tab = PLAN_GRID_TABS.find((t) => t.id === tabId) || PLAN_GRID_TABS[1];
  let list = visibleCrops(tab.half, '');
  if (tab.groups) list = list.filter((c) => tab.groups.includes(c.g));
  return { tab, list };
}

function cropPlanCount(crop) {
  const keys = new Set();
  const add = (t) => { const v = String(t || '').trim(); if (v) keys.add(v); };
  const label = crop.l || crop.n;
  add(label);
  add(crop.n);
  if (itemNeedsSize(crop.n) || itemNeedsSize(crop.l)) {
    for (const s of sizesForItem(crop.n || crop.l)) add(label + ' ' + s);
  }
  for (const v of pickerVariants(crop, '')) {
    add(v.l || v.n);
    add(v.n);
  }
  let n = 0;
  for (const k of keys) n += planQtyOnTarget(k);
  return n;
}

function renderPlanGrid() {
  const tabId = planGridTab || 'bulk';
  const tabBtns = PLAN_GRID_TABS.map((t) => {
    const on = t.id === tabId ? ' on' : '';
    return `<button type="button" class="plan-grid-tab${on}" data-act="plan-grid-tab" data-v="${t.id}">${escapeHtml(t.label)}</button>`;
  }).join('');

  let body;
  if (planVariantPick && planVariantPick.crop) {
    const crop = planVariantPick.crop;
    const label = crop.l || crop.n;
    const kind = planVariantPick.kind;
    const btns = [];
    if (kind === 'size') {
      const none = planCountBadge(label);
      btns.push(`<button type="button" class="item-btn${none.cls}${peelClass(crop.n)}" data-act="plan-tap-item" data-name="${escapeHtml(label)}">不指定大小${none.html}</button>`);
      for (const s of sizesForItem(crop.n || crop.l)) {
        const text = label + ' ' + s;
        const badge = planCountBadge(text);
        btns.push(`<button type="button" class="item-btn${badge.cls}${peelClass(crop.n)}" data-act="plan-tap-item" data-name="${escapeHtml(text)}">${escapeHtml(s)}${badge.html}</button>`);
      }
      const vars = pickerVariants(crop, '');
      if (vars.length > 1) {
        btns.push('<div class="item-group-h">品種</div>');
        for (const v of vars) {
          const vlabel = v.l || v.n;
          const badge = planCountBadge(vlabel);
          btns.push(`<button type="button" class="item-btn${badge.cls}${peelClass(v.n)}" data-act="plan-tap-item" data-name="${escapeHtml(vlabel)}">${escapeHtml(vlabel)}${badge.html}</button>`);
        }
      }
    } else {
      const none = planCountBadge(label);
      btns.push(`<button type="button" class="item-btn${none.cls}${peelClass(crop.n)}" data-act="plan-tap-item" data-name="${escapeHtml(label)}">不指定品種${none.html}</button>`);
      for (const v of pickerVariants(crop, '')) {
        const vlabel = v.l || v.n;
        const badge = planCountBadge(vlabel);
        btns.push(`<button type="button" class="item-btn${badge.cls}${peelClass(v.n)}" data-act="plan-tap-item" data-name="${escapeHtml(vlabel)}">${escapeHtml(vlabel)}${badge.html}</button>`);
      }
    }
    const title = kind === 'size' ? escapeHtml(label) + ' 大小' : escapeHtml(label);
    body = `<div class="plan-var-sheet">
      <div class="var-sheet-head">
        <button type="button" class="var-back" data-act="plan-close-vars">返回</button>
        <div class="var-title">${title}</div>
      </div>
      <div class="item-pick plan-grid-list">${btns.join('')}</div>
    </div>`;
  } else {
    const { tab, list } = planGridCrops(tabId);
    const parts = [];
    const customs = customItemsOf(tab.half)
      .map((n) => String(n || '').trim())
      .filter((n) => n);
    if (customs.length) {
      parts.push('<div class="item-group-h">自己輸入</div>');
      for (const name of customs) {
        const badge = planCountBadge(name);
        parts.push(`<button type="button" class="item-btn custom${badge.cls}" data-act="plan-tap-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}${badge.html}</button>`);
      }
    }
    let lastGroup = null;
    const showGroup = !tab.groups || tab.groups.length > 1;
    for (const crop of list) {
      if (showGroup && crop.g !== lastGroup) {
        lastGroup = crop.g;
        parts.push(`<div class="item-group-h">${escapeHtml(crop.g)}</div>`);
      }
      const needsSize = itemNeedsSize(crop.n) || itemNeedsSize(crop.l);
      const hasVars = shouldOpenVariants(crop, '');
      const n = cropPlanCount(crop);
      const badge = n > 0 ? { cls: ' has-plan-qty', html: `<span class="plan-grid-badge">×${n}</span>` } : planCountBadge(crop.l);
      const main = `<button type="button" class="item-btn${badge.cls}${peelClass(crop.n)}" data-act="plan-tap-item" data-name="${escapeHtml(crop.l)}">${escapeHtml(crop.l)}${badge.html}</button>`;
      if (needsSize) {
        parts.push(`<div class="plan-item-cell">${main}<button type="button" class="plan-var-nudge" data-act="plan-open-size" data-crop="${escapeHtml(crop.n)}" aria-label="${escapeHtml(crop.l)} 大小">▾</button></div>`);
      } else if (hasVars) {
        parts.push(`<div class="plan-item-cell">${main}<button type="button" class="plan-var-nudge" data-act="plan-open-vars" data-crop="${escapeHtml(crop.n)}" aria-label="${escapeHtml(crop.l)} 品種">▾</button></div>`);
      } else {
        parts.push(main);
      }
    }
    body = `<div class="item-pick plan-grid-list">${parts.join('') || '<div class="plan-empty">這個分類沒有品項</div>'}</div>`;
  }

  return `<div class="plan-grid-tabs" role="tablist">${tabBtns}</div>${body}`;
}

function capturePlanGridScroll() {
  const el = document.querySelector('.plan-grid-list');
  if (el) planGridScroll = el.scrollTop;
}

function restorePlanGridScroll() {
  const el = document.querySelector('.plan-grid-list');
  if (el) el.scrollTop = planGridScroll;
}

function capturePlanListScroll() {
  const plan = document.querySelector('#plan-screen .plan-body');
  const sum = document.querySelector('#sum-screen .plan-body');
  if (plan) planBodyScroll = plan.scrollTop;
  if (sum) sumBodyScroll = sum.scrollTop;
  const se = document.scrollingElement || document.documentElement;
  pageScrollY = window.scrollY || (se && se.scrollTop) || 0;
}

function restorePlanListScroll() {
  const plan = document.querySelector('#plan-screen .plan-body');
  const sum = document.querySelector('#sum-screen .plan-body');
  if (plan) plan.scrollTop = planBodyScroll;
  if (sum) sum.scrollTop = sumBodyScroll;
  if (pageScrollY) {
    const se = document.scrollingElement || document.documentElement;
    if (se) se.scrollTop = pageScrollY;
    window.scrollTo(0, pageScrollY);
  }
}

function resetPlanListScroll() {
  planBodyScroll = 0;
  pageScrollY = 0;
}

function captureMainScroll() {
  const el = document.getElementById('main');
  if (!el) return;
  mainScrollTop = el.scrollTop;
  mainScrollKey = currentPageKey();
}

function restoreMainScroll() {
  const el = document.getElementById('main');
  if (!el) return;
  if (currentPageKey() === mainScrollKey) el.scrollTop = mainScrollTop;
  else {
    el.scrollTop = 0;
    mainScrollTop = 0;
    mainScrollKey = currentPageKey();
  }
}

function captureActiveField() {
  const active = document.activeElement;
  if (!active || !active.closest || !active.closest('#app')) return null;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return null;
  return {
    id: active.id || '',
    tag: active.tagName.toLowerCase(),
    act: active.getAttribute('data-act') || '',
    half: active.getAttribute('data-half') || '',
    mid: active.getAttribute('data-id') || '',
    index: active.getAttribute('data-i') || '',
    field: active.getAttribute('data-field') || '',
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
  };
}

function cssAttr(s) {
  const v = String(s || '');
  if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(v);
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function restoreActiveField(info) {
  if (!info) return;
  let el = info.id ? document.getElementById(info.id) : null;
  if (!el && info.act) {
    let sel = `${info.tag}[data-act="${cssAttr(info.act)}"]`;
    if (info.half) sel += `[data-half="${cssAttr(info.half)}"]`;
    if (info.mid) sel += `[data-id="${cssAttr(info.mid)}"]`;
    if (info.index) sel += `[data-i="${cssAttr(info.index)}"]`;
    if (info.field) sel += `[data-field="${cssAttr(info.field)}"]`;
    el = document.querySelector(sel);
  }
  if (!el || typeof el.focus !== 'function') return;
  el.focus({ preventScroll: true });
  if (info.start != null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(info.start, info.end); } catch { /* ignore */ }
  }
}

function firstElFromHtml(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = String(html || '').trim();
  return wrap.firstElementChild;
}

function replaceNode(el, html) {
  if (!el) return null;
  const node = firstElFromHtml(html);
  if (!node) {
    el.remove();
    return null;
  }
  el.replaceWith(node);
  return node;
}

function upsertAppSection(app, el, html, before) {
  const trimmed = String(html || '').trim();
  if (!trimmed) {
    if (el) el.remove();
    return null;
  }
  if (el) return replaceNode(el, trimmed);
  const node = firstElFromHtml(trimmed);
  if (node) app.insertBefore(node, before || null);
  return node;
}

function openPlanQtyEdit(id) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) return;
  modal = { type: 'plan-qty', id, value: String(planQtyOf(item)) };
  render();
}

function applyPlanQtyDigit(d) {
  if (!modal || modal.type !== 'plan-qty') return;
  const cur = String(modal.value || '');
  if (cur.length >= 2) return;
  modal.value = (cur === '0' ? '' : cur) + String(d);
  render();
}

function commitPlanQtyEdit() {
  if (!modal || modal.type !== 'plan-qty') return;
  const id = modal.id;
  const raw = String(modal.value || '').trim();
  const n = raw === '' ? NaN : parseInt(raw, 10);
  modal = null;
  setPlanQtyExact(id, n);
}

function setPlanQtyExact(id, qty) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) {
    render();
    return;
  }
  const snap = snapshotPlanItems();
  const n = parseInt(qty, 10);
  if (!Number.isFinite(n) || n <= 0) {
    state.planItems = state.planItems.filter((p) => p.id !== item.id);
    saveState();
    offerPlanUndo(snap, `已刪除 ${item.text}`);
    buzz(24);
    render();
    return;
  }
  item.qty = Math.min(99, n);
  saveState();
  offerPlanUndo(snap, `${item.text}　${item.qty} 件`);
  buzz(24);
  render();
}

function addPlanText(text, which) {
  return addOrBumpPlanItem(text, which);
}

function togglePlanPick(text) {
  addOrBumpPlanItem(text);
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
  planAddTarget = defaultPlanAddTarget();
  planVariantPick = null;
  planGridOpen = false;
  resetPlanListScroll();
  planGridScroll = 0;
  applyPlanProgressFromLots();
  try {
    history.pushState({ auctionPlan: true }, '');
    planHistoryPushed = true;
  } catch {
    planHistoryPushed = false;
  }
  render();
}

function closePlan(fromPop, opts) {
  if (!planOpen) return;
  planOpen = false;
  resetPlanListScroll();
  const skipHistory = !!(opts && opts.skipHistory);
  if (!fromPop && planHistoryPushed && !skipHistory) {
    planHistoryPushed = false;
    try { history.back(); } catch { /* ignore */ }
  } else {
    planHistoryPushed = false;
  }
  render();
}

function onPlanPopState() {
  if (paddleOpen) {
    exitPaddle(true);
    return;
  }
  if (planOpen) closePlan(true);
}

function addPlanItem(which) {
  const parsed = parsePlanDraft(planDraft);
  if (!parsed.text) {
    toast('請先輸入預計要批的品項或備註');
    return;
  }
  planDraft = '';
  planQty = 1;
  addOrBumpPlanItem(parsed.text, which || planAddTarget, { parsed });
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
  return planWonPieces(plan, assignWonToPlans());
}

function bumpPlanQty(id, delta) {
  const item = (state.planItems || []).find((p) => p.id === id);
  if (!item) return;
  const snap = snapshotPlanItems();
  const next = planQtyOf(item) + (Number(delta) || 0);
  if (next <= 0) {
    toast('要刪掉請把件數改成 0，或到件數裡按刪除這一列');
    buzz(24);
    return;
  }
  item.qty = Math.min(99, next);
  saveState();
  render();
}

function bumpDraftQty(delta) {
  planQty = Math.max(1, Math.min(99, (parseInt(planQty, 10) || 1) + delta));
  render();
}

function deletePlanItem(id) {
  const item = (state.planItems || []).find((p) => p.id === id);
  const snap = snapshotPlanItems();
  state.planItems = (state.planItems || []).filter((p) => p.id !== id);
  saveState();
  offerPlanUndo(snap, item ? `已刪除 ${item.text}` : '已刪除');
  buzz(24);
  render();
}

function planTodayCount() {
  const today = todayStr();
  return (state.planItems || []).filter((p) => !p.done && p.forDay <= today).length;
}

function planSectionItems(kind) {
  const today = todayStr();
  const items = state.planItems || [];
  if (kind === 'today') return items.filter((p) => !p.done && p.forDay <= today);
  if (kind === 'tomorrow') return items.filter((p) => !p.done && p.forDay > today);
  if (kind === 'done') return items.filter((p) => p.done && p.doneOn === today);
  return items.slice();
}

function confirmClearPlans(kind) {
  kind = kind || 'all';
  const list = planSectionItems(kind);
  if (!list.length) {
    toast('沒有可以清除的項目');
    return;
  }
  const titles = {
    today: '清除今日預計？',
    tomorrow: '清除明日預計？',
    done: '清除已完成？',
    all: '全部清除？'
  };
  const bodies = {
    today: '會刪掉今日預計 ' + list.length + ' 筆。房間裡的手機都會一起刪掉。可再按復原。',
    tomorrow: '會刪掉明日預計 ' + list.length + ' 筆。房間裡的手機都會一起刪掉。可再按復原。',
    done: '會刪掉今天的已完成 ' + list.length + ' 筆。房間裡的手機都會一起刪掉。可再按復原。',
    all: '會刪掉全部備註，共 ' + list.length + ' 筆。房間裡的手機都會一起刪掉。可再按復原。'
  };
  modal = {
    type: 'confirm',
    title: titles[kind] || '清除備註？',
    body: bodies[kind] || ('會刪掉 ' + list.length + ' 筆。房間裡的手機都會一起刪掉。可再按復原。'),
    ok: '清除 ' + list.length + ' 筆',
    cancel: '取消',
    danger: true,
    onOk: () => clearPlanItems(kind),
    onCancel: () => { modal = null; render(); }
  };
  render();
}

function clearPlanItems(kind) {
  modal = null;
  const dropIds = new Set(planSectionItems(kind).map((p) => p && p.id).filter(Boolean));
  if (!dropIds.size) {
    render();
    return;
  }
  const snap = snapshotPlanItems();
  state.planItems = (state.planItems || []).filter((p) => !dropIds.has(p.id));
  saveState();
  offerPlanUndo(snap, '已清除 ' + dropIds.size + ' 筆備註');
  buzz(24);
  render();
}

function renderSizeChips(current, opts) {
  opts = opts || {};
  const item = opts.item || (opts.lotId && (state.lots || []).find((l) => l.id === opts.lotId)?.item) || draftItem || '';
  const sizes = sizesForItem(item);
  const cur = normalizeSize(current, item);
  const act = opts.lotId ? 'set-size' : 'set-draft-size';
  const lotAttr = opts.lotId ? ` data-id="${escapeHtml(opts.lotId)}"` : '';
  const cls = (opts.sheet ? 'size-chips sheet-size' : 'size-chips') + (isTomatoCrop(item) ? ' tomato-sizes' : '');
  return `<div class="${cls}" role="group" aria-label="大小">
    <span class="size-lbl">大小</span>
    ${sizes.map((s) => {
      const on = cur === s ? ' on' : '';
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
  const doneItems = items.filter((p) => p.done && p.doneOn === today).slice().reverse();
  const wonMap = assignWonToPlans();
  const row = (p, kind) => {
    const qty = planQtyOf(p);
    const won = kind === 'tomorrow' ? 0 : planWonPieces(p, wonMap);
    const remain = Math.max(0, qty - won);
    let remainHtml = '';
    if (kind !== 'tomorrow' && qty >= 1) {
      remainHtml = p.done && remain === 0
        ? `<span class="plan-remain ok">已完成<span class="plan-frac">${qty} 件</span></span>`
        : `<span class="plan-remain"><span class="plan-remain-lbl">還差 </span>${remain} 件 <span class="plan-frac">${Math.min(won, qty)}/${qty}</span></span>`;
    }
    const qtyCtrl = kind === 'done'
      ? `<button type="button" class="plan-qty-read" data-act="plan-qty-edit" data-id="${escapeHtml(p.id)}" aria-label="輸入件數 ${qty} 件">${qty}<span>件</span></button>`
      : `<span class="plan-qty-step">
        <button type="button" class="plan-qty-minus" data-act="plan-item-qty-dec" data-id="${escapeHtml(p.id)}" aria-label="減少一件">−</button>
        <button type="button" class="plan-qty-num" data-act="plan-qty-edit" data-id="${escapeHtml(p.id)}" aria-label="輸入件數 ${qty} 件">${qty}<span>件</span></button>
        <button type="button" class="plan-qty-plus" data-act="plan-item-qty-inc" data-id="${escapeHtml(p.id)}" aria-label="增加一件">＋</button>
      </span>`;
    const purpose = planPurposeOf(p);
    const purposeLbl = planPurposeLabel(p);
    const purposeBtn = `<button type="button" class="plan-purpose ${purpose}" data-act="plan-purpose" data-id="${escapeHtml(p.id)}" aria-label="用途 ${purposeLbl}，點一下改成${purpose === 'delivery' ? '零賣' : '交貨'}">${purposeLbl}</button>`;
    const remainBlock = remainHtml ? `<div class="plan-meta">${remainHtml}</div>` : '';
    return `<div class="plan-row${kind === 'done' ? ' done' : ''}">
      <button type="button" class="plan-check${p.done ? ' on' : ''}" data-act="${p.done ? 'plan-undone' : 'plan-done'}" data-id="${escapeHtml(p.id)}" aria-label="${p.done ? '取消完成' : '完成'}">${p.done ? '✓' : ''}</button>
      <div class="plan-main">
        <div class="plan-text">${escapeHtml(p.text)}</div>
        ${remainBlock}
      </div>
      ${purposeBtn}
      ${qtyCtrl}
    </div>`;
  };
  const section = (title, hint, list, kind) => {
    const target = kind === 'today' || kind === 'tomorrow';
    const on = target && planAddTarget === kind ? ' on' : '';
    const headAct = target ? ` data-act="plan-target" data-v="${kind}"` : '';
    const clearBtn = list.length
      ? `<button type="button" class="plan-clear-btn" data-act="plan-clear" data-v="${kind}">清除</button>`
      : '';
    return `<section class="plan-sec${on}">
      <div class="plan-sec-head">
        <h2${headAct} class="${target ? 'plan-target' : ''}${on}">${title}${list.length ? `<span>${list.length}</span>` : ''}</h2>
        ${clearBtn}
      </div>
      ${hint ? `<p class="plan-hint">${hint}</p>` : ''}
      ${list.length ? list.map((p) => row(p, kind)).join('') : '<div class="plan-empty">還沒有項目</div>'}
    </section>`;
  };
  const suggest = planSuggestList(planDraft);
  const suggestBox = suggest.length
    ? `<div class="plan-suggest">${suggest.map((s) => `<button type="button" class="plan-suggest-item${peelClass(s)}" data-act="plan-suggest" data-v="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`
    : '';
  const todayOn = planAddTarget === 'today' ? ' on' : '';
  const tomoOn = planAddTarget === 'tomorrow' ? ' on' : '';
  const targetRow = `<div class="plan-target-row">
      <div class="plan-target-seg" role="tablist" aria-label="加到哪一天">
        <span class="plan-target-lbl">加到</span>
        <button type="button" class="${todayOn}" data-act="plan-target" data-v="today">今日</button>
        <button type="button" class="${tomoOn}" data-act="plan-target" data-v="tomorrow">明日</button>
      </div>
    </div>`;
  const gridBox = planGridOpen ? renderPlanGrid() : '';
  const gridToggleLabel = planGridOpen ? '收起' : '選品項';
  return `<div class="plan-screen${planGridOpen ? ' is-picking' : ''}" id="plan-screen">
    <header class="plan-bar">
      <button type="button" class="plan-back" data-act="close-plan">返回</button>
      <h1>備註</h1>
      <button type="button" class="plan-bar-link" data-act="open-summary">今日總結</button>
    </header>
    <div class="plan-mid">
      <div class="plan-body">
        ${(todayItems.length || !planGridOpen) ? section('今日預計', planGridOpen ? '' : '昨天記下的會留在這裡，開始新的一天也不會清掉。要一次清掉請按清除。', todayItems, 'today') : ''}
        ${(tomorrowItems.length || !planGridOpen) ? section('明日預計', planGridOpen ? '' : '先記下來，明天會自動變成今日預計。', tomorrowItems, 'tomorrow') : ''}
        ${doneItems.length ? section('已完成', '', doneItems, 'done') : ''}
        ${(!planGridOpen && items.length) ? '<button type="button" class="plan-clear-all" data-act="plan-clear" data-v="all">全部清除</button>' : ''}
      </div>
      ${planGridOpen ? `<div class="plan-add">
        ${targetRow}
        ${gridBox}
        <div class="plan-input-wrap">
          <input id="plan-input" maxlength="40" placeholder="搜尋品項，或輸入「高麗菜 5」直接設件數" value="${escapeHtml(planDraft)}" data-act="plan-draft" inputmode="search" autocomplete="off" />
          ${suggestBox}
        </div>
      </div>` : ''}
    </div>
    <div class="plan-footer hand-${thumbHand()}">
      <button type="button" class="plan-grid-toggle" data-act="toggle-plan-grid" aria-expanded="${planGridOpen ? 'true' : 'false'}">${gridToggleLabel}</button>
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

function defaultAnchors(machines) {
  const out = { fruit: {}, morning: {}, afternoon: {} };
  for (const half of HALVES) {
    out[half] = {};
    for (const m of machines[half] || []) {
      out[half][m.id] = null;
    }
  }
  return out;
}

function defaultSeriesPath(machines) {
  const out = { fruit: {}, morning: {}, afternoon: {} };
  for (const half of HALVES) {
    out[half] = {};
    for (const m of (machines && machines[half]) || []) out[half][m.id] = { segs: [], ts: 0 };
  }
  return out;
}

function defaultMachineMerges(machines) {
  const out = { fruit: {}, morning: {}, afternoon: {} };
  for (const half of HALVES) {
    out[half] = {};
    for (const m of (machines && machines[half]) || []) out[half][m.id] = null;
  }
  return out;
}

function clearCollapsedMerges(st) {
  st = st || state;
  if (!st || !st.machineMerges || typeof st.machineMerges !== 'object') return;
  const halves = Object.keys(st.machineMerges);
  for (const half of halves) {
    const map = st.machineMerges[half];
    if (!map || typeof map !== 'object') continue;
    for (const id of Object.keys(map)) {
      const e = map[id];
      if (e && typeof e === 'object' && e.into) {
        map[id] = { into: null, ts: Date.now(), cleared: true };
      }
    }
  }
}

function clearSavedSeriesPlans(st) {
  st = st || state;
  if (!st) return;
  const now = Date.now();
  const out = defaultSeriesPlans(st.machines);
  const prev = st.seriesPlans && typeof st.seriesPlans === 'object' ? st.seriesPlans : {};
  for (const half of Object.keys(out)) {
    const ids = new Set(Object.keys(out[half] || {}));
    const src = prev[half] && typeof prev[half] === 'object' ? prev[half] : {};
    Object.keys(src).forEach((id) => ids.add(id));
    out[half] = out[half] || {};
    ids.forEach((id) => { out[half][id] = { entries: [], ts: now }; });
  }
  st.seriesPlans = out;
}


function defaultSeriesPlans(machines) {
  const out = { fruit: {}, morning: {}, afternoon: {} };
  for (const half of HALVES) {
    out[half] = {};
    for (const m of (machines && machines[half]) || []) out[half][m.id] = { entries: [], ts: 0 };
  }
  return out;
}

function ensurePathStore(half) {
  const h = half || (state && state.currentHalf) || 'afternoon';
  if (!state.seriesPath) state.seriesPath = defaultSeriesPath(state.machines);
  if (!state.seriesPath[h]) state.seriesPath[h] = {};
  if (!state.machineMerges) state.machineMerges = defaultMachineMerges(state.machines);
  if (!state.machineMerges[h]) state.machineMerges[h] = {};
  if (!state.seriesPlans) state.seriesPlans = defaultSeriesPlans(state.machines);
  if (!state.seriesPlans[h]) state.seriesPlans[h] = {};
  return h;
}

function seriesOf(n, half) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  const h = half || (state && state.currentHalf) || '';
  if (h === 'morning') {
    if (num >= 1000 && num <= 1999) return { lo: 1001, hi: 1999, key: '1xxx' };
    if (num >= 3000 && num <= 3499) return { lo: 3001, hi: 3499, key: '30xx' };
    if (num >= 3500 && num <= 3999) return { lo: 3500, hi: 3999, key: '35xx' };
  }
  if (num >= 2000 && num <= 2499) return { lo: 2000, hi: 2499, key: '2xxx' };
  if (num >= 2500 && num <= 4999) return { lo: 2500, hi: 4999, key: '25xx' };
  if (num >= 5000 && num <= 5999) return { lo: 5001, hi: 5999, key: '5xxx' };
  if (num >= 6000 && num <= 6999) return { lo: 6001, hi: 6999, key: '6xxx' };
  const base = Math.floor(num / 1000) * 1000;
  return { lo: base + 1, hi: base + 999, key: 's' + base };
}

function inSeries(n, ser) {
  if (!ser) return false;
  const num = Number(n);
  if (!Number.isFinite(num)) return false;
  if (num >= ser.lo && num <= ser.hi) return true;
  if (ser.key === '5xxx' && num === 5000) return true;
  if (ser.key === '6xxx' && num === 6000) return true;
  return false;
}

function seriesEffLo(ser) {
  if (!ser) return 0;
  if (ser.key === '5xxx') return 5000;
  if (ser.key === '6xxx') return 6000;
  return ser.lo;
}

function seriesLabel(ser) {
  if (!ser) return '';
  return String(ser.lo);
}

function seriesPos(n, start, ser) {
  if (!ser || !inSeries(n, ser) || start == null || !inSeries(start, ser)) return null;
  const lo = seriesEffLo(ser);
  const hi = ser.hi;
  const num = Number(n);
  const s = Number(start);
  if (num >= s && num <= hi) return num - s;
  return (hi - s + 1) + (num - lo);
}

function seriesNumAt(pos, start, ser) {
  const lo = seriesEffLo(ser);
  const hi = ser.hi;
  const s = Number(start);
  const head = hi - s + 1;
  const len = hi - lo + 1;
  if (len <= 0) return s;
  let p = pos % len;
  if (p < 0) p += len;
  if (p < head) return s + p;
  return lo + (p - head);
}

function seriesCycleLen(ser) {
  if (!ser) return 0;
  return ser.hi - seriesEffLo(ser) + 1;
}

function pathEntry(machineId, half) {
  const h = ensurePathStore(half);
  if (!state.seriesPath[h][machineId] || typeof state.seriesPath[h][machineId] !== 'object') {
    state.seriesPath[h][machineId] = { segs: [], ts: 0 };
  }
  if (!Array.isArray(state.seriesPath[h][machineId].segs)) state.seriesPath[h][machineId].segs = [];
  return state.seriesPath[h][machineId];
}

function planEntry(machineId, half) {
  const h = ensurePathStore(half);
  if (!state.seriesPlans[h][machineId] || typeof state.seriesPlans[h][machineId] !== 'object') {
    state.seriesPlans[h][machineId] = { entries: [], ts: 0 };
  }
  if (!Array.isArray(state.seriesPlans[h][machineId].entries)) state.seriesPlans[h][machineId].entries = [];
  return state.seriesPlans[h][machineId];
}

function plannedEntries(machineId, half) {
  return (planEntry(machineId, half).entries || []).map(Number).filter((n) => Number.isFinite(n));
}

function seriesStart(machineId, half, ser) {
  if (!ser) return null;
  const segs = pathEntry(machineId, half).segs;
  const hit = segs.filter((s) => s && s.key === ser.key).pop();
  if (hit && hit.start != null && Number.isFinite(Number(hit.start))) return Number(hit.start);
  return null;
}

function displayStartOf(machineId, half) {
  const h = half || (state && state.currentHalf);
  const cur = currentOf(machineId, h);
  const ser = cur != null ? seriesOf(cur, h) : null;
  if (ser) {
    const s = seriesStart(machineId, h, ser);
    if (s != null) return s;
  }
  const segs = pathEntry(machineId, h).segs || [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg && seg.start != null && Number.isFinite(Number(seg.start))) return Number(seg.start);
  }
  return null;
}

function liveInfoLabel(startN) {
  return startN != null && Number.isFinite(Number(startN)) ? ('起 ' + Number(startN)) : '';
}

function wrapIsBehind(n, cur, start, ser) {
  const a = seriesPos(n, start, ser);
  const b = seriesPos(cur, start, ser);
  if (a == null || b == null) return Number(n) < Number(cur);
  return a < b;
}

function wrapDist(from, to, start, ser) {
  const a = seriesPos(from, start, ser);
  const b = seriesPos(to, start, ser);
  if (a == null || b == null) return Number(to) - Number(from);
  return b - a;
}

/* A series with a start splits into the run (n >= start) and the wrap (n < start).
   ETA and "near" only apply when 現在 is already inside the same part as the lot. */
function inSameStartSegment(from, to, start, ser) {
  if (!ser || start == null) return false;
  if (!inSeries(from, ser) || !inSeries(to, ser) || !inSeries(start, ser)) return false;
  const s = Number(start);
  return (Number(from) >= s) === (Number(to) >= s);
}

/* Forward count inside one start-split segment. Does not wrap around the series.
   When start is unknown, falls back to a plain numeric difference. */
function segmentDist(from, to, start, ser) {
  if (start == null || !ser) {
    const d = Number(to) - Number(from);
    return Number.isFinite(d) ? d : null;
  }
  if (!inSameStartSegment(from, to, start, ser)) return null;
  const d = Number(to) - Number(from);
  return Number.isFinite(d) ? d : null;
}

/* 下半場: each 台 runs a segment to its tail and then jumps to another segment
   (5xxx→6xxx, 25xx→5xxx, 2xxx→6xxx). It never wraps back to the series start. */
function seriesWraps(half) {
  return half !== 'afternoon';
}

function walkSeries(from, steps, start, ser, half) {
  const fromN = Number(from);
  if (!ser || start == null) {
    return { n: clampProgress(fromN + steps), capped: false, wrapped: false };
  }
  if (half && !seriesWraps(half)) {
    const floor = Number(start);
    const next = fromN + steps;
    if (steps > 0 && fromN >= ser.hi) return { n: fromN, capped: true, wrapped: false };
    if (steps > 0 && next > ser.hi) return { n: ser.hi, capped: true, wrapped: false };
    if (steps < 0 && next < floor) return { n: Math.min(fromN, floor), capped: true, wrapped: false };
    return { n: next, capped: false, wrapped: false };
  }
  const pos = seriesPos(fromN, start, ser);
  if (pos == null) return { n: clampProgress(fromN + steps), capped: false, wrapped: false };
  const endPos = seriesCycleLen(ser) - 1;
  const nextPos = pos + steps;
  if (steps > 0 && pos >= endPos) return { n: fromN, capped: true, wrapped: false };
  if (steps > 0 && nextPos > endPos) return { n: seriesNumAt(endPos, start, ser), capped: true, wrapped: false };
  if (steps < 0 && nextPos < 0) return { n: seriesNumAt(0, start, ser), capped: true, wrapped: false };
  const n = seriesNumAt(nextPos, start, ser);
  return { n, capped: false, wrapped: steps > 0 && n < fromN };
}

function seriesAtEnd(machineId, half, cur) {
  const h = half || state.currentHalf;
  const now = cur != null ? Number(cur) : currentOf(machineId, h);
  if (now == null) return false;
  const ser = seriesOf(now, h);
  if (!ser) return false;
  if (!seriesWraps(h)) return now >= ser.hi;
  const start = seriesStart(machineId, h, ser);
  if (start == null) return false;
  const pos = seriesPos(now, start, ser);
  return pos != null && pos >= seriesCycleLen(ser) - 1;
}

/* Where this 台 goes after the segment it is in now, from its own ranges.
   Uses the start already set for that segment, else the range's first number.
   Only ever offered as a tap; nothing jumps by itself. */
function nextSegmentOf(machineId, half) {
  const h = half || state.currentHalf;
  const m = machineById(machineId, h);
  const cur = currentOf(machineId, h);
  if (!m || cur == null) return null;
  const ser = seriesOf(cur, h);
  if (!ser) return null;
  const ranges = (m.ranges || []).filter((r) => r && r.start != null && Number.isFinite(Number(r.start)));
  let idx = -1;
  for (let i = 0; i < ranges.length; i++) {
    const rs = seriesOf(ranges[i].start, h);
    if (rs && rs.key === ser.key) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let j = idx + 1; j < ranges.length; j++) {
    const nser = seriesOf(ranges[j].start, h);
    if (!nser || nser.key === ser.key) continue;
    const seg = (pathEntry(machineId, h).segs || []).find((x) => x && x.key === nser.key);
    const start = seg && seg.start != null && Number.isFinite(Number(seg.start))
      ? Number(seg.start)
      : Number(ranges[j].start);
    return { start, ser: nser, key: nser.key };
  }
  return null;
}

/* Next segment even when this 台 has no 現在 yet (he sets 跳到 in the morning).
   First listed range is the opening segment; the following range is the jump. */
function upcomingJumpSegment(machineId, half) {
  const h = half || state.currentHalf;
  const m = machineById(machineId, h);
  if (!m) return null;
  const ranges = (m.ranges || []).filter((r) => r && r.start != null && Number.isFinite(Number(r.start)));
  if (ranges.length < 2) return null;
  const cur = currentOf(machineId, h);
  const ser = cur != null ? seriesOf(cur, h) : null;
  let idx = -1;
  if (ser) {
    for (let i = 0; i < ranges.length; i++) {
      const rs = seriesOf(ranges[i].start, h);
      if (rs && rs.key === ser.key) { idx = i; break; }
    }
  }
  if (idx < 0) idx = 0;
  for (let j = idx + 1; j < ranges.length; j++) {
    const nser = seriesOf(ranges[j].start, h);
    if (!nser || (ser && nser.key === ser.key)) continue;
    const start = Number(ranges[j].start);
    const lo = nser.lo;
    const hi = nser.hi;
    return { start, ser: nser, key: nser.key, lo, hi };
  }
  return null;
}

function jumpTargetValid(n, machineId, half) {
  const seg = upcomingJumpSegment(machineId, half);
  const num = Number(n);
  if (!seg || !Number.isFinite(num)) return false;
  if (num < seg.lo || num > seg.hi) return false;
  return typeof inSeries === 'function' ? inSeries(num, seg.ser) : true;
}

function jumpTargetOf(machineId, half) {
  const h = half || (state && state.currentHalf);
  const seg = upcomingJumpSegment(machineId, h);
  if (!seg) return null;
  const day = state && state.day;
  const stored = day && state.jumpTargets && state.jumpTargets[day] && state.jumpTargets[day][machineId];
  const n = stored == null || stored === '' ? null : Number(stored);
  if (n != null && jumpTargetValid(n, machineId, h)) return n;
  return seg.start;
}

function setJumpTarget(machineId, value, half) {
  const h = half || state.currentHalf;
  const n = parseInt(value, 10);
  const seg = upcomingJumpSegment(machineId, h);
  if (!seg) return false;
  if (!jumpTargetValid(n, machineId, h)) {
    toast('請輸入 ' + seg.lo + ' 到 ' + seg.hi + ' 的號碼，例如 ' + seg.start);
    return false;
  }
  if (!state.jumpTargets || typeof state.jumpTargets !== 'object') state.jumpTargets = {};
  if (!state.jumpTargets[state.day] || typeof state.jumpTargets[state.day] !== 'object') state.jumpTargets[state.day] = {};
  state.jumpTargets[state.day][machineId] = n;
  saveState();
  return true;
}

function endOfSegmentToast(machineId, half) {
  const target = jumpTargetOf(machineId, half);
  toast(target
    ? '這段已到尾，按住「跳到 ' + target + '」'
    : '這段已到尾，點「現在」輸入下一段號碼');
}

function jumpToNextSegment(machineId) {
  const half = state.currentHalf;
  const target = jumpTargetOf(machineId, half);
  if (target == null) {
    toast('這台沒有下一段');
    return;
  }
  modal = null;
  editCurrent = null;
  const snap = snapshotProgress(machineId, half);
  setProgress(machineId, target, half, { silentAdopt: true });
  offerUndo(snap, '已跳到 ' + target + '，按復原可退回');
  render();
}

function nextPlannedEntry(machineId, half, cur) {
  const h = half || state.currentHalf;
  const now = cur != null ? Number(cur) : currentOf(machineId, h);
  const entries = plannedEntries(machineId, h);
  if (!entries.length || now == null) return null;
  const curSer = seriesOf(now, h);
  if (!curSer) return entries[0];
  let seen = false;
  for (const n of entries) {
    const s = seriesOf(n, h);
    if (!s) continue;
    if (s.key === curSer.key) {
      seen = true;
      continue;
    }
    if (seen) return n;
  }
  return null;
}

function ensureSeriesPath(machineId, n, half, opts) {
  opts = opts || {};
  const h = half || state.currentHalf;
  const ser = seriesOf(n, h);
  if (!ser) return { changedSeries: false, started: false, ser: null, start: null };
  const entry = pathEntry(machineId, h);
  const prevCur = opts.prevCur;
  const last = entry.segs.length ? entry.segs[entry.segs.length - 1] : null;
  if (last && last.key === ser.key) {
    return { changedSeries: false, started: false, ser, start: last.start };
  }
  const existing = entry.segs.find((s) => s.key === ser.key);
  if (last && last !== existing && prevCur != null && Number.isFinite(Number(prevCur))) {
    last.lastCur = Number(prevCur);
  }
  if (existing) {
    existing.lastCur = null;
    entry.segs = entry.segs.filter((s) => s !== existing).concat([existing]);
    entry.ts = nowDate().getTime();
    return { changedSeries: true, started: false, resumed: true, ser, start: existing.start };
  }
  const start = opts.start != null ? Number(opts.start) : Number(n);
  entry.segs.push({
    key: ser.key, lo: ser.lo, hi: ser.hi, start, at: nowDate().getTime(), lastCur: null
  });
  entry.ts = nowDate().getTime();
  return { changedSeries: !!last, started: true, first: !last, ser, start };
}

function setSeriesStart(machineId, start, half) {
  const h = half || state.currentHalf;
  const n = parseInt(start, 10);
  if (!Number.isFinite(n)) return false;
  const ser = seriesOf(n, h);
  if (!ser) return false;
  const entry = pathEntry(machineId, h);
  let seg = entry.segs.find((s) => s.key === ser.key);
  if (!seg) {
    entry.segs.push({ key: ser.key, lo: ser.lo, hi: ser.hi, start: n, at: nowDate().getTime(), lastCur: null });
  } else {
    seg.start = n;
    seg.lo = ser.lo;
    seg.hi = ser.hi;
  }
  entry.ts = nowDate().getTime();
  return true;
}

function machineIsRunningSeries(machineId, half, ser) {
  if (!ser) return false;
  const cur = currentOf(machineId, half);
  if (cur == null) return false;
  const s = seriesOf(cur, half);
  return !!(s && s.key === ser.key);
}

function lotsInSeriesOnOtherMachines(machineId, half, ser, opts) {
  opts = opts || {};
  const h = half || state.currentHalf;
  const day = state.day;
  const out = [];
  for (const lot of state.lots || []) {
    if (lot.day !== day || (lot.half || h) !== h) continue;
    if (lot.secondMarket) continue;
    if (lot.machineId === machineId) continue;
    if (lot.status !== 'pending') continue;
    if (!inSeries(lot.number, ser)) continue;
    if (isPassed(lot, currentOf(lot.machineId, h))) continue;
    if (!opts.includeRunning && machineIsRunningSeries(lot.machineId, h, ser)) continue;
    out.push(lot);
  }
  return out;
}

function lotsInSeriesOnOthersForPlan(machineId, half, entries) {
  const seen = new Set();
  const out = [];
  const h = half || state.currentHalf;
  for (const n of entries || []) {
    const ser = seriesOf(n, h);
    if (!ser || seen.has(ser.key)) continue;
    seen.add(ser.key);
    for (const lot of lotsInSeriesOnOtherMachines(machineId, h, ser)) out.push(lot);
  }
  return out;
}

function moveLotsToMachine(lots, destId, half) {
  const moved = [];
  for (const lot of lots || []) {
    if (!lot || lot.machineId === destId) continue;
    moved.push({ id: lot.id, machineId: lot.machineId });
    lot.machineId = destId;
    if (typeof BidSyncCore !== 'undefined' && BidSyncCore.stamp) {
      BidSyncCore.stamp(lot, BidSyncCore.LOT_FIELDS, Date.now(), state.peerId || '');
    }
  }
  return moved;
}

function columnTitleOf(machineId, half) {
  const m = machineById(machineId, half);
  return (m && columnTitle(m, half)) || (m && m.name) || '另一台';
}


function defaultState() {
  const machines = structuredClone(DEFAULT_MACHINES);
  return {
    sellerCode: '',
    paddleTheme: 'yellow',
    vibrate: true,
    keepAwake: true,
    thumbHand: 'left',
    alertGap: 3,
    autoSave4: true,
    currentHalf: 'fruit',
    tab: 'note',
    machines,
    currentNumbers: defaultCurrents(machines),
    progressAnchors: defaultAnchors(machines),
    seriesPath: defaultSeriesPath(machines),
    seriesPlans: defaultSeriesPlans(machines),
    machineMerges: defaultMachineMerges(machines),
    autoAdvance: true,
    lots: [],
    day: todayStr(),
    alerted: {},
    customItems: [],
    itemCounts: {},
    customItemsByHalf: { fruit: [], morning: [], afternoon: [] },
    itemOrderByHalf: { fruit: {}, morning: {}, afternoon: {} },
    itemCountsByHalf: { fruit: {}, morning: {}, afternoon: {} },
    itemUseLogByHalf: { fruit: {}, morning: {}, afternoon: {} },
    itemUseLogMigrated: true,
    progressV2: true,
    itemsMigratedV2: true,
    lastPriority: 'watch',
    dayRules: [],
    machinesMigratedV9: true,
    machinesMigratedAfternoonV96: true,
    machinesMigratedAfternoonV98: true,
    v98ProgressCleaned: '',
    gpIgnoreBefore: 0,
    jumpTargets: {},
    itemsMigratedV17: true,
    itemsMigratedV21: true,
    itemsMigratedV46: true,
    itemsMigratedV67: true,
    itemsMigratedV85: true,
    itemsMigratedV86: true,
    itemsMigratedV108: true,
    dayCutoffHour: DEFAULT_DAY_CUTOFF_HOUR,
    lotsPerMin: DEFAULT_LOTS_PER_MIN,
    skipAutoDay: '',
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
    syncTombstones: { lots: {}, plan: {} },
    syncDisplayName: '',
    syncNamePrompted: false
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
    merged.progressAnchors = {};
    merged.seriesPath = {};
    merged.seriesPlans = {};
    merged.machineMerges = {};
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
      merged.progressAnchors[half] = {
        ...(base.progressAnchors[half] || {}),
        ...((saved.progressAnchors && saved.progressAnchors[half]) || {})
      };
      merged.seriesPath[half] = {
        ...(base.seriesPath[half] || {}),
        ...((saved.seriesPath && saved.seriesPath[half]) || {})
      };
      merged.seriesPlans[half] = {
        ...(base.seriesPlans[half] || {}),
        ...((saved.seriesPlans && saved.seriesPlans[half]) || {})
      };
      merged.machineMerges[half] = {
        ...(base.machineMerges[half] || {}),
        ...((saved.machineMerges && saved.machineMerges[half]) || {})
      };
    }
    merged.autoAdvance = merged.autoAdvance !== false;
    if (!isHalf(merged.currentHalf)) merged.currentHalf = 'fruit';
    {
      const ch = Number(merged.dayCutoffHour);
      merged.dayCutoffHour = (Number.isFinite(ch) && ch >= 0 && ch <= 23)
        ? Math.floor(ch)
        : DEFAULT_DAY_CUTOFF_HOUR;
    }
    {
      const r = Number(merged.lotsPerMin);
      merged.lotsPerMin = (Number.isFinite(r) && r >= 1 && r <= 12)
        ? Math.round(r * 10) / 10
        : DEFAULT_LOTS_PER_MIN;
    }
    if (merged.skipAutoDay != null && typeof merged.skipAutoDay !== 'string') merged.skipAutoDay = '';
    if (!merged.jumpTargets || typeof merged.jumpTargets !== 'object' || Array.isArray(merged.jumpTargets)) {
      merged.jumpTargets = {};
    }

    if (!Array.isArray(merged.lots)) merged.lots = [];
    if (!merged.alerted || typeof merged.alerted !== 'object') merged.alerted = {};
    if (!Array.isArray(merged.customItems)) merged.customItems = [];
    if (!merged.itemCounts || typeof merged.itemCounts !== 'object') merged.itemCounts = {};
    migrateItemLists(merged);
    merged.itemOrderByHalf = normalizeItemOrderMap(merged.itemOrderByHalf);
    if (!Array.isArray(merged.dayRules)) merged.dayRules = [];
    if (!['must', 'watch', 'skip'].includes(merged.lastPriority)) merged.lastPriority = 'watch';
    if (merged.thumbHand !== 'right') merged.thumbHand = 'left';
    if (!saved.machinesMigratedV9) {
      migrateMorning3500(merged);
      merged.machinesMigratedV9 = true;
    }
    if (!saved.machinesMigratedAfternoonV96) {
      migrateAfternoonV96(merged);
      merged.machinesMigratedAfternoonV96 = true;
    }
    if (!saved.machinesMigratedAfternoonV98) {
      migrateAfternoonV98(merged);
      merged.machinesMigratedAfternoonV98 = true;
    }
    if (!saved.itemsMigratedV17) {
      migrateItemsV17(merged);
    }
    if (!saved.itemsMigratedV21) {
      migrateItemsV21(merged);
    }
    if (!saved.itemsMigratedV46) {
      migrateItemsV46(merged);
    }
    if (!saved.itemsMigratedV67) {
      migrateItemsV67(merged);
    }
    if (!saved.itemsMigratedV85) {
      migrateItemsV85(merged);
    }
    if (!saved.itemsMigratedV86) {
      migrateItemsV86(merged);
    }
    if (!saved.itemsMigratedV108) {
      migrateItemsV108(merged);
    }
    for (const lot of merged.lots) {
      if (!['must', 'watch', 'skip'].includes(lot.priority)) lot.priority = 'watch';
      if (lot.subCode != null) {
        const c = String(lot.subCode).replace(/\D/g, '').slice(0, 3);
        lot.subCode = c;
      }
      if (lot.item && itemNeedsSize(lot.item)) {
        lot.size = normalizeSize(lot.size, lot.item);
      }
    }
    if (/^\d{4}$/.test(String(merged.sellerCode || ''))) merged.setupDone = true;
    if (merged.tab === 'track' || merged.tab === 'result' || merged.tab === 'settings') {
      merged.tab = 'live';
    }
    if (!merged.progressV2) {
      merged.currentNumbers = defaultCurrents(merged.machines);
      merged.progressAnchors = defaultAnchors(merged.machines);
      merged.progressV2 = true;
    }
    if (!merged.machinesMigratedXferV75) {
      clearCollapsedMerges(merged);
      merged.machinesMigratedXferV75 = true;
    }
    if (!merged.machinesMigratedSeqV76) {
      clearSavedSeriesPlans(merged);
      merged.machinesMigratedSeqV76 = true;
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
    if (typeof merged.syncDisplayName !== 'string') merged.syncDisplayName = '';
    else if (typeof normalizeSyncName === 'function') merged.syncDisplayName = normalizeSyncName(merged.syncDisplayName);
    merged.syncNamePrompted = !!merged.syncNamePrompted;
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

/* v109: serialising the whole state (hundreds of lots) and writing it to
   localStorage took ~30 ms on a mid-range phone, on every single tap. The
   write now happens once the taps pause (and always when the page is hidden
   or closed), so rapid taps stay quick and nothing is lost. */
let stateWriteTimer = null;
let stateWriteFailedToasted = false;
function writeStateNow() {
  if (stateWriteTimer) {
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    stateWriteFailedToasted = false;
  } catch (err) {
    if (!stateWriteFailedToasted) {
      stateWriteFailedToasted = true;
      toast('儲存失敗，空間可能不足');
    }
  }
}
let stateDirtySince = 0;
function writeStateSoon() {
  // Wait for a pause in the tapping (trailing debounce), but never hold a change
  // back for more than 3 seconds.
  const now = Date.now();
  if (!stateWriteTimer) stateDirtySince = now;
  else clearTimeout(stateWriteTimer);
  const wait = Math.max(0, Math.min(700, 3000 - (now - stateDirtySince)));
  stateWriteTimer = setTimeout(writeStateNow, wait);
}
['pagehide', 'beforeunload', 'freeze'].forEach((ev) => window.addEventListener(ev, () => { if (stateWriteTimer) writeStateNow(); }));
document.addEventListener('visibilitychange', () => { if (stateWriteTimer && document.visibilityState !== 'visible') writeStateNow(); });

function saveState() {
  if (!planProgressLock) {
    planProgressLock = true;
    try { applyPlanProgressFromLots(); } finally { planProgressLock = false; }
  }
  writeStateSoon();
  if (typeof onLocalStateSaved === 'function') onLocalStateSaved();
  if (typeof onGlobalProgressSaved === 'function') onGlobalProgressSaved();
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
  if (!state.progressAnchors) state.progressAnchors = defaultAnchors(state.machines);
  if (!state.progressAnchors[h]) state.progressAnchors[h] = {};
  state.progressAnchors[h][id] = null;
  ensurePathStore(h);
  state.seriesPath[h][id] = { segs: [], ts: 0 };
  state.seriesPlans[h][id] = { entries: [], ts: 0 };
  state.machineMerges[h][id] = null;
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
  if (state.progressAnchors && state.progressAnchors[h]) delete state.progressAnchors[h][gone.id];
  if (state.seriesPath && state.seriesPath[h]) delete state.seriesPath[h][gone.id];
  if (state.seriesPlans && state.seriesPlans[h]) delete state.seriesPlans[h][gone.id];
  if (state.machineMerges && state.machineMerges[h]) delete state.machineMerges[h][gone.id];
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
  if (p === 'must') return '美';
  if (p === 'skip') return '交貨';
  return '普';
}

function prioShort(p) {
  if (p === 'must') return '美';
  if (p === 'skip') return '交';
  return '普';
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
  if (!lot || lot.status !== 'pending' || lot.secondMarket) return false;
  const half = lot.half || (state && state.currentHalf);
  const mid = lot.machineId;
  const now = (cur != null && cur !== '') ? Number(cur) : currentOf(mid, half);
  if (now == null || !Number.isFinite(Number(now))) return false;
  const lotSer = seriesOf(lot.number, half);
  if (!lotSer || !inSeries(lot.number, lotSer)) return Number(lot.number) < now;
  const curSer = seriesOf(now, half);
  if (curSer && curSer.key === lotSer.key) {
    const start = seriesStart(mid, half, curSer);
    const s = start != null ? start : now;
    return wrapIsBehind(lot.number, now, s, lotSer);
  }
  // This 台 already left the series: only the portion it actually ran is passed.
  // Wrap leftovers stay upcoming — they may still be auctioned, possibly on another 台.
  const segs = pathEntry(mid, half).segs || [];
  const seg = segs.find((s) => s.key === lotSer.key);
  if (seg && seg.start != null && seg.lastCur != null) {
    const last = Number(seg.lastCur);
    return wrapIsBehind(lot.number, last, seg.start, lotSer) || Number(lot.number) === last;
  }
  return false;
}

function lotsPerMin() {
  const n = Number(state && state.lotsPerMin);
  return (Number.isFinite(n) && n >= 1 && n <= 12) ? Math.round(n * 10) / 10 : DEFAULT_LOTS_PER_MIN;
}

function lotEtaMinutes(lot, cur) {
  if (cur == null || !lot || lot.status !== 'pending' || lot.secondMarket) return null;
  const half = lot.half || (state && state.currentHalf);
  const mid = lot.machineId;
  const now = Number(cur);
  const ser = seriesOf(now, half);
  const lotSer = seriesOf(lot.number, half);
  if (!ser || !lotSer || ser.key !== lotSer.key) return null;
  const start = seriesStart(mid, half, ser);
  if (start == null) return null;
  // Wrap lots (before 起) are a later segment. Do not pretend this 台 will
  // finish the rest of the series first unless 現在 is already in that wrap.
  const d = segmentDist(now, lot.number, start, ser);
  if (d == null || !Number.isFinite(d) || d <= 0) return null;
  const rate = lotsPerMin();
  if (!(rate > 0)) return null;
  return Math.max(1, Math.round(d / rate));
}

function lotEtaLabel(lot, cur) {
  const m = lotEtaMinutes(lot, cur);
  return m == null ? '' : '約' + m + '分';
}

function isFlow(lot) {
  return !!(lot && lot.status === 'flow');
}

function isWon(lot) {
  return !!(lot && (lot.status === 'won' || lot.status === 'moved'));
}

function unmovedQty(lots) {
  let n = 0;
  for (const l of lots || []) {
    if (l && l.status === 'won') n += lotQty(l);
  }
  return n;
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

function lotOrderTuple(lot, machineId, half) {
  const h = half || (lot && lot.half) || (state && state.currentHalf);
  const cur = currentOf(machineId, h);
  const curSer = cur != null ? seriesOf(cur, h) : null;
  const lotSer = seriesOf(lot.number, h);
  const segs = pathEntry(machineId, h).segs || [];
  if (curSer && lotSer && lotSer.key === curSer.key) {
    const start = seriesStart(machineId, h, curSer) ?? curSer.lo;
    return [0, seriesPos(lot.number, start, lotSer) ?? 0, lot.createdAt || 0];
  }
  const idx = lotSer ? segs.findIndex((s) => s.key === lotSer.key) : -1;
  if (idx >= 0) {
    const seg = segs[idx];
    const start = seg.start != null ? seg.start : (lotSer && lotSer.lo);
    return [100 + idx, seriesPos(lot.number, start, lotSer) ?? 0, lot.createdAt || 0];
  }
  return [1000, Number(lot.number) || 0, lot.createdAt || 0];
}

function compareLotOrder(a, b, machineId, half) {
  const ta = lotOrderTuple(a, machineId, half);
  const tb = lotOrderTuple(b, machineId, half);
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

function columnLots(machineId, half) {
  return todayLots(half)
    .filter((l) => l.machineId === machineId)
    .sort((a, b) => compareLotOrder(a, b, machineId, half));
}

function captureLiveScroll() {
  liveScrolls = {};
  document.querySelectorAll('.live-col-list').forEach((el) => {
    liveScrolls[el.dataset.id] = el.scrollTop;
  });
}

function restoreLiveScroll(onlyFollow) {
  document.querySelectorAll('.live-col-list').forEach((el) => {
    const id = el.dataset.id;
    if (onlyFollow && !(typeof liveScrollFollow === 'object' && liveScrollFollow[id])) return;
    if (typeof liveScrollFollow === 'object' && liveScrollFollow[id]) {
      const next = el.querySelector('.lot-cell.next');
      if (next) el.scrollTop = Math.max(0, next.offsetTop - 8);
      delete liveScrollFollow[id];
      return;
    }
    if (liveScrolls[id] != null) el.scrollTop = liveScrolls[id];
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
    qty: lotQty(lot),
    lot: { ...lot }
  };
}

function restoreCurrent(snap) {
  if (!snap) return;
  const half = snap.half || state.currentHalf;
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  state.currentNumbers[half][snap.machineId] = snap.current;
  if (!state.progressAnchors) state.progressAnchors = defaultAnchors(state.machines);
  if (!state.progressAnchors[half]) state.progressAnchors[half] = {};
  if (Object.prototype.hasOwnProperty.call(snap, 'anchor')) {
    if (!snap.anchor) {
      writeAnchor(snap.machineId, half, null);
    } else {
      const a = { ...snap.anchor };
      a.at = nowDate().getTime();
      a.seeded = false;
      a.cleared = false;
      state.progressAnchors[half][snap.machineId] = a;
    }
  } else if (snap.current == null || snap.current === '') {
    writeAnchor(snap.machineId, half, null);
  } else {
    writeAnchor(snap.machineId, half, {
      number: Number(snap.current),
      at: nowDate().getTime(),
      paused: true,
      ended: false
    });
  }
  if (snap.seriesPath && typeof snap.seriesPath === 'object') state.seriesPath = structuredClone(snap.seriesPath);
  if (snap.seriesPlans && typeof snap.seriesPlans === 'object') state.seriesPlans = structuredClone(snap.seriesPlans);
  if (snap.machineMerges && typeof snap.machineMerges === 'object') state.machineMerges = structuredClone(snap.machineMerges);
  syncProgressTimer();
}

function offerUndo(snap, msg) {
  undoStack = snap;
  toast(msg, 6000, { label: '復原', fn: undoLast });
}

function undoLast() {
  const snap = undoStack;
  undoStack = null;
  toastMsg = '';
  toastAction = null;
  if (!snap) return;
  if (snap.kind === 'range-add' && Array.isArray(snap.lots)) {
    const ids = new Set(snap.lots.map((l) => l && l.id).filter(Boolean));
    state.lots = (state.lots || []).filter((l) => !ids.has(l.id));
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'delete' && snap.lot) {
    if (!state.lots.some((l) => l.id === snap.lot.id)) state.lots.push(snap.lot);
    restoreCurrent(snap);
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'progress') {
    restoreCurrent(snap);
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'adopt-lots' && Array.isArray(snap.moved)) {
    for (const row of snap.moved) {
      const lot = (state.lots || []).find((l) => l.id === row.id);
      if (lot) {
        lot.machineId = row.machineId;
        if (typeof BidSyncCore !== 'undefined' && BidSyncCore.stamp) {
          BidSyncCore.stamp(lot, BidSyncCore.LOT_FIELDS, Date.now(), state.peerId || '');
        }
      }
    }
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'xfer-wrap' || snap.kind === 'merge-machine') {
    for (const row of snap.moved || []) {
      const lot = (state.lots || []).find((l) => l.id === row.id);
      if (lot) {
        lot.machineId = row.machineId;
        if (typeof BidSyncCore !== 'undefined' && BidSyncCore.stamp) {
          BidSyncCore.stamp(lot, BidSyncCore.LOT_FIELDS, Date.now(), state.peerId || '');
        }
      }
    }
    const h = snap.half || state.currentHalf;
    ensurePathStore(h);
    if (snap.merge === undefined) state.machineMerges[h][snap.srcId] = null;
    else state.machineMerges[h][snap.srcId] = snap.merge;
    if (snap.seriesPath) state.seriesPath = structuredClone(snap.seriesPath);
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'series-plan') {
    const h = snap.half || state.currentHalf;
    ensurePathStore(h);
    if (snap.prevPlan) state.seriesPlans[h][snap.machineId] = structuredClone(snap.prevPlan);
    else state.seriesPlans[h][snap.machineId] = { entries: [], ts: 0 };
    if (Array.isArray(snap.moved)) {
      for (const row of snap.moved) {
        const lot = (state.lots || []).find((l) => l.id === row.id);
        if (lot) {
          lot.machineId = row.machineId;
          if (typeof BidSyncCore !== 'undefined' && BidSyncCore.stamp) {
            BidSyncCore.stamp(lot, BidSyncCore.LOT_FIELDS, Date.now(), state.peerId || '');
          }
        }
      }
    }
    if (snap.seriesPath) state.seriesPath = structuredClone(snap.seriesPath);
    saveState();
    toast('已復原');
    buzz(24);
    render();
    return;
  }
  if (snap.kind === 'new-day') {
    state.lots = Array.isArray(snap.lots) ? snap.lots.slice() : [];
    if (snap.day) state.day = snap.day;
    if (snap.currentNumbers && typeof snap.currentNumbers === 'object') {
      state.currentNumbers = snap.currentNumbers;
    }
    if (snap.progressAnchors && typeof snap.progressAnchors === 'object') {
      state.progressAnchors = snap.progressAnchors;
    }
    if (snap.seriesPath && typeof snap.seriesPath === 'object') state.seriesPath = snap.seriesPath;
    if (snap.seriesPlans && typeof snap.seriesPlans === 'object') state.seriesPlans = snap.seriesPlans;
    if (snap.machineMerges && typeof snap.machineMerges === 'object') state.machineMerges = snap.machineMerges;
    if (snap.jumpTargets && typeof snap.jumpTargets === 'object') state.jumpTargets = snap.jumpTargets;
    if (typeof snap.autoAdvance === 'boolean') state.autoAdvance = snap.autoAdvance;
    state.alerted = snap.alerted && typeof snap.alerted === 'object' ? snap.alerted : {};
    if (Array.isArray(snap.boughtHistory)) state.boughtHistory = snap.boughtHistory;
    if (snap.currentHalf) state.currentHalf = snap.currentHalf;
    if (snap.tab) state.tab = snap.tab;
    state.skipAutoDay = todayStr();
    showSettings = false;
    saveState();
    freezeItemRanks();
    toast('已復原');
    buzz(24);
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
  if (snap.qty != null) lot.qty = lotQty({ qty: snap.qty });
  restoreCurrent(snap);
  saveState();
  toast('已復原');
  buzz(24);
  render();
}

function cycleLotStatus(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  requestLotColorAnim();
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
  } else if (lot.status === 'lost') {
    next = 'moved';
    label = '已搬貨';
  } else if (lot.status === 'moved') {
    next = 'pending';
    label = '改回未拍';
  } else {
    next = 'pending';
    label = '改回未拍';
  }
  lot.status = next;
  rememberBoughtLots(state.lots);
  if (!startColumnFromLot(lot)) saveState();
  checkAlerts();
  offerUndo(snap, withPlanToast(`${label} ${lotLabel(lot)}`));
  buzz(24);
  render();
}

function markFlow(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  requestLotColorAnim();
  const snap = snapshotLot(lot);
  lot.status = 'flow';
  lot.secondMarket = true;
  if (!startColumnFromLot(lot)) saveState();
  checkAlerts();
  offerUndo(snap, withPlanToast(`流標・二市 ${lotLabel(lot)}`));
  buzz(28);
  render();
}

function cancelFlow(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || lot.status !== 'flow') return;
  requestLotColorAnim();
  const snap = snapshotLot(lot);
  lot.status = 'pending';
  lot.secondMarket = false;
  saveState();
  offerUndo(snap, `已取消流標 ${lotLabel(lot)}`);
  render();
}

function setLotQty(id, delta) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const next = Math.max(1, Math.min(99, lotQty(lot) + (Number(delta) || 0)));
  if (next === lotQty(lot) && lot.qty === next) return;
  const snap = snapshotLot(lot);
  lot.qty = next;
  saveState();
  offerUndo(snap, `${lot.number}　${next} 件`);
  buzz(20);
  render();
}

function undoLotMark(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || lot.status === 'pending') return;
  requestLotColorAnim();
  const snap = snapshotLot(lot);
  const label = lot.status === 'won' || lot.status === 'moved' ? '已取消標到' : lot.status === 'flow' ? '已取消流標' : '已改回未拍';
  lot.status = 'pending';
  lot.secondMarket = false;
  saveState();
  checkAlerts();
  offerUndo(snap, withPlanToast(`${label} ${lotLabel(lot)}`));
  buzz(24);
  render();
}

function markLost(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || lot.status === 'lost') return;
  requestLotColorAnim();
  const snap = snapshotLot(lot);
  lot.status = 'lost';
  rememberBoughtLots(state.lots);
  if (!startColumnFromLot(lot)) saveState();
  checkAlerts();
  offerUndo(snap, withPlanToast(`沒標到 ${lotLabel(lot)}`));
  buzz(24);
  render();
}

function unmoveLot(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || lot.status !== 'moved') return;
  requestLotColorAnim();
  const snap = snapshotLot(lot);
  lot.status = 'won';
  rememberBoughtLots(state.lots);
  saveState();
  offerUndo(snap, `改回標到 ${lotLabel(lot)}`);
  buzz(24);
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
  requestSegAnim();
  requestLotColorAnim();
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
  requestSegAnim();
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

function lotSubCode(lot) {
  const s = String(lot && lot.subCode != null ? lot.subCode : '').replace(/\D/g, '').slice(0, 3);
  return s;
}

function lotLabel(lot) {
  if (!lot) return '';
  const code = lotSubCode(lot);
  const codeBit = code ? '　' + code : '';
  if (!lot.item) return String(lot.number) + codeBit;
  const size = itemNeedsSize(lot.item) && sizeLabel(lot.size, lot.item) ? ' ' + sizeLabel(lot.size, lot.item) : '';
  return `${lot.number} ${itemDisplayName(lot.item)}${size}${codeBit}`;
}

function lotNumHtml(lot, opts) {
  const sub = lotSubCode(lot);
  const num = escapeHtml(String(lot && lot.number != null ? lot.number : ''));
  const numClass = (opts && opts.numClass) || 'ln-num';
  const edit = !!(opts && opts.edit);
  const label = sub ? ('小代碼 ' + sub + '，點一下可改或清除') : '註記小代碼';
  if (!edit) {
    if (!sub) return `<span class="${numClass}">${num}</span>`;
    return `<span class="num-sub-wrap has-sub"><span class="${numClass}">${num}</span><span class="num-sub on">${escapeHtml(sub)}</span></span>`;
  }
  const act = ` data-act="edit-subcode" data-id="${escapeHtml(lot.id)}" aria-label="${escapeHtml(label)}"`;
  const body = sub ? escapeHtml(sub) : '···';
  return `<span class="num-sub-wrap${sub ? ' has-sub' : ''}"><span class="${numClass}">${num}</span><span class="num-sub${sub ? ' on' : ' empty'}"${act}>${body}</span></span>`;
}

function lotLabelHtml(lot, opts) {
  if (!lot) return '';
  const size = itemNeedsSize(lot.item) && sizeLabel(lot.size, lot.item) ? ' ' + escapeHtml(sizeLabel(lot.size, lot.item)) : '';
  const item = lot.item ? ` <span class="ln-item">${escapeHtml(itemDisplayName(lot.item))}${size}</span>` : '';
  return `${lotNumHtml(lot, opts)}${item}`;
}

function openSubCodeEditor(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  modal = { type: 'subcode', id, value: lotSubCode(lot) };
  buzz(12);
  render();
}

function typeSubCodeDigit(d) {
  if (!modal || modal.type !== 'subcode') return;
  let v = String(modal.value || '');
  if (v.length >= 3) v = '';
  v = (v + String(d)).replace(/\D/g, '').slice(0, 3);
  modal.value = v;
  if (v.length === 3) {
    setLotSubCode(modal.id, v);
    return;
  }
  render();
}

function backspaceSubCode() {
  if (!modal || modal.type !== 'subcode') return;
  modal.value = String(modal.value || '').slice(0, -1);
  render();
}

function clearSubCodeDraft() {
  if (!modal || modal.type !== 'subcode') return;
  modal.value = '';
  render();
}

function setLotSubCode(id, code) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const next = String(code || '').replace(/\D/g, '').slice(0, 3);
  const prev = lotSubCode(lot);
  if (next === prev) {
    modal = null;
    render();
    return;
  }
  const snap = snapshotLot(lot);
  lot.subCode = next;
  saveState();
  offerUndo(snap, next ? `${lot.number}　${next}` : `${lot.number}　已清除`);
  modal = null;
  buzz(26);
  render();
}

function eraseLotSubCode(id) {
  setLotSubCode(id, '');
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
  if (!merged.itemUseLogByHalf || typeof merged.itemUseLogByHalf !== 'object') {
    merged.itemUseLogByHalf = { fruit: {}, morning: {}, afternoon: {} };
  }
  if (!merged.itemUseLogByHalf[fromHalf] || typeof merged.itemUseLogByHalf[fromHalf] !== 'object') {
    merged.itemUseLogByHalf[fromHalf] = {};
  }
  if (!merged.itemUseLogByHalf[toHalf] || typeof merged.itemUseLogByHalf[toHalf] !== 'object') {
    merged.itemUseLogByHalf[toHalf] = {};
  }
  const fromLog = merged.itemUseLogByHalf[fromHalf];
  const toLog = merged.itemUseLogByHalf[toHalf];
  for (const key of Object.keys(fromLog)) {
    if (!names.has(key)) continue;
    const src = Array.isArray(fromLog[key]) ? fromLog[key] : [];
    const dest = Array.isArray(toLog[key]) ? toLog[key] : [];
    toLog[key] = dest.concat(src);
    delete fromLog[key];
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

const POTATO_V67_NAMES = new Set(['馬鈴薯', '馬鈴薯-本產', '馬鈴薯-進口', '進口馬鈴薯']);
const REMOVED_V67_NAMES = new Set([
  '美人腿', '茭白筍', '茭白筍-帶殼', '茭白筍-去殼', '茭白筍-進口',
  '豆薯', '掛薺',
  '蓮藕', '蓮藕-進口',
  '越瓜', '越瓜-青色', '越瓜-白色', '越瓜-其他', '越瓜-加工', '醃瓜',
  '鵲豆', '鵠豆', '鵲豆-肉豆', '肉豆'
]);

function migrateItemsV67(merged) {
  moveCustomsAndCounts(merged, 'afternoon', 'morning', POTATO_V67_NAMES);
  const strip = (arr) => (Array.isArray(arr) ? arr.filter((n) => n && !REMOVED_V67_NAMES.has(String(n).trim())) : arr);
  if (Array.isArray(merged.customItems)) merged.customItems = strip(merged.customItems);
  if (merged.customItemsByHalf && typeof merged.customItemsByHalf === 'object') {
    for (const half of Object.keys(merged.customItemsByHalf)) {
      merged.customItemsByHalf[half] = strip(merged.customItemsByHalf[half]);
    }
  }
  merged.itemsMigratedV67 = true;
}

const DISPLAY_RENAME_V46 = {
  '萵苣菜': '大陸妹',
  '芥藍菜': '芥藍',
  '芫荽': '香菜',
  '蕨菜': '過貓',
  '海菜': '水蓮',
  '扁蒲': '蒲仔',
  '胡瓜': '大黃瓜',
  '萵苣莖': 'A菜心',
  '球莖甘藍': '結頭菜',
  '隼人瓜': '佛手瓜',
  '薯蕷': '山藥',
  '萊豆': '皇帝豆',
  '落花生': '花生'
};

function renameDisplayText(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  if (DISPLAY_RENAME_V46[raw]) return DISPLAY_RENAME_V46[raw];
  const parsed = (typeof parsePlanItemText === 'function') ? parsePlanItemText(raw) : { name: raw, size: '', raw };
  if (parsed && parsed.name && DISPLAY_RENAME_V46[parsed.name]) {
    const next = DISPLAY_RENAME_V46[parsed.name];
    if (parsed.size) return next + ' ' + parsed.size;
    if (parsed.raw && parsed.raw !== parsed.name) return parsed.raw.replace(parsed.name, next);
    return next;
  }
  return raw;
}

function mergeCountKey(map, from, to) {
  if (!map || from === to || map[from] == null) return;
  const n = Number(map[from]) || 0;
  if (n) map[to] = (Number(map[to]) || 0) + n;
  delete map[from];
}

function mergeUseLogKey(log, from, to) {
  if (!log || from === to || !log[from]) return;
  const src = Array.isArray(log[from]) ? log[from] : [];
  const dest = Array.isArray(log[to]) ? log[to].slice() : [];
  const byDay = new Map();
  for (const ev of dest) {
    if (ev && ev.day) byDay.set(ev.day, { day: ev.day, n: Number(ev.n) || 0 });
  }
  for (const ev of src) {
    if (!ev || !ev.day) continue;
    const cur = byDay.get(ev.day) || { day: ev.day, n: 0 };
    cur.n += Number(ev.n) || 0;
    byDay.set(ev.day, cur);
  }
  log[to] = [...byDay.values()];
  delete log[from];
}

function migrateItemsV46(merged) {
  for (const p of merged.planItems || []) {
    if (!p) continue;
    p.text = renameDisplayText(p.text);
  }
  const seen = new Map();
  const kept = [];
  for (const p of merged.planItems || []) {
    if (!p) continue;
    const key = (p.done ? 'd' : 'o') + '	' + (p.forDay || '') + '	' + String(p.text || '');
    const prev = seen.get(key);
    if (prev && !p.done) {
      const qa = parseInt(prev.qty, 10);
      const qb = parseInt(p.qty, 10);
      const a = Number.isFinite(qa) && qa > 0 ? qa : 1;
      const b = Number.isFinite(qb) && qb > 0 ? qb : 1;
      prev.qty = Math.min(99, a + b);
      continue;
    }
    seen.set(key, p);
    kept.push(p);
  }
  if (merged.planItems) merged.planItems = kept;
  for (const lot of merged.lots || []) {
    if (!lot || !lot.item) continue;
    lot.item = renameDisplayText(lot.item);
  }
  for (const h of merged.boughtHistory || []) {
    for (const it of (h && h.items) || []) {
      if (!it) continue;
      it.text = renameDisplayText(it.text);
    }
  }
  if (merged.itemCounts && typeof merged.itemCounts === 'object') {
    for (const [from, to] of Object.entries(DISPLAY_RENAME_V46)) mergeCountKey(merged.itemCounts, from, to);
  }
  if (merged.itemCountsByHalf && typeof merged.itemCountsByHalf === 'object') {
    for (const half of Object.keys(merged.itemCountsByHalf)) {
      const map = merged.itemCountsByHalf[half];
      if (!map || typeof map !== 'object') continue;
      for (const [from, to] of Object.entries(DISPLAY_RENAME_V46)) mergeCountKey(map, from, to);
    }
  }
  if (merged.itemUseLogByHalf && typeof merged.itemUseLogByHalf === 'object') {
    for (const half of Object.keys(merged.itemUseLogByHalf)) {
      const log = merged.itemUseLogByHalf[half];
      if (!log || typeof log !== 'object') continue;
      for (const [from, to] of Object.entries(DISPLAY_RENAME_V46)) mergeUseLogKey(log, from, to);
    }
  }
  const renameInList = (arr) => {
    if (!Array.isArray(arr)) return arr;
    const out = [];
    const have = new Set();
    for (const raw of arr) {
      const n = renameDisplayText(raw);
      if (!n || have.has(n)) continue;
      have.add(n);
      out.push(n);
    }
    return out;
  };
  if (Array.isArray(merged.customItems)) merged.customItems = renameInList(merged.customItems);
  if (merged.customItemsByHalf && typeof merged.customItemsByHalf === 'object') {
    for (const half of Object.keys(merged.customItemsByHalf)) {
      merged.customItemsByHalf[half] = renameInList(merged.customItemsByHalf[half]);
    }
  }
  merged.itemsMigratedV46 = true;
}



function migrateItemsV86(merged) {
  /* Keep historical lots/notes named 豌豆. Just drop the hidden parent from
     saved button order so it does not occupy a grid slot. */
  const drop = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((n) => {
      const name = String(n || '').trim();
      return name && name !== '豌豆' && name !== '碗豆';
    });
  };
  if (merged.itemOrderByHalf && typeof merged.itemOrderByHalf === 'object') {
    for (const half of Object.keys(merged.itemOrderByHalf)) {
      const groups = merged.itemOrderByHalf[half];
      if (!groups || typeof groups !== 'object') continue;
      for (const group of Object.keys(groups)) {
        groups[group] = drop(groups[group]);
      }
    }
    if (typeof normalizeItemOrderMap === 'function') {
      merged.itemOrderByHalf = normalizeItemOrderMap(merged.itemOrderByHalf);
    }
  }
  merged.itemsMigratedV86 = true;
}

const DISPLAY_RENAME_V108 = {
  'A菜心': '萵筍',
  '萵苣莖': '萵筍',
  '大心菜': '菜心',
  '大心菜-帶葉': '菜心',
  '大心菜 帶葉': '菜心'
};

const CAIXIN_V108_NAMES = new Set([
  '大心菜', '菜心', '大心菜-帶葉', '大心菜 帶葉', '大心菜-其他', '大心菜 其他'
]);

function renameDisplayTextV108(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  if (DISPLAY_RENAME_V108[raw]) return DISPLAY_RENAME_V108[raw];
  const parsed = (typeof parsePlanItemText === 'function') ? parsePlanItemText(raw) : { name: raw, size: '', raw };
  if (parsed && parsed.name && DISPLAY_RENAME_V108[parsed.name]) {
    const next = DISPLAY_RENAME_V108[parsed.name];
    if (parsed.size) return next + ' ' + parsed.size;
    if (parsed.raw && parsed.raw !== parsed.name) return parsed.raw.replace(parsed.name, next);
    return next;
  }
  return raw;
}

function migrateItemsV108(merged) {
  const rename = (raw) => {
    const n = String(raw || '').trim();
    if (!n) return n;
    const next = renameDisplayTextV108(n);
    return next || n;
  };
  for (const p of merged.planItems || []) {
    if (!p) continue;
    p.text = rename(p.text);
  }
  for (const lot of merged.lots || []) {
    if (!lot || !lot.item) continue;
    lot.item = rename(lot.item);
  }
  for (const h of merged.boughtHistory || []) {
    for (const it of (h && h.items) || []) {
      if (!it) continue;
      it.text = rename(it.text);
    }
  }
  if (merged.itemCounts && typeof merged.itemCounts === 'object') {
    for (const [from, to] of Object.entries(DISPLAY_RENAME_V108)) mergeCountKey(merged.itemCounts, from, to);
  }
  if (merged.itemCountsByHalf && typeof merged.itemCountsByHalf === 'object') {
    for (const half of Object.keys(merged.itemCountsByHalf)) {
      const map = merged.itemCountsByHalf[half];
      if (!map || typeof map !== 'object') continue;
      for (const [from, to] of Object.entries(DISPLAY_RENAME_V108)) mergeCountKey(map, from, to);
    }
  }
  if (merged.itemUseLogByHalf && typeof merged.itemUseLogByHalf === 'object') {
    for (const half of Object.keys(merged.itemUseLogByHalf)) {
      const log = merged.itemUseLogByHalf[half];
      if (!log || typeof log !== 'object') continue;
      for (const [from, to] of Object.entries(DISPLAY_RENAME_V108)) mergeUseLogKey(log, from, to);
    }
  }
  const renameInList = (arr) => {
    if (!Array.isArray(arr)) return arr;
    const out = [];
    const have = new Set();
    for (const raw of arr) {
      const n = rename(raw);
      if (!n || have.has(n)) continue;
      have.add(n);
      out.push(n);
    }
    return out;
  };
  if (Array.isArray(merged.customItems)) merged.customItems = renameInList(merged.customItems);
  if (merged.customItemsByHalf && typeof merged.customItemsByHalf === 'object') {
    for (const half of Object.keys(merged.customItemsByHalf)) {
      merged.customItemsByHalf[half] = renameInList(merged.customItemsByHalf[half]);
    }
  }
  if (merged.itemOrderByHalf && typeof merged.itemOrderByHalf === 'object') {
    for (const half of Object.keys(merged.itemOrderByHalf)) {
      const groups = merged.itemOrderByHalf[half];
      if (!groups || typeof groups !== 'object') continue;
      for (const group of Object.keys(groups)) {
        groups[group] = renameInList(groups[group]);
      }
    }
  }
  moveCustomsAndCounts(merged, 'morning', 'afternoon', CAIXIN_V108_NAMES);
  if (merged.itemOrderByHalf && merged.itemOrderByHalf.morning && typeof merged.itemOrderByHalf.morning === 'object') {
    for (const group of Object.keys(merged.itemOrderByHalf.morning)) {
      const arr = merged.itemOrderByHalf.morning[group];
      if (!Array.isArray(arr)) continue;
      merged.itemOrderByHalf.morning[group] = arr.filter((n) => !CAIXIN_V108_NAMES.has(String(n || '').trim()));
    }
  }
  if (typeof normalizeItemOrderMap === 'function') {
    merged.itemOrderByHalf = normalizeItemOrderMap(merged.itemOrderByHalf);
  }
  merged.itemsMigratedV108 = true;
}

function migrateItemsV85(merged) {
  const rename = (raw) => {
    const n = String(raw || '').trim();
    if (!n) return n;
    if (ITEM_CANON_V85[n]) return ITEM_CANON_V85[n];
    if (typeof renameDisplayText === 'function') {
      const next = renameDisplayText(n);
      return ITEM_CANON_V85[next] || next;
    }
    return n;
  };
  const renameKeys = (map, merger) => {
    if (!map || typeof map !== 'object') return;
    for (const from of Object.keys(map)) {
      const to = rename(from);
      if (!to || to === from) continue;
      merger(map, from, to);
    }
  };
  if (merged.itemCounts && typeof merged.itemCounts === 'object') {
    renameKeys(merged.itemCounts, mergeCountKey);
  }
  if (merged.itemCountsByHalf && typeof merged.itemCountsByHalf === 'object') {
    for (const half of Object.keys(merged.itemCountsByHalf)) {
      const map = merged.itemCountsByHalf[half];
      if (!map || typeof map !== 'object') continue;
      renameKeys(map, mergeCountKey);
    }
  }
  if (merged.itemUseLogByHalf && typeof merged.itemUseLogByHalf === 'object') {
    for (const half of Object.keys(merged.itemUseLogByHalf)) {
      const log = merged.itemUseLogByHalf[half];
      if (!log || typeof log !== 'object') continue;
      renameKeys(log, mergeUseLogKey);
    }
  }
  for (const lot of merged.lots || []) {
    if (!lot || !lot.item) continue;
    lot.item = rename(lot.item);
  }
  for (const p of merged.planItems || []) {
    if (!p || !p.text) continue;
    p.text = rename(p.text);
  }
  for (const h of merged.boughtHistory || []) {
    for (const it of (h && h.items) || []) {
      if (!it || !it.text) continue;
      it.text = rename(it.text);
    }
  }
  const officialOf = (half) => {
    try { return catalogNameSet(half); } catch { return new Set(); }
  };
  const foldList = (arr, half) => {
    if (!Array.isArray(arr)) return arr;
    const official = officialOf(half);
    const out = [];
    const have = new Set();
    for (const raw of arr) {
      let n = rename(raw);
      if (!n || have.has(n)) continue;
      if (official.has(n)) continue;
      have.add(n);
      out.push(n);
    }
    return out;
  };
  if (Array.isArray(merged.customItems)) {
    const half = (merged.currentHalf) || 'afternoon';
    merged.customItems = foldList(merged.customItems, half);
  }
  if (merged.customItemsByHalf && typeof merged.customItemsByHalf === 'object') {
    for (const half of Object.keys(merged.customItemsByHalf)) {
      merged.customItemsByHalf[half] = foldList(merged.customItemsByHalf[half], half);
    }
  }
  if (merged.itemOrderByHalf && typeof merged.itemOrderByHalf === 'object') {
    for (const half of Object.keys(merged.itemOrderByHalf)) {
      const groups = merged.itemOrderByHalf[half];
      if (!groups || typeof groups !== 'object') continue;
      for (const group of Object.keys(groups)) {
        const arr = groups[group];
        if (!Array.isArray(arr)) continue;
        const out = [];
        const have = new Set();
        for (const raw of arr) {
          const n = rename(raw);
          if (!n || have.has(n)) continue;
          have.add(n);
          out.push(n);
        }
        groups[group] = out;
      }
    }
    if (typeof normalizeItemOrderMap === 'function') {
      merged.itemOrderByHalf = normalizeItemOrderMap(merged.itemOrderByHalf);
    }
  }
  merged.itemsMigratedV85 = true;
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


let sessionItemRanks = { fruit: {}, morning: {}, afternoon: {} };
let sessionItemRanksDay = '';

function ensureItemUseLog(st) {
  if (!st) return;
  if (!st.itemUseLogByHalf || typeof st.itemUseLogByHalf !== 'object') {
    st.itemUseLogByHalf = { fruit: {}, morning: {}, afternoon: {} };
  }
  for (const half of HALVES) {
    if (!st.itemUseLogByHalf[half] || typeof st.itemUseLogByHalf[half] !== 'object') {
      st.itemUseLogByHalf[half] = {};
    }
  }
  if (!st.itemUseLogMigrated) {
    for (const half of HALVES) {
      const counts = (st.itemCountsByHalf && st.itemCountsByHalf[half]) || {};
      const log = st.itemUseLogByHalf[half];
      for (const [name, n] of Object.entries(counts)) {
        const num = Number(n) || 0;
        if (!name || num < 1) continue;
        if (!Array.isArray(log[name]) || !log[name].length) {
          log[name] = [{ day: todayStr(), n: num }];
        }
      }
    }
    st.itemUseLogMigrated = true;
  }
}

function pruneItemUseLog(st) {
  if (!st || !st.itemUseLogByHalf) return;
  const cut = addDaysIso(todayStr(), -PURCHASE_WINDOW_DAYS);
  for (const half of HALVES) {
    const log = st.itemUseLogByHalf[half] || {};
    for (const name of Object.keys(log)) {
      const kept = (log[name] || []).filter((e) => e && e.day && e.day >= cut && (Number(e.n) || 0) > 0);
      if (kept.length) log[name] = kept;
      else delete log[name];
    }
  }
}


/* v109: these catalog lookups only depend on the item text, yet ran thousands of
   times per tap (every lot, every render). Remember the answers. */
const itemLookupMemo = { crop: new Map(), key: new Map(), disp: new Map() };
function memoGet(map, k, fn) {
  let v = map.get(k);
  if (v === undefined) {
    if (map.size > 5000) map.clear();
    v = fn();
    map.set(k, v);
  }
  return v;
}
function findCrop(name, half) {
  if (half || typeof name !== 'string') return findCropRaw(name, half);
  return memoGet(itemLookupMemo.crop, name, () => findCropRaw(name));
}
function canonicalItemKey(name) {
  if (typeof name !== 'string') return canonicalItemKeyRaw(name);
  return memoGet(itemLookupMemo.key, name, () => canonicalItemKeyRaw(name));
}
function itemDisplayName(name) {
  if (typeof name !== 'string') return itemDisplayNameRaw(name);
  return memoGet(itemLookupMemo.disp, name, () => itemDisplayNameRaw(name));
}

function halfOfItemName(name, fallback) {
  const crop = typeof findCrop === 'function' ? findCrop(name) : null;
  if (crop) return halfFromCatalogKey(crop.h);
  return fallback || '';
}

function canonicalItemKeyRaw(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const parsed = (typeof parsePlanItemText === 'function') ? parsePlanItemText(raw) : { name: raw };
  let key = String(parsed.name || raw).trim();
  if (typeof DISPLAY_RENAME_V46 !== 'undefined' && DISPLAY_RENAME_V46[key]) key = DISPLAY_RENAME_V46[key];
  const everyday = (typeof everydayItemLabel === 'function')
    ? (everydayItemLabel(key) || everydayItemLabel(raw))
    : '';
  if (everyday) return everyday;
  const crop = (typeof findCrop === 'function') ? (findCrop(key) || findCrop(raw)) : null;
  if (crop) {
    const variety = typeof findVariety === 'function'
      ? (findVariety(crop, key) || findVariety(crop, raw))
      : null;
    if (variety && typeof GRID_PROMOTIONS !== 'undefined') {
      const promo = GRID_PROMOTIONS.find((p) => (
        p.varN === variety.n || p.l === variety.l || p.l === key
        || (variety.a || []).includes(p.l)
      ));
      if (promo) return promo.l;
    }
    return crop.l;
  }
  return key;
}

function collectPurchaseCounts() {
  const map = { fruit: {}, morning: {}, afternoon: {} };
  const add = (half, key, day, n) => {
    const count = Number(n) || 0;
    if (!key || !day || count < 1) return;
    if (day < addDaysIso(todayStr(), -PURCHASE_WINDOW_DAYS)) return;
    const h = half || halfOfItemName(key) || 'morning';
    if (!isHalf(h)) return;
    if (!map[h][key]) map[h][key] = {};
    map[h][key][day] = (map[h][key][day] || 0) + count;
  };
  const daysFromLots = new Set();
  for (const lot of (state && state.lots) || []) {
    if (!lot || !lot.day) continue;
    daysFromLots.add(lot.day);
    if (!isWon(lot) || !lot.item) continue;
    const key = canonicalItemKey(lot.item);
    add(lot.half || halfOfItemName(lot.item), key, lot.day, 1);
  }
  for (const hist of (state && state.boughtHistory) || []) {
    if (!hist || !hist.day || daysFromLots.has(hist.day)) continue;
    for (const it of hist.items || []) {
      const raw = String(it.text || it.name || '').trim();
      const key = canonicalItemKey(raw);
      add(it.half || halfOfItemName(raw) || halfOfItemName(key), key, hist.day, it.count);
    }
  }
  return map;
}

function decayedPurchaseScore(dayCounts) {
  const today = todayStr();
  let s = 0;
  for (const [day, n] of Object.entries(dayCounts || {})) {
    const age = Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
    if (!Number.isFinite(age) || age < 0 || age >= PURCHASE_WINDOW_DAYS) continue;
    s += (Number(n) || 0) * (1 - age / PURCHASE_WINDOW_DAYS);
  }
  return s;
}

function freezeItemRanks() {
  ensureItemUseLog(state);
  pruneItemUseLog(state);
  sessionItemRanks = { fruit: {}, morning: {}, afternoon: {} };
  sessionItemRanksDay = todayStr();
  const counts = collectPurchaseCounts();
  for (const half of HALVES) {
    const byName = counts[half] || {};
    for (const name of Object.keys(byName)) {
      sessionItemRanks[half][name] = decayedPurchaseScore(byName[name]);
    }
  }
}

function itemSessionScore(name, half) {
  const h = half || (state && state.currentHalf) || 'morning';
  if (!sessionItemRanksDay || sessionItemRanksDay !== todayStr()) freezeItemRanks();
  const ranks = sessionItemRanks[h] || {};
  const key = canonicalItemKey(name) || name;
  return ranks[key] || ranks[name] || 0;
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
  const h = half || state.currentHalf;
  const counts = itemCountsOf(h);
  counts[name] = (counts[name] || 0) + 1;
  ensureItemUseLog(state);
  const log = state.itemUseLogByHalf[h];
  const today = todayStr();
  const arr = Array.isArray(log[name]) ? log[name] : [];
  const last = arr[arr.length - 1];
  if (last && last.day === today) last.n = (Number(last.n) || 0) + 1;
  else arr.push({ day: today, n: 1 });
  log[name] = arr;
}

function applyItemToLot(lot, name) {
  if (!lot) return;
  lot.item = name;
  if (!itemNeedsSize(name)) lot.size = '';
  else lot.size = normalizeSize(lot.size, name) || defaultSizeForItem(name);
  bumpItemUse(name, lot.half || state.currentHalf);
  applyPlanPurposeToLot(lot);
  saveState();
  toast(withPlanToast(`${lot.number}　${name}`));
  buzz(12);
}

function setLotSize(id, size) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || !itemNeedsSize(lot.item)) return;
  const next = sizeLabel(size, lot.item);
  const cur = normalizeSize(lot.size, lot.item);
  lot.size = cur === next ? '' : next;
  saveState();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
  render();
}

function cycleLotSize(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot || !itemNeedsSize(lot.item)) return;
  const sizes = sizesForItem(lot.item);
  const cur = normalizeSize(lot.size, lot.item);
  const i = sizes.indexOf(cur);
  lot.size = sizes[(i + 1) % sizes.length];
  saveState();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
  render();
}

function setDraftSize(size) {
  const item = (itemTargetId && (state.lots.find((l) => l.id === itemTargetId)?.item)) || draftItem || '';
  const next = sizeLabel(size, item);
  if (itemTargetId) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot && itemNeedsSize(lot.item || draftItem)) {
      const cur = normalizeSize(lot.size, lot.item || draftItem);
      lot.size = cur === next ? '' : next;
      saveState();
      render();
      return;
    }
  }
  const cur = normalizeSize(draftSize, item);
  draftSize = cur === next ? '' : next;
  render();
}

function assignItem(name) {
  name = String(name || '').trim();
  if (!name) return;
  if (!itemNeedsSize(name)) draftSize = '';
  else draftSize = normalizeSize(draftSize, name) || defaultSizeForItem(name);
  if (draftNum) {
    draftItem = name;
    itemLocked = true;
    saveLot();
    return;
  }
  if (itemTargetId && !itemTargetAuto) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot) {
      applyItemToLot(lot, name);
      lockItem(name, { silent: true });
      return;
    }
  }
  if (itemTargetId && itemTargetAuto) {
    const lot = state.lots.find((l) => l.id === itemTargetId);
    if (lot && !lot.item) {
      applyItemToLot(lot, name);
      lockItem(name, { silent: true });
      return;
    }
  }
  lockItem(name);
}

function lockItem(name, opts) {
  opts = opts || {};
  name = String(name || '').trim();
  if (!name) return;
  if (!itemNeedsSize(name)) draftSize = '';
  else draftSize = normalizeSize(draftSize, name) || defaultSizeForItem(name);
  draftItem = name;
  itemLocked = true;
  itemTargetId = null;
  applyPlanPurposeToDraft(name, draftSize);
  itemTargetAuto = false;
  variantPick = null;
  if (!opts.silent) toast('已鎖定 ' + itemDisplayName(name) + '，接著輸入號碼');
  render();
}

function unlockItem() {
  itemLocked = false;
  draftItem = '';
  draftSize = '';
  exitRangeMode({ keepDraft: true });
  toast('已解除鎖定');
  render();
}

function exitRangeMode(opts) {
  opts = opts || {};
  rangeMode = false;
  if (!opts.keepDraft && !rangeMode) {
    /* draftNum already separate */
  }
  if (!opts.keepStart) {
    rangeStart = '';
    rangeEnd = '';
  }
  rangeFocus = 'start';
}

function enterRangeMode() {
  if (!itemLocked || !draftItem) {
    toast('請先鎖定品項，再輸入連號');
    return;
  }
  rangeMode = true;
  rangeStart = draftNum || rangeStart || '';
  rangeEnd = rangeEnd || '';
  rangeFocus = rangeStart.length >= 4 ? 'end' : 'start';
  draftNum = '';
  showMachinePicker = false;
  dupFlash = false;
  render();
}

function rangeFieldValue() {
  return rangeFocus === 'end' ? rangeEnd : rangeStart;
}

function setRangeFieldValue(v) {
  if (rangeFocus === 'end') rangeEnd = v;
  else rangeStart = v;
}

function parseLotRange(start, end) {
  const a = parseInt(start, 10);
  const b = parseInt(end, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 1 || b < 1) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { lo, hi, count: hi - lo + 1 };
}

function previewLotRange(start, end, half) {
  const parsed = parseLotRange(start, end);
  if (!parsed) return null;
  half = half || state.currentHalf;
  const dups = [];
  const noMachine = [];
  const add = [];
  for (let n = parsed.lo; n <= parsed.hi; n++) {
    const dup = state.lots.find((l) => l.day === state.day && l.number === n);
    if (dup) {
      dups.push(n);
      continue;
    }
    const machineId = detectMachineId(n, half) || draftMachineId || '';
    if (!machineId) {
      noMachine.push(n);
      continue;
    }
    add.push({ number: n, machineId, half });
  }
  return Object.assign({ dups, noMachine, add }, parsed);
}

function rangeReady() {
  if (!rangeStart || !rangeEnd) return false;
  return !!parseLotRange(rangeStart, rangeEnd);
}

function maybeAutoConfirmRange() {
  if (!rangeStart || !rangeEnd) return false;
  const auto = rangeEnd.length >= 4 || (rangeStart.length >= 3 && rangeEnd.length >= rangeStart.length);
  if (!auto) return false;
  return openRangeConfirm();
}

function openRangeConfirm() {
  if (!itemLocked || !draftItem) {
    toast('請先鎖定品項，再輸入連號');
    return false;
  }
  const preview = previewLotRange(rangeStart, rangeEnd);
  if (!preview) {
    toast('請輸入起始和結束號碼');
    return false;
  }
  if (preview.count > RANGE_MAX) {
    modal = {
      type: 'confirm',
      title: '範圍太大',
      body: '這段有 ' + preview.count + ' 筆，一次最多 ' + RANGE_MAX + ' 筆，請縮小範圍。',
      ok: '知道了',
      cancel: '返回',
      onOk: () => { modal = null; render(); },
      onCancel: () => { modal = null; render(); }
    };
    render();
    return true;
  }
  if (!preview.add.length) {
    const why = preview.dups.length && !preview.noMachine.length
      ? '這段都已經抄過'
      : preview.noMachine.length
        ? '這段無法判斷台別，請確認現在的場次'
        : '沒有可加入的號碼';
    toast(why);
    buzz(30);
    render();
    return false;
  }
  const itemLabel = itemDisplayName(draftItem);
  const rangeLabel = preview.lo + '–' + preview.hi;
  let body = itemLabel + '　' + rangeLabel + '。加入 ' + preview.add.length + ' 筆';
  const skips = [];
  if (preview.dups.length) skips.push('略過 ' + preview.dups.length + ' 筆已抄過');
  if (preview.noMachine.length) skips.push(preview.noMachine.length + ' 筆無法判斷台別');
  if (skips.length) body += '（' + skips.join('，') + '）';
  const addedN = preview.add.length;
  modal = {
    type: 'confirm',
    title: '加入連號',
    body,
    ok: '加入 ' + addedN + ' 筆',
    cancel: '取消',
    onOk: () => commitLotRange(preview),
    onCancel: () => { modal = null; render(); }
  };
  render();
  return true;
}

function commitLotRange(preview) {
  modal = null;
  if (!preview || !preview.add || !preview.add.length || !draftItem) {
    render();
    return;
  }
  const half = state.currentHalf;
  const now = Date.now();
  const added = [];
  for (let i = 0; i < preview.add.length; i++) {
    const row = preview.add[i];
    const lot = {
      id: uid(),
      day: state.day,
      half: row.half || half,
      machineId: row.machineId,
      number: row.number,
      note: '',
      item: draftItem,
      size: itemNeedsSize(draftItem) ? (sizeLabel(draftSize, draftItem) || defaultSizeForItem(draftItem)) : '',
      status: 'pending',
      priority: PRIORITIES.includes(draftPriority) ? draftPriority : (state.lastPriority || 'watch'),
      qty: 1,
      createdAt: now + i,
      ...lotByField()
    };
    if (lot.item) bumpItemUse(lot.item);
    applyPlanPurposeToLot(lot);
    state.lots.push(lot);
    added.push(lot);
  }
  draftNum = '';
  draftNote = '';
  draftMachineId = '';
  draftShowNote = false;
  showMachinePicker = false;
  dupFlash = false;
  itemTargetId = added.length ? added[added.length - 1].id : null;
  itemTargetAuto = true;
  exitRangeMode();
  saveState();
  offerUndo(
    { kind: 'range-add', lots: added.map((l) => ({ ...l })) },
    '已加入 ' + added.length + ' 筆　' + itemDisplayName(draftItem)
  );
  buzz(26);
  render();
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
  if (oldName !== newName) renameItemOrderKey(h, oldName, newName);
  saveState();
  toast(`已改成「${newName}」`);
  return true;
}

function deleteCustomItem(name, half) {
  const h = half || (modal && modal.half) || state.currentHalf;
  state.customItemsByHalf[h] = customItemsOf(h).filter((n) => n !== name);
  removeItemOrderKey(h, name);
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

function autoAdvanceOn() {
  return !state || state.autoAdvance !== false;
}

function getAnchor(machineId, half) {
  const h = half || state.currentHalf;
  const a = state && state.progressAnchors && state.progressAnchors[h] && state.progressAnchors[h][machineId];
  if (!a || typeof a !== 'object') return null;
  const number = a.number == null || a.number === '' ? null : Number(a.number);
  const at = Number(a.at);
  return {
    number: Number.isFinite(number) ? number : null,
    at: Number.isFinite(at) ? at : null,
    paused: !!a.paused,
    ended: !!a.ended,
    seeded: !!a.seeded,
    cleared: !!a.cleared
  };
}

function writeAnchor(machineId, half, anchor) {
  const h = half || state.currentHalf;
  if (!state.progressAnchors) state.progressAnchors = defaultAnchors(state.machines);
  if (!state.progressAnchors[h]) state.progressAnchors[h] = {};
  if (!anchor) {
    state.progressAnchors[h][machineId] = { number: null, at: nowDate().getTime(), paused: true, ended: false, cleared: true };
    return;
  }
  state.progressAnchors[h][machineId] = {
    number: anchor.number,
    at: anchor.at,
    paused: !!anchor.paused,
    ended: !!anchor.ended,
    cleared: false,
    seeded: !!anchor.seeded
  };
}

function clampProgress(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, Math.round(x)));
}

function progressCap(machineId, half) {
  const h = half || state.currentHalf;
  let cap = null;
  const m = typeof machineById === 'function' ? machineById(machineId, h) : null;
  for (const r of (m && m.ranges) || []) {
    if (r && r.end != null && r.end !== '') {
      const n = Number(r.end);
      if (Number.isFinite(n)) cap = cap == null ? n : Math.max(cap, n);
    }
  }
  const lots = typeof columnLots === 'function' ? columnLots(machineId, h) : [];
  for (const l of lots || []) {
    const n = Number(l && l.number);
    if (Number.isFinite(n)) cap = cap == null ? n : Math.max(cap, n);
  }
  if (cap == null) cap = 9999;
  return cap;
}

function currentOf(machineId, half) {
  const h = half || state.currentHalf;
  const stored = state && state.currentNumbers && state.currentNumbers[h] && state.currentNumbers[h][machineId];
  const storedN = stored == null || stored === '' ? null : Number(stored);
  const a = getAnchor(machineId, h);
  if (autoAdvanceOn() && a && !a.paused && !a.seeded && a.number != null && a.at != null
      && !isStaleProgressAt(a.at, state && state.day)) {
    const elapsed = Math.max(0, nowDate().getTime() - a.at);
    const rate = lotsPerMin();
    const advanced = rate > 0 ? Math.floor((elapsed * rate) / 60000) : 0;
    const ser = seriesOf(a.number, h);
    const start = ser ? (seriesStart(machineId, h, ser) ?? a.number) : a.number;
    if (ser && start != null) {
      const walked = walkSeries(a.number, advanced, start, ser, h);
      return walked.n;
    }
    let n = a.number + advanced;
    if (n > PROGRESS_MAX) n = PROGRESS_MAX;
    if (n < PROGRESS_MIN) n = PROGRESS_MIN;
    const cap = progressCap(machineId, h);
    // 到尾 only stops automatic advance from at-or-below the list/range cap. A manual ＋ past the cap must not snap back.
    if (cap != null && a.number <= cap && n > cap) n = cap;
    return n;
  }
  if (a && a.number != null) return a.number;
  return Number.isFinite(storedN) ? storedN : null;
}

function isAutoRunning(machineId, half) {
  const h = half || state.currentHalf;
  if (!autoAdvanceOn()) return false;
  const a = getAnchor(machineId, h);
  if (!a || a.paused || a.ended || a.seeded || a.number == null || a.at == null) return false;
  if (isStaleProgressAt(a.at, state && state.day)) return false;
  const cur = currentOf(machineId, h);
  if (seriesAtEnd(machineId, h, cur)) return false;
  const cap = progressCap(machineId, h);
  const ser = seriesOf(a.number, h);
  if (!ser && cap != null && a.number <= cap && cur != null && cur >= cap) return false;
  return true;
}

function snapshotProgress(machineId, half) {
  const h = half || state.currentHalf;
  const a = getAnchor(machineId, h);
  return {
    kind: 'progress',
    half: h,
    machineId,
    current: currentOf(machineId, h),
    anchor: a ? { ...a } : null,
    seriesPath: state.seriesPath ? structuredClone(state.seriesPath) : null,
    seriesPlans: state.seriesPlans ? structuredClone(state.seriesPlans) : null,
    machineMerges: state.machineMerges ? structuredClone(state.machineMerges) : null
  };
}

let liveScrollFollow = {};
let pendingAdopt = null;

function setProgress(machineId, next, half, opts) {
  opts = opts || {};
  const h = half || state.currentHalf;
  if (!state.currentNumbers[h]) state.currentNumbers[h] = {};
  if (!state.progressAnchors) state.progressAnchors = defaultAnchors(state.machines);
  if (!state.progressAnchors[h]) state.progressAnchors[h] = {};
  const prevCur = currentOf(machineId, h);
  let pathInfo = null;
  if (next == null || next === '') {
    state.currentNumbers[h][machineId] = null;
    writeAnchor(machineId, h, null);
  } else {
    let n = Number(next);
    if (!Number.isFinite(n)) {
      state.currentNumbers[h][machineId] = null;
      writeAnchor(machineId, h, null);
    } else {
      n = clampProgress(n);
      pathInfo = ensureSeriesPath(machineId, n, h, { prevCur, start: opts.start });
      state.currentNumbers[h][machineId] = n;
      writeAnchor(machineId, h, {
        number: n,
        at: nowDate().getTime(),
        paused: !autoAdvanceOn(),
        ended: false
      });
      liveScrollFollow[machineId] = true;
      if (!opts.silentAdopt && pathInfo && pathInfo.ser) {
        const startN = pathInfo.start != null ? pathInfo.start : seriesStart(machineId, h, pathInfo.ser);
        const typedWrap = !!(opts.typed && startN != null && Number(n) < Number(startN) && inSeries(n, pathInfo.ser));
        if (pathInfo.started || pathInfo.changedSeries || pathInfo.first || typedWrap) {
          pendingAdopt = {
            machineId, half: h, ser: pathInfo.ser, start: pathInfo.start, first: !!pathInfo.first,
            includeRunning: !!typedWrap
          };
        }
      }
    }
  }
  saveState();
  checkAlerts();
  syncProgressTimer();
  return pathInfo;
}

/* A series that more than one 台 lists in its ranges (5xxx on 第一台 and 第二台,
   6xxx on 第一台 and 第三台) is run by each of them in turn. Entering it on one
   台 says nothing about the other 台's numbers, so never offer to take them over. */
function seriesSharedByRanges(ser, half) {
  if (!ser) return false;
  const lo = seriesEffLo(ser);
  let n = 0;
  for (const m of (state.machines[half] || [])) {
    const hit = (m.ranges || []).some((r) => {
      if (!r || r.start == null) return false;
      const a = Number(r.start);
      const b = r.end == null ? Infinity : Number(r.end);
      return a <= ser.hi && b >= lo;
    });
    if (hit) n += 1;
  }
  return n > 1;
}

function offerAdoptIfNeeded() {
  const job = pendingAdopt;
  pendingAdopt = null;
  if (!job || !job.ser) return;
  if (modal) return;
  if (seriesSharedByRanges(job.ser, job.half)) return;
  let lots = lotsInSeriesOnOtherMachines(job.machineId, job.half, job.ser, { includeRunning: !!job.includeRunning });
  if (job.includeRunning && job.start != null) {
    const startN = Number(job.start);
    lots = lots.filter((l) => Number(l.number) < startN);
  }
  if (!lots.length) {
    if (job.first && job.start != null && job.ser && job.start !== job.ser.lo) {
      toast('這段起點是 ' + job.start + '。若起點不對，請長按「現在」改正。');
    }
    return;
  }
  const dest = columnTitleOf(job.machineId, job.half);
  const label = seriesLabel(job.ser);
  const count = lots.length;
  modal = {
    type: 'confirm',
    title: '移到這台？',
    body: label + ' 起的未拍號碼移到' + dest + '？（' + count + ' 筆）。已標過的留在原台。',
    ok: '移過去',
    cancel: '先不要',
    onOk: () => {
      modal = null;
      const moved = moveLotsToMachine(lots, job.machineId, job.half);
      saveState();
      offerUndo({ kind: 'adopt-lots', moved, destId: job.machineId, half: job.half }, '已移入 ' + moved.length + ' 筆到' + dest);
      render();
    },
    onCancel: () => { modal = null; render(); }
  };
  render();
}


function openSetStart(machineId) {
  const half = state.currentHalf;
  const cur = currentOf(machineId, half);
  const ser = cur != null ? seriesOf(cur, half) : null;
  const start = ser ? seriesStart(machineId, half, ser) : null;
  const prefill = start != null ? String(start) : (cur != null ? String(cur) : '');
  const jumpN = jumpTargetOf(machineId, half);
  editStart = {
    machineId,
    half,
    value: prefill,
    fresh: !!prefill,
    jumpValue: jumpN != null ? String(jumpN) : '',
    jumpFresh: jumpN != null,
    focus: 'start'
  };
  modal = { type: 'set-start' };
  render();
}

function commitSetStart() {
  if (!editStart) return;
  const n = parseInt(editStart.value, 10);
  const mid = editStart.machineId;
  const half = editStart.half || state.currentHalf;
  const jumpRaw = editStart.jumpValue;
  if (jumpRaw != null && String(jumpRaw).length && !jumpTargetValid(jumpRaw, mid, half) && upcomingJumpSegment(mid, half)) {
    const seg = upcomingJumpSegment(mid, half);
    toast('跳到請輸入 ' + seg.lo + ' 到 ' + seg.hi + ' 的號碼');
    render();
    return;
  }
  editStart = null;
  modal = null;
  if (!Number.isFinite(n)) {
    render();
    return;
  }
  const snap = snapshotProgress(mid, half);
  const cur = currentOf(mid, half);
  setSeriesStart(mid, n, half);
  if (cur == null) setProgress(mid, n, half, { silentAdopt: true });
  if (jumpTargetValid(jumpRaw, mid, half)) setJumpTarget(mid, jumpRaw, half);
  saveState();
  offerUndo(snap, '起點改為 ' + n);
  render();
  const ser = seriesOf(n, half);
  if (ser) {
    pendingAdopt = { machineId: mid, half, ser, start: n, first: false };
    offerAdoptIfNeeded();
  }
}

function wrapLotsBeforeStart(machineId, half, ser, start) {
  const h = half || state.currentHalf;
  if (!ser || start == null) return [];
  const startN = Number(start);
  return columnLots(machineId, h).filter((l) => (
    l.status === 'pending'
    && !l.secondMarket
    && inSeries(l.number, ser)
    && Number(l.number) < startN
  ));
}

function xferCandidateFromLots(ser, lots, start) {
  const nums = lots.map((l) => Number(l.number)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const from = nums.length ? nums[0] : (ser ? ser.lo : 0);
  const to = nums.length ? nums[nums.length - 1] : (start != null ? Number(start) - 1 : from);
  return {
    key: ser && ser.key,
    ser,
    start: start != null ? Number(start) : null,
    from,
    to,
    lots,
    count: lots.length,
    label: from + '–' + to
  };
}

function xferCandidates(machineId, half) {
  const h = half || state.currentHalf;
  const out = [];
  const seen = new Set();
  const cur = currentOf(machineId, h);
  const curSer = cur != null ? seriesOf(cur, h) : null;
  const segs = pathEntry(machineId, h).segs || [];
  const starts = [];
  for (const seg of segs) {
    if (seg && seg.start != null) {
      const ser = seriesOf(seg.start, h) || (seg.key ? { key: seg.key, lo: seg.lo, hi: seg.hi } : null);
      if (ser) starts.push({ ser, start: Number(seg.start) });
    }
  }
  if (curSer) {
    const s = seriesStart(machineId, h, curSer);
    if (s != null && !starts.some((x) => x.ser.key === curSer.key)) starts.push({ ser: curSer, start: s });
  }
  const ordered = [];
  if (curSer) {
    const hit = starts.find((x) => x.ser.key === curSer.key);
    if (hit) ordered.push(hit);
  }
  for (const x of starts) {
    if (!ordered.some((y) => y.ser.key === x.ser.key)) ordered.push(x);
  }
  for (const { ser, start } of ordered) {
    const lots = wrapLotsBeforeStart(machineId, h, ser, start);
    if (!lots.length) continue;
    seen.add(ser.key);
    out.push(xferCandidateFromLots(ser, lots, start));
  }
  // Received wrap segments can be sent onward (including back to the original 台),
  // even when this 台's start is the series first number (so wrap-before-start is empty).
  const recs = pathEntry(machineId, h).received || [];
  for (const rec of recs) {
    if (!rec || seen.has(rec.key)) continue;
    const lots = [];
    for (const id of rec.ids || []) {
      const lot = (state.lots || []).find((l) => l.id === id);
      if (!lot || lot.machineId !== machineId) continue;
      if (lot.status !== 'pending' || lot.secondMarket) continue;
      lots.push(lot);
    }
    if (!lots.length) continue;
    const ser = (lots[0] && seriesOf(lots[0].number, h)) || rec.ser || null;
    if (!ser) continue;
    seen.add(ser.key);
    const cand = xferCandidateFromLots(ser, lots, rec.start != null ? rec.start : seriesStart(machineId, h, ser));
    if (rec.from != null) cand.from = rec.from;
    if (rec.to != null) cand.to = rec.to;
    cand.label = cand.from + '–' + cand.to;
    out.push(cand);
  }
  return out;
}

function xferEmptyMessage(machineId, half) {
  const h = half || state.currentHalf;
  const cands = xferCandidates(machineId, h);
  if (cands.length) return null;
  const cur = currentOf(machineId, h);
  const curSer = cur != null ? seriesOf(cur, h) : null;
  const start = curSer ? seriesStart(machineId, h, curSer) : null;
  const hasAnyStart = (pathEntry(machineId, h).segs || []).some((s) => s && s.start != null) || start != null;
  if (!hasAnyStart) return '請先設定這段起點（長按「現在」）。還沒有起點時，無法判斷哪一段是前面要轉走的號碼。';
  return '這台目前沒有起點前面的未拍號碼可轉。';
}

function openXfer(machineId) {
  const half = state.currentHalf;
  const candidates = xferCandidates(machineId, half);
  const empty = xferEmptyMessage(machineId, half);
  modal = {
    type: 'xfer',
    srcId: machineId,
    half,
    candidates,
    candKey: candidates.length === 1 ? candidates[0].key : null,
    empty
  };
  render();
}

function pickXferRange(key) {
  if (!modal || modal.type !== 'xfer') return;
  modal.candKey = key;
  render();
}

function confirmXfer(srcId, destId, key) {
  doXfer(srcId, destId, state.currentHalf, key);
}

function doXfer(srcId, destId, half, key) {
  const h = half || state.currentHalf;
  if (!srcId || !destId || srcId === destId) return;
  const cands = (modal && modal.type === 'xfer' && modal.srcId === srcId && Array.isArray(modal.candidates))
    ? modal.candidates
    : xferCandidates(srcId, h);
  const cand = key
    ? cands.find((c) => c.key === key)
    : (cands.length === 1 ? cands[0] : null);
  if (!cand || !cand.lots || !cand.lots.length) {
    modal = null;
    toast('沒有可轉的號碼');
    render();
    return;
  }
  modal = null;
  const snapPath = structuredClone(state.seriesPath);
  const lots = cand.lots.slice();
  const moved = moveLotsToMachine(lots, destId, h);
  const ser = cand.ser;
  if (ser && !machineIsRunningSeries(destId, h, ser) && seriesStart(destId, h, ser) == null) {
    setSeriesStart(destId, ser.lo, h);
  }
  const destEntry = pathEntry(destId, h);
  destEntry.received = (destEntry.received || []).filter((r) => r && r.key !== (ser && ser.key));
  destEntry.received.push({
    key: ser ? ser.key : cand.key,
    ids: moved.map((r) => r.id),
    from: cand.from,
    to: cand.to,
    start: ser ? ser.lo : null,
    ts: Date.now()
  });
  destEntry.ts = Date.now();
  saveState();
  offerUndo({
    kind: 'xfer-wrap',
    moved,
    srcId,
    destId,
    half: h,
    seriesPath: snapPath
  }, '已把 ' + cand.label + ' 轉到' + columnTitleOf(destId, h));
  render();
}

function ensureAutoAnchors() {
  /* Do not start auto-advance just because a 台 already shows a number
     (prefill, leftover, or shared progress). Only keep a 台 running if it
     already has an unpaused, not-stale, not-seeded anchor. */
  if (!autoAdvanceOn() || !state) return false;
  let changed = false;
  for (const half of HALVES) {
    for (const m of state.machines[half] || []) {
      const a0 = getAnchor(m.id, half);
      if (a0 && a0.seeded) continue;
      if (a0 && isStaleProgressAt(a0.at, state.day) && !a0.paused && !a0.cleared) {
        writeAnchor(m.id, half, { number: a0.number, at: a0.at, paused: true, ended: !!a0.ended });
        changed = true;
      }
    }
  }
  if (changed) {
    saveState();
    syncProgressTimer();
  }
  return changed;
}

function pauseProgress(machineId, half) {
  const h = half || state.currentHalf;
  if (!isAutoRunning(machineId, h)) return;
  const snap = snapshotProgress(machineId, h);
  const cur = currentOf(machineId, h);
  if (!state.currentNumbers[h]) state.currentNumbers[h] = {};
  state.currentNumbers[h][machineId] = cur;
  writeAnchor(machineId, h, { number: cur, at: nowDate().getTime(), paused: true });
  saveState();
  syncProgressTimer();
  offerUndo(snap, `${cur}　已暫停自動`);
  render();
}

function resumeProgress(machineId, half) {
  const h = half || state.currentHalf;
  const cur = currentOf(machineId, h);
  if (cur == null) return;
  if (seriesAtEnd(machineId, h, cur)) {
    endOfSegmentToast(machineId, h);
    return;
  }
  const cap = progressCap(machineId, h);
  const ser = seriesOf(cur, h);
  if (!ser && cap != null && cur >= cap) {
    endOfSegmentToast(machineId, h);
    return;
  }
  const snap = snapshotProgress(machineId, h);
  if (!state.currentNumbers[h]) state.currentNumbers[h] = {};
  state.currentNumbers[h][machineId] = cur;
  writeAnchor(machineId, h, { number: cur, at: nowDate().getTime(), paused: false, ended: false });
  saveState();
  syncProgressTimer();
  offerUndo(snap, `${cur}　繼續自動`);
  render();
}

function reanchorRunningAtNewRate() {
  if (!state || !autoAdvanceOn()) return;
  let changed = false;
  for (const half of HALVES) {
    for (const m of state.machines[half] || []) {
      if (!isAutoRunning(m.id, half)) continue;
      const cur = currentOf(m.id, half);
      if (cur == null) continue;
      if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
      state.currentNumbers[half][m.id] = cur;
      writeAnchor(m.id, half, { number: cur, at: nowDate().getTime(), paused: false, ended: false });
      changed = true;
    }
  }
  if (changed) saveState();
}

let progressTimer = null;
let lastProgressSig = '';

function anyAutoRunning() {
  if (!state || !autoAdvanceOn()) return false;
  for (const half of HALVES) {
    for (const m of state.machines[half] || []) {
      if (isAutoRunning(m.id, half)) return true;
    }
  }
  return false;
}

function progressSignature() {
  if (!state) return '';
  const half = state.currentHalf;
  return (state.machines[half] || []).map((m) => m.id + ':' + currentOf(m.id, half)).join('|');
}

/* v110: 跑完歸零等待.
   Auto-advance used to walk every 台 on its own to the tail of its segment (or to the
   biggest 抄號 number) and then sit there "ended" for good, on both phones. Now a
   台 that reaches its tail, or that has been auto-running for hours with nobody
   touching it (the auction is over), goes back to an empty 等待開始 state: no number,
   no start, nothing running. It runs again only when Frank starts it (＋, a typed
   現在, or 跳到), and 跳到 works straight from the waiting state. */
const AUTO_IDLE_MAX_MS = 4 * 60 * 60 * 1000;

/* v111: a 台 in 等待開始 also starts when Frank marks 標到/沒標到 (or taps the
   card) or opens 舉牌. Start at that lot's number, and keep the segment 起 if
   the 台's ranges already have one (第二台 2500, 第三台 2000). Only a local
   tap does this; a 標到 that arrives from the other phone does not, for the
   same reason a remote ＋ only moves 現在 when the progress itself is synced. */
function isColumnWaiting(machineId, half) {
  return currentOf(machineId, half) == null;
}

function inferredSeriesStart(machineId, half, n) {
  const ser = seriesOf(n, half);
  if (!ser) return null;
  const existing = typeof seriesStart === 'function' ? seriesStart(machineId, half, ser) : null;
  if (existing != null) return existing;
  const m = typeof machineById === 'function' ? machineById(machineId, half) : null;
  for (const r of (m && m.ranges) || []) {
    if (!r || r.start == null || r.start === '') continue;
    const rs = seriesOf(r.start, half);
    if (rs && rs.key === ser.key) return Number(r.start);
  }
  return null;
}

function startColumnFromLot(lot) {
  if (!state || !lot || lot.machineId == null || lot.number == null || lot.number === '') return false;
  const half = lot.half || state.currentHalf;
  const mid = lot.machineId;
  if (!isColumnWaiting(mid, half)) return false;
  const n = clampProgress(lot.number);
  if (n == null) return false;
  const start = inferredSeriesStart(mid, half, n);
  setProgress(mid, n, half, { silentAdopt: true, start: start != null ? start : undefined });
  return true;
}

function lotForPaddleStart() {
  if (!state) return null;
  const half = state.currentHalf;
  const nexts = [];
  for (const m of state.machines[half] || []) {
    if (!isColumnWaiting(m.id, half)) continue;
    const lots = (typeof columnLots === 'function' ? columnLots(m.id, half) : []).filter(
      (l) => l && l.status === 'pending' && !l.secondMarket && l.number != null
    );
    if (lots[0]) nexts.push(lots[0]);
  }
  const musts = nexts.filter((l) => (typeof lotPriority === 'function' ? lotPriority(l) : l.priority) === 'must');
  if (musts.length === 1) return musts[0];
  if (musts.length === 0 && nexts.length === 1) return nexts[0];
  return null;
}

function maybeStartColumnFromPaddle() {
  const lot = lotForPaddleStart();
  return lot ? startColumnFromLot(lot) : false;
}

function resetMachineToWaiting(half, machineId) {
  if (!state.currentNumbers) state.currentNumbers = {};
  if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
  state.currentNumbers[half][machineId] = null;
  writeAnchor(machineId, half, null);
  if (!state.seriesPath) state.seriesPath = {};
  if (!state.seriesPath[half]) state.seriesPath[half] = {};
  state.seriesPath[half][machineId] = { segs: [], ts: nowDate().getTime() };
}

function progressFinishReason(machineId, half) {
  const a = getAnchor(machineId, half);
  if (!a || a.cleared || a.number == null) return '';
  if (a.ended) return 'end';
  if (!autoAdvanceOn() || a.paused || a.seeded || a.at == null) return '';
  if (isStaleProgressAt(a.at, state && state.day)) return '';
  const elapsed = nowDate().getTime() - a.at;
  if (elapsed > AUTO_IDLE_MAX_MS) return 'idle';
  // Nothing can have walked to a tail before at least one step has passed.
  const rate = lotsPerMin();
  if (!(rate > 0) || Math.floor((Math.max(0, elapsed) * rate) / 60000) < 1) return '';
  const cur = currentOf(machineId, half);
  if (cur == null) return '';
  // Only a run that walked there by itself is "finished". Someone who tapped ＋ onto the
  // last number is still standing on it, so leave that for the next ＋ / 跳到 (or the idle check).
  if (cur !== a.number && seriesAtEnd(machineId, half, cur)) return 'end';
  const cap = progressCap(machineId, half);
  const ser = seriesOf(a.number, half);
  if (!ser && cap != null && a.number < cap && cur >= cap) return 'end';
  return '';
}

/* Returns the 台 that were sent back to waiting. */
function settleProgress(opts) {
  opts = opts || {};
  if (!state || !state.machines || (typeof isSetupNeeded === 'function' && isSetupNeeded())) return [];
  const done = [];
  for (const half of HALVES) {
    for (const m of state.machines[half] || []) {
      const why = progressFinishReason(m.id, half);
      if (!why) continue;
      const number = currentOf(m.id, half);
      resetMachineToWaiting(half, m.id);
      done.push({ half, id: m.id, number, why });
    }
  }
  if (done.length) {
    saveState();
    syncProgressTimer();
    if (!opts.silent) {
      const names = done.filter((d) => d.half === state.currentHalf).map((d) => columnTitleOf(d.id, d.half));
      if (names.length) toast(names.join('、') + ' 跑完了，已歸零，等待開始', 4000);
    }
  }
  return done;
}

function tickAutoProgress() {
  if (!state) return;
  settleProgress();
  const sig = progressSignature();
  if (sig !== lastProgressSig) {
    lastProgressSig = sig;
    checkAlerts();
    if (typeof render === 'function') render();
  }
}

/* v114: nothing to show while the app is in the background, so the per-second
   clock stops; on return it catches up at once (the numbers come from the time). */
let progressVisHooked = false;
function syncProgressTimer() {
  if (!progressVisHooked) {
    progressVisHooked = true;
    document.addEventListener('visibilitychange', () => {
      syncProgressTimer();
      if (!document.hidden && anyAutoRunning()) tickAutoProgress();
    });
  }
  const need = anyAutoRunning() && !document.hidden;
  if (need && !progressTimer) {
    progressTimer = setInterval(tickAutoProgress, 1000);
  } else if (!need && progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
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
  if (!action && toastAction && toastMsg) return;
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
      node.classList.remove('has-action', 'dock-live');
      node.innerHTML = '';
      node.style.top = '';
      node.style.bottom = '';
      node.style.height = '';
    }
    clearToastDock();
  }, ms || (action ? 6000 : 1600));
}

function dismissActionToast() {
  if (!toastAction || !toastMsg) return;
  toastMsg = '';
  toastAction = null;
  clearTimeout(toastTimer);
  const node = document.getElementById('toast');
  if (node) {
    node.classList.add('hidden');
    node.classList.remove('has-action');
    node.innerHTML = '';
    node.style.top = '';
    node.style.bottom = '';
  }
}

function clearToastDock(keep) {
  /* keep: the toast is about to be docked on the live bar again, so leave the
     classes alone. Removing and re-adding them made the browser re-lay-out the
     whole live screen (hundreds of cells) on every tap. */
  if (keep) return;
  document.querySelectorAll('.live-screen.toast-docked').forEach((n) => n.classList.remove('toast-docked'));
  const el = document.getElementById('toast');
  if (el) {
    el.classList.remove('dock-live');
    el.style.height = '';
  }
}

function placeActionToast() {
  const el = document.getElementById('toast');
  const keepLiveDock = !!(
    el && toastMsg && !el.classList.contains('hidden') &&
    el.classList.contains('dock-live') &&
    document.querySelector('.live-screen.toast-docked') &&
    !document.querySelector('.overlay .keypad') &&
    !document.getElementById('plan-screen') && !document.getElementById('sum-screen') &&
    !document.getElementById('paddle') &&
    document.querySelector('#main.live-mode .live-screen .live-bar')
  );
  clearToastDock(keepLiveDock);
  if (!el || !toastMsg || el.classList.contains('hidden')) {
    if (el) {
      el.style.top = '';
      el.style.bottom = '';
    }
    return;
  }
  const gap = 8;
  const vv = window.visualViewport;
  const vh = vv ? vv.height : window.innerHeight;
  const overlayKeypad = document.querySelector('#app > .overlay .keypad, .overlay .keypad');
  const sheet = overlayKeypad && overlayKeypad.closest('.sheet');
  const planOpen = !!(document.getElementById('plan-screen') || document.getElementById('sum-screen'));
  const paddleOpenNow = !!document.getElementById('paddle');
  const liveBar = document.querySelector('#main.live-mode .live-screen .live-bar');
  const liveScreen = liveBar && liveBar.closest('.live-screen');
  const noteHead = document.querySelector('.note-screen .note-head') || document.querySelector('.note-screen .prio-toggle');
  const header = document.querySelector('#app > .header');
  const paddleBar = document.getElementById('paddle-bar');

  if (sheet && overlayKeypad) {
    if (!toastAction) {
      el.style.top = '';
      el.style.bottom = '';
      return;
    }
    const toastH = Math.max(el.getBoundingClientRect().height || 0, 64);
    const keyTop = overlayKeypad.getBoundingClientRect().top;
    const display = sheet.querySelector('.lot-display');
    const ceiling = display ? Math.min(display.getBoundingClientRect().top, keyTop) : keyTop;
    let top = ceiling - toastH - gap;
    if (top < gap) top = gap;
    if (top + toastH + gap > keyTop) top = Math.max(gap, keyTop - toastH - gap);
    const nav = document.querySelector('#app > .nav');
    const navTop = nav ? nav.getBoundingClientRect().top : vh;
    if (top + toastH + gap > navTop) top = Math.max(gap, navTop - toastH - gap);
    el.style.top = Math.round(top) + 'px';
    el.style.bottom = 'auto';
    return;
  }

  if (planOpen || paddleOpenNow) {
    el.style.top = '';
    el.style.bottom = 'auto';
    return;
  }

  if (liveBar && liveScreen) {
    /* v114: the stats row (美／標到／未搬…) stays readable; the message sits over the
       column names instead (they are only labels), never over the lot cards. */
    liveScreen.classList.add('toast-docked');
    el.classList.add('dock-live');
    const dock = () => {
      if (!el.classList.contains('dock-live') || !toastMsg) return;
      const head = liveScreen.querySelector('.live-col-head');
      const bar = liveBar.getBoundingClientRect();
      const top = head ? head.getBoundingClientRect().top - 2 : bar.bottom + 2;
      el.style.top = Math.round(top) + 'px';
      el.style.bottom = 'auto';
    };
    dock();
    requestAnimationFrame(dock);
    return;
  }

  if (!toastAction) {
    el.style.top = '';
    el.style.bottom = '';
    return;
  }

  const toastH = Math.max(el.getBoundingClientRect().height || 0, 64);
  let top;
  if (noteHead) {
    const keypad = document.querySelector('.note-screen .keypad');
    top = noteHead.getBoundingClientRect().bottom + gap;
    if (keypad) {
      const keyTop = keypad.getBoundingClientRect().top;
      if (top + toastH + gap > keyTop) {
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        top = headerBottom + gap;
        if (top + toastH + gap > keyTop) top = Math.max(gap, keyTop - toastH - gap);
      }
    }
  } else if (paddleBar) {
    top = paddleBar.getBoundingClientRect().bottom + gap;
  } else if (header) {
    top = header.getBoundingClientRect().bottom + gap;
  } else {
    top = gap;
  }
  const nav = document.querySelector('#app > .nav');
  const navTop = nav ? nav.getBoundingClientRect().top : vh;
  if (top + toastH + gap > navTop) top = Math.max(gap, navTop - toastH - gap);
  el.style.top = Math.round(top) + 'px';
  el.style.bottom = 'auto';
}

function paintToast(el) {
  if (!el) return;
  el.classList.toggle('hidden', !toastMsg);
  el.classList.toggle('has-action', !!(toastMsg && toastAction));
  if (!toastMsg) {
    el.innerHTML = '';
    el.style.top = '';
    el.style.bottom = '';
    el.style.height = '';
    el.classList.remove('dock-live');
    clearToastDock();
    return;
  }
  const text = escapeHtml(String(toastMsg || '').replace(/\s+/g, ' ').trim());
  if (toastAction) {
    el.innerHTML = `<span>${text}</span><button type="button" data-act="undo">${escapeHtml(toastAction.label || '復原')}</button>`;
  } else {
    el.innerHTML = `<span>${text}</span>`;
  }
  requestAnimationFrame(() => {
    fitToastText();
    placeActionToast();
  });
}

function fitToastText() {
  const label = document.querySelector('#toast:not(.hidden) span');
  if (!label) return;
  const bar = label.closest('#toast');
  if (bar && bar.classList.contains('has-action')) {
    label.style.fontSize = '';
    return;
  }
  label.style.fontSize = '';
  let size = parseFloat(getComputedStyle(label).fontSize) || 13;
  const min = 11;
  while (size > min && label.scrollWidth > label.clientWidth + 0.5) {
    size -= 0.5;
    label.style.fontSize = size + 'px';
  }
}

function isSetupNeeded() {
  return !state.setupDone;
}

/* ---------- 抄號 ---------- */
function typeDigit(d) {
  d = String(d);
  dismissActionToast();
  if (rangeMode) {
    typeRangeDigit(d);
    return;
  }
  if (draftNum.length >= 4) return;
  const startingFresh = draftNum.length === 0;
  draftNum += d;
  showMachinePicker = false;
  dupFlash = false;
  if (startingFresh && !itemLocked) {
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

function typeRangeDigit(d) {
  let cur = rangeFieldValue();
  if (cur.length >= 4) return;
  setRangeFieldValue(cur + String(d));
  showMachinePicker = false;
  dupFlash = false;
  if (rangeFocus !== 'end' && rangeStart.length >= 4) rangeFocus = 'end';
  else if (rangeFocus === 'end' && maybeAutoConfirmRange()) return;
  render();
}

function backspace() {
  if (rangeMode) {
    const cur = rangeFieldValue();
    if (cur) setRangeFieldValue(cur.slice(0, -1));
    else if (rangeFocus === 'end') rangeFocus = 'start';
    render();
    return;
  }
  draftNum = draftNum.slice(0, -1);
  showMachinePicker = false;
  dupFlash = false;
  draftMachineId = '';
  refreshNoteHead();
}

function clearDraft() {
  if (rangeMode) {
    if (rangeFocus === 'end' && rangeEnd) rangeEnd = '';
    else if (rangeStart) rangeStart = '';
    else exitRangeMode();
    render();
    return;
  }
  draftNum = '';
  draftNote = '';
  draftMachineId = '';
  showMachinePicker = false;
  dupFlash = false;
  if (!itemLocked) {
    draftItem = '';
    draftSize = '';
  }
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

/* v112: who copied this lot (the room name of this phone), shown on the lot sheet. */
function lotByField() {
  if (!state || !state.syncRoom || typeof currentSyncName !== 'function') return {};
  const name = currentSyncName();
  return name ? { by: name } : {};
}

function lotByHtml(lot) {
  if (!lot || !lot.by || !state || !state.syncRoom) return '';
  const mine = typeof currentSyncName === 'function' && lot.by === currentSyncName();
  return `<span class="lot-by">${mine ? '我抄的' : escapeHtml(lot.by) + ' 抄的'}</span>`;
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
    size: itemNeedsSize(draftItem) ? (sizeLabel(draftSize, draftItem) || defaultSizeForItem(draftItem)) : '',
    status: 'pending',
    priority: PRIORITIES.includes(draftPriority) ? draftPriority : (state.lastPriority || 'watch'),
    qty: 1,
    createdAt: Date.now(),
    ...lotByField()
  };
  if (lot.item) bumpItemUse(lot.item);
  applyPlanPurposeToLot(lot);
  state.lots.push(lot);
  const keepItem = itemLocked && draftItem;
  const lockedName = draftItem;
  const lockedSize = draftSize;
  draftNum = '';
  draftNote = '';
  draftMachineId = '';
  draftShowNote = false;
  showMachinePicker = false;
  dupFlash = false;
  if (keepItem) {
    draftItem = lockedName;
    draftSize = lockedSize;
    itemLocked = true;
  } else {
    draftItem = '';
    draftSize = '';
  }
  itemTargetId = lot.id;
  itemTargetAuto = true;
  saveState();
  const savedLabel = lot.item
    ? `已存 ${lot.number}　${lot.item}`
    : `已存 ${num}　${machineNameOf(lot)}`;
  offerUndo({ kind: 'range-add', lots: [lot] }, savedLabel);
  buzz(26);
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
    if (status === 'won' || status === 'moved') lot.secondMarket = false;
  }
  rememberBoughtLots(state.lots);
  if (!startColumnFromLot(lot)) saveState();
  checkAlerts();
  const noteMsg = latestPlanToast();
  if (noteMsg) toast(noteMsg);
  render();
}

function jumpToLot(lot, { force } = {}) {
  if (!lot) return;
  const half = lot.half || state.currentHalf;
  const cur = currentOf(lot.machineId, half);
  if (!force && cur != null && isPassed(lot, cur)) return;
  setProgress(lot.machineId, lot.number, half);
}

function goToHere(id) {
  const lot = state.lots.find((l) => l.id === id);
  if (!lot) return;
  const snap = snapshotProgress(lot.machineId, lot.half);
  jumpToLot(lot, { force: true });
  offerUndo(snap, `${lot.number}　已設為現在進度`);
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
  let cur = currentOf(machineId, half);
  const snap = snapshotProgress(machineId, half);
  if (cur == null) {
    const explicit = displayStartOf(machineId, half);
    const m = machineById(machineId, half);
    const start = explicit ?? (m?.ranges || []).find((r) => r.start != null)?.start;
    cur = start ?? 0;
    const next = clampProgress(cur);
    setProgress(machineId, next, half);
    offerUndo(snap, `${next}　已設為現在進度`);
    render();
    offerAdoptIfNeeded();
    return;
  }
  const ser = seriesOf(cur, half);
  const start = ser ? (seriesStart(machineId, half, ser) ?? cur) : null;
  if (ser && start != null && delta > 0 && seriesAtEnd(machineId, half, cur)) {
    endOfSegmentToast(machineId, half);
    return;
  }
  let next;
  if (ser && start != null) {
    const walked = walkSeries(cur, delta, start, ser, half);
    if (walked.capped && delta > 0) {
      endOfSegmentToast(machineId, half);
      return;
    }
    next = walked.n;
  } else {
    next = clampProgress(cur + delta);
  }
  setProgress(machineId, next, half);
  offerUndo(snap, `${next}　已設為現在進度`);
  render();
  offerAdoptIfNeeded();
}

function setCurrent(machineId, value) {
  const half = state.currentHalf;
  const n = parseInt(value, 10);
  const next = Number.isFinite(n) ? clampProgress(n) : null;
  const prev = currentOf(machineId, half);
  editCurrent = null;
  modal = null;
  if (next == null && prev == null) {
    render();
    return;
  }
  const snap = snapshotProgress(machineId, half);
  setProgress(machineId, next, half, { typed: true });
  offerUndo(snap, next == null ? '已清除進度' : `${next}　已設為現在進度`);
  render();
  offerAdoptIfNeeded();
}

function checkAlerts() {
  const gap = state.alertGap || 3;
  const half = state.currentHalf;
  for (const m of state.machines[half]) {
    const cur = currentOf(m.id);
    if (cur == null) continue;
    for (const lot of lotsForMachine(m.id, half)) {
      if (lot.status !== 'pending' || lot.secondMarket) continue;
      const ser = seriesOf(cur, half);
      const lotSer = seriesOf(lot.number, half);
      if (!ser || !lotSer || ser.key !== lotSer.key) continue;
      const start = seriesStart(m.id, half, ser);
      const d = segmentDist(cur, lot.number, start, ser);
      if (d == null) continue;
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
  let reusedPlanHist = false;
  if (planOpen) {
    reusedPlanHist = !!planHistoryPushed;
    closePlan(false, reusedPlanHist ? { skipHistory: true } : undefined);
  }
  paddleOpen = true;
  maybeStartColumnFromPaddle();
  resetPaddleTaps();
  try {
    if (reusedPlanHist) history.replaceState({ auctionPaddle: true }, '');
    else history.pushState({ auctionPaddle: true }, '');
    paddleHistoryPushed = true;
  } catch {
    paddleHistoryPushed = false;
  }
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

async function exitPaddle(fromPop) {
  if (!paddleOpen && !document.fullscreenElement && !document.webkitFullscreenElement) {
    await unlockOrientation();
    return;
  }
  paddleOpen = false;
  resetPaddleTaps();
  await unlockOrientation();
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  } catch {
    /* ignore */
  }
  if (!fromPop && paddleHistoryPushed) {
    paddleHistoryPushed = false;
    try { history.back(); } catch { /* ignore */ }
  } else {
    paddleHistoryPushed = false;
  }
  syncWakeLock();
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


function syncWakeLock() {
  if (document.visibilityState !== 'visible' || (state && state.keepAwake === false)) {
    if (!paddleOpen) releaseWakeLock();
    return;
  }
  requestWakeLock();
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

function paddleInkMetrics(text, fontPx) {
  const canvas = paddleInkMetrics._c || (paddleInkMetrics._c = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = '700 ' + fontPx + 'px "Paddle Inter", Inter, sans-serif';
  let inkH = 0;
  const widths = [];
  for (const ch of String(text || '0000')) {
    const m = ctx.measureText(ch);
    const up = m.actualBoundingBoxAscent;
    const down = m.actualBoundingBoxDescent;
    if (Number.isFinite(up) && Number.isFinite(down)) inkH = Math.max(inkH, up + down);
    const left = m.actualBoundingBoxLeft;
    const right = m.actualBoundingBoxRight;
    if (Number.isFinite(left) && Number.isFinite(right)) widths.push(Math.max(m.width, left + right));
    else widths.push(m.width);
  }
  if (!(inkH > 0)) inkH = fontPx * 0.78;
  return { inkH, widths };
}

function fitPaddleDigits() {
  const el = document.getElementById('paddle-code');
  const box = document.getElementById('paddle-box');
  if (!el || !box) return;
  if (document.fonts && !fitPaddleDigits._armed) {
    fitPaddleDigits._armed = true;
    Promise.resolve(document.fonts.load('700 200px "Paddle Inter"'))
      .then(() => document.fonts.ready)
      .then(() => { if (paddleOpen) fitPaddleDigits(); })
      .catch(() => {});
  }
  applyCssLandscapeIfNeeded();
  const bw = box.clientWidth;
  const bh = box.clientHeight;
  if (bw < 20 || bh < 20) return;
  const text = String(el.innerText || '0000').replace(/\s+/g, '');
  const n = Math.max(1, text.length);
  const TARGET = 0.75;
  const strokeRatio = 0.018;
  const probe = 200;
  const met = paddleInkMetrics(text, probe);
  const inkWem = met.widths.reduce((s, w) => s + w, 0) / probe;
  const inkHem = Math.max(met.inkH / probe, 0.01);
  // Glyph box height tracks font-size; aim for 75% of the short screen side.
  let size = bh * TARGET;
  const spacing = (tight) => {
    const stroke = Math.max(3, Math.min(12, size * strokeRatio));
    const gap = tight
      ? Math.max(8, Math.min(12, bw * 0.015))
      : Math.max(14, Math.min(22, bw * 0.026));
    const padX = tight
      ? Math.max(4, bw * 0.005)
      : Math.max(8, bw * 0.012);
    return { gap, padX, stroke };
  };
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.whiteSpace = 'nowrap';
  el.style.lineHeight = '1';
  el.style.letterSpacing = '0';
  el.style.fontWeight = '700';
  el.style.fontStretch = 'normal';
  el.style.fontFamily = '"Paddle Inter", Inter, sans-serif';
  el.style.width = 'max-content';
  el.style.maxWidth = 'none';
  el.style.transform = 'none';
  el.style.transformOrigin = 'center center';
  const applySize = (px, gap, stroke) => {
    el.style.gap = gap + 'px';
    el.style.fontSize = px + 'px';
    el.style.webkitTextStroke = stroke + 'px currentColor';
    el.style.paintOrder = 'stroke fill';
    for (const d of el.querySelectorAll('span')) {
      d.style.fontSize = px + 'px';
      d.style.lineHeight = '1';
      d.style.fontWeight = '700';
      d.style.fontStretch = 'normal';
      d.style.transform = 'none';
      d.style.webkitTextStroke = stroke + 'px currentColor';
      d.style.paintOrder = 'stroke fill';
    }
  };
  const fits = (tight) => {
    const sp = spacing(tight);
    const widthAt = (inkWem + 2 * strokeRatio * n) * size + sp.gap * (n - 1) + 2 * sp.stroke;
    return widthAt <= bw - 2 * sp.padX + 0.5;
  };
  let tight = !fits(false);
  if (tight && !fits(true)) {
    const sp = spacing(true);
    const widthAt = (inkWem + 2 * strokeRatio * n) * size + sp.gap * (n - 1) + 2 * sp.stroke;
    const availW = Math.max(20, bw - 2 * sp.padX);
    size *= availW / Math.max(widthAt, 1);
    tight = true;
  }
  let sp = spacing(tight);
  applySize(size, sp.gap, sp.stroke);
  void el.offsetWidth;
  const measuredH = Math.max(
    1,
    ...Array.from(el.querySelectorAll('span'), (s) => s.offsetHeight),
    el.offsetHeight
  );
  const wantH = bh * TARGET;
  if (Math.abs(measuredH - wantH) / wantH > 0.012) {
    size *= wantH / measuredH;
    sp = spacing(tight);
    applySize(size, sp.gap, sp.stroke);
    void el.offsetWidth;
  }
  const usedW = Math.max(el.scrollWidth, 1) + 2 * sp.stroke;
  const availW = Math.max(20, bw - 2 * sp.padX);
  if (usedW > availW + 0.5) {
    size *= availW / usedW;
    sp = spacing(true);
    applySize(size, sp.gap, sp.stroke);
  }
}

function themeLabel(theme) {
  if (theme === 'white') return '白字黑底';
  if (theme === 'black-yellow') return '黑字黃底';
  return '黃字黑底';
}

/* ---------- 新的一天 ---------- */
/* A day's opening number we can fill in automatically, only when the 台's
   first-segment start is fixed (not 第一台 瓜果, whose start varies by day). */
function fixedStartOf(machine, half) {
  if (!machine) return null;
  const h = half || '';
  const ranges = (machine.ranges || []).filter((r) => r && r.start != null && Number.isFinite(Number(r.start)));
  if (!ranges.length) return null;
  if (h === 'afternoon') {
    /* 第一台 starts at 50xx, different every day — leave blank for Frank. */
    if (machine.id === 'a1') return null;
    if (machine.id === 'a2' || machine.id === 'a3') return Number(ranges[0].start);
    return null;
  }
  /* 上半場 台別 each have one fixed range (1001 / 3001 / 3500). */
  if (h === 'morning' && ranges.length === 1) return Number(ranges[0].start);
  return null;
}

function machineHasProgress(machineId, half) {
  const h = half || (state && state.currentHalf);
  if (currentOf(machineId, h) != null) return true;
  if (typeof displayStartOf === 'function' && displayStartOf(machineId, h) != null) return true;
  const raw = state.progressAnchors && state.progressAnchors[h] && state.progressAnchors[h][machineId];
  if (raw && typeof raw === 'object' && (raw.cleared || raw.number != null || raw.seeded)) return true;
  const segs = (typeof pathEntry === 'function' && pathEntry(machineId, h).segs) || [];
  if (segs.some((seg) => seg && seg.start != null)) return true;
  return false;
}

/* Fill 現在/起 with the fixed opening number when this 台 is still blank today.
   Seeded values are local only: they do not upload to shared progress, they
   stay paused so auto-advance does not run, and a number from another phone wins. */
function applyFixedStartPrefills() {
  if (!state || !state.machines) return false;
  let changed = false;
  for (const half of HALVES) {
    for (const m of state.machines[half] || []) {
      const start = fixedStartOf(m, half);
      if (start == null) continue;
      if (machineHasProgress(m.id, half)) continue;
      setSeriesStart(m.id, start, half);
      if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
      state.currentNumbers[half][m.id] = start;
      writeAnchor(m.id, half, {
        number: start,
        at: nowDate().getTime(),
        paused: true,
        ended: false,
        seeded: true
      });
      changed = true;
    }
  }
  return changed;
}

function startNewDay(confirmed, opts) {
  opts = opts || {};
  const auto = !!opts.auto;
  if (!confirmed && !auto) {
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
  const auctionDay = todayStr();
  if (auto && state.day === auctionDay) return;
  if (auto && isMidAction()) {
    pendingDayRollover = true;
    return;
  }
  const snap = {
    kind: 'new-day',
    lots: (state.lots || []).slice(),
    day: state.day,
    currentNumbers: structuredClone(state.currentNumbers),
    progressAnchors: structuredClone(state.progressAnchors),
    seriesPath: structuredClone(state.seriesPath),
    seriesPlans: structuredClone(state.seriesPlans),
    machineMerges: structuredClone(state.machineMerges),
    jumpTargets: structuredClone(state.jumpTargets || {}),
    autoAdvance: state.autoAdvance,
    alerted: { ...(state.alerted || {}) },
    boughtHistory: structuredClone(state.boughtHistory || []),
    currentHalf: state.currentHalf,
    tab: state.tab
  };
  if ((state.lots || []).length) rememberBoughtLots(state.lots);
  state.lots = [];
  state.alerted = {};
  state.day = auctionDay;
  state.currentNumbers = defaultCurrents(state.machines);
  state.progressAnchors = defaultAnchors(state.machines);
  state.seriesPath = defaultSeriesPath(state.machines);
  state.seriesPlans = defaultSeriesPlans(state.machines);
  state.machineMerges = defaultMachineMerges(state.machines);
  state.jumpTargets = {};
  applyFixedStartPrefills();
  state.v98ProgressCleaned = auctionDay;
  state.gpIgnoreBefore = Date.now();
  if (typeof onAuctionDayChanged === 'function') onAuctionDayChanged();
  if (typeof syncProgressTimer === 'function') syncProgressTimer();
  state.tab = 'note';
  state.currentHalf = 'fruit';
  state.skipAutoDay = '';
  showSettings = false;
  modal = null;
  draftNum = '';
  draftNote = '';
  draftItem = '';
  draftSize = '';
  draftMachineId = '';
  itemLocked = false;
  rangeMode = false;
  rangeStart = '';
  rangeEnd = '';
  rangeFocus = 'start';
  itemTargetId = null;
  itemTargetAuto = false;
  pendingDayRollover = false;
  saveState();
  freezeItemRanks();
  if (auto) offerUndo(snap, '已開始新的一天');
  else toast('已開始新的一天，預計備註還在，先從水果場開始');
  render();
}

function checkNewDay() {
  if (!state) return;
  const today = todayStr();
  if (state.day === today) {
    pendingDayRollover = false;
    return;
  }
  if (state.skipAutoDay === today) return;
  if (today < state.day) return;
  if (isMidAction()) {
    pendingDayRollover = true;
    return;
  }
  pendingDayRollover = false;
  startNewDay(true, { auto: true });
}

function maybeRollAuctionDay() {
  if (!state || (typeof isSetupNeeded === 'function' && isSetupNeeded())) return;
  if (isMidAction()) {
    if (state.day !== todayStr() && state.skipAutoDay !== todayStr()) pendingDayRollover = true;
    return;
  }
  if (!pendingDayRollover && state.day === todayStr()) return;
  const before = state.day;
  const lotsBefore = (state.lots || []).length;
  checkNewDay();
  if (state.day !== before || (state.lots || []).length !== lotsBefore) {
    if (typeof render === 'function') render();
  }
}


function cropGroupOfName(name) {
  const crop = findCrop(name);
  return (crop && crop.g) || '其他';
}

function groupRankForSummary(g) {
  const order = ['大宗', '水菜', '瓜果', '醃製', '水果', '其他'];
  const i = order.indexOf(g);
  return i < 0 ? 9 : i;
}

function sumNumsText(nums) {
  const sorted = (nums || []).slice().sort((x, y) => x.number - y.number);
  return sorted.map((n) => (n.qty > 1 ? `${n.number}×${n.qty}` : String(n.number))).join('、');
}

function daySummaryData() {
  const today = (state && state.day) || todayStr();
  const won = (state.lots || []).filter((l) => l.day === today && isWon(l));
  const unmovedPieces = unmovedQty(won);
  const groups = new Map();
  let pieces = 0;
  for (const lot of won) {
    const name = itemDisplayName(lot.item) || lot.item || '未填品項';
    const size = itemNeedsSize(lot.item) && sizeLabel(lot.size, lot.item) ? sizeLabel(lot.size, lot.item) : '';
    const key = name + (size ? ' ' + size : '');
    const g = lot.item ? cropGroupOfName(lot.item) : '其他';
    if (!groups.has(g)) groups.set(g, new Map());
    const row = groups.get(g);
    const cur = row.get(key) || { name, size, pieces: 0, lots: 0, nums: [] };
    cur.pieces += lotQty(lot);
    cur.lots += 1;
    cur.nums.push({ number: lot.number, qty: lotQty(lot) });
    row.set(key, cur);
    pieces += lotQty(lot);
  }
  const grouped = [...groups.entries()]
    .sort((a, b) => groupRankForSummary(a[0]) - groupRankForSummary(b[0]))
    .map(([g, rows]) => ({
      group: g,
      items: [...rows.values()].sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name, 'zh-Hant'))
    }));

  const wonMap = assignWonToPlans();
  const assigned = new Set();
  for (const ids of wonMap.values()) for (const id of ids) assigned.add(id);
  const lotById = new Map((state.lots || []).map((l) => [l.id, l]));
  const planRows = autoManagedPlans().map((p) => {
    const qty = planQtyOf(p);
    const wonN = planWonPieces(p, wonMap);
    const nums = (wonMap.get(p.id) || []).map((id) => lotById.get(id)).filter(Boolean)
      .map((l) => ({ number: l.number, qty: lotQty(l) }));
    return {
      id: p.id,
      text: p.text,
      qty,
      won: wonN,
      remain: Math.max(0, qty - wonN),
      extra: Math.max(0, wonN - qty),
      purpose: planPurposeOf(p),
      purposeLabel: planPurposeLabel(p),
      manualDone: !!(p.done && p.doneBy === 'manual'),
      nums
    };
  });
  const remainPlans = planRows.filter((r) => r.remain > 0);
  const overPlans = planRows.filter((r) => r.extra > 0);
  const donePlans = planRows.filter((r) => r.remain === 0 && r.extra === 0);

  const unGroups = new Map();
  for (const lot of won) {
    if (assigned.has(lot.id)) continue;
    const name = itemDisplayName(lot.item) || lot.item || '未填品項';
    const size = itemNeedsSize(lot.item) && sizeLabel(lot.size, lot.item) ? sizeLabel(lot.size, lot.item) : '';
    const key = (lot.item ? name : '未填品項') + (size ? ' ' + size : '');
    const cur = unGroups.get(key) || { name: lot.item ? name : '未填品項', size, text: lot.item ? lotPlanText(lot) : '', pieces: 0, nums: [], ids: [], skip: 0, noItem: !lot.item };
    cur.pieces += lotQty(lot);
    cur.nums.push({ number: lot.number, qty: lotQty(lot) });
    cur.ids.push(lot.id);
    if (lotPriority(lot) === 'skip') cur.skip += lotQty(lot);
    unGroups.set(key, cur);
  }
  const unplanned = [...unGroups.values()].sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name, 'zh-Hant'));
  const unplannedPieces = unplanned.reduce((n, r) => n + r.pieces, 0);

  const deliveryRemain = remainPlans.filter((p) => p.purpose === 'delivery').reduce((n, p) => n + p.remain, 0);
  const retailRemain = remainPlans.filter((p) => p.purpose !== 'delivery').reduce((n, p) => n + p.remain, 0);
  const overPieces = overPlans.reduce((n, p) => n + p.extra, 0);
  const deliveryWonPieces = won.filter((l) => lotPriority(l) === 'skip').reduce((n, l) => n + lotQty(l), 0);
  return {
    date: today, wonLots: won.length, pieces, unmovedPieces, grouped,
    remainPlans, overPlans, donePlans, unplanned, unplannedPieces, overPieces,
    deliveryRemain, retailRemain, deliveryWonPieces
  };
}

function daySummaryText() {
  const d = daySummaryData();
  const lines = [`【${formatDateLabel(d.date)} 今日總結】`, `標到 ${d.pieces} 件（${d.wonLots} 筆）`, `未搬 ${d.unmovedPieces} 件`, `交貨標到 ${d.deliveryWonPieces} 件`, `計劃外買到 ${d.unplannedPieces} 件　買超過 ${d.overPieces} 件`, `交貨還差 ${d.deliveryRemain} 件　零賣還差 ${d.retailRemain} 件`];
  lines.push('', '今天買到');
  for (const g of d.grouped) {
    lines.push(g.group);
    for (const it of g.items) {
      const label = it.size ? `${it.name} ${it.size}` : it.name;
      lines.push(`  ${label}　${it.pieces} 件　${sumNumsText(it.nums)}`);
    }
  }
  if (!d.grouped.length) lines.push('今天還沒有標到的貨。');
  const coded = (state.lots || []).filter((l) => l.day === d.date && isWon(l) && lotSubCode(l));
  if (coded.length) {
    lines.push('');
    for (const l of coded) lines.push(`  ${lotLabel(l)}`);
  }
  lines.push('', `計劃外買到（備註沒有）${d.unplanned.length ? '' : '：沒有'}`);
  for (const r of d.unplanned) {
    lines.push(`  ${r.size ? `${r.name} ${r.size}` : r.name}　${r.pieces} 件　${sumNumsText(r.nums)}`);
  }
  lines.push('', `該買沒買到${d.remainPlans.length ? '' : '：沒有，都買齊了'}`);
  for (const purpose of ['delivery', 'retail']) {
    const list = d.remainPlans.filter((p) => p.purpose === purpose);
    if (!list.length) continue;
    lines.push(purpose === 'delivery' ? '交貨' : '零賣');
    for (const p of list) lines.push(`  ${p.text}　標到 ${p.won}／預計 ${p.qty}　還差 ${p.remain} 件`);
  }
  lines.push('', `買超過${d.overPlans.length ? '' : '：沒有'}`);
  for (const p of d.overPlans) lines.push(`  ${p.text}　${p.purposeLabel}　標到 ${p.won}／預計 ${p.qty}　多 ${p.extra} 件　${sumNumsText(p.nums)}`);
  return lines.join('\n');
}

function renderDaySummary() {
  if (!showDaySummary) return '';
  const d = daySummaryData();
  const numsLine = (nums) => (nums && nums.length ? `<div class="sum-nums">號碼 ${escapeHtml(sumNumsText(nums))}</div>` : '');
  const groups = d.grouped.length
    ? d.grouped.map((g) => {
        const rows = g.items.map((it) => {
          const label = it.size ? `${escapeHtml(it.name)} <span class="sum-size">${escapeHtml(it.size)}</span>` : escapeHtml(it.name);
          return `<div class="sum-row has-nums"><div class="sum-line"><span class="sum-name">${label}</span><span class="sum-qty">${it.pieces} 件</span></div>${numsLine(it.nums)}</div>`;
        }).join('');
        return `<section class="sum-sec"><h3 class="sum-grp">${escapeHtml(g.group)}</h3>${rows}</section>`;
      }).join('')
    : '<div class="sum-empty">今天還沒有標到的貨</div>';

  const unplanned = d.unplanned.length
    ? d.unplanned.map((r) => {
        const label = r.size ? `${escapeHtml(r.name)} <span class="sum-size">${escapeHtml(r.size)}</span>` : escapeHtml(r.name);
        const add = r.noItem
          ? ''
          : `<button type="button" class="sum-add-btn" data-act="sum-add-plan" data-ids="${escapeHtml(r.ids.join(','))}">加到備註</button>`;
        return `<div class="sum-row has-nums unplanned"><div class="sum-line"><span class="sum-name">${label}</span><span class="sum-qty">${r.pieces} 件</span></div>${numsLine(r.nums)}${add}</div>`;
      }).join('')
    : '<div class="sum-empty">沒有，買到的都在備註裡</div>';

  const remainBlock = (purpose, title) => {
    const list = d.remainPlans.filter((p) => p.purpose === purpose);
    if (!list.length) return '';
    const total = list.reduce((n, p) => n + p.remain, 0);
    const rows = list.map((p) => `<div class="sum-row has-nums remain"><div class="sum-line"><span class="sum-name">${escapeHtml(p.text)}</span><span class="sum-qty">還差 ${p.remain} 件</span></div><div class="sum-nums">標到 ${p.won}／預計 ${p.qty}${p.manualDone ? '　已手動勾完成' : ''}${p.nums.length ? '　號碼 ' + escapeHtml(sumNumsText(p.nums)) : ''}</div></div>`).join('');
    return `<div class="sum-sub"><span class="sum-purpose ${purpose}">${title}</span><span class="sum-sub-n">共還差 ${total} 件</span></div>${rows}`;
  };
  const remainHtml = d.remainPlans.length
    ? remainBlock('delivery', '交貨') + remainBlock('retail', '零賣')
    : '<div class="sum-empty">沒有，備註都買齊了</div>';

  const over = d.overPlans.length
    ? d.overPlans.map((p) => `<div class="sum-row has-nums over"><div class="sum-line"><span class="sum-name">${escapeHtml(p.text)}</span><span class="sum-purpose ${p.purpose}">${escapeHtml(p.purposeLabel)}</span><span class="sum-qty">多 ${p.extra} 件</span></div><div class="sum-nums">標到 ${p.won}／預計 ${p.qty}　號碼 ${escapeHtml(sumNumsText(p.nums))}</div></div>`).join('')
    : '<div class="sum-empty">沒有買超過的</div>';

  return `<div class="plan-screen sum-screen" id="sum-screen">
    <header class="plan-bar">
      <button type="button" class="plan-back" data-act="close-summary">返回</button>
      <h1>今日總結</h1>
      <span class="plan-bar-spacer"></span>
    </header>
    <div class="plan-body sum-body">
      <div class="sum-date">${escapeHtml(formatDateLabel(d.date))}</div>
      <div class="sum-totals">
        <div class="tot"><b>${d.pieces}</b><span>標到件數</span></div>
        <div class="tot"><b>${d.wonLots}</b><span>標到筆數</span></div>
        <div class="tot"><b>${d.unmovedPieces}</b><span>未搬件數</span></div>
        <div class="tot"><b>${d.deliveryWonPieces}</b><span>交貨標到</span></div>
        <div class="tot${d.unplannedPieces ? ' warn' : ''}"><b>${d.unplannedPieces}</b><span>計劃外買到</span></div>
        <div class="tot${d.remainPlans.length ? ' warn' : ''}"><b>${d.deliveryRemain + d.retailRemain}</b><span>該買沒買到</span></div>
        <div class="tot${d.overPieces ? ' warn' : ''}"><b>${d.overPieces}</b><span>買超過</span></div>
      </div>
      <section class="sum-sec"><h2>今天買到</h2>${groups}</section>
      ${(() => {
        const coded = (state.lots || []).filter((l) => l.day === d.date && isWon(l) && lotSubCode(l));
        if (!coded.length) return '';
        const rows = coded.map((l) => `<div class="sum-row"><span class="sum-name">${lotLabelHtml(l)}</span></div>`).join('');
        return `<section class="sum-sec"><h3 class="sum-grp">有小代碼的</h3>${rows}</section>`;
      })()}
      <section class="sum-sec sum-unplanned"><h2>計劃外買到<small>備註沒有的</small></h2>${unplanned}</section>
      <section class="sum-sec sum-short"><h2>該買沒買到<small>標到少於預計</small></h2>${remainHtml}</section>
      <section class="sum-sec sum-over"><h2>買超過<small>標到多於預計</small></h2>${over}</section>
      <div class="share-row sum-share">
        <button type="button" class="btn" data-act="copy-summary">複製文字</button>
        <button type="button" class="btn primary" data-act="share-summary">分享</button>
      </div>
    </div>
  </div>`;
}

function addUnplannedToPlan(idsText) {
  const ids = String(idsText || '').split(',').filter(Boolean);
  const lots = ids.map((id) => (state.lots || []).find((l) => l.id === id)).filter((l) => l && l.item && isWon(l));
  if (!lots.length) return;
  const text = lotPlanText(lots[0]);
  if (!text) return;
  const qty = Math.min(99, lots.reduce((n, l) => n + lotQty(l), 0));
  const skip = lots.reduce((n, l) => n + (lotPriority(l) === 'skip' ? lotQty(l) : 0), 0);
  const snap = snapshotPlanItems();
  const today = todayStr();
  if (!Array.isArray(state.planItems)) state.planItems = [];
  state.planItems.push({
    id: uid(),
    text,
    forDay: today,
    done: false,
    doneOn: '',
    createdOn: today,
    qty,
    doneBy: '',
    lockCount: 0,
    purpose: skip * 2 > qty ? 'delivery' : 'retail'
  });
  saveState();
  offerPlanUndo(snap, `已加到備註　${text}　${qty} 件`);
  buzz(24);
  render();
}

function openDaySummary() {
  showDaySummary = true;
  sumBodyScroll = 0;
  toastMsg = '';
  toastAction = null;
  render();
}

function closeDaySummary() {
  showDaySummary = false;
  sumBodyScroll = 0;
  render();
}

async function shareDaySummary() {
  const text = daySummaryText();
  if (navigator.share) {
    try {
      await navigator.share({ text, title: '今日總結' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  await copyResults(text);
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
      const w = group.filter((l) => isWon(l));
      const unmoved = group.filter((l) => l.status === 'won');
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
      if (unmoved.length) lines.push(`  未搬：${unmoved.map(lotLabel).join('、')}（${unmoved.length}）`);
      if (x.length) lines.push(`  沒標到：${x.map(lotLabel).join('、')}（${x.length}）`);
      if (flowG.length) lines.push(`  流標・二市：${flowG.map(lotLabel).join('、')}（${flowG.length}）`);
      if (over.length) lines.push(`  過號：${over.map(lotLabel).join('、')}（${over.length}）`);
      if (p.length) lines.push(`  未拍：${p.map(lotLabel).join('、')}（${p.length}）`);
      const musts = group.filter((l) => isUnauctionedMust(l));
      if (musts.length) lines.push(`  美未拍：${musts.map(lotLabel).join('、')}（${musts.length}）`);
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

/* v109: the one-line fit was done button by button with a layout read after every
   style write (~70 ms for the item grid on a phone, after every tap). Now every
   button is reset first, measured in one pass, and the answer is remembered per
   (label, width, font), so a re-render with the same buttons costs almost nothing. */
const itemFitCache = new Map();
function fitItemBtnLabels() {
  const btns = Array.from(document.querySelectorAll('.item-btn, .plan-pick'));
  if (!btns.length) return;
  for (const btn of btns) {
    btn.style.fontSize = '';
    btn.style.whiteSpace = '';
  }
  const meta = btns.map((btn) => {
    const cs = getComputedStyle(btn);
    const inPlan = !!(btn.closest && btn.closest('.plan-grid-list, .plan-yest-list'));
    const base = parseFloat(cs.fontSize) || 18;
    const key = btn.className + '\u0001' + btn.textContent + '\u0001' + btn.clientWidth + '\u0001' + base + '\u0001' + cs.paddingLeft + cs.paddingRight + cs.letterSpacing;
    return { btn, inPlan, base, key, hit: inPlan ? null : itemFitCache.get(key) };
  });
  for (const m of meta) {
    const { btn } = m;
    if (m.inPlan) {
      btn.style.whiteSpace = 'normal';
      continue;
    }
    if (m.hit) {
      btn.style.whiteSpace = m.hit.ws;
      if (m.hit.size !== m.base) btn.style.fontSize = m.hit.size + 'px';
      continue;
    }
    let size = m.base;
    const oneLineMin = 14;
    btn.style.whiteSpace = 'nowrap';
    while (size > oneLineMin && btn.scrollWidth > btn.clientWidth + 0.5) {
      size -= 0.5;
      btn.style.fontSize = size + 'px';
    }
    if (btn.scrollWidth > btn.clientWidth + 0.5) {
      btn.style.whiteSpace = 'normal';
    }
    if (itemFitCache.size > 3000) itemFitCache.clear();
    itemFitCache.set(m.key, { size, ws: btn.style.whiteSpace || 'nowrap' });
  }
}

function fitLotCellNames() {
  // Names stay at the CSS size in every row. Long names ellipsis; never shrink
  // to make room for an ETA chip or a tight cell.
  document.querySelectorAll('.lot-cell .cell-item-name').forEach((el) => {
    el.style.fontSize = '';
  });
}

function fitLotCellEtas() {
  document.querySelectorAll('.lot-cell .eta-badge').forEach((el) => {
    el.style.display = '';
    const top = el.closest('.cell-top');
    if (!top) {
      el.style.display = 'none';
      return;
    }
    const er = el.getBoundingClientRect();
    const tr = top.getBoundingClientRect();
    const wrap = top.querySelector('.num-sub-wrap');
    const wr = wrap ? wrap.getBoundingClientRect() : null;
    const squeezed = el.scrollWidth > el.clientWidth + 0.5;
    const overflowTop = er.right > tr.right + 0.5 || er.left < tr.left - 0.5;
    const overlapWrap = !!(wr && er.left < wr.right - 0.5);
    if (squeezed || overflowTop || overlapWrap || er.width < 28) el.style.display = 'none';
  });
}

function updateLiveListOverflow() {
  document.querySelectorAll('.live-col-list').forEach((el) => {
    const max = el.scrollHeight - el.clientHeight;
    el.classList.toggle('can-scroll-more', max > 2 && el.scrollTop < max - 2);
    el.classList.toggle('can-scroll-up', el.scrollTop > 2);
  });
}


const SEG_TRACK_SEL = '.prio-toggle, .half-switch, .hand-seg';
const SEG_EASE = 'transform 280ms cubic-bezier(.22,1,.36,1), width 280ms cubic-bezier(.22,1,.36,1)';
let segAnimPending = false;
let segAnimFrom = null;
let lotColorPending = false;
let lotColorFrom = null;
let segAnimToken = 0;

function reducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function requestSegAnim() {
  if (!reducedMotion()) segAnimPending = true;
}

function requestLotColorAnim() {
  if (!reducedMotion()) lotColorPending = true;
}

function segTrackKey(track) {
  if (track.classList.contains('sheet-prio')) return 'sheet-prio';
  if (track.classList.contains('note-prio')) return 'note-prio';
  if (track.classList.contains('half-switch')) return 'half-switch';
  if (track.classList.contains('hand-seg')) return 'hand-seg';
  return 'seg';
}

function measureSegTrack(track) {
  const on = track.querySelector('button.on');
  if (!on) return null;
  const colors = {};
  track.querySelectorAll('button').forEach((btn) => {
    if (btn.dataset.v) colors[btn.dataset.v] = getComputedStyle(btn).color;
  });
  return {
    x: on.offsetLeft,
    y: on.offsetTop,
    w: on.offsetWidth,
    h: on.offsetHeight,
    v: on.dataset.v || '',
    colors,
  };
}

function captureSegAnim() {
  const map = {};
  document.querySelectorAll(SEG_TRACK_SEL).forEach((track) => {
    const m = measureSegTrack(track);
    if (m) map[segTrackKey(track)] = m;
  });
  segAnimFrom = Object.keys(map).length ? map : null;
}

function captureLotColors(onlyIds) {
  const map = {};
  document.querySelectorAll('.lot-cell[data-id]').forEach((el) => {
    if (onlyIds && !onlyIds.has(el.dataset.id)) return;
    const s = getComputedStyle(el);
    const tag = el.querySelector('.prio-tag');
    const ts = tag ? getComputedStyle(tag) : null;
    map[el.dataset.id] = {
      background: s.background,
      color: s.color,
      boxShadow: s.boxShadow,
      filter: s.filter,
      borderColor: s.borderColor,
      tag: ts
        ? { background: ts.background, color: ts.color, boxShadow: ts.boxShadow }
        : null,
    };
  });
  lotColorFrom = Object.keys(map).length ? map : null;
}

function applySegBox(ind, box) {
  ind.style.top = `${box.y}px`;
  ind.style.height = `${box.h}px`;
  ind.style.width = `${box.w}px`;
  ind.style.transform = `translate3d(${box.x}px,0,0)`;
}

function positionSegIndicator(track, from, animate) {
  const ind = track.querySelector('.seg-indicator');
  const to = measureSegTrack(track);
  if (!ind || !to) return;
  const canAnim = !!(animate && from && !reducedMotion());
  if (canAnim) {
    ind.style.transition = 'none';
    applySegBox(ind, from);
    track.querySelectorAll('button').forEach((btn) => {
      const prev = from.colors && from.colors[btn.dataset.v];
      if (!prev) return;
      btn.style.transition = 'none';
      btn.style.color = prev;
    });
    ind.classList.add('is-ready');
    track.classList.add('seg-ready');
    void ind.offsetWidth;
    ind.style.transition = SEG_EASE;
    applySegBox(ind, to);
    track.querySelectorAll('button').forEach((btn) => {
      btn.style.transition = '';
      btn.style.color = '';
    });
  } else {
    ind.style.transition = 'none';
    applySegBox(ind, to);
    ind.classList.add('is-ready');
    track.classList.add('seg-ready');
    void ind.offsetWidth;
    ind.style.transition = '';
  }
}

function syncSegIndicators(animate) {
  document.querySelectorAll(SEG_TRACK_SEL).forEach((track) => {
    const from = animate && segAnimFrom ? segAnimFrom[segTrackKey(track)] : null;
    positionSegIndicator(track, from, animate);
  });
}

function applyLotColorFrom(from) {
  if (!from) return;
  document.querySelectorAll('.lot-cell[data-id]').forEach((el) => {
    const prev = from[el.dataset.id];
    if (!prev) return;
    el.style.transition = 'none';
    el.style.background = prev.background;
    el.style.color = prev.color;
    el.style.boxShadow = prev.boxShadow;
    el.style.filter = prev.filter;
    el.style.borderColor = prev.borderColor;
    const tag = el.querySelector('.prio-tag');
    if (tag && prev.tag) {
      tag.style.transition = 'none';
      tag.style.background = prev.tag.background;
      tag.style.color = prev.tag.color;
      tag.style.boxShadow = prev.tag.boxShadow;
    }
  });
}

function clearLotColorInline() {
  document.querySelectorAll('.lot-cell[data-id]').forEach((el) => {
    el.style.transition = '';
    el.style.background = '';
    el.style.color = '';
    el.style.boxShadow = '';
    el.style.filter = '';
    el.style.borderColor = '';
    const tag = el.querySelector('.prio-tag');
    if (tag) {
      tag.style.transition = '';
      tag.style.background = '';
      tag.style.color = '';
      tag.style.boxShadow = '';
    }
  });
}

function playLotColorAnim() {
  const from = lotColorFrom;
  lotColorFrom = null;
  if (!from || reducedMotion()) return;
  applyLotColorFrom(from);
  document.querySelectorAll('.lot-cell[data-id]').forEach((el) => {
    if (from[el.dataset.id]) void el.offsetWidth;
  });
  clearLotColorInline();
}

function layoutSegIndicators() {
  segAnimPending = false;
  segAnimFrom = null;
  syncSegIndicators(false);
}

function afterRenderMotion(doSeg, doLot) {
  const token = ++segAnimToken;
  if (doSeg && segAnimFrom && !reducedMotion()) {
    document.querySelectorAll(SEG_TRACK_SEL).forEach((track) => {
      const ind = track.querySelector('.seg-indicator');
      const from = segAnimFrom[segTrackKey(track)];
      if (!ind || !from) return;
      ind.style.transition = 'none';
      applySegBox(ind, from);
      track.querySelectorAll('button').forEach((btn) => {
        const prev = from.colors && from.colors[btn.dataset.v];
        if (!prev) return;
        btn.style.transition = 'none';
        btn.style.color = prev;
      });
      ind.classList.add('is-ready');
      track.classList.add('seg-ready');
    });
    if (doLot && lotColorFrom) applyLotColorFrom(lotColorFrom);
    requestAnimationFrame(() => {
      if (token !== segAnimToken) return;
      syncSegIndicators(true);
      if (doLot) playLotColorAnim();
      else lotColorFrom = null;
      segAnimFrom = null;
    });
  } else {
    syncSegIndicators(false);
    if (doLot && lotColorFrom && !reducedMotion()) {
      applyLotColorFrom(lotColorFrom);
      requestAnimationFrame(() => {
        if (token !== segAnimToken) return;
        playLotColorAnim();
      });
    } else {
      lotColorFrom = null;
    }
    segAnimFrom = null;
  }
}


let lastPageKey = '';

function currentPageKey() {
  return [
    showSettings ? 'settings' : ((state && state.tab) || ''),
    paddleOpen ? 'paddle' : '',
    modal && modal.type ? 'm:' + modal.type : '',
    planOpen ? 'plan' : '',
    showDaySummary ? 'sum' : '',
  ].join('|');
}

function applyPageEnterFallback() {
  document.querySelectorAll('#main, #paddle, .overlay, .plan-screen').forEach((el) => {
    el.classList.add('page-enter');
  });
}

function pressFlashTarget(e) {
  const t = e.target && e.target.closest && e.target.closest('button, .key, .toggle, .item-btn, .lot-cell, .recent-chip, .nav-btn, .gear-btn');
  if (!t || t.disabled) return null;
  if (t.closest('input, textarea, select')) return null;
  return t;
}

function startPressFlash(e) {
  if (reducedMotion()) return;
  if (e.button != null && e.button !== 0) return;
  const t = pressFlashTarget(e);
  if (!t) return;
  let layer = document.getElementById('press-flash-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'press-flash-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  const r = t.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return;
  const el = document.createElement('span');
  el.className = 'press-flash';
  el.style.left = r.left + 'px';
  el.style.top = r.top + 'px';
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
  el.style.borderRadius = getComputedStyle(t).borderRadius;
  layer.appendChild(el);
  const fade = () => {
    if (!el.isConnected || el.classList.contains('is-out')) return;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 260);
  };
  const up = () => {
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    fade();
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  setTimeout(() => {
    if (el.isConnected && !el.classList.contains('is-out')) fade();
  }, 2000);
}

/* The CSS used  #app:has(...)  to restyle the toast. A :has() on the app root is
   re-checked on every DOM change under it and made the browser restyle every cell
   span on each tap (~80 ms on a phone). Plain classes say the same thing for free. */
function syncAppFlags(app) {
  const want = {
    'has-live': !!document.querySelector('#main.live-mode'),
    'has-plan': !!document.getElementById('plan-screen'),
    'has-sum': !!document.getElementById('sum-screen'),
    'has-paddle': !!document.getElementById('paddle'),
    'has-keypad': !!document.querySelector('.overlay .keypad'),
  };
  for (const k of Object.keys(want)) {
    if (app.classList.contains(k) !== want[k]) app.classList.toggle(k, want[k]);
  }
}

function liveSig(parts) {
  return !!(parts && parts.cols);
}

/* Update the live screen in place: only the cells / footers / bar whose HTML
   changed are swapped, so the 300-cell lists keep their DOM, scroll position
   and layout. Returns false (and touches nothing) when the shape differs, so
   the caller falls back to the old full rebuild. */
function patchLiveMain(main, prev, next, grabColors) {
  if (prev.n !== next.n || prev.empty !== next.empty || prev.cols.length !== next.cols.length) return false;
  const screen = main.firstElementChild;
  if (!screen || !screen.classList.contains('live-screen')) return false;
  const colsEl = screen.querySelector(':scope > .live-cols');
  if (!colsEl || colsEl.children.length !== next.cols.length) return false;
  const plans = [];
  for (let i = 0; i < next.cols.length; i += 1) {
    const a = prev.cols[i];
    const b = next.cols[i];
    if (a.id !== b.id) return false;
    const sec = colsEl.children[i];
    if (!sec || !sec.classList.contains('live-col') || sec.dataset.id !== b.id) return false;
    const list = sec.querySelector(':scope > .live-col-list');
    const head = sec.querySelector(':scope > .live-col-head');
    const foot = sec.querySelector(':scope > .live-col-foot');
    if (!list || !head || !foot) return false;
    let mode = 'cells';
    const changed = [];
    if (!a.cells || !b.cells) {
      mode = 'rebuild';
    } else if (list.children.length !== a.ids.length) {
      mode = 'rebuild';
    } else if (a.ids.length !== b.ids.length || a.ids.some((id, j) => id !== b.ids[j])) {
      /* v114: a lot added or removed (often a teammate's): move only the cells that
         changed instead of rebuilding the whole column (~45 ms each at a busy time). */
      mode = 'keyed';
      const oldIdx = new Map();
      a.ids.forEach((id, j) => oldIdx.set(id, j));
      let last = -1;
      let work = 0;
      for (let j = 0; j < b.ids.length; j += 1) {
        const k = oldIdx.get(b.ids[j]);
        if (k == null) { work += 1; continue; }
        if (k < last) { mode = 'rebuild'; break; }
        last = k;
        if (a.cells[k] !== b.cells[j]) { work += 1; changed.push(j); }
      }
      if (mode === 'keyed') changed.oldIdx = oldIdx;
      if (work > 40) mode = 'rebuild';
    } else {
      for (let j = 0; j < b.ids.length; j += 1) {
        if (a.ids[j] !== b.ids[j]) { mode = 'rebuild'; break; }
        if (a.cells[j] !== b.cells[j]) changed.push(j);
      }
      if (mode === 'cells' && changed.length > 60) mode = 'rebuild';
    }
    plans.push({ a, b, sec, list, head, foot, mode, changed });
  }
  // Everything checked: now the DOM work, which cannot fail half way for shape reasons.
  const ids = new Set();
  for (const pl of plans) {
    if (pl.mode === 'cells' || pl.mode === 'keyed') for (const j of pl.changed) ids.add(pl.b.ids[j]);
    if (pl.mode === 'keyed') for (const id of pl.b.ids) if (!pl.changed.oldIdx.has(id)) ids.add(id);
  }
  grabColors(plans.some((pl) => pl.mode === 'rebuild') ? null : ids);
  if (prev.bar !== next.bar) {
    const bar = screen.querySelector(':scope > .live-bar');
    if (bar) replaceNode(bar, next.bar);
  }
  for (const pl of plans) {
    if (pl.a.head !== pl.b.head) replaceNode(pl.head, pl.b.head);
    if (pl.a.foot !== pl.b.foot) replaceNode(pl.foot, pl.b.foot);
    if (pl.mode === 'keyed') {
      const top = pl.list.scrollTop;
      const oldNodes = Array.from(pl.list.children);
      const oldIdx = pl.changed.oldIdx;
      const keep = new Set();
      const changedSet = new Set(pl.changed);
      const want = pl.b.ids.map((id, j) => {
        const k = oldIdx.get(id);
        if (k == null || changedSet.has(j)) return firstElFromHtml(pl.b.cells[j]);
        keep.add(k);
        return oldNodes[k];
      });
      oldNodes.forEach((n, k) => { if (!keep.has(k)) n.remove(); });
      for (let j = 0; j < want.length; j += 1) {
        const node = want[j];
        if (!node) continue;
        const at = pl.list.children[j] || null;
        if (at !== node) pl.list.insertBefore(node, at);
      }
      pl.list.scrollTop = top;
      continue;
    }
    if (pl.mode === 'rebuild') {
      const top = pl.list.scrollTop;
      pl.list.innerHTML = pl.b.cells ? pl.b.cells.join('') : '<div class="col-empty">還沒抄號</div>';
      pl.list.scrollTop = top;
    } else {
      for (const j of pl.changed) {
        const old = pl.list.children[j];
        if (old) replaceNode(old, pl.b.cells[j]);
      }
    }
  }
  return true;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (state && !planProgressLock) settleProgress({ silent: !!renderSettleSilent });
  if (!planProgressLock && state && !isSetupNeeded()) {
    planProgressLock = true;
    let dirty = false;
    try {
      const ev = applyPlanProgressFromLots();
      dirty = !!(ev && ev.changed);
    } finally {
      planProgressLock = false;
    }
    if (dirty) saveState();
  }
  const activeField = captureActiveField();

  if (isSetupNeeded()) {
    segAnimPending = false;
    lotColorPending = false;
    segAnimFrom = null;
    lotColorFrom = null;
    app.innerHTML = renderSetup();
    syncAppFlags(app);
    restoreActiveField(activeField);
    return;
  }

  if (segAnimPending) captureSegAnim();
  /* On the live tab only the cells that actually change need their old colours,
     so the capture is done inside paint(), once the changed cells are known. */
  let lotColorDeferred = false;
  if (lotColorPending) {
    if (state.tab === 'live' && !showSettings && paintedLive) lotColorDeferred = true;
    else captureLotColors();
  }
  const doSegAnim = segAnimPending && !!segAnimFrom;
  const doLotAnim = lotColorPending && (lotColorDeferred || !!lotColorFrom);
  segAnimPending = false;
  lotColorPending = false;

  /* The live lists are only captured/restored when their DOM is rebuilt (see paint),
     because patched lists keep their own scroll position and reading scrollTop
     forces a full layout. */
  captureItemPickScroll();
  capturePlanGridScroll();
  capturePlanListScroll();
  captureMainScroll();
  const nextPageKey = currentPageKey();
  const shouldPageAnim = !!(lastPageKey && nextPageKey !== lastPageKey && !reducedMotion());
  const samePage = !!(lastPageKey && lastPageKey === nextPageKey);
  lastPageKey = nextPageKey;
  const liveCls = state.tab === 'live' && !showSettings ? ' live-mode' : '';
  const noteCls = state.tab === 'note' && !showSettings ? ' note-mode' : '';

  const paint = () => {
    let headerHtml, mainInner, navHtml, paddleHtml, modalHtml, planHtml, sumHtml;
    renderPassId += 1;
    renderPassActive = true;
    try {
      headerHtml = renderHeader();
      mainInner = renderTab();
      navHtml = renderNav();
      paddleHtml = paddleOpen ? renderPaddle() : '';
      modalHtml = modal ? renderModal() : '';
      planHtml = renderPlanScreen();
      sumHtml = renderDaySummary();
    } finally {
      renderPassActive = false;
    }
    const nextLive = liveParts && liveParts.html === mainInner ? liveParts : null;
    let livePatched = false;
    let liveRebuilt = false;
    const grabColors = (onlyIds) => {
      if (lotColorDeferred) {
        captureLotColors(onlyIds);
        lotColorDeferred = false;
      }
    };
    const mainCls = `main${noteCls}${liveCls}`;
    const mainHtml = `<main class="${mainCls}" id="main">${mainInner}</main>`;
    const shell = document.querySelector('#app > .header') && document.getElementById('main') && document.querySelector('#app > .nav');

    /* Opening or closing an overlay screen (paddle, plan, summary) leaves the main
       screen exactly as it is, so keep its DOM and only swap the sections that
       changed instead of rebuilding hundreds of lot cells underneath. */
    const mainUntouched = !!(shell && lastPaintHtml.main === mainInner && document.getElementById('main') && document.getElementById('main').className === mainCls);
    if (!shell || (!mainUntouched && (shouldPageAnim || !samePage))) {
      grabColors(null);
      captureLiveScroll();
      liveRebuilt = true;
      app.innerHTML =
        headerHtml +
        mainHtml +
        navHtml +
        paddleHtml +
        modalHtml +
        planHtml +
        sumHtml +
        `<div id="toast" class="toast${toastMsg ? '' : ' hidden'}"></div>`;
      paintedLive = nextLive;
      lastPaintHtml = {
        header: headerHtml,
        nav: navHtml,
        main: mainInner,
        paddle: paddleHtml,
        modal: modalHtml,
        plan: planHtml,
        sum: sumHtml
      };
    } else {
      if (lastPaintHtml.header !== headerHtml) {
        const header = document.querySelector('#app > .header');
        if (header) replaceNode(header, headerHtml);
        lastPaintHtml.header = headerHtml;
      }
      if (lastPaintHtml.nav !== navHtml) {
        const nav = document.querySelector('#app > .nav');
        if (nav) replaceNode(nav, navHtml);
        lastPaintHtml.nav = navHtml;
      }
      const main = document.getElementById('main');
      if (main) {
        if (main.className !== mainCls) main.className = mainCls;
        if (lastPaintHtml.main !== mainInner) {
          if (nextLive && paintedLive && liveSig(paintedLive) && lastPaintHtml.main === paintedLive.html) {
            livePatched = patchLiveMain(main, paintedLive, nextLive, grabColors);
          }
          if (!livePatched) {
            grabColors(null);
            captureLiveScroll();
            liveRebuilt = true;
            main.innerHTML = mainInner;
          }
          paintedLive = nextLive;
          lastPaintHtml.main = mainInner;
        }
      }
      if (lastPaintHtml.paddle !== paddleHtml) {
        upsertAppSection(app, document.getElementById('paddle'), paddleHtml, document.getElementById('toast'));
        lastPaintHtml.paddle = paddleHtml;
      }
      if (lastPaintHtml.modal !== modalHtml) {
        upsertAppSection(app, document.querySelector('#app > .overlay'), modalHtml, document.getElementById('toast'));
        lastPaintHtml.modal = modalHtml;
      }
      if (lastPaintHtml.plan !== planHtml) {
        upsertAppSection(app, document.getElementById('plan-screen'), planHtml, document.getElementById('toast'));
        lastPaintHtml.plan = planHtml;
      }
      if (lastPaintHtml.sum !== sumHtml) {
        upsertAppSection(app, document.getElementById('sum-screen'), sumHtml, document.getElementById('toast'));
        lastPaintHtml.sum = sumHtml;
      }
    }

    syncAppFlags(app);
    paintToast(document.getElementById('toast'));
    requestAnimationFrame(fitToastText);
    restoreActiveField(activeField);
    if (liveRebuilt) restoreLiveScroll();
    else if (typeof liveScrollFollow === 'object' && Object.keys(liveScrollFollow).length) restoreLiveScroll(true);
    restoreItemPickScroll();
    restorePlanGridScroll();
    restorePlanListScroll();
    restoreMainScroll();
    requestAnimationFrame(restoreMainScroll);
    if (typeof syncMachinePickAnim === 'function') syncMachinePickAnim();
    afterRenderMotion(doSegAnim, doLotAnim);
    if (modal?.type === 'type-item') {
      const input = document.getElementById('type-item-input');
      if (input && document.activeElement !== input) {
        input.focus({ preventScroll: true });
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch { /* ignore */ }
      }
    }
    if (state.tab === 'live' && !showSettings) {
      requestAnimationFrame(() => {
        fitLotCellNames();
        fitLotCellEtas();
        updateLiveListOverflow();
      });
    }
    if (paddleOpen) requestAnimationFrame(fitPaddleDigits);
    if (typeof paintSyncQr === 'function') requestAnimationFrame(paintSyncQr);
    requestAnimationFrame(fitItemBtnLabels);
    requestAnimationFrame(fitKeypadSheet);
    maybeReloadForNewSW();
  };

  if (shouldPageAnim && document.startViewTransition) {
    try {
      const vt = document.startViewTransition(paint);
      if (vt) ['finished', 'ready', 'updateCallbackDone'].forEach((k) => { if (vt[k] && vt[k].catch) vt[k].catch(() => {}); });
    } catch {
      paint();
      applyPageEnterFallback();
    }
  } else {
    paint();
    if (shouldPageAnim) applyPageEnterFallback();
  }
}

function restoreFocus(focusId, start, end) {
  if (!focusId) return;
  const el = document.getElementById(focusId);
  if (!el || typeof el.focus !== 'function') return;
  el.focus({ preventScroll: true });
  if (start != null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(start, end);
    } catch {
      /* ignore */
    }
  }
}


function iconSvg(name) {
  const paths = {
    pencil: '<path fill="currentColor" d="M4.5 16.8 16.2 5.1l2.7 2.7L7.2 19.5H4.5v-2.7zm13.4-13.4 1.3 1.3c.5.5.5 1.3 0 1.8l-1.2 1.2-2.7-2.7 1.2-1.2c.5-.5 1.3-.5 1.8 0z"/>',
    hand: '<path fill="currentColor" d="M8.2 11.2V5.8a1.3 1.3 0 0 1 2.6 0v4.2h.2V4.7a1.3 1.3 0 0 1 2.6 0v5.3h.2V5.5a1.3 1.3 0 0 1 2.6 0v5.8h.2V7.6a1.3 1.3 0 0 1 2.6 0V14c0 3.4-2.2 6-5.7 6.5-2.6.4-5.3-.7-6.8-2.8L5 15.2c-.5-.7-.4-1.7.3-2.2.7-.5 1.7-.4 2.2.3l.7 1v-3.1z"/>',
    play: '<path fill="currentColor" d="M8 5.2v13.6l11-6.8L8 5.2z"/>',
    gear: '<path fill="currentColor" d="M10.1 3.2h3.8l.4 2.3 1.9.8 2-1.3 2.7 2.7-1.3 2 0.8 1.9 2.3.4v3.8l-2.3.4-.8 1.9 1.3 2-2.7 2.7-2-1.3-1.9.8-.4 2.3h-3.8l-.4-2.3-1.9-.8-2 1.3-2.7-2.7 1.3-2-.8-1.9L3.2 13.9V10.1l2.3-.4.8-1.9-1.3-2 2.7-2.7 2 1.3 1.9-.8.4-2.3zM12 9.2A2.8 2.8 0 1 0 12 14.8 2.8 2.8 0 0 0 12 9.2z"/>',
    close: '<path fill="currentColor" d="M6.2 6.2 12 12l5.8-5.8 1.8 1.8L13.8 13.8l5.8 5.8-1.8 1.8L12 15.6l-5.8 5.8-1.8-1.8 5.8-5.8-5.8-5.8 1.8-1.8z"/>',
    target: '<path fill="currentColor" d="M11 3h2v2.1c3 .4 5.5 2.9 5.9 5.9H21v2h-2.1c-.4 3-2.9 5.5-5.9 5.9V21h-2v-2.1C8 18.5 5.5 16 5.1 13H3v-2h2.1C5.5 8 8 5.5 11 5.1V3zm1 4.5A4.5 4.5 0 1 0 16.5 12 4.5 4.5 0 0 0 12 7.5zm0 2.5A2 2 0 1 1 10 12a2 2 0 0 1 2-2z"/>',
    search: '<path fill="currentColor" d="M10.2 4.2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm6.4 7.3 4.2 4.2-1.5 1.5-4.2-4.2 1.5-1.5z"/>',
    doc: '<path fill="currentColor" d="M7 3.5h7.2L19 8.3V20.5H7V3.5zm7.4 1.2v4.1h4.1l-4.1-4.1zM9.2 12.2h7.6v1.6H9.2v-1.6zm0 3.2h7.6v1.6H9.2v-1.6z"/>',
  };
  const inner = paths[name];
  if (!inner) return '';
  return `<svg class="ico-svg ico-${name}" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">${inner}</svg>`;
}

function renderHeader() {
  const half = state.currentHalf;
  const banner = typeof renderSyncBanner === 'function' ? renderSyncBanner() : '';
  const [, dm, dd] = String(state.day || '').split('-').map(Number);
  const wd = WEEKDAYS[new Date(String(state.day) + 'T12:00:00').getDay()] || '';
  return `
    <header class="header${banner ? ' has-banner' : ''}">
      <div class="header-left">
        <img class="app-logo" src="icons/icon-192.png" alt="拍賣標貨助手" width="24" height="24" />
        <div class="header-date" aria-label="${escapeHtml(formatDateLabel(state.day))}"><span class="hd-md">${dm}/${dd}</span><span class="hd-wd">（${escapeHtml(wd)}）</span></div>
      </div>
      <div class="header-right">
        <div class="half-switch" role="tablist">
          <span class="seg-indicator" aria-hidden="true"></span>
          ${HALVES.map((h) => `<button type="button" data-act="half" data-v="${h}" class="sess-${h}${half === h ? ' on' : ''}">${halfLabel(h)}</button>`).join('')}
        </div>
        ${typeof renderSyncPill === 'function' ? renderSyncPill() : ''}
        <button type="button" class="gear-btn${showSettings ? ' on' : ''}" data-act="settings" aria-label="設定">${showSettings ? iconSvg('close') : iconSvg('gear')}</button>
      </div>
      ${banner}
    </header>`;
}

function renderNav() {
  const tab = showSettings ? '' : state.tab;
  return `
    <nav class="nav">
      <button type="button" class="nav-btn${tab === 'note' ? ' on' : ''}" data-act="tab" data-v="note">
        <span class="ico">${iconSvg('pencil')}</span><span>抄號</span>
      </button>
      <button type="button" class="nav-btn paddle" data-act="paddle">
        <span class="ico">${iconSvg('hand')}</span><span>舉牌</span>
      </button>
      <button type="button" class="nav-btn${tab === 'live' ? ' on' : ''}" data-act="tab" data-v="live">
        <span class="ico">${iconSvg('play')}</span><span>拍賣中</span>
      </button>
    </nav>`;
}

function renderTab() {
  if (showSettings) return renderSettings();
  if (state.tab === 'live') return renderLive();
  return renderNote();
}

function shouldShowMachinePick() {
  if (!state || showSettings || state.tab !== 'note') return false;
  if (showMachinePicker) return true;
  const parsed = draftNum ? parseInt(draftNum, 10) : null;
  return parsed != null && Number.isFinite(parsed) && !detectMachineId(parsed, state.currentHalf);
}

let machinePickWasOpen = false;
let machinePickAnimTok = 0;

function syncMachinePickAnim() {
  const slot = document.getElementById('machine-pick-slot');
  const tok = ++machinePickAnimTok;
  if (!slot) {
    machinePickWasOpen = false;
    return;
  }
  const want = shouldShowMachinePick();
  const reduce = typeof reducedMotion === 'function' && reducedMotion();

  function snap(open) {
    slot.classList.add('no-motion');
    slot.classList.toggle('is-open', open);
    slot.classList.toggle('is-closed', !open);
    slot.setAttribute('aria-hidden', open ? 'false' : 'true');
    slot.offsetHeight;
    slot.classList.remove('no-motion');
  }

  if (reduce) {
    snap(want);
    machinePickWasOpen = want;
    return;
  }

  if (want && machinePickWasOpen) {
    snap(true);
    return;
  }

  if (want && !machinePickWasOpen) {
    slot.classList.add('no-motion');
    slot.classList.remove('is-open');
    slot.classList.remove('is-closed');
    slot.offsetHeight;
    slot.classList.remove('no-motion');
    requestAnimationFrame(() => {
      if (machinePickAnimTok !== tok) return;
      slot.classList.add('is-open');
      slot.setAttribute('aria-hidden', 'false');
    });
    machinePickWasOpen = true;
    return;
  }

  if (!want && machinePickWasOpen) {
    slot.classList.add('no-motion');
    slot.classList.add('is-open');
    slot.classList.remove('is-closed');
    slot.offsetHeight;
    slot.classList.remove('no-motion');
    const onEnd = (e) => {
      if (e && e.propertyName && e.propertyName !== 'grid-template-rows' && e.propertyName !== 'opacity') return;
      if (e && e.target !== slot) return;
      slot.removeEventListener('transitionend', onEnd);
      if (machinePickAnimTok !== tok) return;
      if (!shouldShowMachinePick()) {
        slot.classList.add('is-closed');
        slot.setAttribute('aria-hidden', 'true');
      }
    };
    slot.addEventListener('transitionend', onEnd);
    requestAnimationFrame(() => {
      if (machinePickAnimTok !== tok) return;
      slot.classList.remove('is-open');
    });
    machinePickWasOpen = false;
    return;
  }

  snap(false);
  machinePickWasOpen = false;
}

function renderNote() {
  const num = draftNum;
  const parsed = num ? parseInt(num, 10) : null;
  let machineHint = '';
  let machineHintFull = '';
  let chipClass = 'machine-chip';
  if (parsed != null) {
    const hits = machinesMatching(parsed, state.currentHalf);
    if (draftMachineId) {
      const full = machineNameOf(draftMachineId, state.currentHalf);
      const found = machineById(draftMachineId, state.currentHalf);
      machineHint = found ? columnTitle(found, state.currentHalf) : shortMachineName(full);
      machineHintFull = full;
    } else if (hits.length === 1) {
      machineHint = columnTitle(hits[0], state.currentHalf);
      machineHintFull = hits[0].name;
    } else if (hits.length > 1) {
      machineHint = '請選台';
      machineHintFull = '有多台符合，請選台';
      chipClass += ' warn';
    } else {
      const other = HALVES.find((h) => h !== state.currentHalf && machinesMatching(parsed, h).length);
      if (other) {
        machineHint = `像是${halfLabel(other)}`;
        machineHintFull = `像是${halfLabel(other)}，請選台`;
        chipClass += ' warn';
      } else {
        machineHint = '請選台';
        machineHintFull = '無法判斷，請選台';
        chipClass += ' warn';
      }
    }
  } else {
    const list = state.machines[state.currentHalf] || [];
    const hasRanges = list.some((m) => (m.ranges || []).some((r) => r.start != null));
    if (!hasRanges && list.length === 1) {
      machineHint = `會存到${columnTitle(list[0], state.currentHalf)}`;
      machineHintFull = `會存到${list[0].name}`;
    } else if (!hasRanges) {
      machineHint = '請選台';
      machineHintFull = '這場還沒設號碼區間，請選台';
      chipClass += ' warn';
    } else {
      machineHint = '自動判斷';
      machineHintFull = '輸入後自動判斷台別';
      chipClass += ' idle';
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
              ${lotNumHtml(l, { numClass: 'ln-num' })}
              ${item}
              <span class="mch">${escapeHtml(shortMachineName(machineNameOf(l)))}</span>
              <span class="del" data-act="del-lot" data-id="${escapeHtml(l.id)}" aria-label="刪除 ${l.number}">×</span>
            </button>`;
          }
        )
        .join('')}</div>`
    : '';

  const selectedLot = itemTargetId ? state.lots.find((l) => l.id === itemTargetId) : null;
  const activeItem = itemLocked && draftItem
    ? draftItem
    : (draftNum ? draftItem : (selectedLot?.item || ''));
  const itemHint = itemLocked && draftItem
    ? (rangeMode ? '輸入起始和結束號碼' : '號碼會立刻存成這個品項，點上方可解除鎖定')
    : draftNum
      ? (draftItem ? `點品項就會把 ${draftNum} 存成「${draftItem}」` : '點品項就會把這號存下')
      : (selectedLot && !itemTargetAuto ? `為 ${selectedLot.number} 選品項` : '先點品項鎖定，再連續輸入號碼');
  const itemPick = renderItemPicker(state.currentHalf, { active: activeItem, hint: itemHint });

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
  const keypad = keys
    .map((k) => {
      if (k === '⌫') return `<button type="button" class="key muted" data-act="back">⌫</button>`;
      if (k === 'C') return `<button type="button" class="key muted" data-act="clear">清除</button>`;
      return `<button type="button" class="key" data-act="digit" data-v="${k}">${k}</button>`;
    })
    .join('');

  const machineBtns = (state.machines[state.currentHalf] || [])
    .map(
      (m) =>
        `<button type="button" class="${draftMachineId === m.id ? 'on' : ''}" data-act="pick-machine" data-id="${m.id}">${escapeHtml(m.name)}</button>`
    )
    .join('');
  const picker = `<div class="machine-pick-slot is-closed" id="machine-pick-slot" aria-hidden="true">
      <div class="machine-pick-clip">
        <div class="machine-pick" role="group" aria-label="選擇台別">${machineBtns}</div>
      </div>
    </div>`;

  const sizeItem = (itemLocked && draftItem)
    ? draftItem
    : ((itemTargetId && state.lots.find((l) => l.id === itemTargetId)?.item) || draftItem);
  const sizeLot = (!itemLocked && itemTargetId) ? state.lots.find((l) => l.id === itemTargetId) : null;
  const sizeBlock = itemNeedsSize(sizeItem)
    ? renderSizeChips(sizeLot && itemNeedsSize(sizeLot.item) ? sizeLot.size : draftSize, { item: sizeItem, lotId: sizeLot && itemNeedsSize(sizeLot.item) ? sizeLot.id : '' })
    : '';
  const planN = planTodayCount();
  const lockName = itemLocked && draftItem ? itemDisplayName(draftItem) : '';
  const lockBar = itemLocked && draftItem
    ? `<div class="item-lock">
        <button type="button" class="item-lock-main" data-act="unlock-item" aria-label="解除鎖定 ${escapeHtml(lockName)}">
          <span class="item-lock-lbl">鎖定</span>
          <span class="item-lock-name">${escapeHtml(lockName)}</span>
        </button>
        ${rangeMode ? '' : '<button type="button" class="item-lock-range" data-act="range-start">連號</button>'}
      </div>`
    : '';
  const preview = rangeMode ? previewLotRange(rangeStart, rangeEnd) : null;
  const rangeOkLabel = preview && preview.add && preview.add.length && preview.count <= RANGE_MAX
    ? ('加入 ' + preview.add.length + ' 筆')
    : '加入連號';
  const headHtml = rangeMode
    ? `<div class="note-head range-head">
        <button type="button" class="range-box${rangeFocus === 'start' ? ' on' : ''}${rangeStart ? '' : ' empty'}" data-act="range-focus" data-v="start">${rangeStart ? escapeHtml(rangeStart) : '起始'}</button>
        <div class="range-dash" aria-hidden="true">–</div>
        <button type="button" class="range-box${rangeFocus === 'end' ? ' on' : ''}${rangeEnd ? '' : ' empty'}" data-act="range-focus" data-v="end">${rangeEnd ? escapeHtml(rangeEnd) : '結束'}</button>
      </div>
      <div class="range-actions">
        <button type="button" class="btn range-cancel" data-act="range-cancel">取消連號</button>
        <button type="button" class="btn primary range-ok" data-act="range-ok"${rangeReady() ? '' : ' disabled'}>${escapeHtml(rangeOkLabel)}</button>
      </div>`
    : `<div class="note-head">
        <div class="num${num ? '' : ' empty'}${dupFlash ? ' dup-flash' : ''}">${num ? escapeHtml(num) : '- - - -'}</div>
        <div class="${chipClass}" title="${escapeHtml(machineHintFull || machineHint)}" aria-label="${escapeHtml(machineHintFull || machineHint)}">${iconSvg('target')}<span class="machine-chip-txt">${escapeHtml(machineHint)}</span></div>
      </div>`;

  return `
    <div class="note-screen${itemLocked ? ' item-locked' : ''}${rangeMode ? ' range-mode' : ''}">
      ${headHtml}
      ${lockBar}
      <div class="note-prio-block">
        <div class="prio-toggle note-prio" role="group" aria-label="美普交貨">
          <span class="seg-indicator" aria-hidden="true"></span>
          ${['must', 'watch', 'skip'].map((p) => {
            const on = (draftPriority || state.lastPriority || 'watch') === p ? ' on' : '';
            return `<button type="button" class="prio-${p}${on}" data-act="set-draft-prio" data-v="${p}">${prioLabel(p)}</button>`;
          }).join('')}
        </div>
        ${picker}
      </div>
      ${recentHtml}
      <div class="note-body">
        <div class="keypad">${keypad}</div>
        ${itemPick}
      </div>
      ${sizeBlock}
      <div class="note-tools hand-${thumbHand()}">
        <button type="button" class="plan-open-btn" data-act="open-plan">${iconSvg('doc')}<span>備註</span>${planN ? `<span class="plan-count">${planN}</span>` : ''}</button>
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

let renderSettleSilent = false;
let liveParts = null; // structured copy of the last renderLive(), used to patch the DOM cell by cell
let paintedLive = null; // liveParts that are currently on screen

function renderLive() {
  const half = state.currentHalf;
  const gapN = state.alertGap || 3;
  const allToday = state.lots.filter((l) => l.day === state.day);
  const second = secondLots();
  let won = 0;
  let lost = 0;
  let mustLeft = 0;
  for (const l of allToday) {
    if (isWon(l)) won += 1;
    else if (l.status === 'lost') lost += 1;
    if (isUnauctionedMust(l)) mustLeft += 1;
  }
  const unmovedPieces = unmovedQty(allToday);

  const activeMachines = state.machines[half] || [];

  const anyJump = activeMachines.some((m) => jumpTargetOf(m.id, half) != null);
  const colParts = [];
  activeMachines
    .forEach((m) => {
      const cur = currentOf(m.id);
      const lots = columnLots(m.id, half);
      const upcoming = lots.filter(
        (l) => l.status === 'pending' && !l.secondMarket && (cur == null || !isPassed(l, cur))
      );
      const next = upcoming[0] || null;
      const title = columnTitle(m, half);
      const waiting = cur == null;
      const curLabel = waiting ? '等待開始' : String(cur);
      const ser = cur != null ? seriesOf(cur, half) : null;
      const startN = displayStartOf(m.id, half);
      const infoLabel = liveInfoLabel(startN);
      const jumpN = jumpTargetOf(m.id, half);
      const jumpBtn = jumpN != null
        ? `<button type="button" class="jump-btn hold-btn" data-act="jump-next" data-hold="jump-next" data-id="${m.id}" aria-label="按住跳到 ${jumpN}"><span class="jump-btn-lbl">跳到</span><span class="jump-btn-num">${jumpN}</span></button>`
        : '';
      const jumpSlot = anyJump
        ? `<div class="jump-slot">${jumpBtn}</div>`
        : '';
      const cellHtmls = lots.length
        ? lots
            .map((l) => {
              const over = isPassed(l, cur) || (l.status === 'pending' && l.secondMarket && cur != null && isPassed({ ...l, secondMarket: false }, cur));
              const isNext = next && l.id === next.id;
              const lotSer = seriesOf(l.number, half);
              const pathStart = ser ? seriesStart(m.id, half, ser) : null;
              const d = (cur != null && l.status === 'pending' && !l.secondMarket && ser && lotSer && ser.key === lotSer.key)
                ? segmentDist(cur, l.number, pathStart, ser)
                : null;
              const near = d != null && d >= 0 && d <= gapN;
              const prio = lotPriority(l);
              let cls = `lot-cell prio-${prio}${peelClass(l.item)}`;
              if (typeof lotHasRemoteFlash === 'function' && lotHasRemoteFlash(l.id)) cls += ' remote-flash';
              if (l.status === 'moved') cls += ' moved';
              else if (l.status === 'won') cls += ' won';
              else if (l.status === 'lost') cls += ' lost';
              else if (l.status === 'flow') cls += ' flow';
              else if (over) cls += ' passed';
              if (isNext) cls += ' next';
              if (l.status === 'lost') cls += ' strike';
              let badge = '';
              if (d === 0) badge = '<span class="cell-badge now">到</span>';
              const eta = lotEtaLabel(l, cur);
              const etaHtml = eta ? `<span class="eta-badge">${escapeHtml(eta)}</span>` : '';
              const movedMark = l.status === 'moved' ? '<span class="moved-mark">搬</span>' : '';
              const er = l.secondMarket ? '<span class="er-mark">二</span>' : '';
              const sz = l.item && itemNeedsSize(l.item) ? sizeLabel(l.size, l.item) : '';
              const size = itemNeedsSize(l.item) && l.item
                ? `<span class="size-badge${sz ? ' on s-' + sz : ' empty'}" data-act="cycle-size" data-id="${escapeHtml(l.id)}">${sz || '規'}</span>`
                : '';
              const item = l.item
                ? `<span class="cell-item"><span class="cell-item-name">${escapeHtml(itemCellName(l.item))}</span></span>`
                : '<span class="cell-item dim"></span>';
              return `<button type="button" class="${cls}" data-act="cycle-lot" data-id="${escapeHtml(l.id)}">
                <span class="prio-hit" data-act="cycle-prio" data-id="${escapeHtml(l.id)}">
                  <span class="prio-bar"></span>
                  <span class="prio-stack">
                    <span class="prio-tag">${prioShort(prio)}</span>
                    ${movedMark}
                  </span>
                </span>
                <span class="cell-main">
                  <span class="cell-top">
                    ${lotNumHtml(l, { numClass: 'cell-num' })}
                    ${etaHtml}
                  </span>
                  <span class="cell-item-row">${item}<span class="cell-end">${size}<span class="cell-flags">${badge}${er}</span></span></span>
                </span>
              </button>`;
            })
        : null;
      const head = `<div class="live-col-head">
          <div class="col-name">${escapeHtml(title)}</div>
        </div>`;
      const foot = `<div class="live-col-foot hand-${thumbHand()}" data-stop="1">
          <button type="button" class="live-cur hold-btn" data-act="edit-cur" data-hold="set-start" data-id="${m.id}" aria-label="輸入現在進度，長按設定這段起點">
            <span class="cur-now-row${waiting ? ' waiting' : ''}">
              ${waiting ? '' : '<span class="cur-now-lbl">現在</span>'}
              <span class="cur-now-num${waiting ? ' waiting' : ''}">${curLabel}</span>
            </span>
            <span class="live-info-lbl${infoLabel ? '' : ' empty'}">${infoLabel ? escapeHtml(infoLabel) : ''}</span>
          </button>
          <div class="live-cur-row">
            <button type="button" class="cur-step" data-act="bump" data-id="${m.id}" data-d="-1" aria-label="進度減一">−</button>
            <button type="button" class="cur-step" data-act="bump" data-id="${m.id}" data-d="1" aria-label="進度加一">＋</button>
          </div>
          <div class="live-foot-actions">
            <button type="button" class="xfer-btn" data-act="open-xfer" data-id="${m.id}">轉台</button>
            <button type="button" class="start-btn" data-act="open-start" data-id="${m.id}">起始</button>
          </div>
          ${jumpSlot}
        </div>`;
      colParts.push({
        id: m.id,
        head,
        ids: lots.map((l) => l.id),
        cells: cellHtmls,
        foot,
      });
    });
  const cols = colParts
    .map((c) => {
      const cells = c.cells ? c.cells.join('') : '<div class="col-empty">還沒抄號</div>';
      return `<section class="live-col" data-id="${c.id}">
        ${c.head}
        <div class="live-col-list" data-id="${c.id}">${cells}</div>
        ${c.foot}
      </section>`;
    })
    .join('');


  const empty = allToday.length === 0
    ? '<div class="live-empty">到「抄號」把紙上的號碼存進來，各台會並排顯示。</div>'
    : '';

  const barHtml = `<div class="live-bar">
        <div class="live-counts">
          <span class="must-count${mustLeft ? ' on' : ''}"><b>${mustLeft}</b>美</span>
          <span><b>${won}</b>標到</span>
          ${unmovedPieces ? `<span class="unmoved-count"><b>${unmovedPieces}</b>未搬</span>` : ''}
          <span${lost ? '' : ' class="zero-count"'}><b>${lost}</b>沒標到</span>
          <span${second.length ? '' : ' class="zero-count"'}><b>${second.length}</b>二市</span>
        </div>
        ${half === 'fruit' && (state.machines.fruit || []).length < 2
          ? '<button type="button" class="live-sheet-btn" data-act="add-machine" data-half="fruit">＋第二台</button>'
          : ''}
        <button type="button" class="live-sheet-btn" data-act="open-second">清單</button>
      </div>`;
  const html = `
    <div class="live-screen">
      ${barHtml}
      <div class="live-cols" data-n="${activeMachines.length}">${cols || '<div class="empty-hint">請先在設定裡確認台別</div>'}</div>
      ${empty}
    </div>`;
  liveParts = { html, bar: barHtml, n: activeMachines.length, empty, cols: colParts };
  return html;
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
      const adoptBtn = half === 'afternoon' && typeof afternoonRangesAreDefault === 'function' && !afternoonRangesAreDefault()
        ? '<button type="button" class="btn primary adopt-afternoon-btn" data-act="adopt-afternoon-ranges">改用新的下半場號碼</button><p class="empty-hint" style="text-align:left;padding:8px 0 0;line-height:1.45">第二台從 2500 開始，第三台從 2000 開始，第一台每天 50xx 不一定，先留空。不會改已經抄進來的號碼。</p>'
        : '';
      const heading = half === 'fruit' ? `${halfLabel(half)}　台別（1–2 台）` : `${halfLabel(half)}　三台號碼`;
      return `<div class="setting-block"><h2>${heading}</h2>${sub}${editors}${addBtn}${adoptBtn}</div>`;
    })
    .join('');

  return `
    <div class="setting-block version-block">
      <div class="version-big">版本 ${escapeHtml(APP_VERSION)}</div>
      ${updateInfo.latest && versionNumOf(updateInfo.latest) > versionNumOf(APP_VERSION) ? `<p class="version-new">有新版本 ${escapeHtml(updateInfo.latest)}，請按下面更新</p>` : (updateInfo.checkedAt ? `<p class="version-ok">已是最新版（${escapeHtml(updateInfo.checkedLabel)} 檢查）</p>` : '')}
      <button type="button" class="btn version-check-btn" data-act="check-update">${updateInfo.busy ? '檢查中…' : '檢查更新'}</button>
    </div>
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
        <div><div class="lbl">四碼自動存</div><div class="sub">貨號滿四碼就立刻存下（還不必選品項），接著抄下一號。點品項也可以把已輸入的號碼一起存下。</div></div>
        <button type="button" class="toggle${state.autoSave4 ? ' on' : ''}" data-act="toggle-autosave"><i></i></button>
      </div>
      <div class="switch-row">
        <div><div class="lbl">振動回饋</div><div class="sub">存號、標到、流標、復原，以及追蹤接近時會振動</div></div>
        <button type="button" class="toggle${state.vibrate ? ' on' : ''}" data-act="toggle-vibrate"><i></i></button>
      </div>
      <div class="switch-row">
        <div><div class="lbl">保持螢幕亮著</div><div class="sub">開著 App 時不讓螢幕休眠（裝置不支援會自動略過）</div></div>
        <button type="button" class="toggle${state.keepAwake ? ' on' : ''}" data-act="toggle-awake"><i></i></button>
      </div>
      <div class="switch-row hand-row">
        <div><div class="lbl">備註按鈕位置</div><div class="sub">左手放左下，右手放右下，單手拇指比較好按</div></div>
        <div class="hand-seg" role="group" aria-label="備註按鈕位置">
          <span class="seg-indicator" aria-hidden="true"></span>
          <button type="button" class="${thumbHand() === 'left' ? 'on' : ''}" data-act="set-hand" data-v="left">左手</button>
          <button type="button" class="${thumbHand() === 'right' ? 'on' : ''}" data-act="set-hand" data-v="right">右手</button>
        </div>
      </div>
      <div class="switch-row">
        <div><div class="lbl">新的一天開始時間</div><div class="sub">過了這個時間就自動進入下一場拍賣日，預設下午 3 點</div></div>
        <select id="day-cutoff" class="cutoff-select" data-act="day-cutoff" aria-label="新的一天開始時間">
          ${Array.from({ length: 24 }, (_, h) => {
            const sel = dayCutoffHour() === h ? ' selected' : '';
            return `<option value="${h}"${sel}>${cutoffHourLabel(h)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="switch-row">
        <div><div class="lbl">自動前跳</div><div class="sub">用「現在」或加減設定後，會依拍賣速度自動往前跳。只會移動現在進度，不會自動把貨標成標到或沒標到。不想自動跳時可在這裡關掉。</div></div>
        <button type="button" class="toggle${autoAdvanceOn() ? ' on' : ''}" data-act="toggle-auto-advance"><i></i></button>
      </div>
      <div class="switch-row gp-row">
        <div><div class="lbl">全市場共用拍賣進度</div><div class="sub">「現在拍到幾號」大家一起用：不管哪一組，誰更新都會一起顯示。只分享號碼，抄號、標到、備註不會分享出去。</div><div class="sub gp-status" id="gp-status">${escapeHtml(typeof gpStatusLabel === 'function' ? gpStatusLabel() : '')}</div></div>
        <button type="button" class="toggle${state.globalProgress !== false ? ' on' : ''}" data-act="toggle-global-progress"><i></i></button>
      </div>
      <div class="switch-row">
        <div><div class="lbl">拍賣速度</div><div class="sub">每分鐘大概跳幾號，用來自動前跳，也用來估算還要幾分鐘輪到。預設每分鐘 4 號。</div></div>
        <select id="lots-per-min" class="cutoff-select" data-act="lots-per-min" aria-label="拍賣速度，每分鐘幾號">
          ${[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => {
            const sel = lotsPerMin() === n ? ' selected' : '';
            return `<option value="${n}"${sel}>每分鐘 ${n} 號</option>`;
          }).join('')}
        </select>
      </div>
    </div>
    ${halfBlocks}
    ${renderItemOrderSettings()}
    ${HALVES.map((half) => {
      const title = half === 'fruit' ? '水果場品項（水果）'
        : half === 'afternoon' ? '下半場品項（瓜果、醃製；芋頭、蒜、青花、花椰菜、竹筍等屬瓜果）'
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
      <button type="button" class="btn primary" style="width:100%;margin-bottom:10px" data-act="open-summary">今日總結</button>
      <button type="button" class="btn danger" style="width:100%" data-act="new-day">開始新的一天（清空抄號）</button>
    </div>
    <p class="empty-hint app-version">版本 ${escapeHtml(APP_VERSION)}</p>
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
          <div id="paddle-code">${[...code].map((d) => `<span>${escapeHtml(d)}</span>`).join('')}</div>
        </div>
        <div id="paddle-hint">連點兩下螢幕返回　${themeLabel(theme)}</div>
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
  if (modal.type === 'sync-name' && typeof renderSyncNameModal === 'function') return renderSyncNameModal();
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
  if (modal.type === 'plan-qty') {
    const item = (state.planItems || []).find((p) => p.id === modal.id);
    const val = modal.value != null ? String(modal.value) : (item ? String(planQtyOf(item)) : '');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
    const keypad = keys
      .map((k) => {
        if (k === '⌫') return `<button type="button" class="key muted" data-act="plan-qty-back">⌫</button>`;
        if (k === 'C') return `<button type="button" class="key muted" data-act="plan-qty-clear">清除</button>`;
        return `<button type="button" class="key" data-act="plan-qty-digit" data-v="${k}">${k}</button>`;
      })
      .join('');
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet plan-qty-sheet" data-stop="1">
        <h3>件數${item ? '　' + escapeHtml(item.text) : ''}</h3>
        <div class="lot-display plan-qty-display" aria-live="polite">
          <div class="num${val ? '' : ' empty'}" id="plan-qty-readout">${val ? escapeHtml(val) : '--'}</div>
        </div>
        <div class="keypad">${keypad}</div>
        <p class="empty-hint">輸入 0 再按確定會刪掉這一列，可再按復原。</p>
        <button type="button" class="plan-qty-delete" data-act="plan-qty-delete" data-id="${escapeHtml(modal.id)}">刪除這一列</button>
        <div class="sheet-actions">
          <button type="button" class="btn" data-act="modal-cancel">取消</button>
          <button type="button" class="btn primary" data-act="plan-qty-ok">確定</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'edit-cur' || editCurrent) {
    const ed = editCurrent;
    if (!ed) return '';
    const m = machineById(ed.machineId);
    const nextSeg = nextSegmentOf(ed.machineId, state.currentHalf);
    const jumpRow = nextSeg
      ? `<button type="button" class="btn jump-sheet-btn" data-act="ec-jump" data-id="${escapeHtml(ed.machineId)}">這段拍完　跳到 ${jumpTargetOf(ed.machineId, state.currentHalf) ?? nextSeg.start}</button>`
      : '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
    const keypad = keys
      .map((k) => {
        if (k === '⌫') return `<button type="button" class="key muted" data-act="ec-back">⌫</button>`;
        if (k === 'C') return `<button type="button" class="key muted" data-act="ec-clear">清除</button>`;
        return `<button type="button" class="key" data-act="ec-digit" data-v="${k}">${k}</button>`;
      })
      .join('');
    return `<div class="overlay" data-act="ec-cancel">
      <div class="sheet cur-sheet hand-${thumbHand()}" data-stop="1">
        <h3>現在拍到哪一號？</h3>
        <p>${escapeHtml(m?.name || '')}　直接輸入號碼。若這段已結束，輸入下一段第一號，例如 6080。長按「現在」可改這段起點。</p>
        <div class="lot-display"><div class="num${ed.value ? '' : ' empty'}">${ed.value ? escapeHtml(ed.value) : '----'}</div></div>
        ${jumpRow}
        <div class="keypad">${keypad}</div>
        <div class="sheet-actions">
          <button type="button" class="btn primary" data-act="ec-ok">確定</button>
          <button type="button" class="btn" data-act="ec-cancel">取消</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'set-start' || editStart) {
    const ed = editStart;
    if (!ed) return '';
    const m = machineById(ed.machineId, ed.half);
    const chipStarts = [];
    for (const r of (m && m.ranges) || []) {
      if (r && r.start != null && Number.isFinite(Number(r.start)) && !chipStarts.includes(Number(r.start))) {
        chipStarts.push(Number(r.start));
      }
    }
    const startChips = chipStarts.length
      ? `<div class="start-chips" role="group" aria-label="常用起點">${chipStarts.map((n) =>
        `<button type="button" class="start-chip${ed.focus !== 'jump' && String(ed.value) === String(n) ? ' on' : ''}" data-act="ss-chip" data-v="${n}">${n}</button>`).join('')}</div>`
      : '';
    const jumpSeg = upcomingJumpSegment(ed.machineId, ed.half);
    const jumpChips = jumpSeg
      ? `<div class="start-chips" role="group" aria-label="常用跳到">${[jumpSeg.start].map((n) =>
        `<button type="button" class="start-chip${ed.focus === 'jump' && String(ed.jumpValue) === String(n) ? ' on' : ''}" data-act="ss-jump-chip" data-v="${n}">${n}</button>`).join('')}</div>`
      : '';
    const focus = ed.focus === 'jump' ? 'jump' : 'start';
    const jumpField = jumpSeg
      ? `<div class="start-jump-fields">
          <button type="button" class="start-field${focus === 'start' ? ' on' : ''}" data-act="ss-focus" data-v="start">
            <span class="start-field-lbl">起始</span>
            <span class="num${ed.value ? '' : ' empty'}">${ed.value ? escapeHtml(ed.value) : '----'}</span>
          </button>
          <button type="button" class="start-field${focus === 'jump' ? ' on' : ''}" data-act="ss-focus" data-v="jump">
            <span class="start-field-lbl">跳到</span>
            <span class="num${ed.jumpValue ? '' : ' empty'}">${ed.jumpValue ? escapeHtml(String(ed.jumpValue)) : '----'}</span>
          </button>
        </div>
        <p class="empty-hint" style="text-align:left;padding:0 0 8px;line-height:1.45">跳到可設 ${jumpSeg.lo}–${jumpSeg.hi}，例如 ${jumpSeg.start} 或 ${jumpSeg.key === '6xxx' ? '6150' : (jumpSeg.key === '5xxx' ? '5150' : jumpSeg.start)}。輸入完整四位數。</p>`
      : `<div class="lot-display"><div class="num${ed.value ? '' : ' empty'}">${ed.value ? escapeHtml(ed.value) : '----'}</div></div>`;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
    const keypad = keys
      .map((k) => {
        if (k === '⌫') return `<button type="button" class="key muted" data-act="ss-back">⌫</button>`;
        if (k === 'C') return `<button type="button" class="key muted" data-act="ss-clear">清除</button>`;
        return `<button type="button" class="key" data-act="ss-digit" data-v="${k}">${k}</button>`;
      })
      .join('');
    return `<div class="overlay" data-act="ss-cancel">
      <div class="sheet cur-sheet hand-${thumbHand()}" data-stop="1">
        <h3>這台今天從幾號開始？</h3>
        <p>${escapeHtml(m?.name || '')}　起點每天不一定，例如 5001 或 5150。起點前面的號碼會排在後面。</p>
        ${jumpField}
        ${focus === 'jump' ? jumpChips : startChips}
        <div class="keypad">${keypad}</div>
        <div class="sheet-actions">
          <button type="button" class="btn primary" data-act="ss-ok">確定</button>
          <button type="button" class="btn" data-act="ss-cancel">取消</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'xfer') {

    const half = modal.half || state.currentHalf;
    const srcId = modal.srcId;
    const cands = modal.candidates || [];
    const empty = modal.empty;
    const others = (state.machines[half] || []).filter((m) => m.id !== srcId);
    const destBtns = others.length
      ? others.map((m) => `<button type="button" class="btn primary xfer-dest" data-act="xfer-to" data-id="${escapeHtml(m.id)}">轉到${escapeHtml(columnTitle(m, half))}</button>`).join('')
      : '<p>沒有其他台可以轉。</p>';
    if (empty && !cands.length) {
      return `<div class="overlay" data-act="modal-cancel">
        <div class="sheet" data-stop="1">
          <h3>轉台</h3>
          <p>${escapeHtml(empty)}</p>
          <div class="sheet-actions">
            <button type="button" class="btn" data-act="modal-cancel">知道了</button>
          </div>
        </div>
      </div>`;
    }
    if (!modal.candKey && cands.length > 1) {
      const rangeBtns = cands.map((c) => (
        `<button type="button" class="btn primary xfer-dest" data-act="xfer-pick" data-key="${escapeHtml(c.key)}">${escapeHtml(c.label)} 未拍 ${c.count} 筆</button>`
      )).join('');
      return `<div class="overlay" data-act="modal-cancel">
        <div class="sheet" data-stop="1">
          <h3>轉台</h3>
          <p>要轉哪一段？這是各段起點前面還沒拍的號碼。</p>
          <div class="sheet-actions" style="flex-direction:column;gap:10px">${rangeBtns}
            <button type="button" class="btn" data-act="modal-cancel">取消</button>
          </div>
        </div>
      </div>`;
    }
    const cand = cands.find((c) => c.key === modal.candKey) || cands[0];
    const head = cand
      ? (cand.label + ' 未拍 ' + cand.count + ' 筆 移到哪一台？')
      : '移到哪一台？';
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet" data-stop="1">
        <h3>轉台</h3>
        <p>${escapeHtml(head)}</p>
        <div class="sheet-actions" style="flex-direction:column;gap:10px">${destBtns}
          <button type="button" class="btn" data-act="modal-cancel">取消</button>
        </div>
      </div>
    </div>`;
  }
  if (modal.type === 'lot-actions') {
    const lot = state.lots.find((l) => l.id === modal.id);
    if (!lot) return '';
    const undoMark = lot.status === 'moved'
      ? `<button type="button" class="action-btn" data-act="unmove-lot" data-id="${escapeHtml(lot.id)}">取消已搬貨</button>
         <button type="button" class="action-btn" data-act="undo-mark" data-id="${escapeHtml(lot.id)}">取消標到</button>`
      : lot.status === 'won'
      ? `<button type="button" class="action-btn" data-act="undo-mark" data-id="${escapeHtml(lot.id)}">取消標到</button>`
      : lot.status === 'flow'
        ? `<button type="button" class="action-btn" data-act="undo-mark" data-id="${escapeHtml(lot.id)}">取消流標</button>`
        : lot.status === 'lost'
          ? `<button type="button" class="action-btn" data-act="undo-mark" data-id="${escapeHtml(lot.id)}">改回未拍</button>`
          : '';
    const lostBtn = lot.status === 'won' || lot.status === 'moved'
      ? `<button type="button" class="action-btn" data-act="mark-lost" data-id="${escapeHtml(lot.id)}">沒標到</button>`
      : '';
    const flowBtn = lot.status === 'flow'
      ? ''
      : `<button type="button" class="action-btn flow hold-btn" data-act="mark-flow" data-hold="flow" data-id="${escapeHtml(lot.id)}">流標（按住）<small>沒人買，算流標並轉二市</small></button>`;
    const secondBtn = lot.status === 'flow'
      ? ''
      : lot.secondMarket
        ? `<button type="button" class="action-btn" data-act="from-second" data-id="${escapeHtml(lot.id)}">移回（取消轉二市）</button>`
        : isWon(lot)
          ? ''
          : `<button type="button" class="action-btn" data-act="to-second" data-id="${escapeHtml(lot.id)}">直接轉二市<small>不算流標，只是先放二市</small></button>`;
    const qty = lotQty(lot);
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet action-sheet" data-stop="1">
        <h3>${lotLabelHtml(lot)}</h3>
        <p>${escapeHtml(machineNameOf(lot))}${lot.item ? '　' + escapeHtml(itemDisplayName(lot.item)) : ''}${lotByHtml(lot)}</p>
        <div class="lot-qty-row" aria-label="件數">
          <span class="lot-qty-label">件數</span>
          <button type="button" class="plan-qty-btn" data-act="lot-qty-dec" data-id="${escapeHtml(lot.id)}" aria-label="減少件數">−</button>
          <span class="lot-qty-val">${qty}</span>
          <span class="lot-qty-unit">件</span>
          <button type="button" class="plan-qty-btn" data-act="lot-qty-inc" data-id="${escapeHtml(lot.id)}" aria-label="增加件數">＋</button>
        </div>
        <button type="button" class="action-btn" data-act="edit-subcode" data-id="${escapeHtml(lot.id)}">${lotSubCode(lot) ? lotSubCode(lot) + '（改或清除）' : '註記小代碼'}</button>
        <div class="prio-toggle sheet-prio" role="group" aria-label="美普交貨">
          <span class="seg-indicator" aria-hidden="true"></span>
          ${['must', 'watch', 'skip'].map((p) => {
            const on = lotPriority(lot) === p ? ' on' : '';
            return `<button type="button" class="prio-${p}${on}" data-act="set-prio" data-id="${escapeHtml(lot.id)}" data-v="${p}">${prioLabel(p)}</button>`;
          }).join('')}
        </div>
        ${itemNeedsSize(lot.item) ? renderSizeChips(lot.size || '', { lotId: lot.id, item: lot.item, sheet: true }) : ''}
        <button type="button" class="action-btn" data-act="pick-lot-item" data-id="${escapeHtml(lot.id)}">改品項</button>
        ${undoMark}
        ${lostBtn}
        ${flowBtn}
        <div class="move-lot-row">
          <div class="move-lot-label">移到別台</div>
          ${state.machines[lot.half || state.currentHalf].filter((m) => m.id !== lot.machineId).map((m) =>
            `<button type="button" class="action-btn" data-act="move-lot" data-id="${escapeHtml(lot.id)}" data-v="${escapeHtml(m.id)}">移到${escapeHtml(columnTitle(m, lot.half || state.currentHalf))}</button>`
          ).join('')}
        </div>
        <button type="button" class="action-btn go-here-btn" data-act="go-here" data-id="${escapeHtml(lot.id)}">設為現在進度</button>
        ${secondBtn}
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
  if (modal.type === 'subcode') {
    const lot = state.lots.find((l) => l.id === modal.id);
    if (!lot) return '';
    const val = String(modal.value || '');
    const existing = lotSubCode(lot);
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
    const keypad = keys
      .map((k) => {
        if (k === '⌫') return `<button type="button" class="key muted" data-act="sc-back">⌫</button>`;
        if (k === 'C') return `<button type="button" class="key muted" data-act="sc-clear">清除</button>`;
        return `<button type="button" class="key" data-act="sc-digit" data-v="${k}">${k}</button>`;
      })
      .join('');
    const erase = existing
      ? `<button type="button" class="btn" data-act="sc-erase" data-id="${escapeHtml(lot.id)}">清除小代碼</button>`
      : '';
    return `<div class="overlay" data-act="modal-cancel">
      <div class="sheet subcode-sheet hand-${thumbHand()}" data-stop="1">
        <h3>小代碼</h3>
        <p>${escapeHtml(String(lot.number))}${lot.item ? '　' + escapeHtml(itemDisplayName(lot.item)) : ''}　${escapeHtml(machineNameOf(lot))}</p>
        <div class="lot-display"><div class="num${val ? '' : ' empty'}">${val ? escapeHtml(val) : '---'}</div></div>
        <p class="empty-hint">輸入三碼就會存下，不必再按確定。</p>
        <div class="keypad">${keypad}</div>
        <div class="sheet-actions">${erase}<button type="button" class="btn" data-act="modal-cancel">取消</button></div>
      </div>
    </div>`;
  }
    if (modal.type === 'second-sheet') {
    const second = secondLots();
    const allToday = state.lots.filter((l) => l.day === state.day);
    const won = allToday.filter((l) => isWon(l)).length;
    const lost = allToday.filter((l) => l.status === 'lost').length;
    const list = second.length
      ? second.map((l) => {
          const tag = l.status === 'flow' ? '流標・二市' : (l.status === 'lost' ? '沒標到轉入' : '過號轉入');
          return `<div class="second-item">
            <div>
              <div class="ln">${lotLabelHtml(l)}</div>
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
          <span${lost ? '' : ' class="zero-count"'}><b>${lost}</b>沒標到</span>
          <span${second.length ? '' : ' class="zero-count"'}><b>${second.length}</b>二市</span>
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
const PADDLE_DOUBLE_MS = 400;
const PADDLE_DOUBLE_SLOP = 100;
let paddleTapPrimed = null;
let paddleTapStroke = null;
let paddleClickShieldUntil = 0;

function isPaddleThemeTarget(t) {
  return !!(t && t.closest && t.closest('#paddle [data-act="cycle-theme"]'));
}

function resetPaddleTaps() {
  paddleTapPrimed = null;
  paddleTapStroke = null;
}

function onPaddleExitPointerDown(e) {
  if (!paddleOpen) return;
  if (e.button != null && e.button !== 0) return;
  if (isPaddleThemeTarget(e.target)) {
    paddleTapStroke = null;
    return;
  }
  // Fullscreen: count the tap even if hit-testing misses #paddle
  // (css-landscape rotate + overflow can retarget to <html>).
  const p = eventPoint(e);
  paddleTapStroke = { id: p.id, x: p.x, y: p.y, ok: true };
}

function onPaddleExitPointerMove(e) {
  if (!paddleTapStroke || !paddleTapStroke.ok) return;
  const p = eventPoint(e);
  if (paddleTapStroke.id != null && p.id != null && p.id !== paddleTapStroke.id) return;
  const dx = p.x - paddleTapStroke.x;
  const dy = p.y - paddleTapStroke.y;
  if (dx * dx + dy * dy > PADDLE_DOUBLE_SLOP * PADDLE_DOUBLE_SLOP) paddleTapStroke.ok = false;
}

function onPaddleExitPointerUp(e) {
  if (e.type === 'pointercancel' || e.type === 'touchcancel') {
    paddleTapStroke = null;
    return;
  }
  if (!paddleOpen) {
    resetPaddleTaps();
    return;
  }
  if (isPaddleThemeTarget(e.target)) {
    paddleTapStroke = null;
    return;
  }
  const stroke = paddleTapStroke;
  paddleTapStroke = null;
  if (!stroke || !stroke.ok) {
    paddleTapPrimed = null;
    return;
  }
  const p = eventPoint(e);
  const now = Date.now();
  const prev = paddleTapPrimed;
  paddleTapPrimed = { t: now, x: p.x, y: p.y };
  if (prev && now - prev.t <= PADDLE_DOUBLE_MS) {
    const dx = (p.x - prev.x);
    const dy = (p.y - prev.y);
    if (dx * dx + dy * dy <= PADDLE_DOUBLE_SLOP * PADDLE_DOUBLE_SLOP) {
      resetPaddleTaps();
      paddleClickShieldUntil = now + 400;
      if (e.cancelable) e.preventDefault();
      exitPaddle();
    }
  }
}

function onClick(e) {
  if (Date.now() < paddleClickShieldUntil) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const t = e.target;

  if (paddleOpen) {
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'cycle-theme') {
      e.preventDefault();
      e.stopPropagation();
      cyclePaddleTheme();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
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

  const DISMISS_TOAST_ON_INPUT = {
    digit: 1, back: 1, clear: 1,
    'edit-cur': 1, 'open-start': 1,
    'ss-digit': 1, 'ss-back': 1, 'ss-clear': 1, 'ss-chip': 1, 'ss-jump-chip': 1, 'ss-focus': 1,
    'ec-digit': 1, 'ec-back': 1, 'ec-clear': 1,
    'plan-qty-digit': 1, 'plan-qty-back': 1, 'plan-qty-clear': 1, 'plan-qty-edit': 1,
    'setup-digit': 1, 'setup-back': 1, 'setup-clear': 1
  };
  if (DISMISS_TOAST_ON_INPUT[act]) dismissActionToast();

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
      buzz(10);
      break;
    case 'unlock-item':
      unlockItem();
      break;
    case 'range-start':
      enterRangeMode();
      buzz(8);
      break;
    case 'range-focus':
      if (v === 'start' || v === 'end') {
        rangeFocus = v;
        render();
      }
      break;
    case 'range-cancel':
      exitRangeMode();
      render();
      break;
    case 'range-ok':
      openRangeConfirm();
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
      if (ignoreRecentClick) { ignoreRecentClick = false; break; }
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
    case 'reset-item-order':
      resetItemOrder(btn.dataset.half || '', btn.dataset.group || '');
      render();
      break;
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
    case 'toggle-global-progress':
      if (typeof setGlobalProgressOn === 'function') setGlobalProgressOn(state.globalProgress === false);
      else state.globalProgress = state.globalProgress === false;
      saveState();
      render();
      break;
    case 'toggle-auto-advance':
      state.autoAdvance = !autoAdvanceOn();
      if (!state.autoAdvance) {
        for (const half of HALVES) {
          for (const m of state.machines[half] || []) {
            const a = getAnchor(m.id, half);
            if (a && !a.paused && a.number != null && a.at != null) {
              const cur = currentOf(m.id, half);
              if (!state.currentNumbers[half]) state.currentNumbers[half] = {};
              state.currentNumbers[half][m.id] = cur;
              writeAnchor(m.id, half, { number: cur, at: nowDate().getTime(), paused: true, ended: !!a.ended });
            }
          }
        }
      } else {
        ensureAutoAnchors();
      }
      saveState();
      syncProgressTimer();
      render();
      break;
    case 'toggle-note':
    case 'open-summary':
      showSettings = false;
      modal = null;
      openDaySummary();
      break;
    case 'close-summary':
      closeDaySummary();
      break;
    case 'share-summary':
      shareDaySummary();
      break;
    case 'sum-add-plan':
      addUnplannedToPlan(btn.dataset.ids);
      break;
    case 'copy-summary':
      copyResults(daySummaryText());
      break;
    case 'lot-qty-inc':
      setLotQty(btn.dataset.id, 1);
      break;
    case 'lot-qty-dec':
      setLotQty(btn.dataset.id, -1);
      break;
    case 'undo-mark':
      modal = null;
      undoLotMark(btn.dataset.id);
      break;
    case 'mark-lost':
      modal = null;
      markLost(btn.dataset.id);
      break;
    case 'unmove-lot':
      modal = null;
      unmoveLot(btn.dataset.id);
      break;
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
      addOrBumpPlanItem(v);
      break;
    case 'plan-tap-item':
      addOrBumpPlanItem(btn.dataset.name);
      break;
    case 'plan-open-size': {
      const crop = findCrop(btn.dataset.crop);
      if (crop) {
        planVariantPick = { kind: 'size', crop };
        planGridOpen = true;
        render();
      }
      break;
    }
    case 'plan-open-vars': {
      const crop = findCrop(btn.dataset.crop);
      if (crop) {
        planVariantPick = { kind: 'vars', crop };
        planGridOpen = true;
        render();
      }
      break;
    }
    case 'plan-close-vars':
      planVariantPick = null;
      render();
      break;
    case 'plan-grid-tab':
      planGridTab = v || 'bulk';
      planVariantPick = null;
      planGridOpen = true;
      planGridScroll = 0;
      render();
      break;
    case 'toggle-plan-grid':
      planGridOpen = !planGridOpen;
      if (planGridOpen) planVariantPick = null;
      render();
      break;
    case 'plan-qty-edit':
      openPlanQtyEdit(btn.dataset.id);
      break;
    case 'plan-qty-digit':
      applyPlanQtyDigit(v);
      break;
    case 'plan-qty-back':
      if (modal && modal.type === 'plan-qty') {
        modal.value = String(modal.value || '').slice(0, -1);
        render();
      }
      break;
    case 'plan-qty-clear':
      if (modal && modal.type === 'plan-qty') {
        modal.value = '';
        render();
      }
      break;
    case 'plan-qty-ok':
      commitPlanQtyEdit();
      break;
    case 'plan-qty-delete': {
      const id = (modal && modal.type === 'plan-qty' && modal.id) || btn.dataset.id;
      modal = null;
      if (id) deletePlanItem(id);
      else render();
      break;
    }
    case 'plan-done':
      setPlanDone(btn.dataset.id, true);
      break;
    case 'plan-undone':
      setPlanDone(btn.dataset.id, false);
      break;
    case 'plan-del':
      deletePlanItem(btn.dataset.id);
      break;
    case 'plan-purpose':
      togglePlanPurpose(btn.dataset.id);
      break;
    case 'plan-clear':
      confirmClearPlans(v || 'all');
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
      if (showSettings) checkForUpdate(false);
      render();
      break;
    case 'check-update':
      checkForUpdate(true);
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
    case 'edit-subcode':
      e.stopPropagation();
      if (ignoreLotClick || dragState) {
        ignoreLotClick = false;
        break;
      }
      openSubCodeEditor(btn.dataset.id);
      break;
    case 'sc-digit':
      typeSubCodeDigit(v);
      buzz(8);
      break;
    case 'sc-back':
      backspaceSubCode();
      break;
    case 'sc-clear':
      clearSubCodeDraft();
      break;
    case 'sc-erase':
      eraseLotSubCode(btn.dataset.id || (modal && modal.id));
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
      buzz(10);
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
      if (ignoreHoldClick) { ignoreHoldClick = false; break; }
      toast('按住不放才會流標');
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
      requestSegAnim();
      if (state.currentHalf !== v) buzz(10);
      state.currentHalf = v;
      draftMachineId = '';
      showMachinePicker = false;
      progressPopId = null;
      draftItem = '';
      draftSize = '';
      itemLocked = false;
      rangeMode = false;
      rangeStart = '';
      rangeEnd = '';
      rangeFocus = 'start';
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
        value: currentOf(btn.dataset.id) != null ? String(currentOf(btn.dataset.id)) : '',
        fresh: currentOf(btn.dataset.id) != null
      };
      modal = { type: 'edit-cur' };
      render();
      break;
    case 'open-xfer':
      openXfer(btn.dataset.id);
      break;
    case 'xfer-pick':
      pickXferRange(btn.dataset.key);
      break;
    case 'xfer-to':
      confirmXfer(modal && modal.srcId, btn.dataset.id, modal && modal.candKey);
      break;
    case 'adopt-afternoon-ranges':
      modal = {
        type: 'confirm',
        title: '改用新的下半場號碼？',
        body: '第二台從 2500 開始，第三台從 2000 開始，第一台先留空（每天 50xx 不一定）。已抄的號碼不會改。',
        ok: '改用新號碼',
        cancel: '取消',
        onOk: () => adoptNewAfternoonRanges()
      };
      render();
      break;
    case 'open-start':
      openSetStart(btn.dataset.id);
      break;
    case 'ss-focus':
      if (editStart) {
        editStart.focus = v === 'jump' ? 'jump' : 'start';
        render();
      }
      break;
    case 'ss-digit':
      if (editStart && editStart.focus === 'jump') {
        if (editStart.jumpFresh) {
          editStart.jumpValue = v;
          editStart.jumpFresh = false;
        } else if (String(editStart.jumpValue || '').length < 4) {
          editStart.jumpValue = String(editStart.jumpValue || '') + v;
        }
        render();
      } else if (editStart && editStart.fresh) {
        editStart.value = v;
        editStart.fresh = false;
        render();
      } else if (editStart && String(editStart.value || '').length < 4) {
        editStart.value = String(editStart.value || '') + v;
        render();
      }
      break;
    case 'ss-chip':
      if (editStart && /^\d{4}$/.test(String(v || ''))) {
        editStart.value = String(v);
        editStart.fresh = true;
        editStart.focus = 'start';
        render();
      }
      break;
    case 'ss-jump-chip':
      if (editStart && /^\d{4}$/.test(String(v || ''))) {
        editStart.jumpValue = String(v);
        editStart.jumpFresh = true;
        editStart.focus = 'jump';
        render();
      }
      break;
    case 'ss-back':
      if (editStart && editStart.focus === 'jump') {
        editStart.jumpFresh = false;
        editStart.jumpValue = String(editStart.jumpValue || '').slice(0, -1);
        render();
      } else if (editStart) {
        editStart.fresh = false;
        editStart.value = String(editStart.value || '').slice(0, -1);
        render();
      }
      break;
    case 'ss-clear':
      if (editStart && editStart.focus === 'jump') {
        editStart.jumpFresh = false;
        editStart.jumpValue = '';
        render();
      } else if (editStart) {
        editStart.fresh = false;
        editStart.value = '';
        render();
      }
      break;
    case 'jump-next':
      if (ignoreHoldClick) { ignoreHoldClick = false; break; }
      toast('按住不放才會跳，號碼在『起始』裡改');
      break;
    case 'ec-jump':
      jumpToNextSegment(btn.dataset.id || (editCurrent && editCurrent.machineId));
      break;
    case 'ss-ok':
      commitSetStart();
      break;
    case 'ss-cancel':
      editStart = null;
      modal = null;
      render();
      break;
    case 'ec-digit':
      /* The number shown is the current one: the first digit typed starts a new number. */
      if (editCurrent && editCurrent.fresh) {
        editCurrent.value = v;
        editCurrent.fresh = false;
        render();
      } else if (editCurrent && editCurrent.value.length < 4) {
        editCurrent.value += v;
        render();
      }
      break;
    case 'ec-back':
      if (editCurrent) {
        editCurrent.fresh = false;
        editCurrent.value = editCurrent.value.slice(0, -1);
        render();
      }
      break;
    case 'ec-clear':
      if (editCurrent) {
        editCurrent.fresh = false;
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
    case 'toggle-awake':
      state.keepAwake = !state.keepAwake;
      saveState();
      syncWakeLock();
      render();
      break;
    case 'toggle-vibrate':
      state.vibrate = !state.vibrate;
      saveState();
      render();
      break;
    case 'set-hand':
      requestSegAnim();
      if ((v === 'right' ? 'right' : 'left') !== thumbHand()) buzz(10);
      state.thumbHand = v === 'right' ? 'right' : 'left';
      saveState();
      render();
      break;
    case 'day-cutoff':
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
  if (act === 'day-cutoff') {
    const h = Number(el.value);
    state.dayCutoffHour = (Number.isFinite(h) && h >= 0 && h <= 23) ? Math.floor(h) : DEFAULT_DAY_CUTOFF_HOUR;
    saveState();
    checkNewDay();
    render();
    return;
  }
  if (act === 'lots-per-min') {
    const n = Number(el.value);
    state.lotsPerMin = (Number.isFinite(n) && n >= 1 && n <= 12) ? Math.round(n * 10) / 10 : DEFAULT_LOTS_PER_MIN;
    reanchorRunningAtNewRate();
    saveState();
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
  if (act === 'plan-qty-type' || el.id === 'plan-qty-input') {
    if (modal && modal.type === 'plan-qty') {
      modal.value = String(el.value || '').replace(/\D/g, '').slice(0, 2);
      if (el.value !== modal.value) el.value = modal.value;
    }
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
    exitPaddle(false);
  } else if (paddleOpen) {
    requestAnimationFrame(() => {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    });
  }
}

function onVisibility() {
  syncWakeLock();
  if (document.visibilityState === 'visible') {
    pokeSWUpdate();
    maybeReloadForNewSW();
    if (typeof checkNewDay === 'function' && state && !isSetupNeeded()) {
      maybeRollAuctionDay();
    }
    if (typeof tickAutoProgress === 'function') tickAutoProgress();
  }
  if (document.visibilityState === 'visible' && paddleOpen) {
    if (orientationLocked) lockLandscape();
    requestAnimationFrame(() => {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    });
  }
}

function syncViewportHeight() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const layoutH = Math.round(window.innerHeight || root.clientHeight || 0);
  const h = Math.round((vv && vv.height) || layoutH);
  const top = Math.round((vv && vv.offsetTop) || 0);
  if (h > 0) root.style.setProperty('--app-h', h + 'px');
  root.style.setProperty('--app-top', top + 'px');
  fitKeypadSheet();
}

function fitKeypadSheet() {
  const vv = window.visualViewport;
  const h = Math.round((vv && vv.height) || window.innerHeight || 0);
  const top = Math.round((vv && vv.offsetTop) || 0);
  const root = document.documentElement;
  if (h > 0) root.style.setProperty('--app-h', h + 'px');
  root.style.setProperty('--app-top', top + 'px');
  document.querySelectorAll('#app > .overlay, .overlay').forEach((overlay) => {
    if (!overlay) return;
    overlay.style.top = (top || 0) + 'px';
    if (h > 0) {
      overlay.style.height = h + 'px';
      overlay.style.maxHeight = h + 'px';
    }
    const focused = document.activeElement;
    if (focused && focused.closest && focused.closest('.overlay') && overlay.querySelector('.keypad') && /^(INPUT|TEXTAREA)$/.test(focused.tagName)) {
      const inSearch = focused.matches('input[type="search"], input[inputmode="search"], .item-search, #plan-input, #type-item-input, #edit-item-name, #sync-name-input, #sync-join-code, #sync-settings-name');
      if (!inSearch) focused.blur();
    }
  });
}


const HOLD_MS = 350;
const ITEM_HOLD_MS = 400;
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
  if (pressOrigin?.recent) pressOrigin.recent.classList.remove('armed');
  if (pressOrigin?.holdBtn) pressOrigin.holdBtn.classList.remove('holding');
  clearPressTimers();
  pressOrigin = null;
}

function lockLists() {
  document.documentElement.classList.add('is-dragging');
  document.querySelectorAll('.live-col-list, .item-pick').forEach((el) => {
    el.style.overflow = 'hidden';
  });
}

function cleanupDrag() {
  document.documentElement.classList.remove('is-dragging');
  document.querySelectorAll('.live-col-list, .item-pick').forEach((el) => {
    el.style.overflow = '';
  });
  if (dragState?.ghost) dragState.ghost.remove();
  document.querySelectorAll('.lot-cell.dragging, .lot-cell.armed, .live-col.drop-target, .live-col.dragging, .live-col.drop-before, .live-col.drop-after, .live-cols.drop-end, .item-btn.dragging').forEach((el) => {
    el.classList.remove('dragging', 'armed', 'drop-target', 'drop-before', 'drop-after', 'drop-end');
  });
  document.querySelectorAll('.item-pick .item-btn, .item-pick .item-group-h').forEach((el) => {
    el.style.transform = '';
    el.style.transition = '';
  });
  const capEl = dragState?.cell || dragState?.colEl || dragState?.btn;
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


function isNoteItemDragBtn(btn) {
  if (!btn || !state || state.tab !== 'note' || showSettings || modal || paddleOpen) return false;
  if (variantPick) return false;
  if (String(itemQuery || '').trim()) return false;
  const act = btn.getAttribute('data-act');
  if (act !== 'pick-item' && act !== 'pick-crop') return false;
  if (btn.classList.contains('item-add')) return false;
  if (!btn.dataset.group) return false;
  const pick = btn.closest('.item-pick');
  if (!pick || pick.classList.contains('sheet-items') || pick.classList.contains('plan-grid-list')) return false;
  if (pick.closest('.in-sheet, .overlay, .plan-screen, .sheet')) return false;
  return true;
}

function itemSectionButtons(btn) {
  const pick = btn && btn.closest('.item-pick');
  const group = btn && btn.dataset.group;
  if (!pick || !group) return [];
  return [...pick.querySelectorAll('button.item-btn')].filter((el) => el.dataset.group === group);
}

function flipItemPick(pick, mutate) {
  if (!pick) {
    mutate();
    return;
  }
  if (typeof reducedMotion === 'function' && reducedMotion()) {
    mutate();
    return;
  }
  const els = [...pick.querySelectorAll('.item-btn, .item-group-h')];
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  els.forEach((el) => {
    const prev = first.get(el);
    if (!prev || !el.isConnected) return;
    const last = el.getBoundingClientRect();
    const dx = prev.left - last.left;
    const dy = prev.top - last.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(() => {
      el.style.transition = 'transform 180ms cubic-bezier(.22, 1, .36, 1)';
      el.style.transform = '';
    });
  });
}

function startItemDrag(pt, btn) {
  if (dragState || !btn || !btn.isConnected) return;
  clearPressTimers();
  ignoreItemClick = true;
  const rect = btn.getBoundingClientRect();
  const ghost = makeGhost(btn, rect, 'item-drag-ghost');
  btn.classList.add('dragging');
  lockLists();
  const cap = maybeCapture(btn);
  const pick = btn.closest('.item-pick');
  if (pick) pick.dataset.scrollLock = String(pick.scrollTop || 0);
  dragState = {
    kind: 'item',
    btn,
    ghost,
    pick,
    group: btn.dataset.group || '',
    name: btn.dataset.name || (btn.textContent || '').trim(),
    half: state.currentHalf,
    pointerId: cap,
    grabX: pt.x - rect.left,
    grabY: pt.y - rect.top,
    startX: pt.x,
    startY: pt.y,
    lastX: pt.x,
    lastY: pt.y,
    moved: false,
    fromIndex: itemSectionButtons(btn).indexOf(btn)
  };
  buzz(14);
  moveItemDrag(pt);
}

function autoScrollItemPick(pick, pt) {
  if (!pick) return;
  const r = pick.getBoundingClientRect();
  const edge = 36;
  let delta = 0;
  if (pt.y < r.top + edge) delta = -Math.max(8, Math.round((r.top + edge - pt.y) / 2));
  else if (pt.y > r.bottom - edge) delta = Math.max(8, Math.round((pt.y - (r.bottom - edge)) / 2));
  if (delta) pick.scrollTop += delta;
}

function moveItemDrag(pt) {
  if (!dragState || dragState.kind !== 'item') return;
  dragState.lastX = pt.x;
  dragState.lastY = pt.y;
  const dx = pt.x - dragState.startX;
  const dy = pt.y - dragState.startY;
  if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) dragState.moved = true;
  const g = dragState.ghost;
  if (g) {
    g.style.left = (pt.x - dragState.grabX) + 'px';
    g.style.top = (pt.y - dragState.grabY) + 'px';
  }
  const btn = dragState.btn;
  const pick = dragState.pick;
  autoScrollItemPick(pick, pt);
  const buttons = itemSectionButtons(btn);
  if (buttons.length < 2) return;
  const from = buttons.indexOf(btn);
  if (from < 0) return;
  let best = from;
  let bestDist = Infinity;
  for (let i = 0; i < buttons.length; i++) {
    const r = buttons[i].getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (pt.x - cx) * (pt.x - cx) + (pt.y - cy) * (pt.y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  const r = buttons[best].getBoundingClientRect();
  const midY = r.top + r.height / 2;
  const midX = r.left + r.width / 2;
  const after = Math.abs(pt.y - midY) > r.height * 0.35 ? pt.y > midY : pt.x > midX;
  let to = after ? best + 1 : best;
  if (from < to) to -= 1;
  if (to < 0) to = 0;
  if (to >= buttons.length) to = buttons.length - 1;
  if (to === from) return;
  const target = buttons[to];
  flipItemPick(pick, () => {
    if (to < from) target.parentNode.insertBefore(btn, target);
    else target.parentNode.insertBefore(btn, target.nextSibling);
  });
}

function endItemDrag(pt) {
  if (!dragState || dragState.kind !== 'item') return;
  const btn = dragState.btn;
  const moved = dragState.moved || (itemSectionButtons(btn).indexOf(btn) !== dragState.fromIndex);
  const group = dragState.group;
  const half = dragState.half;
  const pick = dragState.pick;
  const scroll = pick ? pick.scrollTop : 0;
  const name = dragState.name;
  cleanupDrag();
  if (!moved) {
    if (isCustomItem(name, half)) openItemEditor(name, half);
    return;
  }
  const orderBtn = btn && btn.isConnected ? btn : document.querySelector('.item-pick button.item-btn[data-group="' + CSS.escape(group) + '"]');
  const names = itemSectionButtons(orderBtn || btn).map((el) => el.dataset.name || (el.textContent || '').trim()).filter(Boolean);
  if (names.length && group) {
    setItemOrder(half, group, names);
    saveState();
  }
  render();
  if (pick) {
    const next = document.querySelector('.item-pick');
    if (next) next.scrollTop = scroll;
  }
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

const JUMP_HOLD_MS = 1000;

function armHoldFill(btn, ms) {
  if (!btn) return;
  const reduced = typeof prefersReducedMotion === 'function' && prefersReducedMotion();
  btn.classList.toggle('hold-static', !!reduced);
  btn.style.setProperty('--hold-ms', (ms || 500) + 'ms');
  btn.classList.remove('holding');
  void btn.offsetWidth;
  btn.classList.add('holding');
}

function performHoldAction(act, btn) {
  if (act === 'clear') {
    clearDraft();
    return;
  }
  if (act === 'flow') {
    const id = btn && btn.dataset.id;
    modal = null;
    if (id) markFlow(id);
    return;
  }
  if (act === 'set-start') {
    const id = btn && btn.dataset.id;
    if (id) openSetStart(id);
    return;
  }
  if (act === 'jump-next') {
    const id = btn && btn.dataset.id;
    if (id) jumpToNextSegment(id);
  }
}

function onPressStart(e, pt) {
  clearPressTimers();
  if (dragState) cleanupDrag();
  const target = e.target && e.target.nodeType === 1 ? e.target : document.elementFromPoint(pt.x, pt.y);
  pressOrigin = { x: pt.x, y: pt.y, pointerCap: e.pointerId };
  const holdBtn = target && target.closest && target.closest('[data-hold]');
  if (holdBtn && !target.closest('.del')) {
    pressOrigin.holdBtn = holdBtn;
    pressOrigin.holdAct = holdBtn.dataset.hold || holdBtn.dataset.act;
    const holdMs = pressOrigin.holdAct === 'jump-next' ? JUMP_HOLD_MS : 500;
    if (pressOrigin.holdAct === 'jump-next' && e.cancelable) e.preventDefault();
    armHoldFill(holdBtn, holdMs);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pressOrigin || pressOrigin.holdBtn !== holdBtn) return;
      pressOrigin.holdDone = true;
      holdBtn.classList.remove('holding');
      ignoreHoldClick = true;
      performHoldAction(pressOrigin.holdAct, holdBtn);
    }, holdMs);
    return;
  }
  const recent = target && target.closest && target.closest('.recent-chip');
  if (recent && !(target.closest && target.closest('.del'))) {
    const id = recent.dataset.id;
    pressOrigin.recent = recent;
    pressOrigin.recentId = id;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pressOrigin || pressOrigin.recentId !== id) return;
      ignoreRecentClick = true;
      recent.classList.remove('armed');
      openLotActions(id);
    }, 500);
    recent.classList.add('armed');
    return;
  }
  const itemBtn = target && target.closest && target.closest('.item-btn[data-act="pick-item"], .item-btn[data-act="pick-crop"]');
  const cell = target && target.closest && target.closest('[data-act="cycle-lot"]');
  const colHead = target && target.closest && target.closest('.live-col-head');
  if (itemBtn && isNoteItemDragBtn(itemBtn)) {
    pressOrigin.itemBtn = itemBtn;
    pressOrigin.itemName = itemBtn.dataset.name || '';
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pressOrigin || pressOrigin.itemBtn !== itemBtn || !itemBtn.isConnected || dragState) return;
      startItemDrag({ x: pressOrigin.x, y: pressOrigin.y, id: pt.id }, itemBtn);
    }, ITEM_HOLD_MS);
    return;
  }
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
  if (cell && state.tab === 'live' && !showSettings && !modal && !(target.closest && target.closest('[data-act="edit-subcode"]'))) {
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
    else if (dragState.kind === 'item') moveItemDrag(pt);
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
  if (pressOrigin.itemBtn) {
    // Finger moved before the hold: cancel lift and let the item list scroll.
    if (dist2 > DRAG_SLOP * DRAG_SLOP) {
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
    else if (dragState.kind === 'item') endItemDrag(pt);
    else endLotDrag(pt);
    pressOrigin = null;
    return;
  }
  if (pressOrigin && pressOrigin.holdBtn) {
    const done = !!pressOrigin.holdDone;
    const act = pressOrigin.holdAct;
    pressOrigin.holdBtn.classList.remove('holding');
    if (!done) {
      ignoreHoldClick = true;
      if (act === 'jump-next') toast('按住不放才會跳，號碼在『起始』裡改');
      else if (act === 'flow') toast('按住不放才會流標');
    }
    cancelPress();
    return;
  }
  if (pressOrigin && pressOrigin.recent) {
    pressOrigin.recent.classList.remove('armed');
    cancelPress();
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
    else if (dragState.kind === 'item') endItemDrag(pt);
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
  document.addEventListener('pointerdown', onPaddleExitPointerDown, true);
  document.addEventListener('pointermove', onPaddleExitPointerMove, true);
  document.addEventListener('pointerup', onPaddleExitPointerUp, true);
  document.addEventListener('pointercancel', onPaddleExitPointerUp, true);
  document.addEventListener('click', (e) => { syncWakeLock(); onClick(e); maybeReloadForNewSW(); maybeRollAuctionDay(); });
  document.addEventListener('pointerdown', startPressFlash, { capture: true, passive: true });
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('live-col-list')) updateLiveListOverflow();
  }, true);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  window.addEventListener('popstate', onPlanPopState);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => {
    if (paddleOpen) {
      applyCssLandscapeIfNeeded();
      fitPaddleDigits();
    }
    requestAnimationFrame(() => {
      fitItemBtnLabels();
      layoutSegIndicators();
      placeActionToast();
    });
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (paddleOpen) {
        applyCssLandscapeIfNeeded();
        fitPaddleDigits();
      }
      layoutSegIndicators();
    }, 250);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      requestAnimationFrame(() => {
        fitKeypadSheet();
        layoutSegIndicators();
        placeActionToast();
      });
    });
  }
  document.addEventListener('contextmenu', (e) => {
    if (dragState || e.target.closest('.key, #paddle, .nav, .btn-save, .mini-paddle, .step-btn, .item-btn, .recent-chip, .lot-cell, .live-col, .live-col-head, .prio-hit, .jump-btn, .hold-btn, .plan-qty-step, .plan-qty-plus, .plan-qty-minus, .plan-qty-num')) {
      e.preventDefault();
    }
  });
  if (!window.__auctionDayTimer) {
    window.__auctionDayTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      maybeRollAuctionDay();
    }, 30000);
  }
  document.addEventListener('selectstart', (e) => {
    if (dragState || e.target.closest('.lot-cell, .live-col-head, .live-col-list, .item-btn, .item-pick, .jump-btn, .hold-btn')) e.preventDefault();
  });
  document.addEventListener('touchstart', (e) => {
    if (e.target && e.target.closest && e.target.closest('.jump-btn')) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false, capture: true });
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
    const inField = e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName);
    if (!inField && state && state.tab === 'note' && !showSettings && !paddleOpen && !modal) {
      e.preventDefault();
      if (rangeMode) openRangeConfirm();
      else if (draftNum) saveLot();
      return;
    }
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
      addPlanItem(planAddTarget || defaultPlanAddTarget());
      return;
    }
    if (act === 'plan-qty-type' || id === 'plan-qty-input') {
      e.preventDefault();
      if (modal && modal.type === 'plan-qty') modal.value = e.target.value;
      commitPlanQtyEdit();
      return;
    }
    if (act === 'sync-join-input' || id === 'sync-join-code') {
      e.preventDefault();
      if (typeof joinSyncRoom === 'function') joinSyncRoom(e.target.value);
      return;
    }
    if (act === 'sync-name-input' || id === 'sync-name-input' || id === 'sync-settings-name') {
      e.preventDefault();
      if (typeof submitSyncNamePrompt === 'function' && modal && modal.type === 'sync-name') submitSyncNamePrompt();
      else if (typeof handleSyncAction === 'function') handleSyncAction('sync-name-save');
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
  });
}

let swRegistration = null;
let pendingSWReload = false;

function isMidAction() {
  if (typeof modal !== 'undefined' && modal) return true;
  if (typeof draftNum === 'string' && draftNum) return true;
  if (typeof rangeMode !== 'undefined' && rangeMode) return true;
  if (typeof paddleOpen !== 'undefined' && paddleOpen) return true;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) return true;
  return false;
}

function reloadForNewSW() {
  if (sessionStorage.getItem('auction-bid-sw-reloading') === '1') return;
  if (isMidAction()) {
    pendingSWReload = true;
    return;
  }
  pendingSWReload = false;
  sessionStorage.setItem('auction-bid-sw-reloading', '1');
  sessionStorage.setItem('auction-bid-updated-toast', '1');
  location.reload();
}

function maybeReloadForNewSW() {
  if (pendingSWReload && !isMidAction()) reloadForNewSW();
}

function pokeSWUpdate() {
  if (swRegistration && typeof swRegistration.update === 'function') {
    swRegistration.update().catch(() => {});
  }
}

/* v113: iPhone home-screen apps keep running old files for a long time, and
   「完全關掉重開」 does not always update them. Ask the server which version is out
   (sw.js is tiny and always bumped with the app), and when it is newer, update the
   worker, clear the old file cache and reload. */
function versionNumOf(v) {
  const m = /v(\d+)/.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
}
async function fetchLatestVersion() {
  const res = await fetch('./sw.js?check=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('http ' + res.status);
  const text = await res.text();
  const m = /auction-bid-(v\d+)/.exec(text);
  return m ? m[1] : '';
}
async function forceUpdateNow() {
  toast('正在更新…', 2000);
  try {
    if (swRegistration) {
      await swRegistration.update().catch(() => {});
      const w = swRegistration.waiting || swRegistration.installing;
      if (w) { try { w.postMessage({ type: 'skip-waiting' }); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
  try { if (typeof writeStateNow === 'function') writeStateNow(); } catch { /* ignore */ }
  sessionStorage.setItem('auction-bid-updated-toast', '1');
  const url = location.pathname + '?u=' + Date.now() + location.hash;
  setTimeout(() => location.replace(url), 400);
}
async function checkForUpdate(manual) {
  if (updateInfo.busy) return;
  if (!manual && Date.now() - lastAutoUpdateCheck < 60000) return;
  lastAutoUpdateCheck = Date.now();
  updateInfo.busy = !!manual;
  if (manual) render();
  try {
    const latest = await fetchLatestVersion();
    updateInfo.latest = latest;
    updateInfo.checkedAt = Date.now();
    const d = new Date();
    updateInfo.checkedLabel = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    updateInfo.busy = false;
    if (latest && versionNumOf(latest) > versionNumOf(APP_VERSION)) {
      if (manual) { forceUpdateNow(); return; }
      if (!isMidAction()) {
        modal = modal || {
          type: 'confirm',
          title: '有新版本 ' + latest,
          body: '這支手機還是 ' + APP_VERSION + '。按「更新」會重新載入，資料不會不見。',
          ok: '更新',
          cancel: '等一下',
          onOk: () => { modal = null; forceUpdateNow(); }
        };
      }
    } else if (manual) {
      toast('已是最新版 ' + APP_VERSION, 2200);
    }
  } catch {
    updateInfo.busy = false;
    if (manual) toast('連不到伺服器，稍後再試');
  }
  render();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (sessionStorage.getItem('auction-bid-updated-toast') === '1') {
    sessionStorage.removeItem('auction-bid-updated-toast');
    sessionStorage.removeItem('auction-bid-sw-reloading');
    toast('已更新到新版', 2400);
  } else {
    sessionStorage.removeItem('auction-bid-sw-reloading');
  }
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    reloadForNewSW();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      swRegistration = reg;
      pokeSWUpdate();
    })
    .catch(() => {});
  setTimeout(() => checkForUpdate(false), 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(false); });
  window.addEventListener('pageshow', () => checkForUpdate(false));
}

if (typeof window !== 'undefined') {
  window.__setAuctionNow = setAuctionNow;
  window.__auctionDayStr = todayStr;
  window.__calendarDayStr = calendarDayStr;
  window.__checkNewDay = checkNewDay;
  window.__startNewDay = startNewDay;
  window.__maybeRollAuctionDay = maybeRollAuctionDay;
  window.__tickAutoProgress = tickAutoProgress;
  window.__currentOf = (id, half) => currentOf(id, half);
  window.__ensureAutoAnchors = ensureAutoAnchors;
  window.__isAutoRunning = (id, half) => isAutoRunning(id, half);
  window.__getAnchor = (id, half) => getAnchor(id, half);
  window.__defaultPlanAddTarget = defaultPlanAddTarget;
  window.__resolvePlanName = resolvePlanName;
  window.__planLotMatchScore = planLotMatchScore;
  window.__canonicalItemKey = canonicalItemKey;
  window.__peelClass = peelClass;
  window.__peelToneOf = peelToneOf;
  window.__undoLast = undoLast;
  window.__seriesOf = seriesOf;
  window.__inSeries = inSeries;
  window.__seriesStart = seriesStart;
  window.__seriesPos = seriesPos;
  window.__wrapIsBehind = wrapIsBehind;
  window.__wrapDist = wrapDist;
  window.__inSameStartSegment = inSameStartSegment;
  window.__segmentDist = segmentDist;
  window.__lotEtaMinutes = lotEtaMinutes;
  window.__lotEtaLabel = lotEtaLabel;
  window.__walkSeries = walkSeries;
  window.__isPassed = isPassed;
  window.__columnLots = columnLots;
  window.__ensureSeriesPath = ensureSeriesPath;
  window.__setSeriesStart = setSeriesStart;
  window.__liveInfoLabel = liveInfoLabel;
  window.__displayStartOf = displayStartOf;
  window.__openSetStart = openSetStart;
  window.__seriesAtEnd = seriesAtEnd;
  window.__lotsInSeriesOnOtherMachines = lotsInSeriesOnOtherMachines;
  window.__lotsInSeriesOnOthersForPlan = lotsInSeriesOnOthersForPlan;
  window.__moveLotsToMachine = moveLotsToMachine;
  window.__openXfer = openXfer;
  window.__confirmXfer = confirmXfer;
  window.__doXfer = doXfer;
  window.__xferCandidates = xferCandidates;
  window.__wrapLotsBeforeStart = wrapLotsBeforeStart;
  window.__clearCollapsedMerges = clearCollapsedMerges;
  window.__bumpCurrent = bumpCurrent;
  window.__setCurrent = setCurrent;
  window.__setProgress = setProgress;
  window.__offerAdoptIfNeeded = offerAdoptIfNeeded;
  window.__fixedStartOf = fixedStartOf;
  window.__applyFixedStartPrefills = applyFixedStartPrefills;
  window.__offerUndo = offerUndo;
  window.__undoLast = undoLast;
  window.__commitSetStart = commitSetStart;
  window.__jumpToNextSegment = jumpToNextSegment;
  window.__upcomingJumpSegment = upcomingJumpSegment;
  window.__jumpTargetOf = jumpTargetOf;
  window.__setJumpTarget = setJumpTarget;
  window.__JUMP_HOLD_MS = JUMP_HOLD_MS;
  window.__commitLot = commitLot;
  window.__pickMachineForDraft = pickMachineForDraft;
  window.__writeAnchor = writeAnchor;
  window.__getAnchor = getAnchor;
  window.__restoreCurrent = restoreCurrent;
  window.__snapshotProgress = snapshotProgress;
  window.__placeActionToast = placeActionToast;
  window.__dismissActionToast = dismissActionToast;
  window.__afternoonLooksLikeOldScheme = afternoonLooksLikeOldScheme;
  window.__afternoonRangesAreDefault = afternoonRangesAreDefault;
  window.__migrateAfternoonV98 = migrateAfternoonV98;
  window.__adoptNewAfternoonRanges = adoptNewAfternoonRanges;
  window.__auctionDayStartMs = auctionDayStartMs;
  window.__isStaleProgressAt = isStaleProgressAt;
  window.__cleanNewDayProgressIfNeeded = cleanNewDayProgressIfNeeded;
  window.__setDraftNum = (v) => { draftNum = String(v || ''); };
  window.__getDraftNum = () => draftNum;
  window.__lockItem = lockItem;
  window.__unlockItem = unlockItem;
  window.__enterRangeMode = enterRangeMode;
  window.__getItemLock = () => ({ locked: itemLocked, item: draftItem, rangeMode, rangeStart, rangeEnd, rangeFocus });
  window.__confirmClearPlans = confirmClearPlans;
  window.__clearPlanItems = clearPlanItems;
  window.__planSectionItems = planSectionItems;
  window.__undoPlanLast = undoPlanLast;
}

/* v110: keep only today and yesterday (by auction date) of 抄號 lots and 預計備註 rows.
   Older ones are removed here and, through the normal sync diff, from the room too, so
   the room snapshot stays small enough for the server (it used to be sent whole on every
   connect and could go over the 256 KB limit). Today's data is never touched. */
const KEEP_DATA_DAYS = 2;
function purgeOldData() {
  if (!state || (typeof isSetupNeeded === 'function' && isSetupNeeded())) return 0;
  const today = todayStr();
  const keepFrom = addDaysIso(today, -(KEEP_DATA_DAYS - 1));
  const dayOf = (x) => String((x && x.day) || '');
  const planDayOf = (p) => String((p && (p.forDay || p.createdOn)) || '');
  const oldLot = (l) => { const d = dayOf(l); return !!d && d < keepFrom && d !== state.day; };
  const oldPlan = (p) => { const d = planDayOf(p); return !!d && d < keepFrom && d !== state.day; };
  let removed = 0;
  const lots = state.lots || [];
  if (lots.some(oldLot)) {
    rememberBoughtLots(lots);
    const kept = lots.filter((l) => !oldLot(l));
    removed += lots.length - kept.length;
    state.lots = kept;
  }
  const plans = state.planItems || [];
  if (plans.some(oldPlan)) {
    const kept = plans.filter((p) => !oldPlan(p));
    removed += plans.length - kept.length;
    state.planItems = kept;
  }
  // Delete markers older than the data window are no longer needed.
  const tomb = state.syncTombstones;
  if (tomb && typeof tomb === 'object') {
    const cut = Date.now() - (KEEP_DATA_DAYS + 1) * 24 * 3600 * 1000;
    for (const k of ['lots', 'plan']) {
      const m = tomb[k];
      if (!m || typeof m !== 'object') continue;
      for (const id of Object.keys(m)) {
        const ts = Number(m[id]);
        if (Number.isFinite(ts) && ts < cut) { delete m[id]; removed += 1; }
      }
    }
  }
  if (removed) saveState();
  return removed;
}

function init() {
  if (typeof window !== 'undefined' && window.__pendingAuctionNow) {
    setAuctionNow(window.__pendingAuctionNow);
  }
  state = loadState();
  if (typeof captureSyncBaseline === 'function') captureSyncBaseline();
  if (state.keepAwake == null) state.keepAwake = true;
  ensureItemUseLog(state);
  freezeItemRanks();
  applyPlanProgressFromLots();
  lastPlanEvents = [];
  draftPriority = state.lastPriority || 'watch';
  checkNewDay();
  if (sessionItemRanksDay !== todayStr()) freezeItemRanks();
  bind();
  registerSW();
  if (typeof initSync === 'function') initSync();
  if (typeof initGlobalProgress === 'function') initGlobalProgress();
  applyFixedStartPrefills();
  cleanNewDayProgressIfNeeded();
  ensureAutoAnchors();
  settleProgress({ silent: true });
  purgeOldData();
  setInterval(() => { try { if (purgeOldData()) render(); } catch { /* ignore */ } }, 30 * 60 * 1000);
  render();
  syncProgressTimer();
  syncWakeLock();
}

init();
