/* ============================================================================
 * browser-health.js — 浏览器层健康心跳（零 npm 依赖，CommonJS）
 * ============================================================================
 *
 * 【解决什么问题】
 *   浏览器层和业务层分处两个进程/两个发布节奏，插件读 browser.json 时
 *   只能看到「上次启动成功」这个静态事实。内核中途崩了，browser.json 里
 *   仍然写着 ready:true / alive 无从判断 —— 设置页和远端监测都看不出
 *   「进程已经没了」。于是出现「界面说就绪，实际连不上」。
 *
 *   这里给浏览器层加一层心跳：定时探一次 CDP 端点，把「此刻还活着吗」
 *   连同 pid / uptime / 重启次数 / 最后一次退出原因一起写进中间文件。
 *
 * 【设计原则】
 *   · 只追加字段，绝不删已有字段（读方可能是旧版本插件）
 *   · 写之前先读回来合并，不覆盖业务层/旧版本写进去的其它字段
 *   · 探测永不抛错：探不到就是 alive:false，不是崩溃
 *   · 单例：重复 start 只保留一个定时器，stop 幂等
 *   · 定时器期间任何异常都不能把宿主进程带崩
 * ==========================================================================*/
'use strict';

/** 默认心跳间隔：15 秒。低于 1 秒没有意义（探测本身就要几十毫秒）。 */
const DEFAULT_INTERVAL_MS = 15000;
const MIN_INTERVAL_MS = 1000;

/** @type {NodeJS.Timeout|null} */
let _timer = null;
/** 当前心跳的上下文（stop 时用来收尾） */
let _ctx = null;
/** 本次进程内的累计状态 */
let _state = null;

/** 内部：拿默认的 state-bus（允许注入，测试时传假的） */
function defaultBus() {
  try { return require('./state-bus.js') } catch (_) { return null }
}

/**
 * 探测内核是否还活着。
 *
 * 用 GET /json/version —— CDP 的最小只读端点，不建 WebSocket、不碰页面，
 * 对正在跑的任务零干扰。
 *
 * @param {{host?:string, port?:number, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, version?:string, error?:string}>} 永不抛错
 */
async function probeKernel(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = Number(o.port);
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 4000;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'port 无效：' + String(o.port) };
  }
  const url = 'http://' + host + ':' + port + '/json/version';

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch (_) {} }, timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = await res.json();
    const version = String((j && j.Browser) || '');
    return version ? { ok: true, version } : { ok: false, error: '响应缺少 Browser 字段' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: /abort/i.test(msg) ? 'timeout ' + timeoutMs + 'ms' : msg.slice(0, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 合并写 browser.json。**先读后写**，只覆盖自己管的字段。
 * @param {object} bus  state-bus 实例（或测试替身）
 * @param {object} patch
 * @returns {boolean} 是否写成功
 */
function mergeBrowserState(bus, patch) {
  if (!bus || typeof bus.reportBrowser !== 'function') return false;
  let prev = null;
  try { prev = typeof bus.readBrowser === 'function' ? bus.readBrowser() : null; } catch (_) { prev = null; }
  const base = prev && typeof prev === 'object' ? prev : {};
  const next = Object.assign({}, base, patch, { updatedAt: new Date().toISOString() });
  try { return bus.reportBrowser(next) !== false } catch (_) { return false }
}

/**
 * 记录一次崩溃/异常退出。
 *
 * 专供 createCdpAdapter 的崩溃恢复路径调用：它拿到内核的退出码/信号后
 * 必须让外界看见「重启过一次、上次是怎么死的」，否则设置页只能显示
 * 「就绪」，把一次真实的崩溃掩盖掉。
 *
 * @param {{bus?:object, code?:number|null, signal?:string|null, kind?:string}} opts
 */
function recordCrash(opts) {
  const o = opts || {};
  const bus = o.bus || defaultBus();
  const nowIso = new Date().toISOString();

  /* restarts 由 st 维护（同一进程内累加）；从文件里读回兜底，保证跨调用不丢 */
  let prevRestarts = 0;
  try {
    const prev = bus && typeof bus.readBrowser === 'function' ? bus.readBrowser() : null;
    if (prev && Number.isFinite(prev.restarts)) prevRestarts = prev.restarts;
  } catch (_) { prevRestarts = 0 }
  if (_state && Number.isFinite(_state.restarts)) prevRestarts = Math.max(prevRestarts, _state.restarts);
  const restarts = prevRestarts + 1;
  if (_state) _state.restarts = restarts;

  mergeBrowserState(bus, {
    alive: false,
    restarts,
    lastExit: {
      code: o.code === undefined ? null : o.code,
      signal: o.signal === undefined ? null : o.signal,
      at: nowIso,
    },
    lastErrorKind: o.kind || 'CRASHED',
    heartbeatAt: nowIso,   // 崩溃也是一次「刚刚有结论」的心跳
  });
  return { restarts };
}

/**
 * 启动心跳。重复调用只保留一个定时器（幂等）。
 *
 * @param {object} opts
 * @param {object} [opts.cfg]      引擎配置（取 cdp.host / cdp.port / chromium.executablePath）
 * @param {object} [opts.bus]      state-bus 替身（默认 require('./state-bus.js')）
 * @param {number} [opts.intervalMs]
 * @param {()=>number} [opts.getPort]  覆盖端口来源（引擎的 _activePort 是闭包变量，必须由调用方给）
 * @returns {{stop: ()=>void, tick: ()=>Promise<object>}}
 */
function startHeartbeat(opts) {
  const o = opts || {};
  const bus = o.bus || defaultBus();
  const cfg = o.cfg || {};
  const cdp = cfg.cdp || {};
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(o.intervalMs) || DEFAULT_INTERVAL_MS);

  /* ★ 2026-10-31：区分「内核 owner」与「附着方」。
     实测缺陷：附着方（读课程 / 取证脚本 / 看课）进程退出时，它这一轮心跳
     探测失败，就把 browser.json 写成 alive:false + CRASHED ——
     而内核实际还活着（端口 200、pid 未变）。
     这与 D-009 是同一类谎报，只是入口不同。
     规则：**只有 owner 才有资格宣告内核死亡**；附着方探不到就什么都不写，
     交给 owner 或下一次真探测去判断。 */
  const isOwner = o.isOwner === true;

  /* 重复 start：先停旧的，避免定时器叠加（叠加会让心跳时间戳乱跳） */
  stopHeartbeat();

  const getPort = typeof o.getPort === 'function'
    ? o.getPort
    : () => (Number.isInteger(Number(cdp.port)) ? Number(cdp.port) : 0);

  _state = {
    startedAt: new Date().toISOString(),
    restarts: 0,
    failures: 0,
  };

  /**
   * 探一次并落盘。失败不抛错 —— 心跳本身不能成为新的故障源。
   * @returns {Promise<object>} 本次写入的状态
   */
  const tick = async () => {
    const port = Number(getPort()) || 0;
    const r = port
      ? await probeKernel({ host: cdp.host || '127.0.0.1', port })
      : { ok: false, error: 'port 未就绪' };

    if (!_state) _state = { startedAt: new Date().toISOString(), restarts: 0, failures: 0 };
    if (!r.ok) _state.failures += 1;

    /* ★ 附着方探不到内核时**什么都不写**。
       它的探测失败往往只是「本进程正在退出 / 连接被主动断开」，
       与内核死活无关。写了就会把 owner 记录的 alive:true 冲成 false。 */
    if (!r.ok && !isOwner) {
      return { alive: null, skipped: true, error: r.error };
    }

    const nowIso = new Date().toISOString();
    const startedAt = _state.startedAt;
    const startedMs = Date.parse(startedAt);
    const patch = {
      alive: r.ok === true,
      port: port || null,
      startedAt,
      heartbeatAt: nowIso,
      uptimeMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
      restarts: _state.restarts,
    };

    /* 关键：探活失败时**不要**回写 ready:false 覆盖掉启动时写的 ready:true。
       ready 表达的是「启动成功过」，alive 表达的是「此刻还活着」——
       两者语义不同，合并写会把旧语义冲掉，导致 UI 与浏览器层判断打架。 */
    if (r.ok) {
      patch.lastErrorKind = '';
      if (r.version) patch.browserVersion = r.version;
    } else {
      /* 只有连续 2 次失败才判定 CRASHED：单次超时可能只是瞬时卡顿，
         立刻标死会让 UI 闪红、也会让上层误触发重启。 */
      if (_state.failures >= 2) {
        patch.lastErrorKind = 'CRASHED';
        patch.alive = false;
      } else {
        patch.lastErrorKind = 'PROBE_TIMEOUT';
      }
    }

    if (bus && typeof bus.readBrowser === 'function' && typeof bus.reportBrowser === 'function') {
      let prev = null;
      try { prev = bus.readBrowser() } catch (_) { prev = null }
      const merged = Object.assign({}, prev && typeof prev === 'object' ? prev : {}, patch);
      /* 关键：不覆盖 ready。ready 表达「启动成功过」，alive 表达「此刻还活着」，
         是两个语义；用心跳结果去改 ready 会让 UI 与浏览器层判断打架。 */
      merged.ready = (prev && prev.ready) === true;
      try { bus.reportBrowser(merged) } catch (_) { /* 写不进去不影响主流程 */ }
    }
    return patch;
  };

  _ctx = { bus, tick, intervalMs };
  _timer = setInterval(() => { tick().catch(() => {}) }, intervalMs);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();

  /* 立刻先探一次，别让 UI 空等一个周期 */
  tick().catch(() => {});

  return { stop: stopHeartbeat, tick };
}

/** 停止心跳。幂等：多次调用不抛错。 */
function stopHeartbeat() {
  if (_timer) {
    try { clearInterval(_timer) } catch (_) { /* ignore */ }
    _timer = null;
  }
  _ctx = null;
  return true;
}

/** 是否在跑（测试用） */
function isRunning() {
  return _timer !== null;
}

module.exports = {
  probeKernel,
  startHeartbeat,
  stopHeartbeat,
  recordCrash,
  mergeBrowserState,
  isRunning,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
};
