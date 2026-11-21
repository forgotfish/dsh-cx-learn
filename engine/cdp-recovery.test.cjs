#!/usr/bin/env node
/* ============================================================================
 * cdp-recovery.test.cjs —— 内核崩溃恢复路径的回归守卫
 *
 * 真实事故：ensureBrowser 的 onUnexpectedClose 里写成了裸调用
 *   .then(() => _onCdpLost(kind))
 * 而 _onCdpLost 是 adapter 的方法，不是局部变量 → 触发时
 *   ReferenceError: _onCdpLost is not defined
 * → 崩溃恢复完全失效（日志里 BROWSER_CRASHED 直接终止）。
 *
 * 真触发该路径需要真实 CDP 连接断裂，成本高；这里用源码契约锁住写法：
 * 必须是 this._onCdpLost(...)，且不存在裸调用。
 * 用法：node engine/cdp-recovery.test.cjs
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

const src = fs.readFileSync(path.join(__dirname, 'src', 'browser', 'cdp.js'), 'utf8');

console.log('== cdp 崩溃恢复路径源码契约 ==');
ok(/this\._onCdpLost\(kind\)/.test(src), '★ 恢复入口以 this._onCdpLost(kind) 调用');
/* 裸调用检测：出现过 `_onCdpLost(`，但其前一个字符不是 `.`（即没有 this./xxx. 前缀）。
   允许定义处 `async _onCdpLost(kind) {`（前面是空格）。 */
{
  const bare = [];
  const re = /(^|[^.\w])_onCdpLost\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = m[1];
    /* 定义：`async _onCdpLost(` 前面是空格；调用：`() _onCdpLost(` 前面是空格也要拦。
       只放行「定义」，即前面同时出现 async 的情况。 */
    const idx = m.index + m[0].length - '_onCdpLost('.length;
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', idx));
    if (/\basync\s+_onCdpLost\s*\(/.test(line)) continue; // 方法定义，放行
    bare.push(line.trim().slice(0, 60));
  }
  ok(bare.length === 0, '★ 不存在裸调用 _onCdpLost(...)（实际 ' + JSON.stringify(bare) + '）');
}

console.log('');
if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('== 全部通过（' + pass + ' 项）==');
