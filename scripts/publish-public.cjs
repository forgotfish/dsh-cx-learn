#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * publish-public.cjs —— 把开发目录里的代码同步到公开仓
 *
 * 背景：公开仓不能包含内部文档（HANDOFF/STATUS/DECISIONS…）、部署脚本（ops/）、
 *       真实课程夹具（docs/fixtures）、一次性探针（scripts/_archive）和私有路径。
 *       以前靠手工维护一个 _cx-learn-open 目录，容易过期、容易覆盖掉修好的东西。
 *
 * 做法：克隆公开仓到临时目录 → 只覆盖「白名单」里的代码与测试 →
 *       去掉私有路径 → 在临时目录里跑严格审计 + 语法/自检 → 提交并推送。
 *       全程不产生第二个长期目录。
 *
 * 用法：
 *   node scripts/publish-public.cjs --dry-run          # 只构建+审计+展示差异
 *   node scripts/publish-public.cjs                    # 提交并推送
 *   node scripts/publish-public.cjs --message="feat: …"
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REMOTE = 'https://github.com/forgotfish/dsh-cx-learn.git';
const BRANCH = 'main';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const msgArg = args.find((a) => a.startsWith('--message='));
const MESSAGE = msgArg ? msgArg.slice('--message='.length) : 'chore: sync public release';

/* 直接覆盖到公开仓的文件 */
/* 直接覆盖到公开仓的文件
   ★ 2026-11-18：README.md / CHANGELOG.md 也纳入白名单。
   以前它们不在名单里，公开仓的 README 长期没跟着代码走，甚至出现了「章节测验绝不触碰」
   这种与代码相反的**错误安全声明**（D-020 已放开为「可作答、默认只存草稿」）。
   注意：assets/ 下的截图仍在公开仓维护，这里不动。 */
const COPY_FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md'];
/* 整目录覆盖（公开仓里这些目录会被清空后重建） */
const COPY_DIRS = ['engine', 'scripts'];
/* 不进入公开仓的路径 */
const SKIP = [
  /[\\/]\.state[\\/]/, /[\\/]\.login[\\/]/, /[\\/]_archive[\\/]/, /[\\/]\.migration[\\/]/,
  /[\\/]watch-fnos\.cjs$/, /[\\/]node_modules[\\/]/, /\.(log|png|jpg|jpeg|webp|zip)$/i,
];
/* 公开仓里必须去掉的内部路径（写成占位符或直接删除） */
const SANITIZE = [
  [/^[ \t]*'\/vol1\/@apphome\/dsh-shared\/browsers',\r?\n/gm, ''],
  [/'\/vol1\/@apphome\/dsh-shared\/browsers'/g, "'/opt/dsh-shared/browsers'"],
];

function die(msg, code = 1) {
  console.error('\n✗ ' + msg);
  process.exit(code);
}

function run(cmd, cmdArgs, cwd, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd, stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8', shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return r;
}

function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const rel = path.relative(ROOT, s).split(path.sep).join('/');
      if (SKIP.some((re) => re.test('/' + rel))) continue;
      copyTree(s, path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function sanitize(file) {
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [re, rep] of SANITIZE) {
    const before = s;
    s = s.replace(re, rep);
    if (s !== before) changed = true;
  }
  if (changed) fs.writeFileSync(file, s);
}

/* 同步公开仓 package.json 的 version 与 description（★ 2026-11-21）。
 * 为什么不直接 copy 本地 package.json：本地 homepage/repository 指向 forgotfish/cx-learn，
 * 公开仓指向 forgotfish/dsh-cx-learn，URL 不同。所以只补两个字段，其余（含 URL）保留公开仓原值。
 * 以前公开仓 description 停在「章节测验只识别不触碰」，与 D-020（可作答、默认只存草稿）
 * 及后续能力相反，属于**错误的安全声明**，必须随发版纠正。 */
function syncPackageMeta(tmp) {
  const localPath = path.join(ROOT, 'package.json');
  const pubPath = path.join(tmp, 'package.json');
  if (!fs.existsSync(pubPath)) return;
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const pub = JSON.parse(fs.readFileSync(pubPath, 'utf8'));
  let changed = false;
  if (local.version && pub.version !== local.version) { pub.version = local.version; changed = true; }
  if (local.description && pub.description !== local.description) { pub.description = local.description; changed = true; }
  if (changed) fs.writeFileSync(pubPath, JSON.stringify(pub, null, 2) + '\n');
}

/* ---------------------------------------------------------------- main */
/* ★ 2026-11-21：发布前先做版本一致性守卫（package.json vs CHANGELOG 顶部）。
   防止「代码已发、元数据停在旧版本」的静默漂移（真实发生过 0.2.0/0.2.3/0.2.4 三处不一致）。 */
{
  let guard = null;
  try { guard = require('./release-guard.cjs'); } catch (_) { guard = null; }
  if (guard && typeof guard.checkRelease === 'function') {
    const chk = guard.checkRelease(ROOT);
    if (!chk.ok) die('发布前版本一致性校验失败：\n  - ' + chk.problems.join('\n  - '));
    console.log('== 0. 版本一致性 OK v' + chk.version);
  }
}
console.log('== 1. 准备临时目录');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-learn-pub-'));
console.log('  ' + tmp);

console.log('== 2. 克隆公开仓');
const clone = run('git', ['clone', '--depth', '1', '--branch', BRANCH, REMOTE, tmp], ROOT, { quiet: true });
if (clone.status !== 0) {
  console.error(clone.stderr || '');
  die('克隆失败：检查网络/代理（git 需要能访问 github.com）');
}

console.log('== 3. 覆盖代码目录');
for (const f of COPY_FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) die('缺少文件：' + f);
  fs.copyFileSync(src, path.join(tmp, f));
  sanitize(path.join(tmp, f));
}
for (const d of COPY_DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) die('缺少目录：' + d);
  fs.rmSync(path.join(tmp, d), { recursive: true, force: true });
  copyTree(src, path.join(tmp, d));
}
syncPackageMeta(tmp);

console.log('== 4. 严格审计（在临时目录内，按公开仓 tracked 文件扫）');
run('git', ['add', '-A'], tmp, { quiet: true });
const audit = run(process.execPath, ['scripts/audit-publish.cjs', '--strict'], tmp);
if (audit.status !== 0) die('审计未通过，已中止；临时目录保留：' + tmp, 2);

console.log('== 5. 语法与自检');
for (const f of ['index.js', 'client.js', 'engine/chaoxing-autolearn.js']) {
  const r = run(process.execPath, ['--check', f], tmp, { quiet: true });
  if (r.status !== 0) { console.error(r.stderr || ''); die('语法检查失败：' + f, 3); }
}
const self = run(process.execPath, ['engine/chaoxing-autolearn.js', '--self-test'], tmp, { quiet: true });
if (self.status !== 0) { console.error(self.stdout || ''); die('引擎自检失败', 3); }

console.log('== 6. 差异');
run('git', ['status', '--short'], tmp);
const stat = run('git', ['diff', '--cached', '--stat'], tmp, { quiet: true });
process.stdout.write(stat.stdout || '');

if (DRY) {
  console.log('\n[dry-run] 未提交。临时目录：' + tmp);
  process.exit(0);
}

const dirty = run('git', ['status', '--porcelain'], tmp, { quiet: true }).stdout.trim();
if (!dirty) {
  console.log('\n没有差异，公开仓已是最新。');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

console.log('== 7. 提交并推送');
const commit = run('git', [
  '-c', 'core.autocrlf=true',
  '-c', 'user.name=forgotfish',
  '-c', 'user.email=forgotfish@users.noreply.github.com',
  'commit', '-m', MESSAGE,
], tmp, { quiet: true });
if (commit.status !== 0) { console.error(commit.stdout, commit.stderr); die('提交失败', 4); }
const push = run('git', ['push', 'origin', BRANCH], tmp);
if (push.status !== 0) die('推送失败（提交已在临时目录，可手动补推）', 5);

console.log('\n✓ 已推送到 ' + REMOTE);
fs.rmSync(tmp, { recursive: true, force: true });
