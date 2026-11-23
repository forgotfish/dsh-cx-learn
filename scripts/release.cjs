#!/usr/bin/env node
/* ============================================================================
 * release.cjs —— 一条命令发版（对标 ocsjs 的 release-please 流水线，但零依赖）
 *
 * 现状痛点：发一次版要手工做 5 步 —— 改版本 → 写 CHANGELOG → 跑 publish-public.cjs
 * → 克隆公开仓打 tag → 建 GitHub Release（→ 再同步 fnOS）。任何一步漏掉就出现
 * 「代码已发、元数据没跟上」的漂移（历史上真实发生过 0.2.0/v0.2.3/0.2.4 三处不一致）。
 *
 * 本脚本把这些步骤串成一条，且**默认只做只读预检**：
 *   node scripts/release.cjs                 # 预检（不推送、不建 tag、不发 Release）
 *   node scripts/release.cjs --dry-run       # 同上（显式）
 *   node scripts/release.cjs --yes           # 真发：publish → tag → Release
 *   node scripts/release.cjs --yes --skip-fnos
 *
 * 安全性：
 *   · 不加 --yes 绝不推送任何东西。
 *   · 预检会拦：工作区不干净 / 版本与 CHANGELOG 不一致 / 测试未通过（除非 --skip-tests）。
 *   · fnOS 生产机**默认不动**（只打印后续命令），需要 --fnos 显式开启。
 *
 * 需要网络与 GitHub 凭据（沿用本机 git credential；publish-public.cjs 已在用）。
 * ==========================================================================*/
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const YES = has('--yes');
const SKIP_TESTS = has('--skip-tests');
const SKIP_FNOS = has('--skip-fnos');
const FNOS = has('--fnos');
const msgArg = args.find((a) => a.startsWith('--message='));
const MESSAGE = msgArg ? msgArg.slice('--message='.length) : '';

function log(s) { process.stdout.write(s + '\n'); }
function die(s, code) { console.error('\n✗ ' + s); process.exit(code || 1); }
function run(cmd, cmdArgs, opts) {
  const o = opts || {};
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: o.inherit ? 'inherit' : 'pipe' });
  return r;
}
function node(scriptArgs, inherit) {
  return run(process.execPath, scriptArgs, { inherit });
}

/* ---------------- 0. 读版本 ---------------- */
let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
catch (e) { die('读不到 package.json: ' + e.message); }
const VERSION = String(pkg.version || '');
const TAG = 'v' + VERSION;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die('package.json version 非 x.y.z：' + VERSION);

log('============================================');
log('发版计划');
log('  版本    : ' + VERSION);
log('  tag     : ' + TAG);
log('  模式    : ' + (YES ? '真发（会推送/打 tag/建 Release）' : '预检（只读，不推送）'));
log('  fnOS    : ' + (FNOS ? '会同步（需单独确认）' : '不动（默认）'));
log('============================================');

/* ---------------- 1. 预检：工作区干净 ---------------- */
log('\n[1/5] 工作区检查');
const st = run('git', ['status', '--porcelain']);
if (st.status !== 0) die('git status 失败: ' + (st.stderr || ''));
const dirty = String(st.stdout || '').split('\n').filter((l) => l.trim() && !/^\?\?\s+(\.agent-teams\/|HANDOFF-)/.test(l));
if (dirty.length) {
  log('  未提交改动：');
  dirty.forEach((l) => log('    ' + l));
  die('工作区不干净，先提交再发版。');
}
log('  ✓ 干净（忽略本地未跟踪的 .agent-teams/ 与 HANDOFF-*.md）');

/* ---------------- 2. 预检：版本一致性 ---------------- */
log('\n[2/5] 版本一致性（package.version == CHANGELOG 顶部）');
const guard = node([path.join('scripts', 'release-guard.cjs')], true);
if (guard.status !== 0) die('版本一致性未通过');
log('  ✓ 通过');

/* ---------------- 3. 预检：测试 ---------------- */
log('\n[3/5] 全量测试');
if (SKIP_TESTS) {
  log('  ⚠ 已跳过（--skip-tests）');
} else {
  const t = node([path.join('scripts', 'run-all-tests.cjs'), '--quiet'], false);
  const out = String(t.stdout || '');
  const tail = out.split('\n').filter((l) => /测试文件|失败|全部通过/.test(l)).slice(-3).join('\n');
  if (t.status !== 0) { log(tail); die('测试未通过，拒绝发版'); }
  log(tail || '  ✓ 通过');
}

/* ---------------- 4. 预检：tag 是否已存在 ---------------- */
log('\n[4/5] 检查 tag ' + TAG + ' 是否已存在（本地）');
const tagExists = run('git', ['tag', '--list', TAG]).stdout.trim();
if (tagExists) {
  log('  ⚠ 本地已存在 tag ' + TAG + '（真发会失败，请先确认是否已发过）');
} else {
  log('  ✓ 尚无该 tag');
}

/* ---------------- 预检结束 ---------------- */
if (!YES) {
  log('\n============================================');
  log('预检通过。**未推送任何东西。**');
  log('真发请执行：');
  log('  node scripts/release.cjs --yes' + (MESSAGE ? ' --message="' + MESSAGE + '"' : ''));
  log('（需要 Clash 代理与 GitHub 凭据；publish 会做脱敏审计）');
  log('============================================');
  process.exit(0);
}

/* ---------------- 5a. 真发：publish ---------------- */
log('\n[5/5] 真发开始');
log('\n  → publish-public.cjs（脱敏审计 + 推送公开仓）');
const pubArgs = [path.join('scripts', 'publish-public.cjs')];
if (MESSAGE) pubArgs.push('--message=' + MESSAGE);
else pubArgs.push('--message=release: ' + TAG);
const pub = node(pubArgs, true);
if (pub.status !== 0) die('publish 失败（公开仓可能未更新）');

/* ---------------- 5b. 真发：打 tag 并推送 ---------------- */
log('\n  → 打 tag ' + TAG + ' 并推送');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-release-'));
try {
  const clone = run('git', ['clone', '--depth', '1', '--branch', 'main',
    'https://github.com/forgotfish/dsh-cx-learn.git', tmp]);
  if (clone.status !== 0) die('克隆公开仓失败: ' + (clone.stderr || ''));
  run('git', ['-C', tmp, 'config', 'user.name', 'forgotfish']);
  run('git', ['-C', tmp, 'config', 'user.email', 'forgotfish@users.noreply.github.com']);
  const tg = run('git', ['-C', tmp, 'tag', '-a', TAG, '-m', 'release ' + TAG]);
  if (tg.status !== 0) die('打 tag 失败: ' + (tg.stderr || ''));
  const push = run('git', ['-C', tmp, 'push', 'origin', TAG], { inherit: true });
  if (push.status !== 0) die('推送 tag 失败');
  log('  ✓ tag 已推 ' + TAG);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

/* ---------------- 5c. 提示后续 ---------------- */
log('\n============================================');
log('✓ publish 与 tag 完成：' + TAG);
log('');
log('还需两步（本脚本不代劳，避免误操作）：');
log('  1) 建 GitHub Release：浏览器打开');
log('     https://github.com/forgotfish/dsh-cx-learn/releases/new?tag=' + TAG);
log('     （或告诉我「发 Release」，我用 API 建，正文取 CHANGELOG 顶部段落）');
if (!SKIP_FNOS && !FNOS) {
  log('  2) fnOS 同步：见 skill `fnos-runbook` §4；或加 --fnos 让我按手册执行');
}
log('============================================');
