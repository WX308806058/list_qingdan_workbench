/* ============================================================
   清单工作台 — 数据 / 列表 / 分组 / 筛选 / 键盘 / 批量
   ------------------------------------------------------------
   数据来自 /api/state（wx-workbench/pipeline.build_state）：
     { generatedAt, generatedAtTs, stats{...},
       projects:[{ id, name, priority, status, metrics{...},
                   records:[open], doneRecords:[done],
                   chats:[{ name, username, lastFromMe, lastFromThem, items[] }] }] }

   本文件只做「视图层聚合」，不产生新的业务真相：
     - 逾期 / 今天 / 本周 一律用**本机当天**重算，避免快照过期
     - 「待回」= 该会话最后一条不是我发的（欠对方一个回复）
   ============================================================ */

/* ---------------- 小工具 ---------------- */

const $ = (id) => document.getElementById(id);

/** 所有用户文本进 DOM 前必须转义 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DAY = 86400000;
const PRIO_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 今天 00:00:00.000 */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周一 00:00（周一为一周起点） */
function startOfWeek() {
  const d = new Date(startOfToday());
  const wd = (d.getDay() + 6) % 7; // 周一=0
  return d.getTime() - wd * DAY;
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { /* 隐私模式：静默降级 */ }
  return null;
}

function storeJson(key, val) {
  try {
    if (val === undefined) {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }
    localStorage.setItem(key, JSON.stringify(val));
  } catch (_) { /* 忽略 */ }
  return null;
}

/* ---------------- 常量 ---------------- */

const K = {
  view: 'list.view',
  group: 'list.group',
  density: 'list.density',
  collapse: 'list.collapse',
  project: 'list.project',
  noise: 'list.noiseOpen',
  keep: 'list.keep',
  mode: 'list.mode',
  fx: 'list.fx',
  wLeft: 'list.wLeft',
  wRight: 'list.wRight',
};

const VIEWS = [
  { id: 'today', label: '今日', hint: '逾期 + 今天到期 + 待回' },
  { id: 'all', label: '全部', hint: '所有未完成' },
  { id: 'pending', label: '待回', hint: '对方最后发言，欠一个回复' },
  { id: 'overdue', label: '逾期', hint: '截止日已过' },
  { id: 'done', label: '已完成', hint: '已归档的记录' },
];

const GROUP_MODES = [
  { id: 'project', label: '按项目' },
  { id: 'urgency', label: '按紧急度' },
  { id: 'customer', label: '按客户' },
  { id: 'week', label: '按周' },
];

const URGENCY = [
  { key: 'overdue', label: '逾期', tone: 'warn' },
  { key: 'today', label: '今天到期', tone: '' },
  { key: 'week', label: '本周内', tone: '' },
  { key: 'later', label: '稍后', tone: '' },
  { key: 'none', label: '未排期', tone: '' },
  { key: 'done', label: '已完成', tone: 'ok' },
];

const WEEKS = [
  { key: 'earlier', label: '更早', tone: 'warn' },
  { key: 'this', label: '本周', tone: '' },
  { key: 'next', label: '下周及以后', tone: '' },
  { key: 'none', label: '未排期', tone: '' },
  { key: 'done', label: '已完成', tone: 'ok' },
];

/* ---------------- 状态 ---------------- */

const S = {
  state: null,
  loading: true,
  error: '',
  view: VIEWS.some(v => v.id === store(K.view)) ? store(K.view) : 'today',
  groupBy: GROUP_MODES.some(g => g.id === store(K.group)) ? store(K.group) : 'project',
  query: '',
  density: store(K.density) === 'compact' ? 'compact' : 'comfort',
  mode: store(K.mode) === 'dash' ? 'dash' : 'list',
  warnOpen: false,
  showHidden: false,
  logMd: '',
  logHtml: '',
  logTab: 'doc',
  docRows: [],
  editRec: null,
  dashEnter: false,
  fx: store(K.fx) === 'ultra' ? 'ultra' : 'normal',
  selId: null,
  ctxAll: null,
  checked: new Set(),
  anchor: null,
  collapsed: new Set(storeJson(K.collapse) || []),
  showNoise: store(K.noise) === '1',
  keep: new Set(storeJson(K.keep) || []),
  projectFilter: store(K.project) || null,
  busy: false,
  token: '',
  refreshing: false,
};

/** 派生数据（每次拿到新 state 时重建） */
const D = {
  records: [],
  byId: new Map(),
  projects: [],
  chatIndex: new Map(),
};

/** 当前列表的 DOM 顺序，键盘移动用 */
let VISIBLE = [];
let toastTimer = 0;

/* ---------------- HTTP ---------------- */

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

async function post(url, body, retried) {
  if (!S.token) {
    const ping = await getJson('/api/ping');
    S.token = ping.token || '';
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WB-Token': S.token },
    body: JSON.stringify(body || {}),
  });
  // 服务重启后令牌会换，遇到 403 换令牌重试一次
  if (r.status === 403 && !retried) {
    const ping = await getJson('/api/ping');
    S.token = ping.token || '';
    return post(url, body, true);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

/* ---------------- toast ---------------- */

function toast(msg, bad) {
  const el = $('toast');
  if (!el) return;
  el.textContent = String(msg);
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ============================================================
   数据摄入
   ============================================================ */

/** 单条记录的视图态：统一字段 + 截止日分类 + 待回标记 */
function makeRecord(raw, proj, chatIndex, firstChat, fallbackStatus) {
  const status = raw.status || fallbackStatus || 'open';
  // 手工写在 projects.json 里的记录没有 chat 字段。只有在项目**仅有一个会话**时
  // 才敢回退，否则宁可不填 —— 给一个错误来源会话，比空着更糟。
  const onlyChat = (proj && Array.isArray(proj.chats) && proj.chats.length === 1)
    ? proj.chats[0] : null;
  const chatName = raw.chat || (onlyChat ? onlyChat.name : '');
  const chatObj = (raw.chat && chatIndex.get(proj.id + '::' + raw.chat)) ||
                  (raw.chat ? null : onlyChat) || null;

  // 待回：会话里对方最后发言（欠一个回复），且该记录来自会话抽取。
  // 人工记录是「我自己排的待办」，不按会话热度算待回，避免整列表都被标成待回。
  let pending = false;
  if (status === 'open' && chatObj && String(raw.source || '') === 'auto') {
    const mine = Number(chatObj.lastFromMe || 0);
    const theirs = Number(chatObj.lastFromThem || 0);
    pending = theirs > mine;
  }

  const rec = {
    id: String(raw.id || ''),
    text: String(raw.text || ''),
    level: String(raw.level || 'P2'),
    owner: String(raw.owner || ''),
    due: String(raw.due || ''),
    dueTs: raw.dueTs ? Number(raw.dueTs) : null,
    source: String(raw.source || ''),
    status,
    ts: raw.ts ? Number(raw.ts) : null,
    who: String(raw.who || ''),
    doneAt: String(raw.doneAt || ''),
    project: String(raw.project || proj.id),
    projectName: String(proj.name || '未归类'),
    projectSubtitle: String(proj.subtitle || ''),
    projectPriority: String(proj.priority || 'P3'),
    chatName: String(chatName || ''),
    chatUsername: chatObj ? String(chatObj.username || '') : '',
    chatObj,
    pending,
  };
  rec.dueInfo = classifyDue(rec.dueTs, status);
  return rec;
}

/** 截止日分类：逾期 / 今天 / 本周 / 稍后 / 未排期 / 已完成 */
function classifyDue(dueTs, status) {
  if (status === 'done') return { key: 'done', label: '已完成', days: 0 };
  if (!dueTs) return { key: 'none', label: '未排期', days: 0 };

  const t0 = startOfToday();
  const dueDay = new Date(dueTs * 1000);
  dueDay.setHours(0, 0, 0, 0);
  const dayTs = dueDay.getTime();

  if (dayTs < t0) {
    const days = Math.max(1, Math.round((t0 - dayTs) / DAY));
    return { key: 'overdue', label: '逾期 ' + days + ' 天', days };
  }
  if (dayTs === t0) return { key: 'today', label: '今天到期', days: 0 };
  if (dayTs < t0 + 7 * DAY) return { key: 'week', label: '本周内', days: 0 };
  return { key: 'later', label: '稍后', days: 0 };
}

/** 按周分组用的桶 */
function weekBucket(rec) {
  if (rec.status === 'done') return 'done';
  if (!rec.dueTs) return 'none';
  const t0 = startOfToday();
  const due = new Date(rec.dueTs * 1000);
  due.setHours(0, 0, 0, 0);
  const ts = due.getTime();
  if (ts < t0) return 'earlier';
  if (ts < startOfWeek() + 7 * DAY) return 'this';
  return 'next';
}

function ingest(st) {
  D.records = [];
  D.byId = new Map();
  D.projects = [];
  D.chatIndex = new Map();
  D.hidden = Array.isArray(st && st.hiddenProjects) ? st.hiddenProjects : [];
  const verEl = document.getElementById('appVer');
  if (verEl) verEl.textContent = st.appVersion ? 'v' + st.appVersion : '';

  const projects = Array.isArray(st && st.projects) ? st.projects : [];
  for (const p of projects) {
    if (!p || !p.id) continue;
    const chats = Array.isArray(p.chats) ? p.chats : [];
    let firstChat = null;
    for (const c of chats) {
      if (!c) continue;
      if (c.name) D.chatIndex.set(p.id + '::' + c.name, c);
      if (!firstChat) firstChat = c;
    }

    const bucket = [];
    for (const r of (Array.isArray(p.records) ? p.records : [])) {
      if (r && r.id) bucket.push(makeRecord(r, p, D.chatIndex, firstChat, 'open'));
    }
    for (const r of (Array.isArray(p.doneRecords) ? p.doneRecords : [])) {
      if (r && r.id) bucket.push(makeRecord(r, p, D.chatIndex, firstChat, 'done'));
    }

    for (const rec of bucket) {
      if (D.byId.has(rec.id)) continue;
      D.byId.set(rec.id, rec);
      D.records.push(rec);
    }

    if (bucket.length) {
      D.projects.push({
        id: p.id,
        name: String(p.name || '未归类'),
        priority: String(p.priority || 'P3'),
        status: String(p.status || ''),
        subtitle: String(p.subtitle || ''),
        open: bucket.filter(r => r.status === 'open').length,
        done: bucket.filter(r => r.status === 'done').length,
      });
    }
  }

  D.projects.sort((a, b) => {
    const ra = PRIO_RANK[a.priority] == null ? 9 : PRIO_RANK[a.priority];
    const rb = PRIO_RANK[b.priority] == null ? 9 : PRIO_RANK[b.priority];
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'zh');
  });

  // 旧的选择 / 勾选可能已经不存在
  if (S.selId && !D.byId.has(S.selId)) S.selId = null;
  for (const id of Array.from(S.checked)) if (!D.byId.has(id)) S.checked.delete(id);
  if (S.projectFilter && !D.projects.some(p => p.id === S.projectFilter)) S.projectFilter = null;
}

/* ============================================================
   统计 / 筛选 / 分组
   ============================================================ */

function counts() {
  const open = D.records.filter(r => r.status === 'open');
  const done = D.records.filter(r => r.status === 'done');
  return {
    all: open.length,
    today: open.filter(r => r.dueInfo.key === 'overdue' || r.dueInfo.key === 'today' || r.pending).length,
    pending: open.filter(r => r.pending).length,
    overdue: open.filter(r => r.dueInfo.key === 'overdue').length,
    done: done.length,
    total: D.records.length,
  };
}

function sortRecords(list) {
  const rank = { overdue: 0, today: 1, week: 2, later: 3, none: 4, done: 5 };
  return list.slice().sort((a, b) => {
    const ka = rank[a.dueInfo.key] == null ? 9 : rank[a.dueInfo.key];
    const kb = rank[b.dueInfo.key] == null ? 9 : rank[b.dueInfo.key];
    if (ka !== kb) return ka - kb;
    const da = a.dueTs || Number.MAX_SAFE_INTEGER;
    const db = b.dueTs || Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    const la = PRIO_RANK[a.level] == null ? 9 : PRIO_RANK[a.level];
    const lb = PRIO_RANK[b.level] == null ? 9 : PRIO_RANK[b.level];
    if (la !== lb) return la - lb;
    return a.text.localeCompare(b.text, 'zh');
  });
}

function viewRecords() {
  const open = D.records.filter(r => r.status === 'open');
  let list;

  switch (S.view) {
    case 'today':
      list = open.filter(r => r.dueInfo.key === 'overdue' || r.dueInfo.key === 'today' || r.pending);
      break;
    case 'pending':
      list = open.filter(r => r.pending);
      break;
    case 'overdue':
      list = open.filter(r => r.dueInfo.key === 'overdue');
      break;
    case 'done':
      list = D.records.filter(r => r.status === 'done');
      break;
    default:
      list = open;
  }

  if (S.projectFilter) list = list.filter(r => r.project === S.projectFilter);

  const q = S.query.trim().toLowerCase();
  if (q) {
    list = list.filter(r =>
      (r.text + ' ' + r.projectName + ' ' + r.chatName + ' ' + r.owner).toLowerCase().includes(q));
  }
  return sortRecords(list);
}

function groupList(list) {
  const buckets = new Map(); // key -> {key,label,tone,items}

  const put = (key, label, tone, rec) => {
    let g = buckets.get(key);
    if (!g) { g = { key, label, tone: tone || '', items: [] }; buckets.set(key, g); }
    g.items.push(rec);
  };

  if (S.groupBy === 'project') {
    for (const r of list) put(r.project, r.projectName, '', r);
    const out = Array.from(buckets.values());
    out.sort((a, b) => {
      const pa = D.projects.find(x => x.id === a.key);
      const pb = D.projects.find(x => x.id === b.key);
      const ra = pa ? (PRIO_RANK[pa.priority] == null ? 9 : PRIO_RANK[pa.priority]) : 9;
      const rb = pb ? (PRIO_RANK[pb.priority] == null ? 9 : PRIO_RANK[pb.priority]) : 9;
      if (ra !== rb) return ra - rb;
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.label.localeCompare(b.label, 'zh');
    });
    return out;
  }

  if (S.groupBy === 'urgency') {
    for (const r of list) {
      const u = URGENCY.find(x => x.key === r.dueInfo.key) || URGENCY[URGENCY.length - 2];
      put(r.dueInfo.key, u.label, u.tone, r);
    }
    return URGENCY.filter(u => buckets.has(u.key)).map(u => buckets.get(u.key));
  }

  if (S.groupBy === 'customer') {
    for (const r of list) put(r.chatName || '未标注', r.chatName || '未标注', '', r);
    const out = Array.from(buckets.values());
    out.sort((a, b) => {
      const ea = a.key === '未标注' ? 1 : 0;
      const eb = b.key === '未标注' ? 1 : 0;
      if (ea !== eb) return ea - eb;
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.label.localeCompare(b.label, 'zh');
    });
    return out;
  }

  // week
  for (const r of list) {
    const k = weekBucket(r);
    const w = WEEKS.find(x => x.key === k) || WEEKS[WEEKS.length - 2];
    put(k, w.label, w.tone, r);
  }
  return WEEKS.filter(w => buckets.has(w.key)).map(w => buckets.get(w.key));
}

/* ============================================================
   渲染
   ============================================================ */

function renderChips() {
  const c = counts();
  const chips = [
    { id: 'all', label: '待办', num: c.all, view: 'all' },
    { id: 'overdue', label: '逾期', num: c.overdue, view: 'overdue', danger: true },
    { id: 'pending', label: '待回', num: c.pending, view: 'pending' },
  ];
  $('chips').innerHTML = chips.map(x => `
    <button class="chip${x.danger ? ' danger' : ''}${S.view === x.view ? ' on' : ''}"
            type="button" data-view="${x.view}" title="切到「${esc(x.label)}」视图">
      ${esc(x.label)} <b>${x.num}</b>
    </button>`).join('');
}

function renderNav() {
  const c = counts();
  const num = { today: c.today, all: c.all, pending: c.pending, overdue: c.overdue, done: c.done };

  $('viewList').innerHTML = VIEWS.map(v => `
    <li><button class="nav-item${S.view === v.id ? ' on' : ''}" type="button"
                data-view="${v.id}" title="${esc(v.hint)}">
      <span class="nav-txt">${esc(v.label)}</span>
      <span class="nav-num">${num[v.id] || 0}</span>
    </button></li>`).join('');

  const hideBtn = (id, name) =>
    `<span class="nav-hide" data-hide="${esc(id)}" data-name="${esc(name)}"
           title="隐藏「${esc(name)}」（可随时恢复）" role="button" tabindex="-1">✕</span>`;

  const projHtml = D.projects.length
    ? D.projects.map(p => `
      <li><button class="nav-item${S.projectFilter === p.id ? ' on' : ''}" type="button"
                  data-project="${esc(p.id)}" title="${esc(p.name)} · 待办 ${p.open}">
        <span class="dot ${esc(p.priority.toLowerCase())}"></span>
        <span class="nav-txt">${esc(p.name)}</span>
        <span class="nav-num">${p.open}</span>
        ${hideBtn(p.id, p.name)}
      </button></li>`).join('')
    : `<li><div class="nav-item" style="cursor:default;color:var(--t3)">暂无项目</div></li>`;

  // 已隐藏分组：识别错 / 已完结的项目收在这里，可随时恢复
  const hid = D.hidden || [];
  const hiddenHtml = hid.length ? `
      <li><button class="nav-hd" type="button" data-hidden-toggle
                  title="这些项目不会出现在任何列表与统计里">
        <span class="nav-txt">已隐藏</span>
        <span class="nav-num">${hid.length}</span>
        <span class="nw-caret" aria-hidden="true">${S.showHidden ? '▾' : '▸'}</span>
      </button></li>
      ${S.showHidden ? hid.map(h => `
      <li><div class="nav-item nav-item-hidden" title="${esc(h.name)} · 隐藏于 ${esc(h.at || '')}">
        <span class="nav-txt">${esc(h.name)}</span>
        <span class="nav-restore" data-restore="${esc(h.id)}" role="button" tabindex="-1">恢复</span>
      </div></li>`).join('') : ''}` : '';

  $('projectList').innerHTML = projHtml + hiddenHtml;

  const st = S.state || {};
  const warns = Array.isArray(st.warnings) ? st.warnings : [];
  // 警告不能只说「N 条」——那等于让用户去猜。标题带全文，点开看完整句子。
  const warn = warns.length
    ? `<button class="nav-warn${S.warnOpen ? ' open' : ''}" type="button" data-warn
              title="${esc(warns.join('\n'))}">
        <span class="nw-dot" aria-hidden="true"></span>
        <span class="nw-n">${warns.length} 条采集警告</span>
        <span class="nw-caret" aria-hidden="true">${S.warnOpen ? '▾' : '▸'}</span>
      </button>
      ${S.warnOpen ? `<div class="nav-warn-body">${warns.map(w => `<p>${esc(w)}</p>`).join('')}</div>` : ''}`
    : '';
  $('navMeta').innerHTML = `
    <div>快照 ${esc(st.generatedAt || '—')}</div>
    <div>记录 ${c.total} 条 · 待办 ${c.all}</div>
    ${warn}
    ${st.desktop ? '<button class="nav-quit" type="button" data-quit>退出应用</button>' : ''}`;
}

function renderHead() {
  const list = VISIBLE;
  const v = VIEWS.find(x => x.id === S.view) || VIEWS[1];
  const pf = S.projectFilter ? D.projects.find(p => p.id === S.projectFilter) : null;

  $('listHead').innerHTML = `
    <div class="seg" role="tablist" aria-label="显示方式">
      <button class="seg-b${S.mode === 'list' ? ' on' : ''}" type="button" data-mode="list" role="tab"
              aria-selected="${S.mode === 'list'}">列表</button>
      <button class="seg-b${S.mode === 'dash' ? ' on' : ''}" type="button" data-mode="dash" role="tab"
              aria-selected="${S.mode === 'dash'}">面板</button>
    </div>
    <span class="lh-title">${esc(v.label)}</span>
    <span class="lh-count">${list.length} 条</span>
    ${S.query.trim() ? `<span class="lh-count">· 匹配「${esc(S.query.trim())}」</span>` : ''}
    <span class="grow"></span>
    ${S.mode === 'dash' ? `<button class="btn sm fx-btn${S.fx === 'ultra' ? ' on' : ''}"
      type="button" data-fx title="切换面板动效强度">${S.fx === 'ultra' ? '炫酷' : '标准'}</button>` : ''}
    <button class="btn sm" type="button" data-new-record>+ 新建</button>
    ${pf ? `<span class="lh-filter">${esc(pf.name)}
      <button type="button" data-clear-project title="清除项目筛选" aria-label="清除项目筛选">×</button></span>` : ''}`;
}

/**
 * 疑似噪音：抽取器常把寒暄当待办（"可以""好的""更新"）。
 * 判定宁可宽松——它只是被折叠，点开就能看见，还可以「保留」永久豁免。
 */
const NOISE_WORDS = /^(可以|好的|好|收到|多谢|谢谢|感谢|嗯+|哦+|行|ok|okay|了解|明白|知道|辛苦|稍等|没问题|已阅|支持|赞|牛|收到谢谢|好的谢谢|没了|没事)$/i;

/** 会话名常以项目名开头（"冠亚恒温 销售易对接U9接口"），显示时剪掉前缀免得看着像重复 */
function shortChat(rec) {
  const cn = String(rec.chatName || '');
  const pn = String(rec.projectName || '');
  if (!cn || !pn) return cn;
  return cn.startsWith(pn) ? (cn.slice(pn.length).trim() || cn) : cn;
}

function isNoisy(rec) {
  if (S.keep.has(rec.id)) return false;
  const raw = String(rec.text || '');
  if (raw.length > 40) return false;              // 长句一定不是寒暄
  const t = raw
    .replace(/@[^\s@]+/g, '')                     // 去掉 @某人
    .replace(/[\s,，。.!！?？;；:：~～、'"“”‘’\-—_()（）\[\]【】]/g, '');
  if (!t) return true;                            // 只剩标点/表情
  if (NOISE_WORDS.test(t)) return true;
  return t.length <= 4;                           // 四个字以内且无信息量
}

function rowHtml(rec, idx) {
  const lv = (rec.level || 'P2').toUpperCase();
  const cls = ['P0', 'P1', 'P2', 'P3'].includes(lv) ? lv.toLowerCase() : 'p3';
  const checked = S.checked.has(rec.id);
  const isDone = rec.status === 'done';
  const overdueCls = rec.dueInfo.key === 'overdue' ? 'overdue' : '';

  const bits = [];
  bits.push(`<span class="pm">${esc(rec.projectName)}</span>`);
  if (rec.chatName) bits.push(`<span class="sep">·</span><span>${esc(shortChat(rec))}</span>`);
  if (rec.pending && !isDone) bits.push(`<span class="sep">·</span><span class="pend">待回</span>`);

  // 截止 / 完成信息移到右侧独立列：左侧留白给正文，右侧形成一条可扫读的时间轴
  let rightTxt = '';
  if (isDone) rightTxt = rec.doneAt ? `已完成 ${rec.doneAt}` : '已完成';
  else if (rec.dueInfo.key !== 'none') rightTxt = rec.dueInfo.label;
  else if (rec.due) rightTxt = rec.due;

  return `
    <div class="row${isDone ? ' done' : ''}${checked ? ' checked' : ''}${S.selId === rec.id ? ' sel' : ''}"
         data-id="${esc(rec.id)}" data-idx="${idx}" role="listitem" tabindex="-1">
      <span class="bar ${cls}" aria-hidden="true"></span>
      <span class="cb">
        <input class="cbx" type="checkbox" data-cbx="${esc(rec.id)}" data-idx="${idx}"
               ${checked ? 'checked' : ''} aria-label="选择这条记录">
      </span>
      <div class="row-main">
        <div class="row-text">${esc(rec.text)}</div>
        <div class="row-meta">
          <span class="lv ${cls}">${esc(lv)}</span>
          ${bits.join('')}
        </div>
      </div>
      <div class="row-right">
        ${rightTxt ? `<span class="row-due ${overdueCls}${isDone ? ' isdone' : ''}">${esc(rightTxt)}</span>` : ''}
        <div class="row-actions">
          ${isNoisy(rec) ? `<button type="button" data-act="keep" data-id="${esc(rec.id)}">保留</button>` : ''}
          ${isDone ? '' : `<button type="button" data-act="done" data-id="${esc(rec.id)}">完成</button>
          <button type="button" data-act="plus1" data-id="${esc(rec.id)}">+1天</button>`}
        </div>
      </div>
    </div>`;
}

function skeletonHtml() {
  return `<div class="skel">
    <i></i><i></i><i></i><i></i><i></i><i></i>
  </div>`;
}

function stateHtml(title, desc, bad, action) {
  return `<div class="state${bad ? ' err' : ''}">
    <div><div class="st-mark"></div><div class="st-t">${esc(title)}</div>
    <div class="st-d">${esc(desc)}</div>
    ${action ? `<div class="st-a">${action}</div>` : ''}</div>
  </div>`;
}

/** 图形化面板：把「一条条」换成「一片」，一眼看出盘子有多满、哪块在冒烟 */
function dashHtml() {
  const all = D.records;
  const open = all.filter(r => r.status === 'open');
  const doneN = all.length - open.length;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const DAY = 86400;

  // ① 紧迫度堆叠条
  const ORDER = [
    { key: 'overdue', label: '逾期', color: '#C2410C' },
    { key: 'today', label: '今天到期', color: '#D9822B' },
    { key: 'week', label: '本周内', color: '#2F6BD8' },
    { key: 'later', label: '稍后', color: '#7A8598' },
    { key: 'none', label: '未排期', color: '#C7CDD6' },
  ];
  const cnt = {}; ORDER.forEach(o => { cnt[o.key] = 0; });
  for (const r of open) {
    const k = (r.dueInfo && r.dueInfo.key) || 'none';
    cnt[k] = (cnt[k] || 0) + 1;
  }
  const tot = open.length || 1;
  const stack = ORDER.filter(o => cnt[o.key]).map(o =>
    `<i style="width:${(cnt[o.key] / tot * 100).toFixed(2)}%;background:${o.color}"></i>`).join('')
    || `<i style="width:100%;background:var(--surface-2)"></i>`;
  const legend = ORDER.map(o =>
    `<li><span class="dot" style="background:${o.color}"></span>${o.label}<b data-count="${cnt[o.key]}">${cnt[o.key]}</b></li>`).join('');

  // ② 按项目：逾期红 / 在办蓝 / 已完成灰
  const byP = new Map();
  for (const r of all) {
    const k = r.projectName || '未标注';
    if (!byP.has(k)) byP.set(k, { open: 0, done: 0, od: 0 });
    const o = byP.get(k);
    if (r.status === 'done') o.done++;
    else { o.open++; if (r.dueInfo && r.dueInfo.key === 'overdue') o.od++; }
  }
  const pjHtml = [...byP.entries()].sort((a, b) => b[1].open - a[1].open).map(([name, o]) => {
    const t = (o.open + o.done) || 1;
    const seg = (w, c) => (w > 0 ? `<i style="width:${(w / t * 100).toFixed(2)}%;background:${c}"></i>` : '');
    return `<div class="pj-row">
      <span class="pj-name" title="${esc(name)}">${esc(name)}</span>
      <span class="pj-cnt">${o.open} 待办${o.od ? ` · <span style="color:#C2410C">逾期 ${o.od}</span>` : ''} / ${t}</span>
      <span class="pj-bar">${seg(o.od, '#C2410C')}${seg(o.open - o.od, '#2F6BD8')}${seg(o.done, '#E5E8ED')}</span>
    </div>`;
  }).join('') || '<div class="cm-empty">暂无项目</div>';

  // ③ 近 14 天消息量
  const startTs = Math.floor(today0.getTime() / 1000) - 13 * DAY;
  const mc = new Array(14).fill(0);
  for (const p of (S.state && S.state.projects) || []) {
    for (const c of p.chats || []) {
      for (const it of c.items || []) {
        const i = Math.floor((it.ts - startTs) / DAY);
        if (i >= 0 && i < 14) mc[i]++;
      }
    }
  }
  const mmax = Math.max(1, ...mc);
  const mBars = mc.map((v, i) => {
    const d = new Date((startTs + i * DAY) * 1000);
    const lab = `${d.getMonth() + 1}-${d.getDate()}`;
    return `<i style="--i:${i};height:${Math.max(2, v / mmax * 100).toFixed(1)}%" title="${lab}：${v} 条"></i>`;
  }).join('');
  const mLabels = mc.map((v, i) => {
    const d = new Date((startTs + i * DAY) * 1000);
    return `<span>${d.getDate()}</span>`;
  }).join('');

  // ④ 未来四周到期
  const wk = [0, 0, 0, 0, 0];
  for (const r of open) {
    if (!r.dueTs) { wk[4]++; continue; }
    const days = Math.floor((r.dueTs * 1000 - today0.getTime()) / (DAY * 1000));
    wk[Math.max(0, Math.min(3, Math.floor(days / 7)))]++;
  }
  const wmax = Math.max(1, ...wk.slice(0, 4));
  const wBars = wk.slice(0, 4).map((v, i) =>
    `<i style="--i:${i};height:${Math.max(2, v / wmax * 100).toFixed(1)}%" title="第 ${i + 1} 周：${v} 条"></i>`).join('');
  const wLabels = ['本周', '下周', '第3周', '第4周'].map(s2 => `<span>${s2}</span>`).join('');

  const fxCls = (S.dashEnter && S.fx === 'ultra') ? ' ultra' : '';
  return `<div class="dash${S.dashEnter ? ' enter' : ''}${fxCls}">
    <section class="card">${S.dashEnter && S.fx === 'ultra' ? sparkRow(0) : ''}
      <h3>待办紧迫度<span class="grow"></span>
        <span class="num">${open.length} 未闭环 · ${doneN} 已完成</span></h3>
      <div class="stack">${stack}</div>
      <ul class="lg">${legend}</ul>
    </section>

    <section class="card">${S.dashEnter && S.fx === 'ultra' ? sparkRow(1) : ''}
      <h3>按项目<span class="grow"></span>
        <span class="num"><span style="color:#C2410C">红</span>逾期 · <span style="color:#2F6BD8">蓝</span>在办 · 灰已完成</span></h3>
      <div class="pj">${pjHtml}</div>
    </section>

    <section class="card">${S.dashEnter && S.fx === 'ultra' ? sparkRow(2) : ''}
      <h3>近 14 天消息量<span class="grow"></span>
        <span class="num">共 ${mc.reduce((a, b) => a + b, 0)} 条</span></h3>
      <div class="bars">${mBars}</div>
      <div class="bars-x">${mLabels}</div>
    </section>

    <section class="card">${S.dashEnter && S.fx === 'ultra' ? sparkRow(3) : ''}
      <h3>未来四周到期<span class="grow"></span>
        <span class="num">未排期 ${wk[4]} 条</span></h3>
      ${(wk[0] + wk[1] + wk[2] + wk[3]) ? `<div class="bars">${wBars}</div>
      <div class="bars-x">${wLabels}</div>` : '<div class="card-empty">未来四周没有到期安排</div>'}
    </section>
  </div>`;
}

/**
 * 三栏拖拽：改 CSS 变量即可，内容全部是 flex/grid，自动跟着重排。
 * 双击复位到默认宽度。
 */
const RZ_LIMIT = { left: [176, 430], right: [300, 640] };
const RZ_VAR = { left: '--sidenav-w', right: '--detail-w' };

function rzWidth(side) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(RZ_VAR[side]);
  return parseInt(v, 10) || (side === 'left' ? 232 : 380);
}

function syncNarrow() {
  const main = document.querySelector('.main');
  const det = document.querySelector('.detail');
  if (det) det.classList.toggle('narrow-detail', det.clientWidth < 340);
  if (main) main.classList.toggle('narrow-main', main.clientWidth < 520);
}

function initResize() {
  const root = document.documentElement;
  const savedL = Number(store(K.wLeft));
  const savedR = Number(store(K.wRight));
  if (savedL) root.style.setProperty(RZ_VAR.left, savedL + 'px');
  if (savedR) root.style.setProperty(RZ_VAR.right, savedR + 'px');
  syncNarrow();

  document.querySelectorAll('.rz').forEach(el => {
    const side = el.dataset.rz;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = rzWidth(side);
      el.classList.add('drag');
      document.body.classList.add('dragging');

      const move = (ev) => {
        const dx = ev.clientX - startX;
        const raw = side === 'left' ? startW + dx : startW - dx;
        const [lo, hi] = RZ_LIMIT[side];
        const w = Math.max(lo, Math.min(hi, raw));
        root.style.setProperty(RZ_VAR[side], w + 'px');
        syncNarrow();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('drag');
        document.body.classList.remove('dragging');
        store(side === 'left' ? K.wLeft : K.wRight, String(rzWidth(side)));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    el.addEventListener('dblclick', () => {
      root.style.removeProperty(RZ_VAR[side]);
      store(side === 'left' ? K.wLeft : K.wRight, '');
      syncNarrow();
    });
  });

  window.addEventListener('resize', syncNarrow);
}

function setMode(m) {
  if (m !== 'list' && m !== 'dash') return;
  if (S.mode === m) return;
  // 只有「切进来」那一次播放入场；之后数据变动重渲染不再闪
  S.dashEnter = (m === 'dash');
  S.mode = m;
  store(K.mode, m);
  renderList();
}

/** 炫酷档的迸发火星：每张卡 9 颗，角度均匀、距离错开 */
function sparkRow(seed) {
  const parts = [];
  for (let i = 0; i < 9; i++) {
    const a = (i * 40) + seed * 17;
    const d = 30 + ((i + seed) % 3) * 22;
    parts.push(`<i style="--a:${a}deg;--d:${d}px;--t:${i * 26}ms"></i>`);
  }
  return `<span class="sparks" aria-hidden="true">${parts.join('')}</span>`;
}

/** 数字滚动：从 0 缓出到目标值，只跑一次 */
function rollNumbers(root) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = Number(el.dataset.count) || 0;
    if (!target) return;
    const dur = 720;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function renderList() {
  const wrap = $('list');
  wrap.classList.toggle('compact', S.density === 'compact');
  wrap.classList.toggle('batch-mode', S.checked.size > 0);

  if (S.loading) {
    VISIBLE = [];
    wrap.innerHTML = skeletonHtml();
    renderHead();
    return;
  }
  if (S.error) {
    VISIBLE = [];
    wrap.innerHTML = stateHtml('加载失败', S.error + ' — 检查服务是否在 8790 端口运行。', true);
    renderHead();
    return;
  }

  if (S.mode === 'dash') {
    VISIBLE = [];
    const animate = S.dashEnter;
    wrap.innerHTML = dashHtml();
    S.dashEnter = false;   // 类已经落到 DOM 上，后续重渲染不再播放
    if (animate) {
      if (S.fx === 'ultra') rollNumbers(wrap);
      // 兜底：入场动效用了 fill:both，万一动画因后台标签/省电/无障碍设置没跑起来，
      // 卡片会永久停在首帧（透明）。1.6 秒后无条件摘掉标记，保证一定看得见。
      setTimeout(() => {
        const el = document.querySelector('.dash.enter');
        if (el) el.classList.remove('enter');
      }, 1600);
    }
    renderHead();
    return;
  }

  const list = viewRecords();
  VISIBLE = list;

  if (!list.length) {
    const q = S.query.trim();
    const pf = S.projectFilter ? (D.projects || []).find(p => p.id === S.projectFilter) : null;
    let title, desc, action = '';

    if (q && pf) {
      title = '筛选下没有记录';
      desc = `「${pf.name}」里没有，同时也没匹配搜索「${q}」。`;
      action = `<button class="btn sm" type="button" data-clear-q>清除搜索</button>
                <button class="btn sm" type="button" data-clear-project>看全部项目</button>`;
    } else if (q) {
      title = '没有匹配的记录';
      desc = `没有内容包含「${q}」，换个关键词试试。`;
      action = `<button class="btn sm" type="button" data-clear-q>清除搜索</button>`;
    } else if (pf) {
      // 最常见：筛选还挂着，用户以为今天没事
      title = `${pf.name} 下没有记录`;
      desc = viewEmptyHint();
      action = `<button class="btn sm" type="button" data-clear-project>看全部项目</button>`;
    } else {
      title = '这一栏是空的';
      desc = viewEmptyHint();
    }
    wrap.innerHTML = stateHtml(title, desc, false, action);
    renderHead();
    return;
  }

  // 疑似噪音单独成组、默认收起：它们占列表体积但不占注意力
  const noise = list.filter(isNoisy);
  const cleanList = list.filter(r => !isNoisy(r));

  const groups = groupList(cleanList);
  if (noise.length) {
    groups.push({ key: '__noise__', label: '疑似噪音', tone: 'noise', items: noise });
  }
  const frag = document.createDocumentFragment();

  // 行序 = 屏幕上的实际顺序（分组之后），键盘 J/K 与 Shift 连选都按它走，
  // 否则在「按项目」分组下上下移动会跨组乱跳。
  const rendered = [];

  for (const g of groups) {
    const ckey = S.groupBy + ':' + g.key;
    const isNoise = g.key === '__noise__';
    const collapsed = isNoise ? !S.showNoise : S.collapsed.has(ckey);

    const sec = document.createElement('section');
    sec.dataset.gkey = ckey;
    const inner = [];
    inner.push(`
      <div class="group-head${collapsed ? ' collapsed' : ''}${g.tone ? ' tone-' + g.tone : ''}"
           data-gkey="${esc(ckey)}" role="button" tabindex="0"
           aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="caret"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.6 L5 6.6 L8 3.6"/></svg></span>
        <span class="g-name">${esc(g.label)}</span>
        <span class="g-badge">${g.items.length}</span>
      </div>
      <div class="group-body${collapsed ? ' hidden' : ''}">`);

    // 折叠的分组不渲染行：既省 DOM，也让 J/K 不会跳到看不见的行上
    if (!collapsed) {
      for (const rec of g.items) {
        inner.push(rowHtml(rec, rendered.length));
        rendered.push(rec);
      }
    }
    inner.push('</div>');

    sec.innerHTML = inner.join('');
    frag.appendChild(sec);
  }

  VISIBLE = rendered;

  wrap.replaceChildren(frag);
  renderHead();
}

function viewEmptyHint() {
  switch (S.view) {
    case 'today': return '今天没有逾期、到期和待回的记录，可以喘口气。';
    case 'pending': return '没有等你回复的会话。';
    case 'overdue': return '没有逾期记录。';
    case 'done': return '还没有已完成的记录。';
    default: return '当前没有未完成的记录。';
  }
}

/* ---------------- 右栏默认态：今日概览 ---------------- */

/** 当前筛选口径下的未完成记录（不含视图，视图切换不该把概览清零） */
function scopeOpen() {
  let list = D.records.filter(r => r.status === 'open');
  if (S.projectFilter) list = list.filter(r => r.project === S.projectFilter);
  const q = S.query.trim().toLowerCase();
  if (q) {
    list = list.filter(r =>
      (r.text + ' ' + r.projectName + ' ' + r.chatName + ' ' + r.owner).toLowerCase().includes(q));
  }
  return list;
}

function prioCls(rec) {
  const lv = String(rec.level || 'P2').toUpperCase();
  return ['P0', 'P1', 'P2', 'P3'].includes(lv) ? lv.toLowerCase() : 'p3';
}

/** 最该处理的 3 条：逾期天数↓ → 待回↓ → 截止日↑ */
function topThree(open) {
  const score = (r) => [
    r.dueInfo.key === 'overdue' ? -r.dueInfo.days : 0,
    r.pending ? 0 : 1,
    r.dueTs || Number.MAX_SAFE_INTEGER,
  ];
  return open.slice().sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return 0;
  }).slice(0, 3);
}

/** 概览里那一行的右侧标签 */
function ovTag(rec) {
  if (rec.dueInfo.key === 'overdue') return { text: rec.dueInfo.label, cls: 'warn' };
  if (rec.pending) return { text: '待回', cls: 'accent' };
  if (rec.dueInfo.key === 'today') return { text: '今天到期', cls: 'muted' };
  if (rec.dueTs) return { text: rec.dueInfo.label, cls: 'muted' };
  return { text: '', cls: '' };
}

function overviewHtml() {
  if (S.loading) {
    return `<div class="d-body"><div class="skel"><i></i><i></i><i></i><i></i></div></div>`;
  }
  if (S.error) {
    return `<div class="d-body">
      <div class="d-sec-title">今日概览</div>
      <div class="state err" style="padding:24px 0">
        <div><div class="st-t">读不到数据</div>
        <div class="st-d">${esc(S.error)}</div></div>
      </div></div>`;
  }

  const v = VIEWS.find(x => x.id === S.view) || VIEWS[1];
  const open = scopeOpen();
  const allOpen = D.records.filter(r => r.status === 'open');
  const doneN = D.records.filter(r => r.status === 'done').length;

  const odN = open.filter(r => r.dueInfo.key === 'overdue').length;
  const tdN = open.filter(r => r.dueInfo.key === 'today').length;
  const prN = open.filter(r => r.pending).length;

  const pf = S.projectFilter ? D.projects.find(p => p.id === S.projectFilter) : null;
  const sub = `${D.projects.length} 个项目 · ${allOpen.length} 条待办 · ${doneN} 条已完成`;

  const top = topThree(open);
  const topHtml = top.length
    ? top.map((r) => {
        const tag = ovTag(r);
        return `
        <div class="ov-item" data-ov-id="${esc(r.id)}" role="button" tabindex="0"
             title="${esc(r.text)}">
          <span class="ov-dot ${prioCls(r)}"></span>
          <span class="ov-text">${esc(r.text)}</span>
          ${tag.text ? `<span class="ov-tag ${tag.cls}">${esc(tag.text)}</span>` : ''}
        </div>`;
      }).join('')
    : `<div class="ov-none">都处理完了</div>`;

  const projHtml = D.projects.length
    ? D.projects.map((p) => {
        const recs = D.records.filter(r => r.project === p.id);
        const total = recs.length;
        const openN = recs.filter(r => r.status === 'open').length;
        const od = recs.filter(r => r.status === 'open' && r.dueInfo.key === 'overdue').length;
        const openRest = Math.max(0, openN - od);
        const pct = (n) => (total ? (n / total) * 100 : 0);
        const cls = prioCls({ level: p.priority });
        return `
        <div class="ov-proj">
          <span class="ov-pname" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="ov-bar">
            <i class="ov-b-od" style="width:${pct(od).toFixed(2)}%"></i>
            <i class="ov-b-open ${cls}" style="width:${pct(openRest).toFixed(2)}%"></i>
          </span>
          <span class="ov-pnum">${openN} / ${total}</span>
          <span class="ov-pod">${od ? '逾期 ' + od : ''}</span>
        </div>`;
      }).join('')
    : `<div class="ov-none">暂无项目</div>`;

  return `
  <div class="d-body ov">
    <div class="ov-head">
      <h2 class="ov-title">${esc(v.label)}</h2>
      <div class="ov-sub">${esc(sub)}</div>
      ${pf ? `<div class="ov-sub">筛选：${esc(pf.name)}</div>` : ''}
    </div>

    <div class="ov-nums">
      <div class="ov-num">
        <b class="warn">${odN}</b><span>逾期</span>
      </div>
      <div class="ov-num">
        <b>${tdN}</b><span>今天到期</span>
      </div>
      <div class="ov-num">
        <b class="accent">${prN}</b><span>待回</span>
      </div>
    </div>

    <div class="ov-sec">
      <div class="d-sec-title">最该处理的 3 条<span class="grow"></span>
        <span class="ov-hint">点击可定位</span></div>
      <div class="ov-list">${topHtml}</div>
    </div>

    <div class="ov-sec">
      <div class="d-sec-title">按项目分布</div>
      <div class="ov-projs">${projHtml}</div>
    </div>

    <div class="ov-foot">
      <span>快照 ${esc((S.state && S.state.generatedAt) || '—')}</span>
      <span class="grow"></span>
      <button class="btn ghost sm" type="button" data-ov="refresh">刷新数据</button>
    </div>
  </div>`;
}

/** 从概览点某条：若它不在当前列表里（被视图或搜索挡住了），先切到「全部」再选中 */
function selectFromOverview(id) {
  if (!D.byId.has(id)) return;
  if (VISIBLE.some(r => r.id === id)) {
    selectRow(id);
    return;
  }
  if (S.view !== 'all' || S.query.trim()) {
    S.view = 'all';
    S.query = '';
    const q = $('q');
    if (q) q.value = '';
    store(K.view, 'all');
    renderChips();
    renderNav();
  }
  S.selId = id;
  renderList();
  paintSelection();
  renderDetail();
}

function renderDetail() {
  const el = $('detail');
  const rec = S.selId ? D.byId.get(S.selId) : null;

  if (!rec) {
    el.innerHTML = overviewHtml();
    return;
  }

  const lv = (rec.level || 'P2').toUpperCase();
  const cls = ['P0', 'P1', 'P2', 'P3'].includes(lv) ? lv.toLowerCase() : 'p3';
  const isDone = rec.status === 'done';
  const stCls = isDone ? 'done' : (rec.dueInfo.key === 'overdue' ? 'overdue' : '');
  const stTxt = isDone ? '已完成' : rec.dueInfo.label;

  // 消息流：默认近 6 条，但一定保证「产生这条待办的那句」在窗口里
  const allMsg = (rec.chatObj && Array.isArray(rec.chatObj.items)) ? rec.chatObj.items : [];
  const anchorTs = Number(rec.ts) || 0;
  const wantAll = S.ctxAll === rec.id;
  let items = wantAll ? allMsg.slice(-40) : allMsg.slice(-6);
  if (anchorTs && !items.some(m => Number(m.ts) === anchorTs)) {
    const hit = allMsg.find(m => Number(m.ts) === anchorTs);
    if (hit) items = [hit, ...items];
  }

  let prevMsg = null;
  const ctx = items.length
    ? items.map(m => {
      const me = m.who === '我';
      const anchor = anchorTs && Number(m.ts) === anchorTs;
      // 同一个人 3 分钟内的连续消息合并，名字只出现一次
      const cont = !anchor && prevMsg && prevMsg.who === m.who
        && Math.abs(m.ts - prevMsg.ts) < 180;
      prevMsg = m;
      const long = String(m.text || '').length > 100;
      return `<li class="cm${me ? ' isme' : ''}${anchor ? ' anchor' : ''}${cont ? ' cont' : ''}${long ? ' long' : ''}">
        <div class="cm-h">
          ${cont ? '' : `<span class="cm-who">${esc(me ? '我' : (m.who || '未知'))}</span>`}
          <span class="cm-ts">${esc(fmtTime(m.ts))}</span>
          ${anchor ? '<span class="cm-tag">来源</span>' : ''}
        </div>
        <div class="cm-t">${esc(m.text || '')}</div>
        ${long ? '<button class="cm-more" type="button">展开</button>' : ''}
      </li>`;
    }).join('')
    : `<li class="cm-empty">该记录没有关联会话上下文</li>`;

  const moreBtn = (!wantAll && allMsg.length > items.length)
    ? `<button class="ctx-more" type="button" data-ctx-all>展开更多（共 ${allMsg.length} 条）</button>`
    : '';

  el.innerHTML = `
  <div class="d-body">
    <div class="d-top">
      <span class="d-lv ${cls}">${esc(lv)}</span>
      <span class="d-status ${stCls}">${esc(stTxt)}</span>
      <span class="grow"></span>
      <button class="btn ghost sm" type="button" data-detail="copy">复制</button>
    </div>

    <p class="d-text">${esc(rec.text)}</p>

    <div class="d-actions">
      ${isDone ? '' : `<button class="btn primary sm" type="button" data-detail="done">完成</button>`}
      <button class="btn sm" type="button" data-detail="plus1">+1 天</button>
      <button class="btn sm" type="button" data-detail="plus3">+3 天</button>
      <button class="btn sm" type="button" data-detail="locate">定位到会话</button>
      ${rec.source === 'manual' ? '<button class="btn sm" type="button" data-detail="edit">编辑</button>' : ''}
    </div>

    <div class="d-sec-title">元信息</div>
    <dl class="meta-grid">
      <dt>项目</dt><dd>${esc(rec.projectName)}</dd>
      <dt>会话</dt><dd>${esc(shortChat(rec) || '—')}</dd>
      <dt>等级</dt><dd>${esc(lv)}${rec.owner ? ' · ' + esc(rec.owner) : ''}</dd>
      <dt>截止日</dt><dd>${esc(rec.due || '未排期')}${rec.dueInfo.key === 'overdue' ? ' · ' + esc(rec.dueInfo.label) : ''}</dd>
      <dt>来源</dt><dd>${rec.source === 'auto' ? '会话抽取' : '人工'}</dd>
      <dt>来源时间</dt><dd>${esc(rec.ts ? fmtTime(rec.ts) : (rec.doneAt || '—'))}</dd>
      ${rec.chatUsername ? `<dt>会话 ID</dt><dd class="mono">${esc(rec.chatUsername)}</dd>` : ''}
    </dl>

    <div class="d-sec-title">来源会话<span class="grow"></span>
      <span class="ctx-hint">${esc(shortChat(rec) || '')}</span></div>
    <ul class="ctx">${ctx}</ul>
    ${moreBtn}
  </div>`;
}

function renderBatch() {
  const bar = $('batchBar');
  const n = S.checked.size;
  bar.classList.toggle('show', n > 0);
  $('batchCount').innerHTML = `已选 <b>${n}</b> 条`;
}

function renderAll() {
  renderChips();
  renderNav();
  renderList();
  renderDetail();
  renderBatch();
  const sel = $('groupSel');
  if (sel && sel.value !== S.groupBy) sel.value = S.groupBy;
  const db = $('densityBtn');
  if (db) db.textContent = S.density === 'compact' ? '紧凑' : '舒适';
}

/** 只重画选中态（键盘移动时用，避免整表重排） */
function paintSelection() {
  const wrap = $('list');
  wrap.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel'));
  if (!S.selId) return;
  const row = wrap.querySelector(`.row[data-id="${CSS.escape(S.selId)}"]`);
  if (row) {
    row.classList.add('sel');
    row.scrollIntoView({ block: 'nearest' });
  }
}

/* ============================================================
   交互：视图 / 分组 / 筛选 / 密度
   ============================================================ */

function setView(id) {
  if (!VIEWS.some(v => v.id === id)) return;
  if (S.view === id) return;
  S.view = id;
  S.projectFilter = null;
  store(K.view, id);
  store(K.project, '');
  S.anchor = null;
  // 新视图里若没有当前选中项，右栏会停在一条中栏找不到的记录上，直接退回概览
  if (S.selId && !viewRecords().some(r => r.id === S.selId)) S.selId = null;
  renderAll();
}

function setProject(id) {
  S.projectFilter = S.projectFilter === id ? null : id;
  store(K.project, S.projectFilter || '');
  renderAll();
}

function setGroup(id) {
  if (!GROUP_MODES.some(g => g.id === id)) return;
  S.groupBy = id;
  store(K.group, id);
  renderList();
  const sel = $('groupSel');
  if (sel) sel.value = id;
}

function setDensity(d) {
  S.density = d === 'compact' ? 'compact' : 'comfort';
  store(K.density, S.density);
  $('densityBtn').textContent = S.density === 'compact' ? '紧凑' : '舒适';
  renderList();
}

function toggleGroup(ckey) {
  if (ckey.endsWith(':__noise__')) {
    S.showNoise = !S.showNoise;
    store(K.noise, S.showNoise ? '1' : '0');
    renderList();
    return;
  }
  if (S.collapsed.has(ckey)) S.collapsed.delete(ckey);
  else S.collapsed.add(ckey);
  storeJson(K.collapse, Array.from(S.collapsed));
  renderList();
}

function selectRow(id) {
  if (!D.byId.has(id)) return;
  if (S.selId !== id) S.ctxAll = null;
  S.selId = id;
  paintSelection();
  renderDetail();
}

/** 只同步勾选态，不整表重排（连续勾选时右栏与滚动位置都不丢） */
function syncCheckedDom() {
  const wrap = $('list');
  wrap.classList.toggle('batch-mode', S.checked.size > 0);
  wrap.querySelectorAll('.cbx').forEach((cb) => {
    const on = S.checked.has(cb.dataset.cbx);
    if (cb.checked !== on) cb.checked = on;
    const row = cb.closest('.row');
    if (row) row.classList.toggle('checked', on);
  });
}

function toggleCheck(id, idx, want, shiftKey) {
  const pick = want == null ? !S.checked.has(id) : !!want;

  if (shiftKey && S.anchor != null && S.anchor >= 0 && S.anchor < VISIBLE.length) {
    const a = Math.min(S.anchor, idx);
    const b = Math.max(S.anchor, idx);
    for (let i = a; i <= b; i += 1) {
      const r = VISIBLE[i];
      if (!r) continue;
      if (pick) S.checked.add(r.id);
      else S.checked.delete(r.id);
    }
  } else {
    if (pick) S.checked.add(id); else S.checked.delete(id);
    S.anchor = idx;
  }

  S.selId = id;
  syncCheckedDom();
  paintSelection();
  renderBatch();
  renderDetail();
}

/* ============================================================
   写操作
   ============================================================ */

/** 把 dueTs（或今天）往后推 n 天，返回 MM-DD 文本（pipeline.parse_due 认这个格式） */
function shiftDue(rec, n) {
  const base = rec.dueTs ? new Date(rec.dueTs * 1000) : new Date();
  base.setHours(12, 0, 0, 0);
  const d = new Date(base.getTime() + n * DAY);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function applyRecord(id, patch, okMsg) {
  if (S.busy) return false;
  S.busy = true;
  try {
    const st = await post('/api/record', Object.assign({ id }, patch));
    S.state = st;
    ingest(st);
    renderAll();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast('操作失败：' + e.message, true);
    return false;
  } finally {
    S.busy = false;
  }
}

async function completeOne(id) {
  const rec = D.byId.get(id);
  if (!rec || rec.status === 'done') return;
  const ok = await applyRecord(id, { status: 'done' }, '已完成');
  if (ok && S.selId === id) {
    // 完成后把选中移到下一条，便于连续处理
    const i = VISIBLE.findIndex(r => r.id === id);
    const next = VISIBLE[i + 1] || VISIBLE[i - 1] || null;
    S.selId = next ? next.id : null;
    paintSelection();
    renderDetail();
  }
}

async function snoozeOne(id, days) {
  const rec = D.byId.get(id);
  if (!rec) return;
  await applyRecord(id, { due: shiftDue(rec, days) }, `已延到 +${days} 天`);
}

async function batchApply(kind) {
  const ids = Array.from(S.checked).filter(id => {
    const r = D.byId.get(id);
    return r && r.status === 'open';
  });
  if (!ids.length) {
    toast('没有可操作的未完成记录', true);
    return;
  }
  if (S.busy) return;
  S.busy = true;

  const fails = [];
  let st = null;
  for (const id of ids) {
    try {
      const rec = D.byId.get(id);
      const body = { id };
      if (kind === 'done') body.status = 'done';
      else if (kind === 'plus1' && rec) body.due = shiftDue(rec, 1);
      st = await post('/api/record', body);
    } catch (e) {
      fails.push(id + ': ' + e.message);
    }
  }

  S.busy = false;
  if (st) {
    S.state = st;
    ingest(st);
  }
  S.checked.clear();
  S.anchor = null;
  renderAll();

  if (fails.length) {
    toast(`完成 ${ids.length - fails.length} 条，失败 ${fails.length} 条`, true);
    console.warn('批量操作失败明细', fails);
  } else {
    toast(kind === 'done' ? `已完成 ${ids.length} 条` : `已延期 ${ids.length} 条`);
  }
}

/* ============================================================
   导出
   ============================================================ */

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function buildMarkdown() {
  const list = viewRecords();
  const groups = groupList(list);
  const v = VIEWS.find(x => x.id === S.view) || VIEWS[1];
  const pf = S.projectFilter ? D.projects.find(p => p.id === S.projectFilter) : null;

  const head = [
    `# 工作台导出 · ${fmtStamp(Date.now())}`,
    '',
    `> 视图：${v.label}${pf ? ' · 项目：' + pf.name : ''} · 分组：` +
      (GROUP_MODES.find(g => g.id === S.groupBy) || {}).label +
      ` · 共 ${list.length} 条`,
    '',
  ];

  const body = [];
  for (const g of groups) {
    body.push(`## ${g.label}（${g.items.length}）`);
    for (const r of g.items) {
      const box = r.status === 'done' ? 'x' : ' ';
      const parts = [];
      if (r.dueInfo.key === 'overdue') parts.push(r.dueInfo.label);
      else if (r.dueInfo.key !== 'none' && r.dueInfo.label) parts.push(r.dueInfo.label);
      if (r.chatName) parts.push(r.chatName);
      const tail = parts.length ? `（${parts.join(' · ')}）` : '';
      body.push(`- [${box}] ${r.level} ${oneLine(r.text)}${tail}`);
    }
    body.push('');
  }

  return head.concat(body).join('\n');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- 工作日志 ---------------- */

function mmdd(ts) {
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayMMDD() {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function stripProj(projName, chatName) {
  const cn = String(chatName || '');
  const pn = String(projName || '');
  return (pn && cn.startsWith(pn)) ? (cn.slice(pn.length).trim() || cn) : cn;
}

/** 按项目分组输出 Markdown 列表 */
function mdByProject(list, fmt) {
  const by = new Map();
  for (const r of list) {
    const k = r.projectName || '未标注';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const out = [];
  for (const [p, arr] of by) {
    out.push(`**${p}**`);
    for (const r of arr) out.push(fmt(r));
    out.push('');
  }
  return out;
}

/**
 * 生成当日工作日志。
 * 不是「导出」——导出搬的是当前视图的数据；日志要把「今天发生了什么」重新组织成能直接贴出去的成稿：
 * 完成了什么、跟谁沟通过、还剩什么、接下来怎么安排。
 */
function buildDailyLog(withChat) {
  const now = new Date();
  const tk = todayMMDD();
  const wk = '日一二三四五六'[now.getDay()];
  const doneToday = D.records.filter(r => r.status === 'done' && String(r.doneAt || '').startsWith(tk));
  const openAll = D.records.filter(r => r.status === 'open');
  const newToday = openAll.filter(r => r.ts && mmdd(r.ts) === tk);

  // 今日沟通：客户项目会话与「未归类」分开算——
  // 培训群、行业群的广播消息不是客户沟通，混进来会把日志冲垮
  const chats = [];
  const stray = [];
  for (const p of (S.state && S.state.projects) || []) {
    const bucket = p.id === '__other__' ? stray : chats;
    for (const c of p.chats || []) {
      let n = 0, last = null;
      for (const it of c.items || []) {
        if (mmdd(it.ts) === tk) { n++; if (!last || it.ts > last.ts) last = it; }
      }
      if (n) bucket.push({ proj: p.name, name: c.name, n, last });
    }
  }
  chats.sort((a, b) => b.n - a.n);
  stray.sort((a, b) => b.n - a.n);
  const msgN = chats.reduce((a, c) => a + c.n, 0);
  const strayN = stray.reduce((a, c) => a + c.n, 0);

  // 抬头里的项目名取自「今天有动静的客户项目」：完成过、还有未闭环、或来过消息
  const projNames = [...new Set([
    ...doneToday.map(r => r.projectName),
    ...openAll.map(r => r.projectName),
    ...chats.map(c => c.proj),
  ].filter(Boolean))];
  const L = [];
  L.push(`# 工作日志 · ${now.getFullYear()}-${tk} 周${wk}`);
  L.push('');
  L.push(`> ${projNames.join('、') || '—'} · 完成 ${doneToday.length} 条 · 未闭环 ${openAll.length} 条`
    + (withChat ? ` · 沟通 ${msgN} 条` : ''));
  L.push('');

  L.push(`## 一、今日完成（${doneToday.length}）`);
  L.push('');
  L.push(...(doneToday.length
    ? mdByProject(doneToday, r => `- ${r.text}`)
    : ['- 今天没有在应用里标记完成的条目。', '']));

  if (withChat) {
    L.push(`## 二、今日沟通（${chats.length} 个会话 / ${msgN} 条）`);
    L.push('');
    if (chats.length) {
      for (const c of chats) {
        const who = c.last.who === '我' ? '我' : (c.last.who || '对方');
        const txt = String(c.last.text || '').replace(/\s+/g, ' ').trim().slice(0, 42);
        L.push(`- **${c.proj}** · ${stripProj(c.proj, c.name)}（${c.n} 条）· 最后 ${who}：「${txt}${String(c.last.text || '').length > 42 ? '…' : ''}」`);
      }
    } else {
      L.push('- 今天没有客户项目的新消息。');
    }
    if (stray.length) {
      L.push('');
      L.push(`_另有未归类群组 ${stray.length} 个 / ${strayN} 条消息（${stray.slice(0, 2).map(c => stripProj(c.proj, c.name)).join('、')}${stray.length > 2 ? ' 等' : ''}），未计入客户沟通。_`);
    }
    L.push('');
  }

  L.push(`## ${withChat ? '三' : '二'}、未闭环（${openAll.length}${newToday.length ? `，今日新增 ${newToday.length}` : ''}）`);
  L.push('');
  L.push(...(openAll.length
    ? mdByProject(openAll, (r) => {
      const tags = [];
      if (r.pending) tags.push('待回');
      if (r.dueInfo && r.dueInfo.key === 'overdue') tags.push(r.dueInfo.label);
      else if (r.dueInfo && r.dueInfo.key === 'today') tags.push('今天到期');
      return `- [ ] ${r.level} ${r.text}${tags.length ? `（${tags.join(' · ')}）` : ''}`;
    })
    : ['- 没有未闭环的条目。', '']));

  const t0 = openAll.filter(r => r.dueInfo && r.dueInfo.key === 'today').length;
  const w1 = openAll.filter(r => r.dueInfo && r.dueInfo.key === 'week').length;
  const none = openAll.filter(r => !r.dueInfo || r.dueInfo.key === 'none').length;
  L.push(`## ${withChat ? '四' : '三'}、跟进安排`);
  L.push('');
  L.push(`- 今天到期：${t0} 条`);
  L.push(`- 本周内到期：${w1} 条`);
  L.push(`- 未排期：${none} 条`);
  L.push('');
  L.push('---');
  L.push(`_由清单工作台生成 · ${now.getFullYear()}-${tk} ${pad2(now.getHours())}:${pad2(now.getMinutes())}_`);

  return { text: L.join('\n'), stat: `完成 ${doneToday.length} · 未闭环 ${openAll.length} · 沟通 ${msgN} 条` };
}

/**
 * 极简 Markdown → HTML：只覆盖本功能自己产出的语法（标题/引用/加粗/斜体/列表/分隔线）。
 * 不引第三方库——多一个依赖就多一份离线跑不起来的风险。
 */
function mdToHtml(md) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])_([^_]+?)_/g, '$1<em>$2</em>');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of md.split('\n')) {
    const ln = raw.replace(/\s+$/, '');
    if (/^- /.test(ln)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      let body = ln.slice(2);
      let box = '';
      if (/^\[ \] /.test(body)) { box = '<span class="md-box">☐</span>'; body = body.slice(4); }
      out.push(`<li>${box}${inline(body)}</li>`);
      continue;
    }
    closeList();
    if (!ln.trim()) continue;
    if (/^### /.test(ln)) out.push(`<h4>${inline(ln.slice(4))}</h4>`);
    else if (/^## /.test(ln)) out.push(`<h3>${inline(ln.slice(3))}</h3>`);
    else if (/^# /.test(ln)) out.push(`<h2>${inline(ln.slice(2))}</h2>`);
    else if (/^> /.test(ln)) out.push(`<blockquote>${inline(ln.slice(2))}</blockquote>`);
    else if (ln.trim() === '---') out.push('<hr>');
    else out.push(`<p>${inline(ln)}</p>`);
  }
  closeList();
  return out.join('');
}

/* ---- 「开发部门综合」表格记录 ---- */

/** 从副标题里抠系统名：销售易 CRM ↔ U9 接口 → CRM / U9 */
const SYS_RE = /(U9C|U8C|U9|U8|BIP|NCC|CRM|PLM|MES|ERP|OA|WMS|SRM)/gi;
function sysOf(sub) {
  const hit = String(sub || '').match(SYS_RE) || [];
  return [...new Set(hit.map(x => x.toUpperCase()))].join(' / ');
}

function projOf(id) {
  return (D.projects || []).find(p => p.id === id) || null;
}

/**
 * 生成「开发部门综合」的处理记录行。
 * 列结构取自该表：序号 / 客户 / 项目 / 系统 / 状态 / 发生日期 / 提出人 / 负责人 / 问题描述 / 问题截图 / 解决方案
 * 我们只有「问题描述」是确定有的；解决方案留空让人补——不编造结论。
 */
function buildDocRows() {
  const now = new Date();
  const todayCn = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const rows = [];
  const pick = (r) => {
    const sub = r.projectSubtitle || '';
    const isDone = r.status === 'done';
    const d = (isDone && r.doneAt) ? r.doneAt.slice(0, 5) : '';
    let dateCn = todayCn;
    if (d) {
      const [mm, dd] = d.split('-').map(Number);
      dateCn = `${now.getFullYear()}年${mm}月${dd}日`;
    }
    return [
      '',                                   // 序号：交给表格里的人工/公式
      r.projectName || '',                  // 客户
      sub || r.projectName || '',           // 项目
      sysOf(sub),                           // 系统
      isDone ? '已完成' : '处理中',           // 状态
      dateCn,                               // 发生日期
      r.owner || r.who || '',                // 提出人：客户方发言的人，拿不到就留空
      '我',                                  // 负责人
      r.text || '',                          // 问题描述
      '',                                    // 问题截图
      '',                                    // 解决方案：留空
    ];
  };
  for (const r of D.records) if (r.status === 'done' && String(r.doneAt || '').startsWith(todayMMDD())) rows.push(pick(r));
  for (const r of D.records) if (r.status === 'open') rows.push(pick(r));
  return rows;
}

const DOC_HEAD = ['序号', '客户', '项目', '系统', '状态', '发生日期', '提出人', '负责人', '问题描述', '问题截图', '解决方案'];

function docRowsToTsv(rows) {
  const esc2 = (v) => String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  return [DOC_HEAD, ...rows].map(r => r.map(esc2).join('\t')).join('\n');
}

function docTableHtml(rows) {
  const body = rows.map((r, i) => `<tr>${r.map((c, j) =>
    `<td${j === 8 ? ' class="wrap"' : ''}>${esc(c || '')}</td>`).join('')}</tr>`).join('');
  return `<div class="doc-tip">共 ${rows.length} 行 · 点「复制表格」后直接粘贴到「开发部门综合」的空行，列会自己对齐。
    「解决方案」留空待补——我不想替你编结论。</div>
    <table class="doc-table">
      <thead><tr>${DOC_HEAD.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${body || '<tr><td colspan="11" class="empty-cell">今天没有可整理成记录的工作</td></tr>'}</tbody>
    </table>`;
}

/**
 * 生成「编号叙述体」工作日志，对齐你们在用的格式：
 *   工作日志（2026 年 11 月 5 日）| 冠亚恒温 / 冠亚
 *   1. ……
 *   2. ……
 *   待跟进：……；……
 * 纯文本段落，不是 Markdown 清单——目标是能直接贴进 IM / 邮件。
 */
function stripMentions(t) {
  return String(t || '')
    .replace(/@[^\s@]+/g, '')                 // 去掉 @某人
    .replace(/^\s*(大家好|各位|老师|您好|你好)[，,、]?\s*/, '')  // 群聊开场白（先去掉 @ 会留空格）
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；！？、])/g, '$1')
    .trim();
}

/** 去掉句尾标点，便于自己统一补句号，避免出现「；。」这种 */
function trimTail(t) {
  // 只清「，。；、」这类收尾标点，问号感叹号保留——把「明天测一下吗」改成句号是篡改语气
  return stripMentions(t).replace(/[。；，、,.\s]+$/, '');
}

/** 补句号：已经以 。！？ 结尾的不动 */
function endDot(t) {
  return /[。！？]$/.test(t) ? t : t + '。';
}

function buildLogText(withChat) {
  const now = new Date();
  const tk = todayMMDD();
  const doneToday = D.records.filter(r => r.status === 'done' && String(r.doneAt || '').startsWith(tk));
  const openAll = D.records.filter(r => r.status === 'open');
  const projNames = [...new Set([
    ...doneToday.map(r => r.projectName),
    ...openAll.map(r => r.projectName),
  ].filter(Boolean))];

  const pad = (n) => String(n).padStart(2, '0');
  const head = `工作日志（${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日）`
    + ` | ${projNames.join(' / ') || '—'}`;

  // 正文条目：优先今日完成；一条没有时，用当前未闭环的事项顶上并标注
  const items = doneToday.length
    ? doneToday.map(r => endDot(trimTail(r.text)))
    : openAll.map(r => `${trimTail(r.text)}（进行中）`);

  const lines = [head, ''];
  items.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  if (!items.length) lines.push('今天没有需要记录的处理事项。');

  // 待跟进：未闭环合成一段，用分号连起来
  const follow = openAll.map(r => trimTail(r.text)).filter(Boolean);
  if (follow.length) {
    lines.push('');
    lines.push(`待跟进：${endDot(follow.join('；'))}`);
  }

  return { text: lines.join('\n'), stat: `${items.length} 条 · 待跟进 ${follow.length} 条` };
}

function renderLogBody() {
  const body = $('logBody');
  const isTable = S.logTab === 'table';
  document.querySelectorAll('[data-logtab]').forEach(b =>
    b.classList.toggle('on', b.dataset.logtab === S.logTab));
  // 表格有 11 列，窄弹层放不下——切到表格时把弹层放开
  document.querySelector('#logModal .modal-card').classList.toggle('wide', isTable);
  const dl = document.querySelector('[data-log="download"]');
  if (dl) dl.textContent = isTable ? '下载 .tsv' : '下载 .txt';

  if (S.logTab === 'table') {
    const rows = buildDocRows();
    S.docRows = rows;
    body.className = 'modal-body log-doc log-table';
    body.contentEditable = 'false';
    body.innerHTML = docTableHtml(rows);
    $('logStat').textContent = `${rows.length} 行`;
    return;
  }

  const { text, stat } = buildLogText();
  S.logMd = text;
  body.className = 'modal-body log-plain';
  body.contentEditable = 'true';
  body.spellcheck = false;
  body.textContent = text;
  $('logStat').textContent = stat + ' · 可直接改';
}

/** 复制为富文本：粘到 Word / 企业微信 / 邮件里标题和列表还在 */
async function copyRich(html, text) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      toast('已复制（保留标题与列表）');
      return;
    }
  } catch (_) { /* 权限或浏览器不支持，退回纯文本 */ }
  copyText(text);
}

function openLog() {
  $('logModal').hidden = false;
  renderLogBody();
  $('logBody').scrollTop = 0;
}

function closeLog() {
  $('logModal').hidden = true;
}

function bindLog() {
  $('logBtn').addEventListener('click', openLog);
  $('logModal').addEventListener('click', (e) => {
    const t = e.target.closest('[data-logtab]');
    if (!t || t.dataset.logtab === S.logTab) return;
    S.logTab = t.dataset.logtab;
    renderLogBody();
  });
  $('logModal').addEventListener('click', (e) => {
    if (e.target.closest('[data-log-close]')) { closeLog(); return; }
    const b = e.target.closest('[data-log]');
    if (!b) return;
    const tableMode = S.logTab === 'table';
    if (tableMode) {
      const tsv = docRowsToTsv(S.docRows || []);
      if (b.dataset.log === 'copy') {
        copyText(tsv);
        toast('已复制表格 · 直接粘到空行即可');
      } else {
        download(`开发部门综合-${todayMMDD().replace('-', '')}.tsv`, tsv);
        toast('已下载 TSV');
      }
      return;
    }
    // 日志：取编辑框里的当前内容（用户可能已经改过），纯文本
    const plain = ($('logBody').innerText || '').trim();
    if (!plain) return;
    if (b.dataset.log === 'copy') {
      copyText(plain);
    } else {
      download(`工作日志-${todayMMDD().replace('-', '')}.txt`, plain);
      toast('已下载工作日志');
    }
  });
}

function doExport() {
  if (S.loading || S.error) { toast('数据还没准备好', true); return; }
  const n = viewRecords().length;
  if (!n) { toast('当前视图没有内容可导出', true); return; }
  const md = buildMarkdown();
  const d = new Date();
  const name = `workbench-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
               `-${pad2(d.getHours())}${pad2(d.getMinutes())}.md`;
  download(name, md);
  toast(`已导出 ${n} 条 → ${name}`);
}

/* ============================================================
   数据加载 / 刷新
   ============================================================ */

async function loadState() {
  S.loading = true;
  S.error = '';
  renderAll();
  try {
    const st = await getJson('/api/state');
    S.state = st;
    ingest(st);
    S.loading = false;
  } catch (e) {
    S.loading = false;
    S.error = e.message || '未知错误';
  }
  renderAll();
}

async function doRefresh() {
  if (S.refreshing) return;
  S.refreshing = true;
  const btn = $('refreshBtn');
  btn.innerHTML = '<span class="spin">↻</span>';
  btn.disabled = true;
  toast('开始重新采集微信数据…');

  try {
    await post('/api/refresh', {});
    for (let i = 0; i < 600; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const p = await getJson('/api/refresh/status');
      if (!p.running) {
        if (p.error) toast('采集失败：' + p.error, true);
        else toast('采集完成');
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 700));
    }
    const st = await getJson('/api/state');
    S.state = st;
    ingest(st);
    renderAll();
  } catch (e) {
    toast('刷新失败：' + e.message, true);
  } finally {
    S.refreshing = false;
    btn.textContent = '↻';
    btn.disabled = false;
  }
}

/* ============================================================
   键盘
   ============================================================ */

function inField(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName.toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
}

function moveSel(delta) {
  if (!VISIBLE.length) return;
  const cur = S.selId ? VISIBLE.findIndex(r => r.id === S.selId) : -1;
  let next = cur < 0 ? (delta > 0 ? 0 : VISIBLE.length - 1) : cur + delta;
  if (next < 0) next = 0;
  if (next > VISIBLE.length - 1) next = VISIBLE.length - 1;
  S.selId = VISIBLE[next].id;
  paintSelection();
  renderDetail();
}

function cycleGroup() {
  const i = GROUP_MODES.findIndex(g => g.id === S.groupBy);
  const next = GROUP_MODES[(i + 1) % GROUP_MODES.length];
  setGroup(next.id);
  toast('分组：' + next.label);
}

function onKeydown(e) {
  // 日志弹层开着时，Esc 先关弹层，不要穿透到列表快捷键
  if (!$('logModal').hidden) {
    if (e.key === 'Escape') { closeLog(); e.preventDefault(); }
    return;
  }
  if (inField(e.target)) {
    if (e.key === 'Escape') {
      if (S.query) { S.query = ''; $('q').value = ''; renderList(); }
      e.target.blur();
      e.preventDefault();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if ((e.key === 'a' || e.key === 'A') && VISIBLE.length) {
      e.preventDefault();
      for (const r of VISIBLE) S.checked.add(r.id);
      syncCheckedDom();
      renderBatch();
    }
    return;
  }

  switch (e.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      e.preventDefault();
      moveSel(1);
      break;
    case 'k':
    case 'K':
    case 'ArrowUp':
      e.preventDefault();
      moveSel(-1);
      break;
    case 'Enter': {
      if (!S.selId) break;
      e.preventDefault();
      const rec = D.byId.get(S.selId);
      if (rec && rec.status === 'open') completeOne(S.selId);
      break;
    }
    case 'x':
    case 'X': {
      if (!S.selId) break;
      e.preventDefault();
      const idx = VISIBLE.findIndex(r => r.id === S.selId);
      toggleCheck(S.selId, idx < 0 ? 0 : idx, null, false);
      break;
    }
    case '/':
      e.preventDefault();
      $('q').focus();
      $('q').select();
      break;
    case 'Escape':
      e.preventDefault();
      if (S.checked.size) { S.checked.clear(); syncCheckedDom(); renderBatch(); }
      else if (S.selId) { S.selId = null; paintSelection(); renderDetail(); }
      break;
    case 'g':
    case 'G':
      e.preventDefault();
      cycleGroup();
      break;
    default:
      break;
  }
}

/* ============================================================
   事件绑定
   ============================================================ */

/* ---------------- 新建 / 编辑人工待办 ---------------- */

/** 只有项目里手写的记录（source=manual）能改文本；会话抽取的只能完成/延期 */
function openEdit(rec) {
  S.editRec = rec || null;
  const isNew = !rec;
  $('edTitle').textContent = isNew ? '新建待办' : '编辑待办';

  const opts = (D.projects || []).map(p =>
    `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('edProject').innerHTML = opts || '<option value="">（没有可用项目）</option>';
  $('edProject').value = rec ? rec.project
    : (S.projectFilter || (D.projects[0] || {}).id || '');

  $('edLevel').value = rec ? (rec.level || 'P2') : 'P2';
  $('edDue').value = rec ? (rec.due || '') : '';
  $('edText').value = rec ? (rec.text || '') : '';
  $('edDelete').style.display = (rec && rec.source === 'manual') ? '' : 'none';
  $('editModal').hidden = false;
  setTimeout(() => $('edText').focus(), 30);
}

function closeEdit() {
  $('editModal').hidden = true;
  S.editRec = null;
}

async function saveEdit() {
  const rec = S.editRec;
  const text = $('edText').value.trim();
  if (!text) { toast('内容不能为空', true); return; }
  const body = {
    op: rec ? 'update' : 'add',
    project: $('edProject').value,
    level: $('edLevel').value,
    due: $('edDue').value.trim(),
    text,
  };
  if (rec) body.id = rec.id;
  try {
    const st = await post('/api/manual', body);
    S.state = st;
    ingest(st);

    // 保存后必须让用户看见它：新建的「本周」不会出现在「今日」，
    // 筛在别的项目下也看不见——自动挪到能看见的位置并选中
    const hit = rec
      ? D.byId.get(rec.id)
      : D.records.find(r => r.text === text && r.status === 'open');
    if (hit) {
      if (S.projectFilter && S.projectFilter !== hit.project) {
        S.projectFilter = null;
        store(K.project, '');
      }
      if (!viewRecords().some(r => r.id === hit.id)) {
        S.view = 'all';
        store(K.view, 'all');
      }
      S.selId = hit.id;
    }

    closeEdit();
    renderAll();
    toast(rec ? '已保存' : '已新建');
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

async function deleteEdit() {
  const rec = S.editRec;
  if (!rec) return;
  if (!confirm('删除这条人工待办？只删配置里的这条，不影响微信消息。')) return;
  try {
    const st = await post('/api/manual', { op: 'del', project: rec.project, id: rec.id });
    S.state = st;
    S.selId = null;
    ingest(st);
    closeEdit();
    renderAll();
    toast('已删除');
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

function bindEdit() {
  $('editModal').addEventListener('click', (e) => {
    if (e.target.closest('[data-edit-close]')) { closeEdit(); return; }
  });
  $('edSave').addEventListener('click', saveEdit);
  $('edDelete').addEventListener('click', deleteEdit);
  $('editModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeEdit(); e.preventDefault(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
  });
}

function bind() {
  bindEdit();
  $('listHead').addEventListener('click', (e) => {
    if (e.target.closest('[data-fx]')) {
      S.fx = S.fx === 'ultra' ? 'normal' : 'ultra';
      store(K.fx, S.fx);
      S.dashEnter = true;      // 立刻重播一遍，让人看到差别
      renderList();
      return;
    }
    if (e.target.closest('[data-new-record]')) { openEdit(null); return; }
    if (e.target.closest('[data-clear-q]')) { S.query = ''; $('q').value = ''; renderList(); return; }
    if (e.target.closest('[data-clear-project]')) { setProject(S.projectFilter); return; }
  });
  bindLog();

  $('navMeta').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-quit]')) return;
    try { await post('/api/quit', {}); } catch (_) { /* 进程已经退了，正常 */ }
    window.close();
    document.body.innerHTML = '<div style="padding:40px;font:14px system-ui">清单工作台已退出，可以关闭这个标签页。</div>';
  });

  // 采集警告：点开看完整文字
  $('navMeta').addEventListener('click', (e) => {
    if (!e.target.closest('[data-warn]')) return;
    S.warnOpen = !S.warnOpen;
    renderNav();
  });

  // 列表 / 面板 切换（容器是静态的，事件委托即可）
  $('listHead').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  // 顶栏 chips
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });

  // 左栏
  $('viewList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  $('projectList').addEventListener('click', async (e) => {
    const hide = e.target.closest('[data-hide]');
    if (hide) {
      const id = hide.dataset.hide, name = hide.dataset.name || id;
      if (!confirm(`隐藏「${name}」？\n它将从所有列表与统计中消失（数据保留），\n可在左侧底部「已隐藏」里随时恢复。`)) return;
      try {
        const st = await post('/api/project/hide', { id, hidden: true, name });
        ingest(st);
        if (S.projectFilter === id) setProject(id);   // 正筛着它就顺手取消筛选
        renderAll();
        toast(`已隐藏「${name}」`);
      } catch (err) { toast(err.message || String(err), true); }
      return;
    }
    const res = e.target.closest('[data-restore]');
    if (res) {
      const id = res.dataset.restore;
      try {
        const st = await post('/api/project/hide', { id, hidden: false });
        ingest(st);
        renderAll();
        toast('已恢复显示');
      } catch (err) { toast(err.message || String(err), true); }
      return;
    }
    if (e.target.closest('[data-hidden-toggle]')) { S.showHidden = !S.showHidden; renderNav(); return; }
    const b = e.target.closest('[data-project]');
    if (b) setProject(b.dataset.project);
  });

  // 搜索（200ms 防抖）
  let qTimer = 0;
  $('q').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      S.query = v;
      S.anchor = null;
      renderList();
    }, 200);
  });

  // 分组
  $('groupSel').addEventListener('change', (e) => setGroup(e.target.value));

  // 密度 / 导出 / 刷新
  $('densityBtn').addEventListener('click', () => {
    setDensity(S.density === 'compact' ? 'comfort' : 'compact');
  });
  $('exportBtn').addEventListener('click', doExport);
  $('refreshBtn').addEventListener('click', doRefresh);

  // 列表：分组折叠 / 勾选 / 行内操作 / 选中
  $('list').addEventListener('click', (e) => {
    const head = e.target.closest('.group-head');
    if (head) { toggleGroup(head.dataset.gkey); return; }

    const cb = e.target.closest('.cbx');
    if (cb) {
      e.stopPropagation();
      toggleCheck(cb.dataset.cbx, Number(cb.dataset.idx), cb.checked, e.shiftKey);
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      const id = act.dataset.id;
      if (act.dataset.act === 'done') completeOne(id);
      else if (act.dataset.act === 'plus1') snoozeOne(id, 1);
      else if (act.dataset.act === 'keep') {
        S.keep.add(id);
        storeJson(K.keep, Array.from(S.keep));
        renderList();
        toast('已保留为有效待办');
      }
      return;
    }

    const row = e.target.closest('.row');
    if (row) selectRow(row.dataset.id);
  });

  $('list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const head = e.target.closest('.group-head');
      if (head) {
        e.preventDefault();
        toggleGroup(head.dataset.gkey);
      }
    }
  });

  // 批量操作条
  $('batchBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-batch]');
    if (!b) return;
    const kind = b.dataset.batch;
    if (kind === 'clear') {
      S.checked.clear();
      S.anchor = null;
      syncCheckedDom();
      renderBatch();
      return;
    }
    batchApply(kind);
  });

  // 右栏详情 / 概览
  $('detail').addEventListener('click', (e) => {
    // 概览：点某条 → 等同于在列表里选中它
    const ovItem = e.target.closest('[data-ov-id]');
    if (ovItem) {
      selectFromOverview(ovItem.dataset.ovId);
      return;
    }
    if (e.target.closest('[data-ov="refresh"]')) {
      doRefresh();
      return;
    }

    // 来源会话：显示全部 / 单条长消息展开
    if (e.target.closest('[data-ctx-all]')) {
      S.ctxAll = S.selId;
      renderDetail();
      return;
    }
    const moreBtn = e.target.closest('.cm-more');
    if (moreBtn) {
      const li = moreBtn.closest('.cm');
      li.classList.toggle('open');
      moreBtn.textContent = li.classList.contains('open') ? '收起' : '展开';
      return;
    }

    const b = e.target.closest('[data-detail]');
    if (!b) return;
    const rec = S.selId ? D.byId.get(S.selId) : null;
    if (!rec) return;
    const kind = b.dataset.detail;
    if (kind === 'done') completeOne(rec.id);
    else if (kind === 'plus1') snoozeOne(rec.id, 1);
    else if (kind === 'plus3') snoozeOne(rec.id, 3);
    else if (kind === 'copy') copyText(rec.text);
    else if (kind === 'edit') openEdit(rec);
    else if (kind === 'locate') {
      if (rec.chatUsername) {
        copyText(rec.chatUsername);
        toast('已复制会话 ID：' + rec.chatUsername);
      } else {
        toast('该记录没有关联会话', true);
      }
    }
  });

  // 概览条目键盘可达
  $('detail').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('[data-ov-id]');
    if (!item) return;
    e.preventDefault();
    selectFromOverview(item.dataset.ovId);
  });

  // 顶部「清除项目筛选」
  $('listHead').addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-project]')) {
      S.projectFilter = null;
      store(K.project, '');
      renderAll();
    }
  });

  document.addEventListener('keydown', onKeydown);
}

function copyText(text) {
  const s = String(text || '');
  if (!s) return;
  const done = () => toast('已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(s).then(done).catch(() => fallbackCopy(s, done));
  } else {
    fallbackCopy(s, done);
  }
}

function fallbackCopy(s, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (e) {
    toast('复制失败', true);
  }
}

/* ============================================================
   启动
   ============================================================ */

function boot() {
  initResize();
  const sel = $('groupSel');
  if (sel) sel.value = S.groupBy;
  const db = $('densityBtn');
  if (db) db.textContent = S.density === 'compact' ? '紧凑' : '舒适';
  bind();
  loadState().then(autoRefreshIfStale);
}

/**
 * 打开页面时快照太旧就自动抽一次——不然早上第一眼看到的是昨天的数据，
 * 还得自己想起来点刷新。30 分钟内的快照视为新鲜，不打扰。
 */
async function autoRefreshIfStale() {
  const ts = Number((S.state && S.state.generatedAtTs) || 0) * 1000;
  if (!ts) return;
  const ageMin = (Date.now() - ts) / 60000;
  if (ageMin < 30) return;
  if (S.refreshing) return;
  toast(`快照是 ${Math.round(ageMin)} 分钟前的，正在自动刷新…`);
  doRefresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
// 本地调试句柄：控制台可查内部状态、注入测试数据（仅本机工具）
window.__wb = { S, D, renderList, renderDetail, isNoisy, viewRecords };
