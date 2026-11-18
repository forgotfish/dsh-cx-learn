#!/usr/bin/env node
/* ============================================================================
 * ui-render.test.cjs — 设置页在「没有浏览器」的情况下真渲染一次
 * ============================================================================
 * 为什么需要：client.js 只在 DSH Web 里跑，本机三个 profile 都没装这个插件
 * （docs/STATUS.md §7），所以「改完设置页」过去只能靠肉眼，白屏了也发现不了。
 *
 * 做法：
 *   1. 用 vm 执行真实 client.js；
 *   2. 给一个假 window / document / React（createElement + 四个 hook）；
 *   3. 调真实 apply(ctx)，从 slots 注册里拿回 Panel 组件并调用它；
 *   4. 遍历返回的元素树，检查分组、按钮、绑定与接口路径。
 *
 * 它覆盖的真实事故：
 *   · Panel 里引用未定义变量 → 渲染直接抛 ReferenceError → 整页白屏
 *   · 按钮 onClick 忘了绑定 / 绑到已删除的函数
 *   · 前端调了后端已删除的接口（/models、/ask-test 那次）
 *
 * 不做的事：不跑 useEffect（不发起网络请求、不启动定时器）、不写 DOM。
 *
 * 运行：node scripts/ui-render.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra === undefined ? '' : '  ← ' + extra)); fails.push(name); }
}

/* ── 假 React ──────────────────────────────────────────────────────────── */

/**
 * seed：按 useState 的调用顺序预置初始值。
 * 顺序变化时测试会红 —— 那是提醒你同步更新 seed，不是可以忽略的噪音。
 */
function makeReact(seed) {
  let i = 0;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) };
    },
    useState(init) {
      const at = i++;
      const has = seed && Object.prototype.hasOwnProperty.call(seed, at);
      return [has ? seed[at] : (typeof init === 'function' ? init() : init), () => {}];
    },
    useEffect() { /* 不执行：测试不发起网络请求、不起定时器 */ },
    useCallback(fn) { return fn; },
    useRef(v) { return { current: v }; },
  };
  return React;
}

/* ── 假 DOM ────────────────────────────────────────────────────────────── */

function makeDocument() {
  const head = { children: [], appendChild(el) { head.children.push(el); } };
  return {
    head,
    createElement(tag) {
      return {
        tag, attrs: {}, textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        remove() { /* noop */ },
      };
    },
  };
}

/* ── 加载 client.js，拿回 Panel ─────────────────────────────────────────── */

function loadPanel(seed) {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const React = makeReact(seed);
  const registered = [];
  let factory = null;

  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    navigator: { clipboard: null },
    document: makeDocument(),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    fetch: async () => { throw new Error('测试不发起网络请求'); },
    __ModuleLoader__: {
      load(spec) {
        if (spec && spec.id === 'dsh-cx-learn') factory = spec.factory;
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__;

  vm.runInNewContext(src, sandbox, { filename: 'client.js' });
  if (typeof factory !== 'function') throw new Error('client.js 没有通过 __ModuleLoader__ 注册 factory');

  const mod = factory((id) => {
    if (id === 'react') return React;
    throw new Error('未预期的 require: ' + id);
  });

  /* 假宿主：slots 只记录注册，register 时把组件留下 */
  const slots = {
    inject(name, setup) { if (name === 'settings.section') setup(); },
    register(meta, component) { registered.push({ meta, component }); },
  };
  const ctx = {
    effect(fn) { const d = fn(); return d; },
    get(name) { return name === 'slots' ? slots : undefined; },
    slots,
  };
  mod.apply(ctx, {});

  const entry = registered.find((r) => r.meta && r.meta.name === 'settings.section');
  if (!entry) throw new Error('设置页没有注册 settings.section');
  const el = entry.component();
  if (!el || typeof el !== 'object' || typeof el.type !== 'function') throw new Error('settings.section 组件没有返回 React 元素');
  const Panel = el.type;
  return Panel();
}

/* ── 元素树工具 ────────────────────────────────────────────────────────── */

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return node.children.map(textOf).join('');
  return '';
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
  fn(node);
  node.children.forEach((n) => walk(n, fn));
}

/** 按「分组标题」切段：返回该组标题之后、下一个组标题之前的所有节点。 */
function groupSections(page) {
  const kids = page.children;
  const out = {};
  let current = null;
  for (const kid of kids) {
    if (kid && typeof kid === 'object' && kid.props && kid.props['data-cx-group'] !== undefined) {
      current = textOf(kid).trim();
      out[current] = [];
      continue;
    }
    if (current) out[current].push(kid);
  }
  return out;
}

function buttonsIn(nodes) {
  const out = [];
  for (const n of nodes) walk(n, (el) => { if (el.type === 'button') out.push(el); });
  return out;
}

/* ── 路由契约：client 调的路径必须在 index.js 里存在 ───────────────────── */

function routesOfIndex() {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const routes = new Set();
  const re = /path === '([^']+)' && req\.method === '[A-Z]+'/g;
  let m;
  while ((m = re.exec(src))) routes.add(m[1]);
  if (/const draftMatch = path\.match\(\/\^\\\/questions\\\/\(\[\^\/\]\+\)\\\/draft\$\//.test(src)) routes.add('/questions/:id/draft');
  return routes;
}

function pathsUsedByClient() {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const used = new Set();
  const re = /j(?:get|post)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    // 动态拼接的前缀（'/questions/' + id + '/draft'）单独按模式收口
    if (!m[1].endsWith('/')) used.add(m[1]);
  }
  // 动态路径：jpost('/questions/' + encodeURIComponent(id) + '/draft', ...)
  if (/jpost\(\s*'\/questions\/'/.test(src)) used.add('/questions/:id/draft');
  return used;
}

/* ── 跑 ────────────────────────────────────────────────────────────────── */

console.log('== 1. 设置页真实渲染（无浏览器）==');
let page;
try {
  page = loadPanel();
  ok(true, 'Panel 渲染不抛错（引用未定义变量会在这里炸）');
} catch (e) {
  ok(false, 'Panel 渲染不抛错', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)).slice(0, 300));
  finish();
  process.exit(1);
}

/* 2026-11-15：界面按主人的草图改成 5 个标签页（内核/登录/选课/答题/开始），
   不再有「浏览器环境 / 课程业务」两块分组，因此这里改成按 data-cx-tab-of 断言。 */
const TAB_NAMES = ['内核', '登录', '选课', '答题', '开始'];
let tabsBar = null;
walk(page, (el) => { if (!tabsBar && el.props && el.props['data-cx-tabs'] !== undefined) tabsBar = el; });
const tabIds = tabsBar
  ? tabsBar.children.map((b) => (b && b.props ? b.props['data-cx-tab-id'] : null)).filter(Boolean)
  : [];
console.log('  标签页：' + tabIds.join(' / '));
ok(JSON.stringify(tabIds) === JSON.stringify(TAB_NAMES),
  '★ 五个标签页且顺序是 内核 → 登录 → 选课 → 答题 → 开始（实际 ' + tabIds.join('/') + '）');
ok(page.props['data-cx-tab'] === '登录', '★ 页面根节点带 data-cx-tab，默认停在「登录」');

const tabCards = {};
for (const kid of page.children) {
  const k = kid && typeof kid === 'object' && kid.props && kid.props['data-cx-tab-of'];
  if (k) (tabCards[k] = tabCards[k] || []).push(kid);
}
ok(JSON.stringify(Object.keys(tabCards).sort()) === JSON.stringify(TAB_NAMES.slice().sort()),
  '★ 每张卡片都归属某个标签页（实际 ' + Object.keys(tabCards).join('/') + '）');

const allButtons = buttonsIn([page]);
console.log('  按钮：' + allButtons.map((b) => textOf(b).trim()).join(' / '));

ok(allButtons.length > 0, '面板上有按钮');
ok(allButtons.every((b) => typeof b.props.onClick === 'function'), '★ 每个按钮都绑定了 onClick（无「定义了但没绑定」）');

const btnsOf = (n) => buttonsIn(tabCards[n] || []).map((b) => textOf(b).trim());
const kernelBtns = btnsOf('内核');
const loginBtns = btnsOf('登录');
const courseBtns = btnsOf('选课');
const answerBtns = btnsOf('答题');
const runBtns = btnsOf('开始');

ok(['刷新', '重启内核', '结束会话'].every((t) => kernelBtns.includes(t)),
  '★「内核」含：刷新 / 重启内核 / 结束会话（实际 ' + kernelBtns.join(',') + '）');
ok(['开始登录', '刷新二维码'].every((t) => loginBtns.includes(t)),
  '★「登录」含：开始登录 / 刷新二维码（实际 ' + loginBtns.join(',') + '）');
ok(courseBtns.includes('读取我的课程'), '★「选课」含：读取我的课程（实际 ' + courseBtns.join(',') + '）');
ok(answerBtns.includes('高级'), '★「答题」含：高级（答题通道/每次题量收在里面）');
ok(['开始看课', '停止'].every((t) => runBtns.includes(t)),
  '★「开始」含：开始看课 / 停止（实际 ' + runBtns.join(',') + '）');

const pageBtns = allButtons.map((b) => textOf(b).trim());
/* 存盘行只在「有未保存改动」时出现（dirty 是第 18 个 useState，索引 17）。 */
const dirtyPage = loadPanel({ 17: true });
const dirtyBtns = buttonsIn([dirtyPage]).map((b) => textOf(b).trim());
ok(dirtyBtns.includes('保存配置') && dirtyBtns.includes('撤销改动'),
  '★ 有未保存改动时出现「保存配置 / 撤销改动」（实际 ' + dirtyBtns.join(',') + '）');
ok(!pageBtns.includes('保存配置'), '★ 没有改动时不留空按钮行');

ok(!loginBtns.includes('开始看课') && !courseBtns.includes('开始看课'),
  '★「开始看课」只在「开始」页');
ok(!courseBtns.includes('重启内核') && !courseBtns.includes('结束会话') && !loginBtns.includes('结束会话'),
  '★「重启内核 / 结束会话」只在「内核」页');

console.log('== 2. 已删除的答题 UI 不得回来 ==');
const pageText = textOf(page);
ok(!/答题方式/.test(pageText), '★ 不再有「答题方式」下拉');
/* AI 答题卡片有意引入「模型」输入框（留空走宿主默认）；
   被删掉的是旧的「模型下拉选择」，不许以 select 的形式回来。 */
{
  const modelSelects = [];
  walk(page, (el) => {
    if (el.type === 'select' && /模型/.test(textOf(el))) modelSelects.push(textOf(el).slice(0, 40));
  });
  ok(modelSelects.length === 0, '★ 不再有「模型」下拉选择（实际 ' + modelSelects.join(',') + '）');
}
ok(!/ask-test|models\/health/.test(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')), '★ client.js 不再调用已删除的答题接口');

console.log('== 3. 前端调用的接口必须在后端存在 ==');
const routes = routesOfIndex();
const used = pathsUsedByClient();
const missing = [...used].filter((p) => !routes.has(p));
console.log('  client 调用：' + [...used].sort().join(', '));
ok(missing.length === 0, '★ 所有 jget/jpost 路径在 index.js 里都有对应路由（缺：' + missing.join(',') + '）');

console.log('== 4. 后端路由都有前端入口（只读提示类路由除外）==');
/* 这些路由没有 UI 入口是合理的：
   · /health /status /config /log /questions —— 读状态与日志，UI 走 status 合并字段
   · /ask —— 预留接口（D-015），主人明确「不给 UI」
   · /browsers —— 内核清单已并进 /status.browsers
   · /start /check-login —— UI 统一走 /start-precheck（预检+启动）
   新增路由如果落进「孤儿」列表，要么补 UI，要么在这里写清理由。 */
const noUiNeeded = new Map([
  ['/health', '监测用'], ['/status', 'UI 已用'], ['/config', 'UI 已用'], ['/log', 'UI 已用'],
  ['/questions', 'UI 已用'], ['/ask', '预留接口，不给 UI'], ['/browsers', '并进 /status'],
  ['/start', 'UI 走 /start-precheck'], ['/check-login', 'UI 走 /start-precheck'],
  /* D-033：/ai-selftest 是本机排障用的自检端点（仅回环 + 需 ai.enabled），
     不是给设置页用的，故意不给 UI 入口。 */
  ['/ai-selftest', '本机排障自检，不给 UI'],
  /* D-019：/llm-ask 是**引擎专用**内部端点，不是给设置页用的。
     调用方是子进程引擎（读 CX_LLM_ASK_URL 发起），带本轮 spawn 的 x-cx-token 鉴权；
     前端永远不该调它。给它配 UI 入口反而是安全倒退。 */
  ['/llm-ask', '引擎专用内部端点（D-019），前端不得调用'],
]);
const orphan = [...routes].filter((r) => !used.has(r) && !noUiNeeded.has(r));
ok(orphan.length === 0, '★ 没有「后端实现了但前端从不调用」的路由（孤儿：' + orphan.join(',') + '）');

/* ── 数据态：登录完成、有二维码、有题目、有日志 ────────────────────────
 * 空状态渲染不到的分支（会话进行中、二维码图片、题目列表）最容易白屏，
 * 因为平时看不到。这里按 useState 顺序灌入真实形状的数据。
 * 顺序：0 st / 1 qr / 2 busy / 3 loginState / 4 loginHint / 5 msg / 6 zoom /
 *       7 url / 8 mode / 9 maxSections / 10 browserId / 11 chromiumPath /
 *       12 questions / 13 draftText / 14 needLogin / 15 courses /
 *       16 loadingCourses / 17 dirty / 18 questionsOpen /
 *       19 aiEnabled / 20 aiDryRun / 21 aiModel / 22 aiVision / 23 aiOpen /
 *       24 chapterQuiz / 25 aiChannel / 26 aiBatch / 27 aiSessionId
 * 改了 Panel 的 state 顺序 → 这里会红，同步更新即可。 */
console.log('== 5. 数据态渲染（会话 / 二维码 / 题目 / 日志）==');
const now = Date.now();
const stFull = {
  running: false,
  pid: null,
  engineReady: true,
  chromiumReady: true,
  home: '/tmp/cx-learn',
  chromium: '/usr/bin/chrome',
  browserRoot: '/opt/browsers',
  browsers: [{ id: 'system:Edge', label: '系统内核 · Edge' }],
  browser: { alive: true, pid: 4242, port: 9223, ageMs: 5000, restarts: 0, lastErrorKind: '' },
  session: {
    active: true, loginVerified: true, port: 9223, kernelPid: 4242,
    lastUsedAt: new Date(now).toISOString(), keepAliveMs: 30 * 60 * 1000,
  },
  config: {},
  state: { startedAt: now, mode: 'continue_chapters', maxSections: 5 },
  logTail: '[engine] 本节视频任务已完成',
  questions: [{ id: 'q1', kind: 'video_embedded_quiz', question: '1+1=?', chapterTitle: '1.1' }],
};
let fullPage = null;
try {
  fullPage = loadPanel({
    0: stFull,
    1: { ok: true, dataUrl: 'data:image/png;base64,AAAA', mtime: now },
    3: 'logged_in',
    12: [{ id: 'q1', kind: 'video_embedded_quiz', question: '1+1=?', chapterTitle: '1.1' }],
    15: [{ courseId: '1', title: '课程A', clazzid: '2' }],
  });
  ok(true, '★ 数据态 Panel 渲染不抛错');
} catch (e) {
  ok(false, '★ 数据态 Panel 渲染不抛错', (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)).slice(0, 300));
}

if (fullPage) {
  const t = textOf(fullPage);
  ok(t.includes('会话进行中'), '★ 会话进行中的状态行已渲染');
  ok(t.includes('1+1=?'), '★ 题目内容已渲染');
  ok(t.includes('本节视频任务已完成'), '★ 日志尾已渲染');
  ok(!/undefined|NaN/.test(t), '★ 数据齐全时不出现 undefined / NaN');

  const btns = buttonsIn([fullPage]);
  const endBtn = btns.find((b) => textOf(b).trim() === '结束会话');
  ok(endBtn && endBtn.props.disabled === false, '★ 会话可用时「结束会话」可点');
  const draftBtn = btns.find((b) => textOf(b).trim() === '投递草稿');
  ok(draftBtn && typeof draftBtn.props.onClick === 'function', '★ 题目「投递草稿」已绑定');
  const imgs = [];
  walk(fullPage, (el) => { if (el.type === 'img') imgs.push(el); });
  ok(imgs.length >= 1 && /^data:image\/png/.test(imgs[0].props.src || ''), '★ 二维码图片已渲染');
}

console.log('== 6. 待处理题目折叠（>3 条默认收起）==');
{
  const many = Array.from({ length: 5 }, (_, i) => ({ id: 'q' + i, kind: 'video_embedded_quiz', question: '题目' + i }));
  const page = loadPanel({ 12: many });
  const t = textOf(page);
  const btns = buttonsIn([page]).map((b) => textOf(b).trim());
  ok(t.includes('待处理题目（5）'), '★ 标题带数量（5）');
  ok(btns.includes('展开'), '★ 提供「展开」按钮');
  ok(!btns.includes('投递草稿'), '★ 默认折叠时不渲染题目列表');
  ok(t.includes('已折叠 5 条'), '★ 折叠时给出摘要');
}

console.log('== 7. 答题卡片（一句话开关：用不用 AI / 答完保留还是提交）==');
{
  const findOne = (root, key) => {
    let hit = null;
    walk(root, (el) => { if (!hit && el.props && el.props[key] !== undefined) hit = el; });
    return hit;
  };
  /* state 顺序：19 aiEnabled / 20 aiDryRun / 21 aiModel / 22 aiVision / 23 aiOpen（高级） / 24 chapterQuiz */
  const AI_ENABLED = 19;
  const AI_OPEN = 23;
  const CHAPTER_QUIZ = 24;

  const page0 = loadPanel();
  const toggle = findOne(page0, 'data-cx-ai-enabled');
  const statusEl = findOne(page0, 'data-cx-ai-status');
  ok(toggle && toggle.props.type === 'checkbox' && toggle.props.checked === false,
    '★ 「用 AI 答题」默认关闭');
  ok(statusEl && textOf(statusEl).trim() === '未开启',
    '★ 默认状态文案为「未开启」（实际 ' + (statusEl ? textOf(statusEl).trim() : '无') + '）');

  const saveRadio = findOne(page0, 'data-cx-quiz-after');
  ok(saveRadio && saveRadio.props.type === 'radio', '★ 有「答完之后」单选组');
  const allRadios = [];
  walk(page0, (el) => { if (el.type === 'input' && el.props && el.props.name === 'cx-quiz-after') allRadios.push(el); });
  ok(allRadios.length === 2, '★ 两个选项：保留 / 提交（实际 ' + allRadios.length + '）');
  ok(allRadios.every((r) => r.props.disabled === true), '★ AI 关闭时两个选项都禁用');
  ok(/盲试/.test(textOf(page0)), '★ AI 关闭时提示「随堂题按顺序盲试」');

  /* 高级默认收起：技术项不该占版面 */
  ok(findOne(page0, 'data-cx-ai-dryrun') === null, '★ 「高级」默认收起（不渲染模型/通道/题量）');
  const advBtn = buttonsIn([page0]).filter((b) => /高级/.test(textOf(b)));
  ok(advBtn.length === 1, '★ 有「高级」按钮');

  /* 打开高级后技术项才出现 */
  const adv = loadPanel({ [AI_ENABLED]: true, [AI_OPEN]: true });
  ok(findOne(adv, 'data-cx-ai-dryrun') !== null, '★ 展开后出现「只判定不点选」调试开关');

  /* 开关打开后单选可改，默认仍是「保留」 */
  const live = loadPanel({ [AI_ENABLED]: true });
  const liveRadios = [];
  walk(live, (el) => { if (el.type === 'input' && el.props && el.props.name === 'cx-quiz-after') liveRadios.push(el); });
  ok(liveRadios.every((r) => r.props.disabled === false), '★ AI 开启后两个选项可点');
  const liveSave = liveRadios.find((r) => r.props['data-cx-quiz-after'] === 'save');
  ok(liveSave && liveSave.props.checked === true, '★ 默认选「保留（存草稿）」');
  ok(/只点「保存」存草稿，不交卷/.test(textOf(live)), '★ 保留档提示写明「只存草稿、不交卷」');

  /* 选提交必须有醒目警示 */
  const sub = loadPanel({ [AI_ENABLED]: true, [CHAPTER_QUIZ]: 'submit' });
  const subRadios = [];
  walk(sub, (el) => { if (el.type === 'input' && el.props && el.props.name === 'cx-quiz-after') subRadios.push(el); });
  const subSubmit = subRadios.find((r) => r.props['data-cx-quiz-after'] === 'submit');
  ok(subSubmit && subSubmit.props.checked === true, '★ 选提交时 radio 状态正确');
  ok(/不可撤回/.test(textOf(sub)), '★ 选提交时给出「不可撤回」警示');
}

console.log('== 8. 高级项（模型 / 通道 / 题量 / 会话回显）==');
{
  const findSelectByLabel = (root, labelRe) => {
    let hit = null;
    walk(root, (el) => {
      if (!hit && el.type === 'select' && el.props && el.props['data-cx-in'] !== undefined
          && el.children.some((c) => c && c.type === 'option' && labelRe.test(textOf(c)))) hit = el;
    });
    return hit;
  };
  /* 23 aiOpen / 25 aiChannel / 26 aiBatch / 27 aiSessionId */
  const AI_OPEN = 23;
  const AI_CHANNEL = 25;
  const AI_BATCH = 26;
  const AI_SESSION = 27;

  const adv = loadPanel({ 19: true, [AI_OPEN]: true });

  const channelSel = findSelectByLabel(adv, /工作区窗口|隐藏直连/);
  ok(!!channelSel, '★ 有「答题通道」下拉');
  const channelVals = channelSel ? channelSel.children.filter((c) => c && c.type === 'option').map((o) => o.props.value) : [];
  ok(JSON.stringify(channelVals) === JSON.stringify(['session', 'direct']),
    '★ 通道两档：session / direct（实际 ' + channelVals.join(',') + '）');
  ok(channelSel && channelSel.props.value === 'session', '★ 通道默认 session');

  const batchSel = findSelectByLabel(adv, /逐题|题$/);
  ok(!!batchSel, '★ 有「每次题量」下拉');
  const batchVals = batchSel ? batchSel.children.filter((c) => c && c.type === 'option').map((o) => o.props.value) : [];
  ok(JSON.stringify(batchVals) === JSON.stringify(['1', '5', '10', '16']),
    '★ 题量四档：1 / 5 / 10 / 16（实际 ' + batchVals.join(',') + '）');
  ok(batchSel && batchSel.props.value === '10', '★ 题量默认 10');

  /* 索引反证 */
  const wired = loadPanel({ 19: true, [AI_OPEN]: true, [AI_CHANNEL]: 'direct', [AI_BATCH]: 5 });
  const chSel2 = findSelectByLabel(wired, /工作区窗口|隐藏直连/);
  const btSel2 = findSelectByLabel(wired, /逐题|题$/);
  ok(chSel2 && chSel2.props.value === 'direct', '★ INDEX 25 确为 aiChannel');
  ok(btSel2 && btSel2.props.value === '5', '★ INDEX 26 确为 aiBatch');

  const noSess = textOf(adv);
  ok(!/答题窗口会话：/.test(noSess), '★ 没会话时不渲染会话提示');
  const withSess = loadPanel({ 19: true, [AI_OPEN]: true, [AI_SESSION]: 'sess-abc123' });
  ok(/答题窗口会话：sess-abc123/.test(textOf(withSess)), '★ 有会话时回显会话 id');
}

console.log('== 9. 保存体（一章策略由「用 AI」+「保留/提交」推导）==');
{
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(/chapterQuiz:\s*aiEnabled\s*\?\s*\(chapterQuiz === 'submit' \? 'submit' : 'save'\)\s*:\s*'skip'/.test(src),
    '★ 关掉 AI → chapterQuiz=skip；开着 → 保留 save / 提交 submit');
  ok(/enabled:\s*aiEnabled/.test(src) && /dryRun:\s*aiDryRun/.test(src) && /model:\s*aiModel\.trim\(\)/.test(src),
    '★ ai 段写入 enabled / dryRun / model');
  ok(/channel:\s*aiChannel/.test(src), '★ ai 段写入 channel');
  ok(/batchSize:\s*Number\(aiBatch\)/.test(src), '★ ai 段写入 batchSize');
}

/* ---- 10. ★ D-025：内核圆点 = 内核实测在跑；未启动是灰不是红 ---- */
console.log('== 10. 内核圆点：未启动=灰、在跑=绿、文件缺=红 ==');
{
  const dotOf = (page, tab) => {
    let color = null;
    walk(page, (el) => {
      if (el.type === 'button' && el.props && el.props['data-cx-tab-id'] === tab) {
        walk(el, (c) => { if (c.props && 'data-cx-tabdot' in c.props) color = c.props.style && c.props.style.background; });
      }
    });
    return color;
  };
  const cAlive = dotOf(loadPanel({ 0: stFull }), '内核');
  ok(cAlive === '#16a34a', '★ 内核在跑 → 绿（实际 ' + cAlive + '）');
  const cDead = dotOf(loadPanel({ 0: { ...stFull, browser: { alive: false, lastErrorKind: '', restarts: 0 } } }), '内核');
  ok(cDead === '#9ca3af', '★ 内核只是没在跑（alive:false 无错）→ 灰不是红（实际 ' + cDead + '）');
  const cNoBr = dotOf(loadPanel({ 0: { ...stFull, browser: null } }), '内核');
  ok(cNoBr === '#9ca3af', '★ 浏览器状态缺失 → 灰（实际 ' + cNoBr + '）');
  const cNoEnv = dotOf(loadPanel({ 0: { ...stFull, engineReady: false, browser: null } }), '内核');
  ok(cNoEnv === '#ef4444', '★ 引擎文件缺失 → 红（实际 ' + cNoEnv + '）');
}

/* ---- 11. ★ D-029：选课圆点必须「登录成功 + 已选课」才绿 ---- */
console.log('== 11. 选课圆点：未登录不绿、登录且有课程才绿 ==');
{
  const dotOf = (page, tab) => {
    let color = null;
    walk(page, (el) => {
      if (el.type === 'button' && el.props && el.props['data-cx-tab-id'] === tab) {
        walk(el, (c) => { if (c.props && 'data-cx-tabdot' in c.props) color = c.props.style && c.props.style.background; });
      }
    });
    return color;
  };
  const URL_OK = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=143117166&courseId=204169157';
  /* 复现截图现场：有课程 URL，但登录态是 stale（上次扫码被中断）→ 必须灰 */
  const cStale = dotOf(loadPanel({ 0: stFull, 3: 'stale', 7: URL_OK }), '选课');
  ok(cStale === '#9ca3af', '★ 未登录(stale) + 有课程 URL → 灰（实际 ' + cStale + '）');
  /* 从未登录过（idle）也一样 */
  const cIdle = dotOf(loadPanel({ 0: stFull, 3: 'idle', 7: URL_OK }), '选课');
  ok(cIdle === '#9ca3af', '★ 未登录(idle) + 有课程 URL → 灰（实际 ' + cIdle + '）');
  /* 登录成功 + 有课程 → 绿 */
  const cOk = dotOf(loadPanel({ 0: stFull, 3: 'logged_in', 7: URL_OK }), '选课');
  ok(cOk === '#16a34a', '★ 登录成功 + 有课程 → 绿（实际 ' + cOk + '）');
  /* 登录成功但没选课 → 灰 */
  const cNoUrl = dotOf(loadPanel({ 0: stFull, 3: 'logged_in', 7: '   ' }), '选课');
  ok(cNoUrl === '#9ca3af', '★ 登录成功但课程地址为空 → 灰（实际 ' + cNoUrl + '）');
}

/* ---- 12. ★ D-040：答题圆点必须「AI 启用 + 章节测验非 skip」才绿 ---- */
console.log('== 12. 答题圆点：chapterQuiz=skip 时不许绿（假绿灯）==');
{
  const dotOf = (page, tab) => {
    let color = null;
    walk(page, (el) => {
      if (el.type === 'button' && el.props && el.props['data-cx-tab-id'] === tab) {
        walk(el, (c) => { if (c.props && 'data-cx-tabdot' in c.props) color = c.props.style && c.props.style.background; });
      }
    });
    return color;
  };
  /* 复现现场：aiEnabled=true 但 chapterQuiz='skip' → 必须灰 */
  const cSkip = dotOf(loadPanel({ 0: stFull, 19: true, 24: 'skip' }), '答题');
  ok(cSkip === '#9ca3af', '★ AI 开着但 chapterQuiz=skip → 灰（实际 ' + cSkip + '）');
  const cOff = dotOf(loadPanel({ 0: stFull, 19: false, 24: 'save' }), '答题');
  ok(cOff === '#9ca3af', '★ AI 关闭 → 灰（实际 ' + cOff + '）');
  const cSave = dotOf(loadPanel({ 0: stFull, 19: true, 24: 'save' }), '答题');
  ok(cSave === '#16a34a', '★ AI 开 + save → 绿（实际 ' + cSave + '）');
  const cSub = dotOf(loadPanel({ 0: stFull, 19: true, 24: 'submit' }), '答题');
  ok(cSub === '#16a34a', '★ AI 开 + submit → 绿（实际 ' + cSub + '）');
}

finish();

function finish() {
  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过 ==');
  process.exit(0);
}
