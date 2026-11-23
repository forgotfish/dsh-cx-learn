#!/usr/bin/env node
/* ============================================================================
 * install-hooks.cjs —— 把 pre-push 门禁装进 .git/hooks（零依赖，不用 husky）
 *
 * 为什么不用 husky：本项目「零 npm 依赖」是卖点（引擎只用 Node 内置模块），
 * 引入 husky 意味着 contributors 要 npm install。用 Node 生成一个钩子脚本即可。
 *
 * 用法：node scripts/install-hooks.cjs
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const hookDir = path.join(ROOT, '.git', 'hooks');
const hookPath = path.join(hookDir, 'pre-push');

if (!fs.existsSync(hookDir)) {
  console.error('✗ 找不到 .git/hooks —— 这里不是 git 仓库根目录？');
  process.exit(1);
}

const script = `#!/bin/sh
# 由 scripts/install-hooks.cjs 生成 —— 请勿手改（改 scripts/pre-push-check.cjs）
# 逃生口：git push --no-verify
echo "[pre-push] 跑门禁：测试 + 自检 + 版本一致性 ..."
node "$(git rev-parse --show-toplevel)/scripts/pre-push-check.cjs"
`;
fs.writeFileSync(hookPath, script, { mode: 0o755 });
try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* Windows 无需 */ }
console.log('✓ 已安装 pre-push 钩子: ' + hookPath);
console.log('  跳过门禁: git push --no-verify');
