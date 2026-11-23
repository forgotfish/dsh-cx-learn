#!/usr/bin/env node
/* ============================================================================
 * run-all-tests.cjs —— 全量测试统一入口（CI / pre-push / 本地共用同一条命令）
 *
 * 为什么要有：
 *   以前 38 个 *.test.cjs 只靠「本地手动逐个跑」，CI 里只跑 --check + --self-test，
 *   等于测试没有门禁（对标 ocsjs 的 pnpm check 会拦住不合格提交）。
 *
 * 设计要点：
 *   · 用**退出码**判定（各测试文件失败时都 process.exit(非0)），不解析输出文本
 *     —— 文本判定曾经误伤（"计失败" 这种标签被当成失败）。
 *   · 子进程用 stdio:'inherit'（不是管道），这样在 Windows 受限环境下也能跑
 *     （管道捕获会触发 EPERM；inherit 不受限）。
 *   · 失败也**跑完全部**再汇总，不早退——一次看到所有红项。
 *
 * 用法：
 *   node scripts/run-all-tests.cjs            # 全量
 *   node scripts/run-all-tests.cjs --quiet    # 只打印每项结果与汇总
 * ==========================================================================*/
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const SKIP_DIRS = new Set(['node_modules', '.git', '.state', '.login', 'dist', 'lib', '_refs']);

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.test.cjs')) out.push(full);
  }
}

const files = [];
walk(ROOT, files);
files.sort();

if (!files.length) {
  console.error('✗ 没找到任何 *.test.cjs');
  process.exit(1);
}

const failed = [];
const t0 = Date.now();
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (!QUIET) console.log('\n=========== ' + rel + ' ===========');
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.error('✗ ' + rel + ' 启动失败: ' + r.error.message);
    failed.push(rel);
    continue;
  }
  if (r.status !== 0) failed.push(rel + ' (exit=' + r.status + ')');
  if (QUIET) console.log((r.status === 0 ? '✓ ' : '✗ ') + rel);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n============================================');
console.log('测试文件 ' + files.length + ' 个，失败 ' + failed.length + ' 个，耗时 ' + secs + 's');
if (failed.length) {
  console.log('失败清单:');
  failed.forEach((x) => console.log('  ✗ ' + x));
  process.exit(1);
}
console.log('全部通过 ✓');
