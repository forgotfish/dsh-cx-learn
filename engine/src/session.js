/* ============================================================================
 * engine/src/session.js — 会话生命周期（B-精简的核心）
 * ============================================================================
 *
 * 【为什么需要】
 *   原设计里「一次看课任务」= 「一个浏览器生命周期」：任务结束就
 *   关内核 + 删 profile。于是：
 *     · 跑完一门课想接着刷第二门 → 必须重新扫码
 *     · 中途碰壁停下（随堂题失败 / 手动停止）→ 也必须重扫
 *   实测用户诉求（2026-10-31）：「整个刷课过程里不死，刷完再死」。
 *
 * 【会话是什么】
 *   一段「浏览器允许活着」的时间窗。窗口内：
 *     · 内核不关、profile 不删
 *     · 读课程 / 看课 / 再读课程 / 再看课 都可以复用同一个内核
 *   窗口关闭的唯一三种方式：
 *     1. 用户点「结束会话」
 *     2. 闲置超过 keepAliveMs 没有任何请求
 *     3. DSH 关闭 / 插件卸载
 *
 * 【与「一次性登录」的关系】
 *   仍然是一次性：会话结束就删 profile，下次必须重扫。
 *   变化的只是**会话的粒度**：从「一次任务」放宽到「一段连续使用」。
 *
 * 【文件】
 *   `$STATE/session.json` — 会话状态，插件与引擎都读。
 *   写方：插件（宿主）唯一写。引擎只读、只上报心跳时间。
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 会话状态文件（放在插件状态目录，而不是引擎目录 —— 它属于运行期数据） */
function sessionFile(stateDir) {
  return path.join(stateDir || process.env.CX_STATE_DIR || '.', 'session.json');
}

/** 一次性登录 profile 目录（会话期间复用，会话结束才删） */
function ephemeralDir() {
  return path.join(os.tmpdir(), 'cx-learn-ephemeral', 'session');
}

const DEFAULT_KEEP_ALIVE_MS = 30 * 60 * 1000; // 30 分钟无请求 → 自动结束

/**
 * 读会话状态。永不抛错；不存在/坏文件 → null。
 * @returns {null | {active:boolean, startedAt:string, lastUsedAt:string, port:number|null,
 *                   kernelPid:number|null, reason?:string}}
 */
function readSession(stateDir) {
  try {
    const raw = fs.readFileSync(sessionFile(stateDir), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (_) {
    return null;
  }
}

/** 原子写会话状态。失败返回 false，不抛错。 */
function writeSession(stateDir, patch) {
  const file = sessionFile(stateDir);
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = readSession(stateDir) || {};
    const next = Object.assign({}, prev, patch, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return false;
  }
}

/**
 * 标记会话活跃（每次请求开始时调用）。
 * 不新建会话 —— 只刷新 lastUsedAt，避免「请求顺手把死会话复活」。
 */
function touchSession(stateDir) {
  const cur = readSession(stateDir);
  if (!cur || !cur.active) return null;
  writeSession(stateDir, { lastUsedAt: new Date().toISOString() });
  return readSession(stateDir);
}

/** 开启会话（登录成功后调用）。重复调用不重置 startedAt。 */
function openSession(stateDir, info) {
  const cur = readSession(stateDir);
  if (cur && cur.active) {
    return writeSession(stateDir, Object.assign({ reason: '' }, info || {}, { lastUsedAt: new Date().toISOString() }));
  }
  const next = Object.assign({
    active: true,
    startedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    /* ★ 开会话要把上一次的关闭原因清掉：否则 UI 上一边显示「会话进行中」，
       一边还挂着 reason=kernel_dead/login_failed 这种历史值。 */
    reason: '',
    port: null,
    kernelPid: null,
  }, info || {});
  /* ★ 2026-10-31 真机事故：登录成功后 2.4 秒会话就被判死、profile 被删。
     原因是宿主先 `syncSessionFromBrowserJson()` 把 port/pid 写进会话，
     紧接着 `openSession()` 用默认值 port:null 把它们覆盖掉 → watcher 看到
     port=null 就 probe 失败 → 判 kernel_dead → 清会话 + 删 profile。
     这里保留「已经写在会话里、本次也没显式传」的端口信息。 */
  if (cur && next.port == null && cur.port != null) next.port = cur.port;
  if (cur && next.kernelPid == null && cur.kernelPid != null) next.kernelPid = cur.kernelPid;
  return writeSession(stateDir, next);
}

/** 关闭会话（只改状态，删 profile / 关内核由调用方做，因为那是平台相关动作）。 */
function closeSession(stateDir, reason) {
  return writeSession(stateDir, {
    active: false,
    closedAt: new Date().toISOString(),
    reason: String(reason || ''),
    port: null,
    kernelPid: null,
  });
}

/**
 * 会话是否应该被自动结束（闲置超时）。
 * @returns {{expire:boolean, idleMs:number}}
 */
function shouldExpire(stateDir, keepAliveMs) {
  const cur = readSession(stateDir);
  if (!cur || !cur.active) return { expire: false, idleMs: 0 };
  const last = Date.parse(cur.lastUsedAt || cur.startedAt || '');
  if (!Number.isFinite(last)) return { expire: false, idleMs: 0 };
  const idleMs = Date.now() - last;
  const limit = Number(keepAliveMs) > 0 ? Number(keepAliveMs) : DEFAULT_KEEP_ALIVE_MS;
  return { expire: idleMs >= limit, idleMs };
}

module.exports = {
  sessionFile,
  ephemeralDir,
  DEFAULT_KEEP_ALIVE_MS,
  readSession,
  writeSession,
  touchSession,
  openSession,
  closeSession,
  shouldExpire,
};
