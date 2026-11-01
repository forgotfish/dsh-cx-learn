/* ============================================================================
 * engine/src/core/logging.js — humanize（拟人化延迟）、logger（结构化日志 + 环形缓冲）、启动横幅
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { VERSION, fs, sleep } = require('./base.js');
const { CONFIG } = require('./config.js');

/* ============================================================================
 * 第 2.5 节 · redact —— 日志与落盘内容的统一脱敏
 * ----------------------------------------------------------------------------
 * 【为什么集中在这里】
 *   实体里 `url` 被写到几十个地方（logger 的 meta、events.ndjson、
 *   .login/result.json、HTTP 响应），逐处改必然漏。收口到一个函数，
 *   新增日志点自动受保护。
 *
 * 【脱什么】（SPEC §4.6）
 *   enc / cpi / openc  —— 学习通的授权参数，泄露后别人能直接打开你的课程页
 *   uuid                —— 二维码会话，扫到就能冒用登录
 *   cookie 值 / JSESSIONID / UID / _uid / uf / vc3
 *   token / apiKey / sk- / password / Authorization
 *
 * 【留什么】
 *   courseId / clazzid / chapterId / 域名 / 路径 —— 排查必需，且不具授权性
 *
 * 【注意】
 *   只脱敏**输出**，不改内存里的值。业务仍然用完整 URL 导航，
 *   否则会 break「重载当前节取新签名」这类需要完整参数的功能。
 * ==========================================================================*/
const REDACT_PARAMS = ['enc', 'cpi', 'openc', 'uuid', '_uid', 'uf', 'vc3', 'token', 't', 'ak_', 'at_'];
const REDACT_RE = new RegExp(
  '([?&](?:' + REDACT_PARAMS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')=)([^&#\\s"\']*)',
  'gi'
);

/**
 * 脱敏一段文本（URL / 日志行 / JSON 片段都适用）。
 * @param {string} s
 * @returns {string}
 */
function redact(s) {
  let out = String(s == null ? '' : s);
  /* 1) URL 查询参数：enc=abc123 → enc=*** */
  out = out.replace(REDACT_RE, (_all, head) => head + '***');
  /* 2) 已知前缀的令牌 */
  out = out.replace(/\b(gh[pousr]_)[A-Za-z0-9]{6,}/g, '$1***');
  out = out.replace(/\b(sk-)[A-Za-z0-9]{6,}/g, '$1***');
  /* 3) Authorization: Bearer xxx → 保留 scheme，只脱凭据本体
     （先做这一步，否则会被第 4 步的通用键值规则连 scheme 一起吞掉） */
  out = out.replace(
    /\b(authorization)\b(\s*[:=]\s*)(bearer|basic|token)?\s*([A-Za-z0-9._\-+/=]{8,})/gi,
    (_a, k, sep, scheme) => k + sep + (scheme ? scheme + ' ' : '') + '***'
  );
  /* 4) 裸 Bearer xxx */
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer ***');
  /* 5) 显式键值形态（password: "xxx" / apiKey=xxx / token=xxx） */
  out = out.replace(
    /\b(password|passwd|secret|api[_-]?key|apikey|jsessionid|token)\b(\s*[:=]\s*)(['"]?)([^\s'",;}]{3,})\3/gi,
    (_a, k, sep, q) => k + sep + q + '***' + q
  );
  return out;
}

/**
 * 递归脱敏一个对象（用于 logger meta 与落盘 JSON）。
 * 只处理字符串值；数字/布尔/嵌套原样保留。
 * 深度上限 6，防止环引用或超深结构拖慢日志。
 */
function redactDeep(value, depth) {
  const d = depth || 0;
  if (d > 6) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactDeep(value[k], d + 1);
    return out;
  }
  return value;
}


/* ============================================================================
 * 第 3 节 · humanize 模块 —— 所有拟人化延迟集中管理（业务代码零散落 sleep）
 * ==========================================================================*/
const humanize = {
  _cfg: null,
  _ops: 0,
  _longEvery: null,
  configure(h) {
    this._cfg = h || {};
    this._ops = 0;
    this._longEvery = this._ri(this._cfg.longPauseEveryOps || [12, 20]);
    logger.log('HUMANIZE', 'INFO', '节奏模块初始化（所有随机范围来自 CONFIG）', { ranges: this._cfg, nextLongPauseAtOp: this._longEvery });
  },
  /** [min,max] 内取随机整数（含端点） */
  _ri(range) {
    const min = Math.max(0, range[0] | 0);
    const max = Math.max(min, range[1] | 0);
    return min + Math.floor(Math.random() * (max - min + 1));
  },
  /** 每次点击/按键前：300–1200ms */
  async beforeClick() { await sleep(this._ri(this._cfg.clickDelayMs || [300, 1200])); },
  /** 切换章节后的冷却：8–15s */
  async sectionCooldown() {
    const ms = this._ri(this._cfg.sectionCooldownMs || [8000, 15000]);
    logger.log('HUMANIZE', 'INFO', '切节冷却', { ms });
    await sleep(ms);
  },
  /** 弹题思考延迟：2–5s，不秒选 */
  async quizThink() {
    const ms = this._ri(this._cfg.quizThinkMs || [2000, 5000]);
    logger.log('HUMANIZE', 'INFO', '弹题思考延迟（不秒选）', { ms });
    await sleep(ms);
  },
  /** 每隔随机 N 次操作插入 3–6s 长停顿，打破固定间隔画像 */
  async maybeLongPause() {
    this._ops += 1;
    if (this._longEvery && this._ops >= this._longEvery) {
      this._ops = 0;
      this._longEvery = this._ri(this._cfg.longPauseEveryOps || [12, 20]);
      const ms = this._ri(this._cfg.longPauseMs || [3000, 6000]);
      logger.log('HUMANIZE', 'INFO', '插入长停顿（防固定间隔风控画像）', { ms, nextLongPauseAtOp: this._longEvery });
      await sleep(ms);
    }
  },
  /** 播放态轮询间隔：4–9s 随机 */
  async pollDelay() { await sleep(this._ri(this._cfg.pollMs || [4000, 9000])); }
};

/* ============================================================================
 * 第 4 节 · logger 模块 —— 结构化日志（时间戳/阶段/层级/结果）+ 内存环形缓冲
 *   每条日志：{ ts, phase, level, message, ...meta }
 *   phase: PRECHECK | PLAYING_CHECK | PLAYING | QUIZ | DIALOG | ADVANCE |
 *          WAIT_LOAD | CLICK | HUMANIZE | LOOP | FATAL | SUMMARY | MCP
 *   同时写 console 与环形缓冲；MCP 模式下 console 被重定向到 stderr（stdout 专供协议）。
 * ==========================================================================*/
const logger = {
  _ring: [],
  _max: CONFIG.log.ringSize,
  _file: null,
  _out: (line) => console.log(line),
  configure(logCfg) {
    this._ring = [];
    this._max = (logCfg && logCfg.ringSize) || CONFIG.log.ringSize;
    this._file = (logCfg && logCfg.file) || null;
    return this;
  },
  setConsole(fn) { this._out = fn; },
  log(phase, level, message, meta) {
    const e = { ts: new Date().toISOString(), phase, level, message };
    if (meta) for (const k of Object.keys(meta)) if (meta[k] !== undefined) e[k] = meta[k];
    this._ring.push(e);
    if (this._ring.length > this._max) this._ring.shift();
    /* ★ 输出前统一脱敏：URL 里的 enc/cpi/uuid 等授权参数一律打成 ***。
       收口在这里而不是逐个日志点，因为 url 被写到几十处，逐处改必漏。 */
    let metaStr = '';
    if (meta) {
      try { metaStr = ' ' + JSON.stringify(redactDeep(meta)); } catch (_) { metaStr = ' [unserializable-meta]'; }
      if (metaStr.length > 420) metaStr = metaStr.slice(0, 420) + '…';
    }
    const line = '[' + e.ts + '][' + level + '][' + phase + '] ' + redact(message) + metaStr;
    try { this._out(line); } catch (_) { /* stdout 关闭等情况 */ }
    if (this._file) { try { fs.appendFileSync(this._file, line + '\n'); } catch (_) { /* 文件日志失败不影响主流程 */ } }
    return e;
  },
  info(p, m, meta) { return this.log(p, 'INFO', m, meta); },
  warn(p, m, meta) { return this.log(p, 'WARN', m, meta); },
  error(p, m, meta) { return this.log(p, 'ERROR', m, meta); },
  tail(n) { return this._ring.slice(-(n || 40)); }
};

/** 启动横幅：免责声明 + 运行配置（免责声明同时出现在头部注释与启动日志） */
function logBanner(cfg) {
  const B = '[DISCLAIMER]';
  logger.info('PRECHECK', B + ' 本脚本用于浏览器自动化技术研究；请自行确认所在平台政策与当地法规。');
  logger.info('PRECHECK', B + ' 学习通平台禁止自动化脚本；实际使用可能导致学习进度被退回或账号处罚。');
  logger.info('PRECHECK', B + ' 本脚本不篡改后端数据、不伪造进度上报、不调用进度写接口；全部动作均为模拟页面点击/播放行为。');
  logger.info('PRECHECK', B + ' 检测到人脸识别/活体检测/验证码等人工验证特征时立即停止，不做任何绕过。');
  logger.info('PRECHECK', '运行配置', {
    version: VERSION,
    dshCompat: 'DSH 0.2.0-rc.2 / Node ' + process.version,
    path: 'A (CDP over native WebSocket, zero-dependency)',
    mode: cfg.mode,
    maxSections: cfg.maxSections,
    cdp: cfg.cdp.host + ':' + (Number(cfg.cdp.port) > 0 ? cfg.cdp.port : 'auto'),
    chromium: cfg.chromium.executablePath,
    videoDoneAt: cfg.video.progressDoneRatio + '%',
    humanize: cfg.humanize
  });
}

module.exports = {
  humanize,
  logger,
  logBanner,
  redact,
  redactDeep
};
