#!/usr/bin/env node
/* ============================================================================
 * ui-kernel-line.cjs — 设置页「内核健康行」的渲染逻辑验证
 * ============================================================================
 * 背景：client.js 里 kernelLine 是纯字符串拼接，字段全来自 /health 或 status()
 * 的 browser 对象。这些字段**可能缺失**（引擎比插件旧、内核从未启动、
 * 心跳还没跑第一轮）。缺一个字段就拼出 "undefined" 或 "NaN"，用户会看到
 * "内核：就绪 pid undefined · CDP NaN"这种垃圾 —— 这类 bug 只有在浏览器里
 * 肉眼才能发现，所以这里把逻辑抽出来跑一遍。
 *
 * 做法：从 client.js 里按原文抽出 ageText 与 kernelLine 的等价实现
 * （保持逐字一致），喂 6 种真实/边界输入。
 *
 * 用法：node scripts/ui-kernel-line.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* ---- 1. 从 client.js 里逐字抽取 ageText / kernelLine，防止两处实现漂移 ---- */
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

const ageTextMatch = src.match(/const ageText = \(ms\) => \{[\s\S]*?\n    \}/);
if (!ageTextMatch) { console.error('未能在 client.js 中定位 ageText'); process.exit(1) }
const kernelLineMatch = src.match(/const kernelLine = \(\(\) => \{[\s\S]*?\n      \}\)\(\)/);
if (!kernelLineMatch) { console.error('未能在 client.js 中定位 kernelLine'); process.exit(1) }

/* 在同一作用域里求值：ageText 先定义，kernelLine 依赖它 */
const factory = new Function(
  'st',
  ageTextMatch[0].replace(/^\s+/, '') + '\n' +
  'const br = st?.browser || null;\n' +
  'const browserBad = !!br && br.alive === false;\n' +
  kernelLineMatch[0].replace(/^\s+/, '') + '\n' +
  'return { kernelLine, browserBad };'
);

console.log('== 设置页「内核健康行」渲染 ==');

/* ---- 2. 正常：内核在跑，心跳新鲜 ---- */
{
  const { kernelLine, browserBad } = factory({
    browser: { alive: true, pid: 4242, port: 34319, ageMs: 4200, restarts: 0, lastErrorKind: '' },
  });
  console.log('  正常: ' + kernelLine);
  ok(kernelLine.includes('就绪'), '显示「就绪」');
  ok(kernelLine.includes('pid 4242'), '带 pid');
  ok(kernelLine.includes('CDP 34319'), '带 CDP 端口');
  ok(kernelLine.includes('4s 前'), '心跳显示 4s 前');
  ok(!kernelLine.includes('重启'), '重启 0 次时不显示（减少噪音）');
  ok(browserBad === false, 'browserBad 为 false');
}

/* ---- 3. 崩溃过 ---- */
{
  const { kernelLine, browserBad } = factory({
    browser: { alive: false, pid: 9, port: 34319, ageMs: 61000, restarts: 2, lastErrorKind: 'CRASHED' },
  });
  console.log('  崩溃: ' + kernelLine);
  ok(kernelLine.includes('已停止'), '★ alive:false → 「已停止」');
  ok(kernelLine.includes('重启 2 次'), '带重启次数');
  ok(kernelLine.includes('CRASHED'), '带错误类型');
  ok(kernelLine.includes('1 分钟前'), '心跳 61s → 「1 分钟前」');
  ok(browserBad === true, '★ browserBad 为 true（UI 标红）');
}

/* ---- 4. ★ 关键边界：browser 为 null（内核从未启动过 / 引擎比插件旧） ---- */
{
  const { kernelLine, browserBad } = factory({ browser: null });
  console.log('  无数据: ' + kernelLine);
  ok(kernelLine === '内核：—', '★ browser 为 null → 整行只剩「内核：—」');
  ok(!kernelLine.includes('undefined'), '不出现 undefined');
  ok(browserBad === false, '无数据时不标红（不是故障）');
}

/* ---- 5. ★ 关键边界：字段全缺（老引擎只写了 ready/port） ---- */
{
  const { kernelLine } = factory({ browser: { ready: true, port: 1 } });
  console.log('  老字段: ' + kernelLine);
  ok(!kernelLine.includes('undefined'), '★ 缺 pid/alive/ageMs 时不出现 undefined');
  ok(!kernelLine.includes('NaN'), '不出现 NaN');
  ok(kernelLine.includes('—'), '缺失项显示「—」');
}

/* ---- 6. ★ 关键边界：心跳时间是解析不了的字符串 ---- */
{
  const { kernelLine } = factory({
    browser: { alive: true, port: 34319, heartbeatAt: 'not-a-date', ageMs: null, restarts: 0 },
  });
  console.log('  坏时间: ' + kernelLine);
  ok(!kernelLine.includes('NaN'), '★ heartbeatAt 非法时不出现 NaN');
  ok(kernelLine.includes('—'), '显示「—」');
}

/* ---- 7. ageText 单独验证分档 ---- */
{
  const { kernelLine } = factory({ browser: { alive: true, port: 1, ageMs: 5 * 60 * 1000 } });
  ok(kernelLine.includes('5 分钟前'), '5 分钟 → 「5 分钟前」', kernelLine);
}
{
  const { kernelLine } = factory({ browser: { alive: true, port: 1, ageMs: 2 * 3600 * 1000 } });
  ok(kernelLine.includes('2 小时前'), '2 小时 → 「2 小时前」', kernelLine);
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
