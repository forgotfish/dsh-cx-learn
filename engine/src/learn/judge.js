/* ============================================================================
 * engine/src/learn/judge.js — 判定纯函数（L4）
 * ============================================================================
 *
 * 【为什么抽出来】
 *   原来「这一节看完没有」「下一节在哪」这些判定散在 LearnMachine 的
 *   tick() / advanceSection() 里，和 CDP 调用、日志、计数器搅在一起。
 *   后果：改一处判定要读 1800 行；测试只能靠 Mock 跑整条状态机，
 *   测不出边界情况（比如「拿不到目录」「任务点属于上一节」）。
 *
 *   现在：判定 = 纯函数（输入 state，输出结论），不碰 adapter、不写日志、
 *   不改计数器。边界情况用表驱动测试全覆盖，不需要浏览器。
 *
 * 【SPEC §5 的判定链（唯一权威）】
 *   1. 本节 video/audio 任务点全部 finished，且任务点所属 frame 的
 *      knowledgeid 与当前节一致  → 视频已完成
 *   2. 目录当前项 unfinish === 0                        → 整节已完成
 *   3. 视频 ended 或 progress ≥ 阈值，且是本次启动过的   → 播放到位（等确认）
 *   —  拿不到任何证据                                    → 不停机，继续
 *
 * 【明令禁止（每条都对应一次真实事故）】
 *   ❌ 用 unfinish < 假定总数 猜完成
 *      —— 单任务点小节未看时 unfinish 就是 1，按 1<2 会把没看的课判成看完
 *   ❌ 用 duration === 0 时的 ended 判完成
 *      —— HTML5 的 ended 在无元数据时默认 true
 *   ❌ 用「外壳页目录读不到」推断选择器过时
 *      —— 两版页面各用一套目录
 * ==========================================================================*/
'use strict';

/**
 * 从 frame URL 里取 knowledgeid（任务点归属哪一节）。
 * @returns {string} 没有则空串
 */
function knowledgeIdOf(frameUrl) {
  const m = /[?&]knowledgeid=([0-9]+)/i.exec(String(frameUrl || ''));
  return m ? m[1] : '';
}

/**
 * 把任务点清单按「当前节」过滤。
 *
 * 为什么要这层：切节瞬间，knowledge/cards iframe 可能还挂着**上一节**的内容，
 * 只按 ans-job-finished 判会拿上一节的「已完成」去跳过这一节 —— 那是误跳。
 *
 * @param {Array<{kind?:string, finished?:boolean, frameUrl?:string}>} tasks
 * @param {string} currentChapterId 当前节 chapterId（目录里的 cur<id> 去掉 cur）
 * @returns {{scoped:Array, stale:boolean}}
 *   stale=true 表示「有带 knowledgeid 的任务点，但都不是当前节的」→ 数据不可用
 */
function scopeTasksToSection(tasks, currentChapterId) {
  const all = Array.isArray(tasks) ? tasks : [];
  const want = String(currentChapterId || '');
  if (!want) return { scoped: all, stale: false };
  const matched = all.filter((t) => knowledgeIdOf(t && t.frameUrl) === want);
  if (matched.length) return { scoped: matched, stale: false };
  const anyHasId = all.some((t) => knowledgeIdOf(t && t.frameUrl) !== '');
  return { scoped: all, stale: anyHasId };
}

/**
 * 判定「本节视频任务是否已完成」—— SPEC §5 第 1、2 条。
 *
 * @param {object} input
 * @param {Array}  input.tasks            任务点清单（来自页面探针）
 * @param {string} input.currentChapterId 当前节 chapterId
 * @param {object|null} input.tocItem     目录当前项（含 unfinish / taskTotal）
 * @returns {{done:boolean, by:string, count?:number, stale?:boolean, unfinish?:number}}
 *   by 取值：
 *     page-video-task-finished  页面任务点全绿（最强证据）
 *     toc-unfinish-zero         目录待办归零
 *     inventory-from-other-section  只有上一节的任务点，数据不可用
 *     nothing                   无证据
 */
function isVideoTaskDone(input) {
  const o = input || {};
  const { scoped, stale } = scopeTasksToSection(o.tasks, o.currentChapterId);

  /* 有带 knowledgeid 的任务点但都不是当前节的 ⇒ 明确不可用，不许用 */
  if (stale) return { done: false, by: 'inventory-from-other-section' };

  /* ① 页面层面：所有 video/audio 任务点都 finished */
  const media = scoped.filter((t) => t && (t.kind === 'video' || t.kind === 'audio'));
  if (media.length && media.every((t) => t.finished === true)) {
    return { done: true, by: 'page-video-task-finished', count: media.length };
  }

  /* ② 目录层面：只认确定的 0。
     ⚠️ 绝不用 unfinish < taskTotal 这类猜法（见文件头「明令禁止」）。 */
  const item = o.tocItem || null;
  if (item && typeof item.unfinish === 'number' && item.unfinish === 0) {
    return { done: true, by: 'toc-unfinish-zero', unfinish: 0, count: 0 };
  }

  return { done: false, by: 'nothing' };
}

/**
 * 判定「整节是否已完成」（含章节测验也做完了）。
 * 只有当目录项 done 且没有未完成任务点时成立。
 */
function isSectionDone(tocItem) {
  if (!tocItem || tocItem.done !== true) return false;
  if (typeof tocItem.unfinish === 'number' && tocItem.unfinish > 0) return false;
  return true;
}

/**
 * 当前节还剩几个待办。拿不到返回 'unknown'（**绝不返回假默认值**）。
 */
function pendingOf(tocItem) {
  if (!tocItem) return 'unknown';
  if (tocItem.done === true) return 0;
  return typeof tocItem.unfinish === 'number' && tocItem.unfinish >= 0 ? tocItem.unfinish : 'unknown';
}

/**
 * 定位「下一节」——SPEC §5 之外，但同样纯。
 *
 * @param {object} input
 * @param {Array}  input.items       目录项（含 chapterHeader / done / i / title）
 * @param {number|null} input.curIdx 引擎当前所在索引（null = 未知）
 * @param {string} input.mode        'current_chapter' | 'continue_chapters'
 * @param {number} input.maxSections 本节数上限
 * @param {number} input.completed   已完整看完的节数
 * @returns {{action:'advance'|'stop', target?:object, skipped:number, stopReason?:string}}
 */
function pickNextSection(input) {
  const o = input || {};
  const items = Array.isArray(o.items) ? o.items : [];
  if (!items.length) return { action: 'stop', skipped: 0, stopReason: 'TOC_MISSING' };

  const curIdx = Number.isInteger(o.curIdx) && o.curIdx >= 0 && o.curIdx < items.length ? o.curIdx : -1;
  const start = curIdx >= 0 ? curIdx + 1 : 0;

  const chapterNoOf = (idx) => {
    let n = 0;
    for (let i = 0; i <= idx && i < items.length; i++) if (items[i] && items[i].chapterHeader) n += 1;
    return n;
  };
  const curChapter = curIdx >= 0 ? chapterNoOf(curIdx) : 0;

  let target = null;
  let skipped = 0;
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.chapterHeader) continue;          /* 章头只参与章号计算，不点 */
    /* 跳过判据用目录的 `done` 标记，**不要求 unfinish===0**。
       理由：章节测验永不做，所以「视频看完 + 测验没做」的节 unfinish 恒为 1；
       若按 isSectionDone 判，这类节会被当成没做完而反复进入，
       进去后又立刻判定视频已完成再切走 —— 正是历史上那个空转。
       与 machine.js 原循环的 `if (it.done)` 语义严格一致。 */
    if (it.done === true) { skipped += 1; continue }  /* 已完成：跳过，不重播 */
    target = it;
    break;
  }

  if (!target) return { action: 'stop', skipped, stopReason: 'all_done_or_no_target' };

  if (Number(o.completed) >= Number(o.maxSections)) {
    return { action: 'stop', skipped, stopReason: 'max_sections_reached' };
  }

  const targetChapter = chapterNoOf(target.i != null ? target.i : items.indexOf(target));
  if (targetChapter > curChapter && o.mode === 'current_chapter') {
    return { action: 'stop', skipped, stopReason: 'chapter_boundary' };
  }

  return { action: 'advance', target, skipped };
}

/**
 * 起跑点选择（run() 的前置定位规则）。
 *
 * 规则（按优先级，SPEC 之外的实测结论）：
 *   1. 当前打开的节未完成 → 就在它上面干活
 *   2. 当前节已完成、后面还有未完成的 → 定位到第一个未完成节
 *   3. 全部完成 → allDone
 *
 * @returns {{mode:'stay'|'jump'|'allDone', idx:number|null}}
 */
function pickStart(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { mode: 'allDone', idx: null };
  /* 与 run.js 原有实现保持一致的判据：只看目录的 `done` 标记。
     不要换成 isSectionDone —— 那会要求 unfinish===0，而「视频看完、测验没做」
     的节 unfinish 恒为 1，会导致每次启动都「原地继续」而不往下一节走。 */
  const isDone = (x) => !!(x && x.done === true);
  const curIdx = list.findIndex((x) => x && x.current);
  const cur = curIdx >= 0 ? list[curIdx] : null;
  if (cur && !cur.chapterHeader && !isDone(cur)) {
    return { mode: 'stay', idx: curIdx };
  }
  const firstUndone = list.findIndex((x) => x && !x.chapterHeader && !isDone(x));
  if (firstUndone >= 0) return { mode: 'jump', idx: firstUndone };
  return { mode: 'allDone', idx: curIdx >= 0 ? curIdx : null };
}

module.exports = {
  knowledgeIdOf,
  scopeTasksToSection,
  isVideoTaskDone,
  isSectionDone,
  pendingOf,
  pickNextSection,
  pickStart,
};
