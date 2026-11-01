/* ============================================================================
 * adapter-contract.js — 浏览器层 ↔ 业务层 的中间契约
 * ============================================================================
 *
 * 【为什么需要这个文件】
 *   这个仓库同时有两拨人在改两类代码：
 *     A. 浏览器层（engine/browser/）：内核启动参数、CDP 连接、target 管理、
 *        页面导航、注入脚本、截图。关心的是「浏览器能不能稳定驱动」。
 *     B. 业务层（engine/learn/）：状态机、目录推进、视频判定、弹题、风控。
 *        关心的是「这节课到底看完没有」。
 *
 *   之前两个人在同一个 chaoxing-autolearn.js 上改，git 天天冲突，
 *   而且 A 的改动经常无意中破坏 B 的假设（反之亦然）。
 *
 * 【这个文件怎么起作用】
 *   1. 只放**接口契约**：方法名、参数、返回值形状、错误约定。不含实现。
 *   2. 双方都从这里 require 常量与类型断言，所以任何一方改契约都会
 *      同时暴露给另一方 —— 冲突从「代码冲突」变成「契约冲突」，
 *      后者在启动时立刻报错，而不是运行到一半才莫名其妙失败。
 *   3. 用**中间状态文件**（engine/.state/adapter.json）传递运行期信息，
 *      而不是让两层直接读对方的内部变量。
 *
 * 【红线】
 *   · 这个文件只允许追加方法，**不允许**改变已有方法的语义。
 *   · 要改已有方法：先加一个新方法（v2 后缀），让双方都迁移过去，
 *     再删旧的。不允许原地改签名。
 *   · 业务层禁止 require 浏览器层的实现文件，只能拿 adapter 实例。
 *   · 浏览器层禁止知道「章节」「任务点」「弹题」这些业务概念。
 * ==========================================================================*/

'use strict';

/* ---------------------------------------------------------------------------
 * 1. 浏览器层必须实现的方法（业务层只会调用这些）
 * -------------------------------------------------------------------------*/

/**
 * 每个方法的契约。key = 方法名，value = 描述 + 参数 + 返回。
 * 这份表同时用于启动自检：adapter 实例缺任何一项直接抛错。
 */
const ADAPTER_METHODS = {
  /* —— 生命周期 —— */
  ensureBrowser: 'async () => void　确保浏览器已启动并连上 CDP',
  navigate: 'async (url, opts?) => void　导航到 URL（含风控检测）',
  shutdown: 'async () => void　关闭并清理',

  /* —— 状态读取（只读，不改页面）—— */
  getCurrentUrl: 'async () => string　当前顶层 frame 的 URL',
  getFrameDocuments: 'async () => Array<{frameId, url, isTop, depth}>　frame 树',
  getAllCookies: 'async () => Array<Cookie>|null　全部 cookie（null=无法判断）',

  /* —— 页面求值 —— */
  evalInFrame: 'async (frameId, expression) => any　在指定 frame 求值',
  getText: 'async (frameId, expression?) => string　取文本',

  /* —— 交互（模拟真实输入，禁止直接改 DOM）—— */
  click: 'async (frameId, kind, arg) => {ok, mode, note?}　真实鼠标事件点击',
  jsClick: 'async (frameId, kind, arg) => {ok, reason?}　JS click（兜底）',
  typeInto: 'async (frameId, kind, arg, text) => {ok, reason?}　输入文本',

  /* —— 取证 —— */
  screenshot: 'async (filePath) => string(base64)　全页截图',
  screenshotClip: 'async (rect) => string(base64)　区域截图',
};

/* ---------------------------------------------------------------------------
 * 2. 业务层看到的状态对象形状（浏览器层只负责采集，不负责解释）
 * -------------------------------------------------------------------------*/

/**
 * gatherState() 的返回结构。字段名固定，语义由业务层定义。
 * 浏览器层只保证：这些字段会被填上，且类型正确。
 */
const STATE_SHAPE = {
  frames: 'Array<{frameId, url, isTop, error?, probe?}>',
  topUrl: 'string',
  video: 'null | {found, paused, ended, currentTime, duration, progress, muted, readyState, networkState, buffered, error, src, frameId}',
  videoFrameId: 'string|null',
  dialogs: 'Array<{kind, layer, note?}>',
  human: 'Array<{evidence}>',
  quiz: 'null | {present, parseable, options, layer}',
  quizFrameId: 'string|null',
  videoQuiz: 'null | {present, title, options, submitVisible, continueVisible, correct, wrong, wrongBack, wrongBackText, correctAnswer, remaining, panelText}',
  quizTab: 'null | {present, title, index}',
  toc: 'null | {found, layer, frameId, items: Array<{title, chapterId, current, done, unfinish, taskTotal}>}',
  loginInvalid: 'boolean',
  loginEvidence: 'Array<string>',
};

/* ---------------------------------------------------------------------------
 * 3. 中间状态文件：两层之间只通过它交换「运行期事实」
 * -------------------------------------------------------------------------*/

/**
 * 落盘位置。读写都走这个路径，双方不互相 import。
 *
 * 用途举例：
 *   · 浏览器层写入：这次用了哪个内核、哪个端口、profile 在哪、启动耗时
 *   · 业务层写入：当前在第几节、累计完成数、上次停止原因
 *   · 出问题时：两边都往这里追加事件，不用去翻对方代码加日志
 */
const STATE_DIR = 'engine/.state';
const FILES = {
  /** 浏览器层写：内核路径、CDP 端口、profile、启动参数、健康状态 */
  browser: 'engine/.state/browser.json',
  /** 业务层写：当前节、计数、停止原因 */
  learn: 'engine/.state/learn.json',
  /** 双方都可追加：带时间戳的事件流（排查用，一条一行） */
  events: 'engine/.state/events.ndjson',
};

/* ---------------------------------------------------------------------------
 * 4. 启动自检：契约被破坏时立刻报错，而不是运行到一半才炸
 * -------------------------------------------------------------------------*/

/**
 * 校验一个 adapter 实例是否完整实现了契约。
 * @param {object} adapter
 * @param {string} [who]  谁在校验（只用于报错信息）
 * @returns {{ok: boolean, missing: string[]}}
 */
function assertAdapter(adapter, who) {
  const missing = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, missing: Object.keys(ADAPTER_METHODS) };
  }
  for (const name of Object.keys(ADAPTER_METHODS)) {
    if (typeof adapter[name] !== 'function') missing.push(name);
  }
  if (missing.length) {
    const err = new Error(
      (who ? who + '：' : '') +
      'adapter 未实现契约方法 → ' + missing.join(', ') +
      '（契约见 engine/adapter-contract.js；浏览器层加方法不会破坏业务层，' +
      '但删/改已有方法必须同步这里）'
    );
    err.code = 'ADAPTER_CONTRACT_VIOLATION';
    err.missing = missing;
    /* 不直接 throw，让调用方决定是致命还是告警；但一定要让 main 看到 */
    if (typeof console !== 'undefined' && console.error) console.error(String(err.message));
  }
  return { ok: missing.length === 0, missing };
}

module.exports = {
  ADAPTER_METHODS,
  STATE_SHAPE,
  STATE_DIR,
  FILES,
  assertAdapter,
};
