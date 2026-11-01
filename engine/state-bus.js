/* ============================================================================
 * state-bus.js — 两层之间的中间状态总线
 * ============================================================================
 *
 * 【解决什么问题】
 *   浏览器层和业务层以前靠「共享内存变量 + 读对方日志」沟通，于是：
 *     · 两边同时在改 run.log 的格式，谁也看不懂对方的输出
 *     · A 改了字段名，B 静默读到 undefined，跑很久才发现
 *     · git 冲突不断，因为改动都落在同一个大文件的相邻行
 *
 *   改成：双方只通过**约定好的 JSON 文件**交换运行期事实。
 *   文件格式写在 adapter-contract.js 的 FILES 里，加字段安全，改字段要双方同意。
 *
 * 【设计原则】
 *   · 写：原子写入（先写 .tmp 再 rename），避免读到半个文件
 *   · 读：永不抛错，坏文件当作「没有」，返回 null
 *   · 事件流：append-only ndjson，一行一条，方便 grep / tail
 *   · 任何一层崩了，另一层能从这个文件看出「它进行到哪一步」
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 从契约文件取路径，保证两边用同一个定义 */
let CONTRACT;
try {
  CONTRACT = require('./adapter-contract.js');
} catch (_) {
  /* 契约文件被误删时不能让引擎起不来，用同样的默认值兜底 */
  CONTRACT = { FILES: {
    browser: 'engine/.state/browser.json',
    learn: 'engine/.state/learn.json',
    events: 'engine/.state/events.ndjson',
  } };
}

/**
 * 状态根目录。
 *
 * ★ 2026-10-31：支持 `CX_STATE_DIR` 覆盖。
 *   为什么必须要：测试（`--self-test` 与各 .cjs）跑起来会写 learn.json /
 *   events.ndjson，把**生产状态**覆盖成测试数据 —— 设置页里「上次停止原因」
 *   于是显示的是自测留下的假值。实测过一次：跑完自测，`learn.json` 的
 *   mtime 立刻从真实运行时间变成自测时间。
 *
 *   现在测试一律把 CX_STATE_DIR 指到临时目录，生产状态不再被动过。
 *   未设置时行为与以前完全一致（相对插件根目录）。 */
const ROOT = path.resolve(__dirname, '..');
const STATE_ROOT = process.env.CX_STATE_DIR
  ? path.resolve(process.env.CX_STATE_DIR)
  : ROOT;
const abs = (rel) => path.resolve(STATE_ROOT, rel);

function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
}

/**
 * 原子写 JSON。
 * @param {string} relPath  FILES 里的相对路径
 * @param {object} obj      要写的对象（会自动补 updatedAt）
 */
function writeJson(relPath, obj) {
  const file = abs(relPath);
  ensureDir(file);
  const tmp = file + '.tmp';
  const payload = Object.assign({}, obj, { updatedAt: new Date().toISOString() });
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

/**
 * 读 JSON。永不抛错；文件不存在或坏了都返回 null。
 * @param {string} relPath
 */
function readJson(relPath) {
  try {
    const raw = fs.readFileSync(abs(relPath), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (_) {
    return null;
  }
}

/**
 * 追加一条事件（ndjson）。文件超过 2MB 自动轮转一次，避免无限增长。
 * @param {string} layer  'browser' | 'learn' | 'plugin'
 * @param {string} kind   事件类型，如 'navigate' / 'section-advance' / 'stop'
 * @param {object} [data] 附加字段
 */
function emit(layer, kind, data) {
  const file = abs(CONTRACT.FILES.events);
  ensureDir(file);
  /* ★ 2026-10-31：事件流也要脱敏。
     调用方常把 topUrl / 当前 URL 一起写进来，那是带 enc/cpi/uuid 的完整 URL。
     events.ndjson 会被插件读出来展示、也会被复制进排查报告，所以在这里收口。
     依赖保持单向：state-bus 不 require logger（logger 依赖 config，会成环），
     脱敏规则复制一份最小实现 —— 由 engine/redact.test.cjs 同时钉住两处一致。 */
  const line = JSON.stringify(Object.assign(
    { at: new Date().toISOString(), layer: layer || 'unknown', kind: kind || 'event' },
    sanitize(data || {})
  )) + '\n';
  try {
    /* 简易轮转：超过 2MB 就改名留一份，主文件重开 */
    try {
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch (_) { /* 文件还不存在，正常 */ }
    fs.appendFileSync(file, line, 'utf8');
  } catch (_) { /* 事件流写不进去不能影响主流程 */ }
}

/* 与 core/logging.js 的 redact 保持一致的最小实现（只处理必须脱敏的两类） */
const _Q = /([?&](?:enc|cpi|openc|uuid|_uid|uf|vc3|token)=)([^&#\s"']*)/gi;
function sanitize(v) {
  if (typeof v === 'string') {
    let s = v.replace(_Q, (_a, head) => head + '***');
    s = s.replace(/\b(password|passwd|token|api[_-]?key|authorization)\b(\s*[:=]\s*)(['"]?)([^\s'",;}]{3,})\3/gi,
      (_a, k, sep, q) => k + sep + q + '***' + q);
    return s;
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitize(v[k]);
    return out;
  }
  return v;
}

/** 读最近 N 条事件（排查用） */
function tailEvents(n) {
  const want = Math.max(1, Math.min(500, n || 50));
  try {
    const raw = fs.readFileSync(abs(CONTRACT.FILES.events), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-want).map((l) => {
      try { return JSON.parse(l) } catch (_) { return { raw: l } }
    });
  } catch (_) { return [] }
}

/* —— 两层的专用读写口（避免各自拼字段名）—— */

/** 浏览器层：报告内核与 CDP 现状 */
function reportBrowser(info) {
  return writeJson(CONTRACT.FILES.browser, Object.assign({ layer: 'browser' }, info || {}));
}
/** 业务层：读浏览器层留下的现状 */
function readBrowser() { return readJson(CONTRACT.FILES.browser); }

/** 业务层：报告当前学习进度 */
function reportLearn(info) {
  return writeJson(CONTRACT.FILES.learn, Object.assign({ layer: 'learn' }, info || {}));
}
/** 浏览器层 / 插件：读业务层进度 */
function readLearn() { return readJson(CONTRACT.FILES.learn); }

module.exports = {
  writeJson,
  readJson,
  emit,
  tailEvents,
  reportBrowser,
  readBrowser,
  reportLearn,
  readLearn,
  FILES: CONTRACT.FILES,
};
