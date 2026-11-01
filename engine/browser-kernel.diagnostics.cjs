#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.diagnostics.cjs — 启动失败归因的测试
 * ----------------------------------------------------------------------------
 * 覆盖 2026-10-29 新增的诊断层：
 *   · describeLaunchExit   退出码 + stderr + profile 现场 → 人能照着做的建议
 *   · inspectProfileLock   识别 profile 锁文件
 *   · isProfileWritable    真实写入探测（不是查 ACL）
 *
 * 关键实测背景（本机复现）：
 *   共用同一 --user-data-dir 的第二个实例 → 4 秒内静默退出，exit=21，stderr 空
 *   profile 目录不可写               → exit=21，stderr 有 "Lock file can not be created"
 * 两种故障同一个退出码，所以只看退出码必然误判。
 *
 * 用法：node browser-kernel.diagnostics.cjs [--live <浏览器可执行文件路径>]
 *   不带 --live → 只测纯函数
 *   带  --live → 额外真起内核复现 exit=21 两种成因
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const {
  describeLaunchExit, inspectProfileLock, isProfileWritable, CHROMIUM_EXIT_CODES,
  buildChromiumArgs, readDevToolsActivePort,
} = require('./chaoxing-autolearn.js');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}
function eq(a, b, name) { ok(a === b, name, '实际 ' + JSON.stringify(a)); }

const base = path.join(os.tmpdir(), 'cx-diag-' + process.pid);
fs.mkdirSync(base, { recursive: true });
const cfgFor = (prof) => ({ chromium: { profileDir: prof } });

/* ------------------------------------------------------- 1. stderr 优先归因 */
console.log('== 1/4 stderr 原文优先（最具体，应压过退出码推断）==');
const c1 = describeLaunchExit(21, 'Lock file can not be created! Error code: 5', cfgFor(base));
ok(/不可写/.test(c1.reason), 'Lock file 报错 → 判为目录不可写', c1.reason);
ok(c1.hint.indexOf(base) >= 0, '建议里带上了具体目录');

const c2 = describeLaunchExit(21, 'Failed to create a ProcessSingleton for your profile directory.', cfgFor(base));
ok(/占用/.test(c2.reason), 'ProcessSingleton 报错 → 判为被占用', c2.reason);

const c3 = describeLaunchExit(null, 'No usable sandbox! Update your kernel or see ...', cfgFor(base));
ok(/沙箱/.test(c3.reason), 'sandbox 报错 → 判为缺沙箱', c3.reason);
ok(/--no-sandbox/.test(c3.hint), '建议里指明 --no-sandbox');

const c4 = describeLaunchExit(127, 'error while loading shared libraries: libnss3.so', cfgFor(base));
ok(/动态库/.test(c4.reason), '缺库报错 → 判为缺动态库', c4.reason);

console.log('  -- spawn 错误优先于退出码（回归：内核路径不存在曾干等 20 秒）--');
const exeCfg = (p) => ({ chromium: { profileDir: base, executablePath: p } });
const s1 = describeLaunchExit(null, '', exeCfg('C:\\nope\\chrome.exe'), 'ENOENT spawn C:\\nope\\chrome.exe ENOENT');
ok(/不存在/.test(s1.reason), 'ENOENT → 判为文件不存在', s1.reason);
ok(s1.reason.indexOf('chrome.exe') >= 0, '文案里带上具体路径');
const s2 = describeLaunchExit(null, '', exeCfg('/opt/chrome'), 'EACCES spawn /opt/chrome EACCES');
ok(/权限/.test(s2.reason), 'EACCES → 判为权限不足', s2.reason);
const s3 = describeLaunchExit(null, '', exeCfg('/opt/chrome'), 'ENOEXEC spawn /opt/chrome ENOEXEC');
ok(/架构|不是可执行/.test(s3.reason), 'ENOEXEC → 判为架构不匹配', s3.reason);
/* spawn 错误比 stderr 更确定：即便 stderr 里有别的噪音，也应以 spawn 为准 */
const s4 = describeLaunchExit(21, 'Failed to create a ProcessSingleton', exeCfg('/x/chrome'), 'ENOENT spawn /x/chrome ENOENT');
ok(/不存在/.test(s4.reason), 'spawn 错误压过 stderr 与退出码', s4.reason);

console.log('  -- 裸命令名不能被当「文件不存在」（回归）--');
/* config 默认值就是裸名 'chromium'（靠 PATH 查找）。实测 Windows：
   PATH 里的命令 existsSync(裸名) 恒为 false。若用 existsSync 判定存在性，
   合法配置会被误杀成「内核不存在」。这里锁住「裸名不判 ENOENT」这条语义。 */
const { isBareCommandName } = require('./chaoxing-autolearn.js');
ok(isBareCommandName('chromium') === true, 'chromium 识别为裸命令名');
ok(isBareCommandName('chrome-headless-shell') === true, 'chrome-headless-shell 识别为裸命令名');
ok(isBareCommandName('/usr/bin/chromium') === false, '绝对路径不是裸命令名');
ok(isBareCommandName('C:\\browsers\\chrome.exe') === false, 'Windows 绝对路径不是裸命令名');
ok(isBareCommandName('./chrome') === false, '显式相对路径不是裸命令名');
ok(isBareCommandName('') === false, '空串不算裸命令名');

console.log('== 2/4 退出码兜底（stderr 为空时）==');
/* 干净的可写目录 + 无锁文件 → 只能说「不可用」，不应误判成权限问题 */
const clean = path.join(base, 'clean'); fs.mkdirSync(clean, { recursive: true });
const d1 = describeLaunchExit(21, '', cfgFor(clean));
ok(/不可用/.test(d1.reason), '无 stderr、无锁、可写 → 判为 profile 不可用（不甩锅权限）', d1.reason);
ok(/竞态|独立/.test(d1.hint), '建议提到并发竞态或独立 profile');

/* 有锁文件 → 提示疑似占用，并列出证据 */
const locked = path.join(base, 'locked'); fs.mkdirSync(path.join(locked, 'Default'), { recursive: true });
fs.writeFileSync(path.join(locked, 'Default', 'LOCK'), '');
const d2 = describeLaunchExit(21, '', cfgFor(locked));
ok(/占用/.test(d2.reason), '有 LOCK 文件 → 判为疑似占用', d2.reason);
ok(d2.hint.indexOf('LOCK') >= 0, '建议里点名了要删的锁文件');

const d3 = describeLaunchExit(22, '', cfgFor(clean));
ok(/命令行走参数/.test(d3.reason), '退出码 22 → 参数有误', d3.reason);

const d4 = describeLaunchExit(null, '', cfgFor(clean));
ok(/启动失败/.test(d4.reason), '未知退出码 → 通用兜底', d4.reason);
ok(/headless=new/.test(d4.hint), '兜底建议里给了手动复现方式');

console.log('  -- 退出码表 --');
ok(CHROMIUM_EXIT_CODES[21] && /profile/.test(CHROMIUM_EXIT_CODES[21]), '退出码 21 标注为 profile 问题');
eq(describeLaunchExit(21, '', cfgFor(clean)).code, 21, '返回结构里带上原始退出码');

/* --------------------------------------------------------- 3. 现场探测原语 */
console.log('== 3/4 profile 锁探测与可写性探测 ==');
eq(inspectProfileLock('').locked, false, '空 profile 目录 → 未上锁');
eq(inspectProfileLock(clean).locked, false, '干净目录 → 未上锁');
const lk = inspectProfileLock(locked);
ok(lk.locked === true, '有 Default/LOCK → 判定上锁');
ok(lk.evidence.some((p) => /LOCK$/.test(p)), 'evidence 里给出具体文件路径');

/* SingletonLock（Linux 形态）也要认 */
const sl = path.join(base, 'sl'); fs.mkdirSync(sl, { recursive: true });
fs.writeFileSync(path.join(sl, 'SingletonLock'), 'host-1234');
ok(inspectProfileLock(sl).locked === true, 'SingletonLock 也识别（Linux 形态）');

eq(isProfileWritable(clean), true, '可写目录 → true');
eq(isProfileWritable(path.join(base, 'deep', 'new', 'dir')), true, '目录不存在时能建出来 → true');
eq(isProfileWritable(''), true, '空路径视为不检查 → true');
/* 残留探测文件不能留下 */
const leftovers = fs.readdirSync(clean).filter((n) => n.indexOf('.cx-write-probe') >= 0);
eq(leftovers.length, 0, '可写性探测不留下临时文件');

/* ------------------------------------------------------ 4. 真机复现 exit=21 */
const liveIdx = process.argv.indexOf('--live');
function finish() {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log('\n' + (fails.length
    ? '== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==\n' + fails.map((f) => '  - ' + f).join('\n')
    : '== 全部通过（' + pass + ' 项）=='));
  process.exit(fails.length ? 1 : 0);
}

if (liveIdx < 0 || !process.argv[liveIdx + 1] || !fs.existsSync(process.argv[liveIdx + 1])) {
  console.log('\n（未指定有效 --live，跳过真机复现）');
  finish();
} else {
  const exe = process.argv[liveIdx + 1];
  (async () => {
    console.log('\n== 4/4 真机复现：共用 profile 的第二个实例 ==');
    console.log('  内核：' + exe);
    const prof = path.join(base, 'live-prof');
    fs.mkdirSync(prof, { recursive: true });

    function launch() {
      const args = buildChromiumArgs({
        headless: true, port: 0, profileDir: prof,
        shellKernel: /headless[-_]shell/.test(exe), userArgs: ['--no-sandbox'],
      });
      args.push('about:blank');
      const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (b) => { err += b; });
      return { child, errText: () => err };
    }

    const one = launch();
    const deadline = Date.now() + 20000;
    let port = 0;
    while (Date.now() < deadline) {
      const r = readDevToolsActivePort(prof);
      if (r) { port = r.port; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    ok(port > 0, '第一个实例正常起来', '端口 ' + port);

    /* 第二个实例：同一 profile */
    const two = launch();
    let exited = false;
    for (let i = 0; i < 40; i++) {
      if (two.child.exitCode !== null || two.child.signalCode) { exited = true; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    ok(exited, '第二个实例在 8 秒内退出（不会去抢别人的 profile）');
    eq(two.child.exitCode, 21, '退出码为 21（RESULT_CODE_PROFILE_IN_USE）');

    /* 关键：把真实 stderr 喂给归因函数，看能否落到「占用」或「不可用」 */
    const diag = describeLaunchExit(two.child.exitCode, two.errText(), cfgFor(prof));
    console.log('    stderr 长度：' + two.errText().length + ' 字节');
    console.log('    归因：' + diag.reason);
    console.log('    建议：' + diag.hint);
    ok(/占用|不可用/.test(diag.reason), '真实故障能被归到「占用/不可用」而不是泛泛的「连不上」', diag.reason);

    try { one.child.kill(); } catch (_) { /* ignore */ }
    try { two.child.kill(); } catch (_) { /* ignore */ }
    await new Promise((res) => setTimeout(res, 1200));
    try { one.child.kill(); } catch (_) { /* ignore */ }
  })().then(finish).catch((e) => { ok(false, '真机复现异常', e.message); finish(); });
}
