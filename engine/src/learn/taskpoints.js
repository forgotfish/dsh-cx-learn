/* ============================================================================
 * engine/src/learn/taskpoints.js — 任务点类型注册表 + 处理决策（扩展点 E1）
 * ============================================================================
 *
 * 【为什么单独一个模块】
 *   现在只推进视频。非视频任务点（文档 / 阅读 / 音频）一律跳过。
 *   但「文档类怎么才算完成」**没有实测样本**，不能猜 —— 猜错就是把没看的
 *   课当成看完，或者把看完的课反复重播。
 *
 *   所以这里做的不是「实现」，而是**留接口**：
 *     · 把「任务点分类」和「该做什么」收成一张表
 *     · 目前所有非视频类型 → skip（与现有行为完全一致）
 *     · 将来拿到真实样本，只需 registerHandler('document', fn)，
 *       不用动 LearnMachine 的主循环
 *
 * 【怎么升级（给未来的自己）】
 *   1. 用 scripts/capture-fixture.cjs 抓一节「文档/阅读」类小节的真实 DOM
 *   2. 在 fixture 上确认完成判据：停留时长？翻到末页？服务端 unfinish=0？
 *   3. 写一个 handler：
 *        registerHandler('document', async (ctx) => ({ action: 'skip'|'done'|'wait' }))
 *   4. 在 taskpoints.test.cjs 加用例，并写「能失败证明」
 *   5. 在 docs/DECISIONS.md 记一条：依据是哪次实测
 *
 * 【红线】
 *   · `quiz` 类型**永远**返回 'never'（连点都不点），任何 handler 都不得覆盖
 *   · 未注册的类型一律 'skip'，绝不默认「当成完成」
 * ==========================================================================*/
'use strict';

/* 任务点类型。与页面探针 tasks[].kind 的取值对齐（见 learn/selectors.js）。 */
const TASK_KIND = {
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  QUIZ: 'quiz',
  DISCUSSION: 'discussion',
  UNKNOWN: 'unknown',
};

/** 已注册的处理器：kind → async ({ kind, task, state }) => { action, reason } */
const _handlers = new Map();

/**
 * 注册一个任务点处理器（**唯一的扩展入口**）。
 * @param {string} kind   TASK_KIND 之一
 * @param {(ctx:object)=>Promise<{action:string, reason?:string}>} fn
 */
function registerHandler(kind, fn) {
  if (!kind || typeof fn !== 'function') throw new Error('registerHandler(kind, fn) 参数无效');
  _handlers.set(String(kind), fn);
}

/** 清空注册（测试用） */
function _resetHandlers() { _handlers.clear() }

/**
 * 当前这个任务点应该做什么。
 *
 * @param {string} kind       TASK_KIND 之一
 * @param {object} [ctx]      附加信息（task / state），传给自定义 handler
 * @returns {Promise<{action:'play'|'skip'|'wait'|'done'|'never', reason:string}>}
 *   play  = 交给视频流程处理
 *   skip  = 跳过本节（当前对所有非视频类型的默认行为）
 *   wait  = 再等一轮（给异步加载的文档用）
 *   done  = 本任务点已完成（未来 handler 用）
 *   never = 永不触碰（章节测验 / 作业）
 */
async function decideTaskPoint(kind, ctx) {
  const k = String(kind || TASK_KIND.UNKNOWN);

  /* ★ 红线：计分作业永不触碰。放在最前面，任何 handler 都覆盖不了。 */
  if (k === TASK_KIND.QUIZ) {
    return { action: 'never', reason: '计分作业/章节测验：只识别，绝不点击或作答' };
  }
  if (k === TASK_KIND.VIDEO) {
    return { action: 'play', reason: '视频任务点：交给播放推进流程' };
  }

  const fn = _handlers.get(k);
  if (fn) {
    try {
      const r = await fn(Object.assign({ kind: k }, ctx || {}));
      if (r && typeof r.action === 'string') {
        return { action: r.action, reason: String(r.reason || ('handler:' + k)) };
      }
      return { action: 'skip', reason: 'handler 返回无效，按跳过处理' };
    } catch (e) {
      /* handler 出错不能把整轮跑废，降级为跳过并留下原因 */
      return { action: 'skip', reason: 'handler 异常：' + String((e && e.message) || e).slice(0, 80) };
    }
  }

  /* 未注册的类型：保守跳过，且写明「因为没样本所以跳过」，
     避免未来有人把它读成「这个类型已经支持了」。 */
  return {
    action: 'skip',
    reason: '未注册处理器的任务点类型（' + k + '），当前无实测样本，按跳过处理',
  };
}

/**
 * 从页面探针给的 task 对象推断类型。
 * 探针已经算好 kind，这里只做兜底容错（老引擎/字段缺失）。
 * @param {{kind?:string}} task
 */
function kindOf(task) {
  const k = task && task.kind;
  const known = Object.values(TASK_KIND);
  return known.indexOf(k) >= 0 ? k : TASK_KIND.UNKNOWN;
}

/** 当前是否支持「真正推进」某个类型（只有 video 是） */
function isSupported(kind) {
  return String(kind) === TASK_KIND.VIDEO;
}

/** 诊断用：列出当前注册情况 */
function describe() {
  return {
    supported: [TASK_KIND.VIDEO],
    registered: Array.from(_handlers.keys()),
    neverTouch: [TASK_KIND.QUIZ],
    defaultForUnknown: 'skip',
  };
}

module.exports = {
  TASK_KIND,
  registerHandler,
  _resetHandlers,
  decideTaskPoint,
  kindOf,
  isSupported,
  describe,
};
