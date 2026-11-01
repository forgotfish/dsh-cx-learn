#!/usr/bin/env node
/* split-engine.cjs — 把 8133 行的 engine/chaoxing-autolearn.js 按职责拆成 engine/src/* 模块
 *
 * 设计原则（刻意保守）：
 *   1. 只搬运代码，不改逻辑；行号区间人工核对过。
 *   2. 依赖从**剥离注释与字符串后的标识符**推断（否则注释里的 'run'/'fs' 会把依赖搞乱，
 *      上一版就是这么把 base ↔ logging 弄成循环的）。
 *   3. 推断出图后检查必须是 DAG（无环），有环直接报错停下。
 *   4. 拆完必须：node --check 全绿 + require 得动 + self-test + 全部测试脚本。
 *
 * 用法：node scripts/split-engine.cjs [--dry]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/* 迁移源：拆分前的单文件（8133 行）副本。
   不能指向 engine/chaoxing-autolearn.js —— 那个路径已经是拆分后的入口薄壳了。 */
const SRC_FILE = path.join(__dirname, '.migration', 'chaoxing-autolearn.v1.js');
const OUT_DIR = path.join(ROOT, 'engine', 'src');

if (!fs.existsSync(SRC_FILE)) {
  console.error('找不到迁移源：' + SRC_FILE);
  console.error('可先用 git show <提交>:engine/chaoxing-autolearn.js > 该路径 还原。');
  process.exit(1);
}

/* 注意：切片必须用**原始行号**，所以这里不做任何拆行/插行。
   「块注释结束符与声明挤在同一行」（`*\/const CONFIG = {`）只在生成代码体时
   用 normalizeBody 拆开 —— 否则 ^const 匹配不到，CONFIG 不会被识别成顶层声明。 */
const lines = fs.readFileSync(SRC_FILE, 'utf8').split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

function normalizeBody(body) {
  /* 只处理「块注释续行以 *\/ 结尾、紧跟声明」这一种（例如
       * ==========================================*\/const CONFIG = {
     前提是**行首第一个非空字符是 `*`**，否则会把函数体里的
     `  } /* ignore *\/ const x = 1` 也提到行首，局部变量就会被误判成顶层声明。 */
  return body.replace(/^[ \t]*\*.*\*\/[ \t]*((?:const|let|var|async\s+function|function|class)\s+)/gm, function (all, decl) {
    return all.slice(0, all.length - decl.length) + '\n' + decl;
  });
}

/* ---------------------------------------------------------------------------
 * 模块表：ranges = 1-based 闭区间（可多段，用来跳过属于别的模块的片段）
 * -------------------------------------------------------------------------*/
const MODULES = [
  {
    file: 'core/base.js',
    note: '内置依赖、分层中间件加载、错误类型、定时原语、常量',
    ranges: [[53, 95], [124, 134]]
  },
  {
    file: 'core/questions.js',
    note: '题目事件（识别 → 人工审阅）JSONL 写入与去重',
    ranges: [[96, 122]]
  },
  {
    file: 'browser/args.js',
    note: '内核启动参数、调试端口发现、启动失败归因（纯函数）',
    ranges: [[136, 620]]
  },
  {
    file: 'core/config.js',
    note: 'CONFIG 默认值、深合并、参数校验、答案字母解析',
    ranges: [[622, 802]]
  },
  {
    file: 'core/logging.js',
    note: 'humanize（拟人化延迟）、logger（结构化日志 + 环形缓冲）、启动横幅',
    ranges: [[1992, 2095]]
  },
  {
    file: 'browser/cdp.js',
    note: 'CDP 适配器：连接、target 管理、注入求值、真实输入事件、截图',
    ranges: [[804, 1990]]
  },
  {
    file: 'learn/selectors.js',
    note: 'SELECTORS 候选注册表 + 页面探针脚本 + 注入表达式构造',
    ranges: [[2097, 3123]]
  },
  {
    file: 'learn/machine.js',
    note: 'LearnMachine 业务状态机（P0–P4：播放/切节/弹题/跳过/上限）',
    ranges: [[3124, 4861]]
  },
  {
    file: 'learn/run.js',
    note: 'run() 主循环：前置检查、自动点进课程、带停止条件的循环',
    ranges: [[4863, 5153]]
  },
  {
    file: 'login/index.js',
    note: '扫码登录（只按 URL 是否离开登录域判定）、一次性 profile、登录态预检',
    /* 故意跳过两段死代码（2026-10-30 登录重写后的遗留）：
       · 5553-5561 sweepEphemeralProfiles —— 无人调用
       · 5594-5918 旧二维码会话机制（readQrUuid / readQrSession / fetchQrAuthStatus /
         refreshQrInPage / fetchQrAuthStatusInPage / fetchQrDataUrl / applyQrDataUrl /
         qrImageLooksEmpty）—— 新版登录不再碰 /getauthstatus 与 createqr，全部无人调用 */
    ranges: [[5155, 5552], [5562, 5593], [5919, 6016]]
  },
  {
    file: 'browser/exit-guard.js',
    note: '进程退出守卫：任何退出路径都收掉浏览器，避免占着调试端口',
    ranges: [[6018, 6038]]
  },
  {
    file: 'mcp.js',
    note: 'MCP stdio server（零依赖）+ CLI 参数解析',
    ranges: [[6041, 6141]]
  },
  {
    file: 'selftest.js',
    note: '自测（Mock 适配器驱动状态机）+ Mock 适配器',
    ranges: [[6143, 6567]]
  },
  {
    file: 'courses.js',
    note: '课程列表、只读结构扫描、任务点扫描、课程报告（2026-10-27 新版页面适配）',
    ranges: [[6568, 7881]]
  }
];

/* ---------------------------------------------------------------------------
 * 1. 取代码体 + 收集顶层声明
 * -------------------------------------------------------------------------*/
const DECL_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)\s*=|^let\s+([A-Za-z_$][\w$]*)\s*=/gm;
/* ★ 解构声明也要认：`const { spawn } = require('node:child_process')`。
   漏了它 → spawn 不进「可导出名字」表 → 搬进 cdp.js 后没人给它补 import
   → 运行时 `spawn is not defined`（真实踩过，上机登录才炸）。 */
const DESTRUCT_RE = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/gm;

function topLevelNames(body) {
  const out = [];
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(body)) !== null) {
    const n = m[1] || m[2] || m[3] || m[4];
    if (n && out.indexOf(n) < 0) out.push(n);
  }
  /* 解构：{ a, b: c, d = 1, ...rest } → a, c, d, rest */
  DESTRUCT_RE.lastIndex = 0;
  while ((m = DESTRUCT_RE.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().replace(/^\.\.\./, '');
      if (!clean) continue;
      const name = clean.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && out.indexOf(name) < 0) out.push(name);
    }
  }
  return out;
}

const mods = MODULES.map((m) => {
  const body = normalizeBody(m.ranges.map(([a, b]) => slice(a, b)).join('\n'));
  return { ...m, body, names: topLevelNames(body) };
});

/* ---------------------------------------------------------------------------
 * 2b. 跨模块可变状态的显式改写 + 相对路径修正
 * ---------------------------------------------------------------------------
 * 原文件里 _activeAdapter 是同一个作用域内的 let，runLogin 里直接 `_activeAdapter = adapter`。
 * 拆成模块后这行赋值只会改到本模块的局部绑定，退出守卫永远拿不到 adapter
 * （CommonJS 的 require 是值拷贝，不是活绑定），必须改成 setter。
 */
{
  const guard = mods.find((m) => m.file === 'browser/exit-guard.js');
  guard.body = guard.body.replace(
    'let _activeAdapter = null;',
    'let _activeAdapter = null;\n' +
    '/** 由登录/看课流程登记当前 adapter，供退出守卫在进程结束时收掉浏览器。 */\n' +
    'function setActiveAdapter(a) { _activeAdapter = a; }'
  );
  guard.names = topLevelNames(guard.body);

  const login = mods.find((m) => m.file === 'login/index.js');
  login.body = login.body.replace(/(^|[^.\w$])_activeAdapter\s*=\s*adapter;/gm, '$1setActiveAdapter(adapter);');

  /* base.js 搬到了 engine/src/core/，分层中间件的四个文件仍在 engine/ 根下，
     相对路径要跟着上跳两级，否则 require 失败 → 静默降级 → 心跳/事件总线全哑。 */
  const base = mods.find((m) => m.file === 'core/base.js');
  base.body = base.body
    .replace(/require\('\.\/adapter-contract\.js'\)/, "require('../../adapter-contract.js')")
    .replace(/require\('\.\/state-bus\.js'\)/, "require('../../state-bus.js')")
    .replace(/require\('\.\/browser-health\.js'\)/, "require('../../browser-health.js')")
    .replace(/require\('\.\/login-flow\.js'\)/, "require('../../login-flow.js')");
}

/* ---------------------------------------------------------------------------
 * 2. 剥离注释与字符串（保留换行，便于定位）
 * -------------------------------------------------------------------------*/
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {                     // 行注释
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {                     // 块注释
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {         // 字符串 / 模板字面量
      const q = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const PROVIDED = new Map();
for (const m of mods) for (const n of m.names) if (!PROVIDED.has(n)) PROVIDED.set(n, m);

const EXTERNAL = new Set(['require', 'module', 'exports', 'process', 'console', 'Buffer', 'globalThis',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'fetch', 'WebSocket',
  'URL', 'TextDecoder', 'TextEncoder', 'AbortController', 'structuredClone', 'queueMicrotask',
  'Object', 'Array', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'escape', 'unescape', 'Reflect', 'Proxy', 'Intl', 'Atomics', 'arguments', 'undefined', 'NaN',
  'Infinity', '__dirname', '__filename', 'eval', 'Function']);

/* 判断剥离后的代码里是否**真的引用了**某个标识符。
 * 排除两类误判（都真实踩过）：
 *   1. 对象字面量的键名（`  humanize: {`）—— 不是引用；
 *   2. 属性访问（`obj.humanize`）—— 不是顶层引用。 */
function usesIdentifier(code, name) {
  const esc = name.replace(/\$/g, '\\$');
  const re = new RegExp('(^|[^.\\w$])' + esc + '(?![\\w$])', 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[1].length;
    const after = code.slice(start + name.length);
    const before = code.slice(0, start);
    /* 键名：行首（仅缩进） + 名字 + ':' */
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
    if (/^\s*$/.test(lineBefore) && /^\s*:/.test(after)) continue;
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * 3. 推断依赖（只看剥离后的代码）
 * -------------------------------------------------------------------------*/
for (const m of mods) {
  const code = stripNoise(m.body);
  const need = new Map();
  for (const [name, owner] of PROVIDED) {
    if (owner === m) continue;
    if (EXTERNAL.has(name)) continue;
    if (!usesIdentifier(code, name)) continue;
    if (!need.has(owner.file)) need.set(owner.file, new Set());
    need.get(owner.file).add(name);
  }
  m.need = need;
}

/* ---------------------------------------------------------------------------
 * 4. 环检测（必须 DAG）
 * -------------------------------------------------------------------------*/
if (process.argv.includes('--edges')) {
  for (const m of mods) {
    console.log(m.file + '  ->  ' + [...m.need.keys()].sort().join(', '));
  }
  process.exit(0);
}
if (process.argv.includes('--names')) {
  for (const m of mods) console.log(m.file + ': ' + m.names.join(', '));
  process.exit(0);
}
if (process.argv.includes('--deps')) {
  for (const m of mods) {
    for (const [f, ns] of m.need) console.log(m.file + '  ->  ' + f + '  [' + [...ns].sort().join(', ') + ']');
  }
  process.exit(0);
}
if (process.argv.includes('--why')) {
  const target = process.argv[process.argv.indexOf('--why') + 1];
  for (const m of mods) {
    const code = stripNoise(m.body);
    const hit = usesIdentifier(code, target);
    if (!hit) continue;
    const idx = code.indexOf(target);
    console.log('--- ' + m.file + ' 命中 ' + target + ' @' + idx);
    console.log('    ' + JSON.stringify(code.slice(Math.max(0, idx - 100), idx + 80)));
  }
  process.exit(0);
}
{
  const state = new Map(); // file -> 0/1/2
  const stack = [];
  const cycles = [];
  const visit = (m) => {
    const s = state.get(m.file) || 0;
    if (s === 2) return;
    if (s === 1) { cycles.push([...stack, m.file].join(' → ')); return; }
    state.set(m.file, 1);
    stack.push(m.file);
    for (const dep of m.need.keys()) {
      const target = mods.find((x) => x.file === dep);
      if (target) visit(target);
    }
    stack.pop();
    state.set(m.file, 2);
  };
  for (const m of mods) visit(m);
  if (cycles.length) {
    console.error('!! 检测到循环依赖，停止拆分：');
    for (const c of cycles) console.error('   ' + c);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------------------
 * 5. 生成文件
 * -------------------------------------------------------------------------*/
function rel(fromFile, toFile) {
  const r = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return r.startsWith('.') ? r : './' + r;
}

const dry = process.argv.includes('--dry');
let count = 0;

for (const m of mods) {
  const header = [
    '/* ============================================================================',
    ' * engine/src/' + m.file + ' — ' + m.note,
    ' * ----------------------------------------------------------------------------',
    ' * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。',
    ' * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。',
    ' * ==========================================================================*/',
    "'use strict';",
    ''
  ];
  for (const [depFile, names] of [...m.need.entries()].sort()) {
    header.push('const { ' + [...names].sort().join(', ') + " } = require('" + rel(m.file, depFile) + "');");
  }
  if (m.need.size) header.push('');

  const names = m.names;
  const footer = ['', 'module.exports = {', '  ' + names.join(',\n  '), '};', ''];
  const content = header.join('\n') + '\n' + m.body + '\n' + footer.join('\n');

  if (dry) {
    console.log('=== engine/src/' + m.file + '  (' + m.body.split('\n').length + ' 行, 导出 ' + names.length + ')');
    for (const [depFile, ns] of [...m.need.entries()].sort()) {
      console.log('    ← ' + depFile + '  [' + [...ns].sort().join(', ') + ']');
    }
    if (!names.length) console.log('    (无导出)');
  } else {
    const target = path.join(OUT_DIR, m.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    count += 1;
    console.log('written engine/src/' + m.file + '  (' + content.split('\n').length + ' 行)');
  }
}

if (!dry) console.log('\n共写出 ' + count + ' 个模块');
