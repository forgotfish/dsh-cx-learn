#!/usr/bin/env node
/* ============================================================================
 * release-guard.cjs —— 发布前「版本一致性」守卫
 *
 * 背景（真实踩过的坑）：公开仓曾出现 package.json=0.2.0、tag=v0.2.3、
 * 本地=0.2.4 三处不一致，而 audit 只扫泄漏、不查元数据一致性 → 静默漂移。
 *
 * 这里只做一件确定的事：**package.json 的 version 必须等于 CHANGELOG 顶部版本段**。
 * （tag 由发布步骤单独打，脚本运行时尚未建 tag，故不在本函数校验。）
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

function checkRelease(root) {
  const problems = [];
  let pkgVersion = '';
  let changelogTop = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    pkgVersion = String(pkg.version || '');
  } catch (e) {
    problems.push('读不到 package.json: ' + String((e && e.message) || e).slice(0, 80));
  }
  try {
    const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(cl);
    if (m) changelogTop = m[1];
    else problems.push('CHANGELOG.md 顶部没有形如 "## [x.y.z]" 的版本段');
  } catch (e) {
    problems.push('读不到 CHANGELOG.md: ' + String((e && e.message) || e).slice(0, 80));
  }
  if (pkgVersion && changelogTop && pkgVersion !== changelogTop) {
    problems.push('版本不一致：package.json=' + pkgVersion + ' 但 CHANGELOG 顶部=' + changelogTop);
  }
  return { ok: problems.length === 0, version: pkgVersion, changelogTop, problems };
}

module.exports = { checkRelease };

/* 直接命令行运行：node scripts/release-guard.cjs [root] */
if (require.main === module) {
  const root = process.argv[2] || path.resolve(__dirname, '..');
  const r = checkRelease(root);
  if (!r.ok) {
    console.error('✗ 版本一致性校验失败：');
    r.problems.forEach((p) => console.error('   - ' + p));
    process.exit(1);
  }
  console.log('✓ 版本一致性 OK：v' + r.version + '（package.json 与 CHANGELOG 顶部一致）');
}
