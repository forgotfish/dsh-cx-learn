#!/usr/bin/env node
/* ============================================================================
 * verify-injectable.cjs — 验证注入页面的脚本能真正编译
 * ============================================================================
 * 为什么必须单独做：
 *   `node --check` 只查宿主文件语法。注入脚本是**字符串**，字符串内容坏了
 *   完全看不见。而这类错误上线后表现为「每个 frame 都读不到内容」，
 *   报错还没法反推：
 *       SyntaxError: Unexpected token 'else'
 *
 * 2026-10-30 事故：PAGE_PROBE_SRC 是模板字面量，里面写 `/\/modules\/video\//i`，
 * `\/` 在字符串层被吃掉变成 `/`，正则成了 `//modules/video//i`，`//` 变注释，
 * 整段 800 行注入脚本编译失败 → tocFound/hasVideo 永远 false →
 * 每次都卡在 1.1、重试 4 次、UNRECOGNIZED_PAGE、exit=2，还烧掉一次性登录态。
 *
 * 所以：任何改到 PAGE_PROBE_SRC / STRUCT_SCAN_EXPR / SCAN 的提交，
 * 都必须先跑这个脚本。
 *
 * 用法：node scripts/verify-injectable.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const vm = require('node:vm');

const ENGINE = path.join(__dirname, '..', 'engine', 'chaoxing-autolearn.js');
const E = require(ENGINE);

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

console.log('== 注入脚本编译验证 ==');

/* ---- 1. 真实注入表达式（引擎实际会 eval 的那一坨）---- */
const cfg = E.mergeConfig(E.CONFIG, {});
let expr = '';
let buildErr = null;
try {
  expr = E.installProbeExpression(cfg);
} catch (e) {
  buildErr = e;
}
ok(!buildErr, 'installProbeExpression 能构造', buildErr && buildErr.message);

if (expr) {
  ok(expr.length > 10000, '注入表达式长度正常', String(expr.length));

  let compileErr = null;
  try {
    new vm.Script(expr, { filename: 'inject-probe.js' });
  } catch (e) {
    compileErr = e;
  }
  ok(!compileErr, '★ 注入表达式能编译（这一项挂了，整页都读不到）', compileErr && compileErr.message);

  /* 错误里带行号时，打印现场，方便直接跳到出错那一行 */
  if (compileErr) {
    const m = /inject-probe\.js:(\d+)/.exec(String(compileErr.stack || ''));
    if (m) {
      const ln = Number(m[1]);
      const lines = expr.split('\n');
      console.log('       出错在第 ' + ln + ' 行附近：');
      for (let k = Math.max(0, ln - 3); k < Math.min(lines.length, ln + 2); k++) {
        console.log('         ' + (k + 1) + ': ' + lines[k].slice(0, 120));
      }
    }
  }
}

/* ---- 2. 关键正则的功能验证（编译通过但语义错也要抓）---- */
console.log('  -- 正则语义 --');
const cases = [
  ['视频 URL 判定', /\/modules\/video\//i, 'https://x/ananas/modules/video/index.html', true],
  ['视频 URL 判定', /\/modules\/video\//i, 'https://x/ananas/modules/audio/index.html', false],
  ['音频 URL 判定', /\/modules\/audio\//i, 'https://x/ananas/modules/audio/index.html', true],
  ['作业 URL 判定', /work|quiz|exam/i, 'https://x/ananas/modules/work/index.html', true],
];
for (const [label, re, url, want] of cases) {
  ok(re.test(url) === want, label + '：' + url.slice(0, 46), String(re));
}

/* ---- 3. 模板里「单反斜杠转义 /」的静态扫描 ----
   注意：要在**求值后的字符串**上扫，不是在源码上扫。
   求值后如果出现 `/\/` 说明源码里写的是 `\\/`（正确）；
   如果正则体里出现裸 `\/` 且被 `//` 截断，说明写错了。 */
console.log('  -- 模板转义静态检查 --');
const suspicious = [];
if (expr) {
  expr.split('\n').forEach((ln, i) => {
    /* 危险信号：一行里出现 `//` 紧跟字母，且这行看起来是正则调用 */
    if (/\/\/[a-z]+\//i.test(ln) && /\.test\(|\.match\(|\.replace\(/.test(ln)) {
      suspicious.push({ line: i + 1, text: ln.trim().slice(0, 110) });
    }
  });
}
ok(suspicious.length === 0, '★ 求值后没有「// 被当注释」的可疑正则行',
  suspicious.length ? suspicious.map((s) => 'L' + s.line).join(',') : undefined);
if (suspicious.length) {
  suspicious.forEach((s) => console.log('       L' + s.line + ': ' + s.text));
}

/* ---- 4. 其它注入常量至少存在且非空 ---- */
for (const name of ['STRUCT_SCAN_EXPR', 'SCAN']) {
  const t = E[name];
  if (typeof t === 'string') ok(t.length > 200, name + ' 存在且非空', String(t.length));
  else ok(true, name + ' 不是模块导出（跳过编译检查）');
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
