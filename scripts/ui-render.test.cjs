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

const sections = groupSections(page);
const groupNames = Object.keys(sections);
console.log('  分组：' + groupNames.join(' / '));
ok(JSON.stringify(groupNames) === JSON.stringify(['浏览器环境', '课程业务']),
  '★ 只分两块，且顺序是「浏览器环境 → 课程业务」（实际 ' + groupNames.join(' / ') + '）');

const allButtons = buttonsIn([page]);
console.log('  按钮：' + allButtons.map((b) => textOf(b).trim()).join(' / '));

ok(allButtons.length > 0, '面板上有按钮');
ok(allButtons.every((b) => typeof b.props.onClick === 'function'), '★ 每个按钮都绑定了 onClick（无「定义了但没绑定」）');

const groups = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, buttonsIn(v).map((b) => textOf(b).trim())]));
const browserBtns = groups['浏览器环境'] || [];
const courseBtns = groups['课程业务'] || [];

ok(['刷新', '重启内核', '结束会话'].every((t) => browserBtns.includes(t)),
  '★ 浏览器环境含：刷新 / 重启内核 / 结束会话（实际 ' + browserBtns.join(',') + '）');
ok(['开始登录', '刷新二维码', '读取我的课程', '保存配置', '撤销改动', '开始看课', '停止'].every((t) => courseBtns.includes(t)),
  '★ 课程业务含：登录 / 课程 / 启停（实际 ' + courseBtns.join(',') + '）');

ok(!browserBtns.includes('开始看课'), '★「开始看课」不在浏览器环境组');
ok(!courseBtns.includes('重启内核') && !courseBtns.includes('结束会话'),
  '★「重启内核 / 结束会话」不在课程业务组（属于浏览器层）');

console.log('== 2. 已删除的答题 UI 不得回来 ==');
const pageText = textOf(page);
ok(!/答题方式/.test(pageText), '★ 不再有「答题方式」下拉');
ok(!/模型/.test(pageText), '★ 页面上不再出现「模型」字样');
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
]);
const orphan = [...routes].filter((r) => !used.has(r) && !noUiNeeded.has(r));
ok(orphan.length === 0, '★ 没有「后端实现了但前端从不调用」的路由（孤儿：' + orphan.join(',') + '）');

/* ── 数据态：登录完成、有二维码、有题目、有日志 ────────────────────────
 * 空状态渲染不到的分支（会话进行中、二维码图片、题目列表）最容易白屏，
 * 因为平时看不到。这里按 useState 顺序灌入真实形状的数据。
 * 顺序：0 st / 1 qr / 2 busy / 3 loginState / 4 loginHint / 5 msg / 6 zoom /
 *       7 url / 8 mode / 9 maxSections / 10 browserId / 11 chromiumPath /
 *       12 questions / 13 draftText / 14 needLogin / 15 courses /
 *       16 loadingCourses / 17 dirty
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
