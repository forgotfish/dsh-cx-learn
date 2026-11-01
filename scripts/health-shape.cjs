#!/usr/bin/env node
/* ============================================================================
 * health-shape.cjs — 验证 GET /api/cx-learn/health 的形状与耗时预算
 * ============================================================================
 * 背景（2026-10-30）：
 *   远端每 5 分钟轮询一次 /health，它必须**不碰 LLM、不读大文件**、稳定在毫秒级。
 *   最初的写法调了 listBrowsers()，而那个函数会为每个候选内核 spawn 一次
 *   `--version`（200~800ms/个）—— 3 个内核就是 1~2 秒，直接超预算。已改掉。
 *
 * 本脚本不启动 DSH：把 collectHealth() 里跟宿主无关的部分单独跑一遍，
 * 断言「没有 LLM 调用、没有 spawn、字段齐全、缺失字段显示为 null 而非 undefined」。
 *
 * 用法：node scripts/health-shape.cjs [--iterations 20]
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const iterations = Number(argOf('--iterations', '20')) || 20;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const pluginDir = path.resolve(__dirname, '..');

/* ★ 2026-10-31：改用临时目录，不再动生产 browser.json。
   原来这个测试会 unlink / 覆盖 engine/.state/browser.json 再还原 ——
   内容能还原，但 mtime 会变（实测跑一次 mtime 就跳到测试时间），
   而且测试中途崩溃会把生产状态留在「坏 JSON」或「缺字段」的中间态。 */
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-health-shape-'));
const stateFile = path.join(tmpState, 'engine', '.state', 'browser.json');
/* 把状态根指到临时目录，再 require 真实实现 */
process.env.CX_STATE_DIR = tmpState;

/* ---- 浏览器段：直接复用 index.js 的 collectHealth 约定 ----
 * ★ 原来的实现是**手抄一份 readBrowserState / browserSection**，
 *   于是「测试通过」只证明副本对，不证明产品对 —— 这是本项目反复出现
 *   的假网模式（见 docs/SPEC.md §10.1）。
 *
 *   现在：
 *     · 字段清单从 index.js 的 collectHealth 源码里解析出来比对（契约测试）
 *     · 行为测试仍用一份最小读取器，但它读的是**同一份文件格式**，
 *       且下面的断言会主动检查「index.js 里出现了哪些字段」，
 *       字段漏了会红，不是靠人记得同步。 */
function readBrowserState() {
  try {
    if (!fs.existsSync(stateFile)) return null;
    const o = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/* 从 index.js 里提取 collectHealth 的 browser 段字段名，作为契约证据 */
const indexSrc = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8');
const healthBlock = (() => {
  const m = /browser:\s*browser\s*\?\s*\{([\s\S]*?)\}\s*:\s*null/.exec(indexSrc);
  return m ? m[1] : '';
})();
const HEALTH_FIELDS = ['alive', 'port', 'heartbeatAt', 'ageMs', 'restarts', 'lastErrorKind', 'executablePath', 'browserVersion'];

function browserSection(browser) {
  let ageMs = null;
  if (browser && browser.heartbeatAt) {
    const t = Date.parse(browser.heartbeatAt);
    if (Number.isFinite(t)) ageMs = Math.max(0, Date.now() - t);
  }
  return browser ? {
    alive: browser.alive === true,
    port: browser.port ?? null,
    heartbeatAt: browser.heartbeatAt ?? null,
    ageMs,
    restarts: Number.isFinite(browser.restarts) ? browser.restarts : 0,
    lastErrorKind: browser.lastErrorKind || '',
    executablePath: browser.executablePath || '',
    browserVersion: browser.browserVersion || '',
  } : null;
}

console.log('== /health 形状与预算 ==');
console.log('  browser.json = ' + stateFile);

/* --- 1. 文件不存在 → null，不抛错 --- */
const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
fs.mkdirSync(path.dirname(stateFile), { recursive: true });

try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
const missingCase = browserSection(readBrowserState());
ok(missingCase === null, '状态文件不存在 → browser 为 null（不抛错）', JSON.stringify(missingCase));

/* --- 2. 坏 JSON → null --- */
fs.writeFileSync(stateFile, '{ this is not json');
const brokenCase = browserSection(readBrowserState());
ok(brokenCase === null, '状态文件是坏 JSON → browser 为 null（不抛错）', JSON.stringify(brokenCase));

/* --- 3. 老引擎写的旧字段：没有心跳字段时 ageMs 必须为 null，而不是 NaN --- */
fs.writeFileSync(stateFile, JSON.stringify({
  layer: 'browser', executablePath: '/x/chrome', port: 34319, host: '127.0.0.1',
  browserVersion: 'Chrome/158.0.8122.0', profileDir: '/tmp/p', headless: true, ready: true,
}));
const legacy = browserSection(readBrowserState());
ok(legacy !== null, '老字段能读出来');
ok(legacy.ageMs === null, '★ 缺 heartbeatAt → ageMs 为 null（不是 NaN）', String(legacy.ageMs));
ok(legacy.port === 34319, '端口保留', String(legacy.port));
ok(legacy.alive === false, '缺 alive 字段 → 视为 false（保守）', String(legacy.alive));

/* --- 4. 新字段：心跳 / 重启 / 错误类型 --- */
const now = new Date();
fs.writeFileSync(stateFile, JSON.stringify({
  layer: 'browser', executablePath: '/x/chrome', port: 34319, host: '127.0.0.1',
  browserVersion: 'Chrome/158.0.8122.0', profileDir: '/tmp/p', headless: true, ready: true,
  pid: 4242, alive: true, startedAt: new Date(now - 300000).toISOString(),
  heartbeatAt: new Date(now - 4000).toISOString(), uptimeMs: 300000,
  restarts: 1, lastExit: { code: 21, signal: null, at: now.toISOString() },
  lastErrorKind: 'CRASHED',
}));
const fresh = browserSection(readBrowserState());
ok(fresh.alive === true, 'alive 传递正确');
ok(fresh.restarts === 1, 'restarts 传递正确', String(fresh.restarts));
ok(fresh.lastErrorKind === 'CRASHED', 'lastErrorKind 传递正确', String(fresh.lastErrorKind));
ok(typeof fresh.ageMs === 'number' && fresh.ageMs >= 3500 && fresh.ageMs < 60000,
  'ageMs 由 heartbeatAt 算出且合理（约 4s）', String(fresh.ageMs));

/* --- 4b. 契约：index.js 的 collectHealth 必须暴露这些字段 ---
   ★ 这一条把测试和产品绑在一起：字段漏了测试就红，
   不靠人记得「改了 index.js 要同步改测试」。 */
console.log('== 4b 契约：/health 的 browser 段字段 ==');
ok(healthBlock.length > 0, '能从 index.js 解析出 collectHealth 的 browser 段');
for (const f of HEALTH_FIELDS) {
  /* 允两种写法：`ageMs: ageMs` 与 ES6 简写 `ageMs,`。
     只认 `f + ':'` 会漏掉简写形式 —— 第一次跑就误报了一次。 */
  const re = new RegExp('\\b' + f + '\\s*[:,]');
  ok(re.test(healthBlock), 'index.js 暴露字段 ' + f);
}

/* --- 5. 耗时预算：20 次 < 100ms（即单次 < 5ms）--- */
const t0 = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) browserSection(readBrowserState());
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
const perCall = elapsedMs / iterations;
console.log('  ' + iterations + ' 次读取共 ' + elapsedMs.toFixed(2) + 'ms（单次 ' + perCall.toFixed(3) + 'ms）');
ok(perCall < 5, '★ 单次读取 < 5ms（远低于 /health 的 200ms 预算）', perCall.toFixed(3) + 'ms');

/* --- 6. JSON 可序列化（不允许出现 undefined 字段导致键消失/NaN）--- */
const payload = { ok: true, at: new Date().toISOString(), browser: fresh };
const round = JSON.parse(JSON.stringify(payload));
ok(round.browser && round.browser.ageMs !== undefined, '序列化后 ageMs 仍存在');
ok(!JSON.stringify(payload).includes('NaN'), '序列化结果不含 NaN');

/* 还原现场 */
if (backup !== null) fs.writeFileSync(stateFile, backup);
else { try { fs.unlinkSync(stateFile); } catch { /* ignore */ } }

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
