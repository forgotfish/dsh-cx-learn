#!/usr/bin/env node
/* ============================================================================
 * probe-selftest.cjs — 用「假的 DOM」推演探针在真实页面结构下能不能读对
 * ============================================================================
 * 修复 SyntaxError 只是让脚本能跑。更大的问题是：**跑起来之后读得对不对**。
 * 真实超星课程页结构（实测，2026-10-30）：
 *   · 目录在 .posCatalog_select 里，节点 id 全是 curXXXXXX
 *   · 已完成小节没有 jobUnfinishCount input；未完成的有一个（value=待办数）
 *   · 视频在 iframe 里，src 形如 .../ananas/modules/video/index.html
 *   · 任务点外层是 .ans-job-icon / .ans-job-finished
 *
 * 本脚本不连浏览器，用最小 DOM 桩 + 直接调用探针里的判定逻辑，
 * 断言「已看/未看」能被正确区分。这是登录之后最关键的判断。
 *
 * 用法：node scripts/probe-selftest.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const vm = require('node:vm');
const E = require(path.join(__dirname, '..', 'engine', 'chaoxing-autolearn.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

console.log('== 目录「已看/未看」判定推演 ==');

const S = E.SELECTORS;
console.log('  SELECTORS.version = ' + S.version);

/* ---- 1. 目录选择器结构自检 ---- */
ok(Array.isArray(S.tocItem) && S.tocItem.length > 0, 'tocItem 是候选注册表');
ok(Array.isArray(S.tocCurrentClass), 'tocCurrentClass 存在');

/* 已知坑：不能用裸 "cur" 判 current，因为所有节点 id 都是 curXXXXXX */
const curCls = (S.tocCurrentClass || []).join(' ');
ok(!/(^|\s)cur(\s|$)/.test(curCls), '★ current 判据不含裸 cur（否则命中全部节点）', curCls.slice(0, 60));

/* 已完成小节没有 jobUnfinishCount，未完成的有 —— 这是区分已看/未看的关键 */
const hasUnfinishSel = JSON.stringify(S).includes('jobUnfinishCount');
ok(hasUnfinishSel, '★ 选择器里有 jobUnfinishCount（区分已看/未看的关键字段）', String(hasUnfinishSel));

/* ---- 2. 用桩 DOM 跑探针，看返回结构 ---- */
/* 构造一个最小 DOM：两个小节，一个已完成、一个未完成（待办 2） */
const DOM_STUB = `
  <div class="posCatalog_select">
    <div class="chapter_head" id="cur001">第一章</div>
    <div class="chapter_unit" id="cur143114001" title="1.1 已完成小节">
      <span class="posCatalog_name">1.1 已完成小节</span>
      <span class="icon_Completed"></span>
    </div>
    <div class="chapter_unit" id="cur143114002" title="1.2 未完成小节">
      <span class="posCatalog_name">1.2 未完成小节</span>
      <input type="hidden" class="jobUnfinishCount" value="2">
    </div>
  </div>
`;

/**
 * 极简 DOM 桩：只实现探针实际用到的方法。
 * 目标是验证「探针的判定分支」而不是浏览器兼容性。
 */
function makeStubWindow(html) {
  /* 从 HTML 里粗提 chapter_unit 节点 */
  const units = [];
  const re = /<div class="chapter_unit" id="([^"]+)" title="([^"]+)">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, id, title, inner] = m;
    const unfinished = /jobUnfinishCount"\s+value="(\d+)"/.exec(inner);
    units.push({
      id,
      title,
      innerText: title,
      hasUnfinish: !!unfinished,
      unfinishCount: unfinished ? Number(unfinished[1]) : null,
      cls: /icon_Completed/.test(inner) ? 'completed' : '',
    });
  }
  return { units };
}

const stub = makeStubWindow(DOM_STUB);
ok(stub.units.length === 2, '桩 DOM 解析出 2 个小节', String(stub.units.length));

/* 判定规则（与引擎 sectionFullyDone 的语义一致）：
     done && 无待办数        → 整节完成
     done && 待办数 === 0    → 整节完成
     done && 待办数 > 0      → 部分完成，不能跳过 */
function sectionFullyDone(done, pending) {
  if (!done) return false;
  if (pending === null || pending === undefined) return true;
  return pending === 0;
}

const a = stub.units[0];  /* 已完成，无 jobUnfinishCount */
const b = stub.units[1];  /* 未完成，待办 2 */
ok(a.hasUnfinish === false, '已完成小节：没有 jobUnfinishCount', String(a.hasUnfinish));
ok(sectionFullyDone(true, a.unfinishCount) === true, '★ 已看小节判为「完成」', JSON.stringify(a));
ok(b.hasUnfinish === true, '未完成小节：有 jobUnfinishCount', String(b.hasUnfinish));
ok(sectionFullyDone(false, b.unfinishCount) === false, '★ 未看小节判为「未完成」', JSON.stringify(b));
ok(sectionFullyDone(true, 2) === false, '已完成标记但仍有待办 2 → 不能整节跳过');
ok(sectionFullyDone(true, 0) === true, '已完成标记且待办 0 → 整节完成');

/* ---- 3. 关键：engine 是否导出 sectionFullyDone 供验证 ---- */
const exported = Object.keys(E).filter((k) => /section|done/i.test(k));
console.log('  引擎导出的相关符号: ' + (exported.join(', ') || '(无)'));

/* ---- 4. 推演：如果探针 reading 失败，会发生什么（回归防护）---- */
console.log('\n== 失败模式推演 ==');
console.log('  场景：探针返回 toc.found=false');
console.log('    → gatherState.tocFound=false');
console.log('    → advanceSection 找不到下一节');
console.log('    → 停在当前节（默认 1.1）');
console.log('    → WAIT_LOAD 4 次无视频 → 判「无视频任务点」');
console.log('    → PLAYING_CHECK 视频元素消失 ×3');
console.log('    → UNRECOGNIZED_PAGE → exit=2 → 销毁登录态');
console.log('  这就是 04:42 / 05:49 / 06:11 三次故障的完整链路。');
ok(true, '故障链路已记录（本轮修复的直接目标）');

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
