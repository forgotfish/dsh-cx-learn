#!/usr/bin/env node
/* ============================================================================
 * section-videos.test.cjs — 「本节还剩哪几个视频没播」判定（Issue #1 判定层）
 * ============================================================================
 *
 * 【为什么要有这一层】
 *   isVideoTaskDone() 只答「整节视频是否全完成」，答不了「还剩哪几个」。
 *   一节课 12 个任务点、10 个视频时，目录 pending（整节任务点总和）永远降不到
 *   0/1，执行层无法「播下一个」，只能播完第 1 个就切节 —— 这就是 Issue #1。
 *   本测试钉住 pendingSectionVideos() / sectionVideosDone() 的语义边界。
 *
 * 【能失败证明（2026-11-15 实测）】
 *   把 pendingSectionVideos 里 `t.finished !== true` 改成 `t.finished === false`
 *   → 「finished 缺失按未完成」那条变红。
 *   把 stale 分支去掉 → 「别的 knowledgeid 不得判完成」那条变红。
 *
 * 纯函数，不连浏览器。运行：node engine/section-videos.test.cjs
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

const CARD = (kid) => 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=' + kid;

/* ── 1. 一节多视频：只播完 1 个，还剩 2 个 ──────────────────────────── */
console.log('== 1. 三个 video 任务点，1 完成 2 未完成 ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: CARD('111'), objectid: 'a1' },
    { kind: 'video', finished: false, frameUrl: CARD('111'), objectid: 'a2' },
    { kind: 'video', finished: false, frameUrl: CARD('111'), objectid: 'a3' },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.ok, true, 'ok=true（数据可信）');
  eq(r.stale, false, 'stale=false');
  eq(r.pending.length, 2, '★ 还剩 2 个视频未播');
  eq(r.total, 3, 'total=3（本节 media 任务点总数）');
  eq(r.finished, 1, 'finished=1（已完成数）');
  eq(J.sectionVideosDone(tasks, '111'), false, '未全完成 → sectionVideosDone=false');
}

/* ── 2. 全部完成 ──────────────────────────────────────────────────── */
console.log('== 2. 全部 finished ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: CARD('111'), objectid: 'a1' },
    { kind: 'audio', finished: true, frameUrl: CARD('111'), objectid: 'a2' },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.pending.length, 0, 'pending 为 0');
  eq(r.total, 2, 'total=2');
  eq(r.finished, 2, 'finished=2');
  eq(J.sectionVideosDone(tasks, '111'), true, '★ 全完成 → sectionVideosDone=true');
}

/* ── 3. 任务点全部来自别的 knowledgeid（stale）────────────────────── */
console.log('== 3. 任务点全来自别的 knowledgeid → 不可信 ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: CARD('999') },
    { kind: 'video', finished: true, frameUrl: CARD('999') },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.ok, false, '★ ok=false（不允许用不可信数据判断）');
  eq(r.stale, true, 'stale=true');
  eq(r.pending.length, 0, 'stale 时不下发 pending 结论');
  eq(J.sectionVideosDone(tasks, '111'), false, '★ 不能因为 stale 数据得出「已完成」');
}

/* ── 4. 空数组 ────────────────────────────────────────────────────── */
console.log('== 4. 空数组 ==');
{
  const r = J.pendingSectionVideos([], '111');
  eq(r.ok, true, 'ok=true（空不是 stale）');
  eq(r.pending.length, 0, 'pending 0');
  eq(r.total, 0, 'total=0');
  eq(J.sectionVideosDone([], '111'), false, '★ 空清单不算完成（至少一个）');
}

/* ── 5. document / quiz 必须被忽略 ────────────────────────────────── */
console.log('== 5. document / quiz 忽略 ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: CARD('111') },
    { kind: 'document', finished: false, frameUrl: CARD('111') },
    { kind: 'quiz', finished: false, frameUrl: CARD('111') },
    { kind: 'document', finished: true, frameUrl: CARD('111') },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.total, 1, '★ 只统计 video/audio，document/quiz 不计（total=1）');
  eq(r.pending.length, 0, 'document/quiz 未完成不影响 pending');
  eq(J.sectionVideosDone(tasks, '111'), true, '★ 视频全完成即完成，忽略文档/测验');
}

/* ── 6. audio 与 video 同等对待 ───────────────────────────────────── */
console.log('== 6. audio 与 video 同等对待 ==');
{
  const tasks = [
    { kind: 'audio', finished: true, frameUrl: CARD('111') },
    { kind: 'audio', finished: false, frameUrl: CARD('111'), objectid: 'aud2' },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.total, 2, 'audio 计入 total');
  eq(r.pending.length, 1, 'audio 未完成也进 pending');
  eq(r.pending[0].objectid, 'aud2', 'pending 里的 audio 保留 objectid');
  eq(J.sectionVideosDone(tasks, '111'), false, '有未完成 audio → 未完成');
}

/* ── 7. finished 缺失（undefined）按未完成 ────────────────────────── */
console.log('== 7. finished 缺失按未完成 ==');
{
  const tasks = [
    { kind: 'video', frameUrl: CARD('111') },                 /* 无 finished 字段 */
    { kind: 'video', finished: undefined, frameUrl: CARD('111') },
  ];
  const r = J.pendingSectionVideos(tasks, '111');
  eq(r.pending.length, 2, '★ finished 缺失/undefined 一律算未完成');
  eq(r.finished, 0, 'finished=0');
  eq(J.sectionVideosDone(tasks, '111'), false, '未完成 → 不完成');
}

/* ── 8. pending 项保留 objectid 与 frameUrl（含缺失容忍）───────────── */
console.log('== 8. pending 项保留 objectid 与 frameUrl ==');
{
  const tasks = [
    { kind: 'video', finished: false, objectid: 'oid-1', frameUrl: CARD('111') },
    { kind: 'video', finished: false },   /* objectid / frameUrl 都缺，探针还没补 */
  ];
  /* 传空 chapterId 不做归属过滤，两项都保留，专测字段缺失容忍 */
  const r = J.pendingSectionVideos(tasks, '');
  eq(r.pending.length, 2, '两项都在 pending');
  eq(r.pending[0].objectid, 'oid-1', '第 1 项 objectid 保留');
  eq(r.pending[0].frameUrl, CARD('111'), '第 1 项 frameUrl 保留');
  ok('objectid' in r.pending[1] && r.pending[1].objectid === '', '第 2 项缺 objectid → 补成 \'\' 但字段存在');
  ok('frameUrl' in r.pending[1] && r.pending[1].frameUrl === '', '第 2 项缺 frameUrl → 补成 \'\' 但字段存在');
}

/* ── 9. null / undefined 不抛错 ──────────────────────────────────── */
console.log('== 9. null / undefined 不抛错 ==');
{
  let threw = false;
  let r1, r2, d1, d2;
  try {
    r1 = J.pendingSectionVideos(null, '111');
    r2 = J.pendingSectionVideos(undefined, undefined);
    d1 = J.sectionVideosDone(null, '111');
    d2 = J.sectionVideosDone(undefined, undefined);
  } catch (e) { threw = true; console.log('  抛错：' + ((e && e.message) || e)); }
  ok(threw === false, '★ 传 null / undefined 不抛错');
  eq(r1 && r1.ok, true, 'null → ok=true（按空处理）');
  eq(r1 && r1.pending.length, 0, 'null → pending 0');
  eq(r2 && r2.pending.length, 0, 'undefined → pending 0');
  eq(d1, false, 'null → sectionVideosDone=false');
  eq(d2, false, 'undefined → sectionVideosDone=false');
}

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
process.exit(0);
