#!/usr/bin/env node
/* ============================================================================
 * judge.test.cjs — 判定纯函数（表驱动）
 * ============================================================================
 *
 * 【为什么用表驱动】
 *   判定逻辑的坑都在边界：任务点属于上一节、unfinish 恰好等于 1、
 *   duration=0 时 ended 默认 true…… 这些用「跑整条状态机」很难覆盖，
 *   但写成「输入 → 期望输出」的表格就能穷举。
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 isVideoTaskDone 里「只认 unfinish===0」改成「unfinish < 2」
 *   → 「单任务点未观看不得判完成」那条变红。
 *   已实测：改坏退出 1，恢复退出 0。
 *
 * 运行：node engine/judge.test.cjs
 * ==========================================================================*/
'use strict';

const J = require('./src/learn/judge.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}
function eq(actual, want, name) {
  ok(actual === want, name, '实际 ' + JSON.stringify(actual) + ' 期望 ' + JSON.stringify(want));
}

/* ── 1. 任务点归属过滤 ─────────────────────────────────────────────── */
console.log('== 1. 任务点按 knowledgeid 归属当前节 ==');
{
  eq(J.knowledgeIdOf('https://x/knowledge/cards?knowledgeid=143114597&a=1'), '143114597', '能从 frame URL 取 knowledgeid');
  eq(J.knowledgeIdOf('https://x/cards?foo=1'), '', '没有 knowledgeid 返回空串');
  eq(J.knowledgeIdOf(null), '', 'null 不抛错');

  const tasks = [
    { kind: 'video', finished: true, frameUrl: 'https://x/cards?knowledgeid=111' },
    { kind: 'video', finished: false, frameUrl: 'https://x/cards?knowledgeid=222' },
  ];
  const a = J.scopeTasksToSection(tasks, '222');
  eq(a.scoped.length, 1, '只保留属于当前节的任务点');
  eq(a.stale, false, '能匹配到时 stale=false');

  const b = J.scopeTasksToSection(tasks, '999');
  eq(b.stale, true, '★ 有 knowledgeid 但都不是当前节 → stale=true（不可用）');

  const c = J.scopeTasksToSection([{ kind: 'video', finished: true }], '999');
  eq(c.stale, false, '任务点完全没有 knowledgeid 时不判 stale（老页面兼容）');
}

/* ── 2. isVideoTaskDone：SPEC §5 判定链 ────────────────────────────── */
console.log('== 2. 视频任务完成判定 ==');
{
  const done1 = J.isVideoTaskDone({
    tasks: [{ kind: 'video', finished: true, frameUrl: 'https://x/cards?knowledgeid=111' }],
    currentChapterId: '111',
    tocItem: { unfinish: 2 },
  });
  eq(done1.done, true, '页面任务点全绿 → 完成');
  eq(done1.by, 'page-video-task-finished', 'by 标明是页面证据');

  const done2 = J.isVideoTaskDone({ tasks: [], currentChapterId: '111', tocItem: { unfinish: 0 } });
  eq(done2.done, true, '目录 unfinish=0 → 完成');
  eq(done2.by, 'toc-unfinish-zero', 'by 标明是目录证据');

  /* ★ 核心陷阱：单任务点小节未观看时 unfinish 恰好是 1。
     按「1 < 假定总数 2」会判成完成 —— 那就是把没看的课当看完。 */
  const trap = J.isVideoTaskDone({
    tasks: [{ kind: 'video', finished: false, frameUrl: 'https://x/cards?knowledgeid=111' }],
    currentChapterId: '111',
    tocItem: { unfinish: 1 },
  });
  eq(trap.done, false, '★ 单任务点未观看（unfinish=1）不得判完成');

  const stale = J.isVideoTaskDone({
    tasks: [{ kind: 'video', finished: true, frameUrl: 'https://x/cards?knowledgeid=999' }],
    currentChapterId: '111',
    tocItem: { unfinish: 1 },
  });
  eq(stale.done, false, '★ 任务点属于上一节时不得判完成（防误跳）');
  eq(stale.by, 'inventory-from-other-section', 'by 标明数据不可用');

  const none = J.isVideoTaskDone({ tasks: [], currentChapterId: '111', tocItem: null });
  eq(none.done, false, '无任何证据 → 未完成');
  eq(none.by, 'nothing', 'by=nothing');

  /* 视频完成 + 章节测验未做：video/audio 全绿就算完成（测验不计） */
  const mixed = J.isVideoTaskDone({
    tasks: [
      { kind: 'video', finished: true, frameUrl: 'https://x/cards?knowledgeid=111' },
      { kind: 'quiz', finished: false, frameUrl: 'https://x/cards?knowledgeid=111' },
    ],
    currentChapterId: '111',
    tocItem: { unfinish: 1 },
  });
  eq(mixed.done, true, '★ 视频已完成 + 测验未做 → 仍算视频完成（测验永不做）');

  const audio = J.isVideoTaskDone({
    tasks: [{ kind: 'audio', finished: true, frameUrl: 'https://x/cards?knowledgeid=111' }],
    currentChapterId: '111',
    tocItem: null,
  });
  eq(audio.done, true, 'audio 任务点同样按媒体处理');
}

/* ── 3. isSectionDone / pendingOf ──────────────────────────────────── */
console.log('== 3. 整节完成与待办数 ==');
{
  eq(J.isSectionDone({ done: true }), true, 'done 且无 unfinish → 整节完成');
  eq(J.isSectionDone({ done: true, unfinish: 0 }), true, 'done 且 unfinish=0 → 整节完成');
  eq(J.isSectionDone({ done: true, unfinish: 2 }), false, 'done 但还有待办 → 不算整节完成');
  eq(J.isSectionDone({ done: false }), false, '未 done → 不算');
  eq(J.isSectionDone(null), false, 'null → 不算');

  eq(J.pendingOf({ done: true }), 0, '已完成 → 0');
  eq(J.pendingOf({ done: false, unfinish: 3 }), 3, '未完成 → 取 unfinish');
  eq(J.pendingOf({ done: false }), 'unknown', '缺 unfinish → unknown（不造假默认值）');
  eq(J.pendingOf(null), 'unknown', 'null → unknown');
}

/* ── 4. pickNextSection ────────────────────────────────────────────── */
console.log('== 4. 选下一节 ==');
{
  const items = [
    { chapterHeader: true, title: '第一章', done: false },
    { i: 1, title: '1.1', done: true },
    { i: 2, title: '1.2', done: false },
    { i: 3, title: '1.3', done: false },
  ];
  const r1 = J.pickNextSection({ items, curIdx: 1, mode: 'continue_chapters', maxSections: 5, completed: 0 });
  eq(r1.action, 'advance', '从 1.1 往后找到未完成的 1.2');
  eq(r1.target.title, '1.2', '目标是 1.2');
  eq(r1.skipped, 0, '没有跳过');

  const items2 = [
    { chapterHeader: true, title: '第一章' },
    { i: 1, title: '1.1', done: true },
    { i: 2, title: '1.2', done: true },
    { i: 3, title: '1.3', done: false },
  ];
  const r2 = J.pickNextSection({ items: items2, curIdx: 1, mode: 'continue_chapters', maxSections: 5, completed: 0 });
  eq(r2.target.title, '1.3', '跳过已完成的 1.2');
  eq(r2.skipped, 1, 'skipped 计数正确');

  const r3 = J.pickNextSection({ items: items2, curIdx: 3, mode: 'continue_chapters', maxSections: 5, completed: 0 });
  eq(r3.action, 'stop', '全部完成 → 停');
  eq(r3.stopReason, 'all_done_or_no_target', '停止原因正确');

  const r4 = J.pickNextSection({ items, curIdx: 1, mode: 'continue_chapters', maxSections: 1, completed: 1 });
  eq(r4.action, 'stop', '达到节数上限 → 停');
  eq(r4.stopReason, 'max_sections_reached', '停止原因是 max_sections_reached');

  const items3 = [
    { chapterHeader: true, title: '第一章' },
    { i: 1, title: '1.1', done: false },
    { chapterHeader: true, title: '第二章' },
    { i: 3, title: '2.1', done: false },
  ];
  const r5 = J.pickNextSection({ items: items3, curIdx: 1, mode: 'current_chapter', maxSections: 9, completed: 0 });
  eq(r5.action, 'stop', 'current_chapter 模式跨章 → 停');
  eq(r5.stopReason, 'chapter_boundary', '停止原因是 chapter_boundary');

  eq(J.pickNextSection({ items: [], curIdx: null, mode: 'continue_chapters', maxSections: 5, completed: 0 }).stopReason,
    'TOC_MISSING', '目录为空 → TOC_MISSING');
}

/* ── 5. pickStart ──────────────────────────────────────────────────── */
console.log('== 5. 起跑点选择 ==');
{
  const a = J.pickStart([
    { title: '1.1', done: true },
    { title: '1.2', done: false, current: true },
  ]);
  eq(a.mode, 'stay', '当前节未完成 → 原地继续');
  eq(a.idx, 1, 'idx 指向当前节');

  const b = J.pickStart([
    { title: '1.1', done: true, current: true },
    { title: '1.2', done: false },
  ]);
  eq(b.mode, 'jump', '当前节已完成 → 跳到第一个未完成');
  eq(b.idx, 1, 'idx 指向 1.2');

  const c = J.pickStart([
    { title: '1.1', done: true },
    { title: '1.2', done: true },
  ]);
  eq(c.mode, 'allDone', '全完成 → allDone');

  eq(J.pickStart([]).mode, 'allDone', '空目录 → allDone');
}

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
process.exit(0);
