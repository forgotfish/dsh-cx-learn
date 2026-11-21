#!/usr/bin/env node
/* ============================================================================
 * release-guard.test.cjs —— 发布版本一致性守卫的单测
 * 断言：package.version 与 CHANGELOG 顶部版本段一致才通过；不一致必失败。
 * 用法：node scripts/release-guard.test.cjs
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkRelease } = require('./release-guard.cjs');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

function mk(dir, pkgVersion, changelog) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }, null, 2));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-rg-'));

/* 1. 一致 → 通过 */
{
  const d = path.join(base, 'ok'); mk(d, '0.2.4', '# Changelog\n\n## [0.2.4] — 2026-11-21\n\n- x\n\n## [0.2.3] — 2026-11-18\n');
  const r = checkRelease(d);
  ok(r.ok === true, '★ 版本一致 → 通过（实际 ' + JSON.stringify(r.problems) + '）');
  ok(r.version === '0.2.4' && r.changelogTop === '0.2.4', '  取到 0.2.4/0.2.4（实际 ' + r.version + '/' + r.changelogTop + '）');
}

/* 2. 不一致 → 失败 */
{
  const d = path.join(base, 'bad'); mk(d, '0.2.4', '# Changelog\n\n## [0.2.0] — 老\n');
  const r = checkRelease(d);
  ok(r.ok === false, '★ 版本不一致 → 失败（实际 ok=' + r.ok + '）');
  ok(r.problems.some((p) => /不一致/.test(p)), '  报「不一致」（实际 ' + JSON.stringify(r.problems) + '）');
}

/* 3. CHANGELOG 无版本段 → 失败 */
{
  const d = path.join(base, 'noc'); mk(d, '1.0.0', '# Changelog\n\n没版本段\n');
  const r = checkRelease(d);
  ok(r.ok === false, '★ 无版本段 → 失败（实际 ok=' + r.ok + '）');
}

/* 4. 真实工作区（当前仓）应通过（package 0.2.4 == CHANGELOG 顶部 0.2.4） */
{
  const realRoot = path.resolve(__dirname, '..');
  const r = checkRelease(realRoot);
  ok(r.ok === true, '★ 当前工作区版本自洽（实际 ' + JSON.stringify(r.problems) + '）');
}

fs.rmSync(base, { recursive: true, force: true });

console.log('');
if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('== 全部通过（' + pass + ' 项）==');
