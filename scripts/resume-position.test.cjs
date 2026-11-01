#!/usr/bin/env node
/* ============================================================================
 * resume-position.test.cjs — 「从第一节未完成处继续」的判定测试
 * ============================================================================
 * 2026-10-30 事故：
 *   昨天播到 3.3 的 98%，今天每次启动都从 1.1 重来。
 *
 * 根因：起点依赖目录里的 current 标记（posCatalog_active），那是「上次打开的节」，
 * 登录后重新进课程页会被重置到第一节。引擎照着它走 = 每次从头开始。
 *
 * 修法：扫描整个目录找**第一个未完成的节**，不依赖 current。
 *
 * 这个测试用真实目录结构（工程伦理 16 章 85 节）的简化版做推演：
 *   · 1.1 完成、1.2 完成、1.3 完成 …… 3.3 完成、3.4 未完成
 *   · 断言起点落在 3.4，而不是 1.1
 *
 * 用法：node scripts/resume-position.test.cjs
 * ==========================================================================*/
'use strict';

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

console.log('== 断点续看：起点判定 ==');

/**
 * 复刻引擎启动时的起点算法（与 chaoxing-autolearn.js 的 PRECHECK 段一致）
 * @param {Array} items 目录项 {title, done, chapterHeader, current}
 * @returns {number} _lastCurIdx
 */
function pickStartIndex(items) {
  if (!items || !items.length) return null;
  const firstUndone = items.findIndex((x) => !x.done && !x.chapterHeader);
  if (firstUndone >= 0) return firstUndone - 1;
  const ci = items.findIndex((x) => x.current);
  return ci >= 0 ? ci : null;
}

/** 复刻 advanceSection 的搜索：从 _lastCurIdx+1 起，跳过 done，返回第一个未完成 */
function findNextTarget(items, lastCurIdx) {
  const curIdx = (lastCurIdx != null && lastCurIdx >= 0 && lastCurIdx < items.length) ? lastCurIdx : -1;
  const start = curIdx >= 0 ? curIdx + 1 : 0;
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (it.chapterHeader) continue;
    if (it.done) continue;
    return { index: i, title: it.title };
  }
  return null;
}

/* ---- 1. 真实场景：1.1~3.3 已完成，3.4 未完成 ---- */
console.log('  -- 场景 A：昨天做到 3.3，今天应从 3.4 继续 --');

const mk = (title, done, extra) => Object.assign({ title, done, chapterHeader: false, current: false }, extra || {});

const scenarioA = [
  { title: '第一章 工程与工程师', done: false, chapterHeader: true },
  mk('1.1 第四次工业革命', true),
  mk('1.2 工程的含义', true),
  mk('1.3 工程形态', true),
  mk('1.4 作为科学的工程', true),
  mk('1.5 新时代工程的定义', true),
  { title: '第二章 工程职业', done: false, chapterHeader: true },
  mk('2.1 作为职业的工程', true),
  mk('2.2 职业自治', true),
  mk('2.3 从自治走向治理', true),
  mk('2.4 工程伦理的性质', true),
  mk('2.5 工程伦理的作用', true),
  { title: '第三章 工程伦理', done: false, chapterHeader: true },
  mk('3.1 遭遇伦理困境', true),
  mk('3.2 传统理论的局限', true),
  mk('3.3 传统理论及方法的局限性', true),
  mk('3.4 对传统理论及方法的补充', false),
  mk('3.5 后续小节', false),
];

/* 关键：current 被重置到 1.1（这正是 bug 的触发条件） */
scenarioA[1].current = true;

const startA = pickStartIndex(scenarioA);
const targetA = findNextTarget(scenarioA, startA);
ok(targetA !== null, '能找到目标节');
ok(targetA && /^3\.4/.test(targetA.title),
  '★ 起点是 3.4（不是 1.1）', targetA && targetA.title);
ok(targetA && targetA.index === 16, '索引正确（16）', String(targetA && targetA.index));

/* 反证：如果按旧逻辑（用 current 标记），会从哪开始 */
const oldStart = scenarioA.findIndex((x) => x.current);
const oldTarget = findNextTarget(scenarioA, oldStart);
ok(oldTarget && /^3\.4/.test(oldTarget.title),
  '旧逻辑在 done 准确时也能到 3.4（真因是 done 没读到）', oldTarget && oldTarget.title);

/* ---- 2. 边界：全部已完成 ---- */
console.log('  -- 场景 B：全部已完成 --');
const scenarioB = [
  { title: 'H', done: false, chapterHeader: true },
  mk('1.1', true), mk('1.2', true), mk('1.3', true),
];
const startB = pickStartIndex(scenarioB);
const targetB = findNextTarget(scenarioB, startB);
ok(targetB === null, '★ 全部完成 → 无目标（走 ALL_DONE）', JSON.stringify(targetB));

/* ---- 3. 边界：第一节就未完成 ---- */
console.log('  -- 场景 C：第一节未完成 --');
const scenarioC = [
  { title: 'H', done: false, chapterHeader: true },
  mk('1.1', false), mk('1.2', false),
];
const startC = pickStartIndex(scenarioC);
ok(startC === 0, '★ _lastCurIdx = 0-1 = -1（表示「还没开始」）', String(startC));
const targetC = findNextTarget(scenarioC, startC);
ok(targetC && targetC.index === 1 && targetC.title === '1.1',
  '★ 从 1.1 开始（-1 的边界正确处理）', JSON.stringify(targetC));

/* ---- 4. 边界：_lastCurIdx = -1 不能被当成有效索引 ---- */
console.log('  -- 场景 D：-1 边界（防止读 items[-1]）--');
const negTarget = findNextTarget(scenarioC, -1);
ok(negTarget && negTarget.index === 1, '★ -1 时 start=0，不越界', JSON.stringify(negTarget));
const nullTarget = findNextTarget(scenarioC, null);
ok(nullTarget && nullTarget.index === 1, 'null 时 start=0', JSON.stringify(nullTarget));

/* ---- 5. 章头不能被当成目标 ---- */
console.log('  -- 场景 E：章头不可点击 --');
const scenarioE = [
  mk('1.1', true),
  { title: '第二章', done: false, chapterHeader: true },
  mk('2.1', false),
];
const startE = pickStartIndex(scenarioE);
const targetE = findNextTarget(scenarioE, startE);
ok(targetE && targetE.title === '2.1', '★ 跳过章头，选中 2.1', JSON.stringify(targetE));

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
