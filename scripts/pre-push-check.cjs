#!/usr/bin/env node
/* ============================================================================
 * pre-push-check.cjs —— push 前门禁（对标 ocsjs 的 .husky/pre-push）
 *
 * 为什么要有：以前测试只是「本地习惯」，push 前没有任何拦截；
 * CI 也不跑测试（2026-11-23 前），等于测试白写。
 *
 * 检查项（全绿才允许 push）：
 *   1. 全量单元测试（scripts/run-all-tests.cjs）
 *   2. 引擎自检（--self-test）
 *   3. 版本一致性（scripts/release-guard.cjs）
 *
 * 逃生口：git push --no-verify
 *
 * 用法：
 *   node scripts/pre-push-check.cjs
 *   node scripts/install-hooks.cjs      # 安装到 .git/hooks/pre-push
 * ==========================================================================*/
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function step(label, args) {
  console.log('\n▶ ' + label);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) { console.error('✗ 启动失败: ' + r.error.message); return false; }
  if (r.status !== 0) { console.error('✗ ' + label + ' 未通过（exit=' + r.status + '）'); return false; }
  console.log('✓ ' + label);
  return true;
}

let ok = true;
ok = step('全量单元测试', [path.join('scripts', 'run-all-tests.cjs'), '--quiet']) && ok;
ok = step('引擎自检 --self-test', [path.join('engine', 'chaoxing-autolearn.js'), '--self-test']) && ok;
ok = step('版本一致性', [path.join('scripts', 'release-guard.cjs')]) && ok;
ok = step('教训静态检查（探针转义/版本锁/变异锚点）', [path.join('scripts', 'lessons-check.cjs')]) && ok;

if (!ok) {
  console.error('\n============================================');
  console.error('✗ 门禁未通过，拒绝 push。');
  console.error('  修复后重试；确需强推请用：git push --no-verify');
  process.exit(1);
}
console.log('\n============================================');
console.log('✓ 门禁全部通过，允许 push');
