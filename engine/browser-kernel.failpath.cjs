#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.failpath.cjs — 启动失败路径的端到端验证
 * ----------------------------------------------------------------------------
 * 前一个测试直接调 describeLaunchExit。这里验证**引擎真实路径**：
 * createCdpAdapter().ensureBrowser() 在三种故障下的表现。
 *
 * 三种场景（都不联网、不碰课程）：
 *   A. profile 被另一个实例占用  → 应快速失败（不干等 20 秒）+ 归因到占用
 *   B. profile 目录不可写        → 应在启动前就被拦下（PROFILE_NOT_WRITABLE）
 *   C. 内核路径不存在            → 应给出路径问题而不是超时
 *
 * 判据重点是**耗时**：旧实现一律等满 attachTimeoutMs(20s) 才报错。
 *
 * 用法：node browser-kernel.failpath.cjs <浏览器可执行文件路径>
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const {
  createCdpAdapter, mergeConfig, CONFIG, buildChromiumArgs, readDevToolsActivePort,
} = require('./chaoxing-autolearn.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('用法: node browser-kernel.failpath.cjs <浏览器可执行文件路径>');
  process.exit(2);
}

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const base = path.join(os.tmpdir(), 'cx-failpath-' + process.pid);
fs.mkdirSync(base, { recursive: true });

/* 静音日志，只看结论 */
const { logger } = require('./chaoxing-autolearn.js');
const collected = [];
logger.setConsole((line) => { collected.push(line); });

function cfgFor(prof, extra) {
  return mergeConfig(CONFIG, {
    chromium: { executablePath: extra && extra.exe ? extra.exe : exe, headless: true, profileDir: prof, extraArgs: ['--no-sandbox'] },
    cdp: { port: 0, attachTimeoutMs: extra && extra.attachTimeoutMs ? extra.attachTimeoutMs : 20000 },
  });
}

async function attempt(label, cfg) {
  const t0 = Date.now();
  const adapter = createCdpAdapter(cfg);
  let err = null;
  try { await adapter.ensureBrowser(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  return { label, err, ms, msg: err ? String(err.message || err) : '' };
}

(async () => {
  console.log('内核：' + exe);
  console.log('== 启动失败路径（关注耗时与错误文案）==\n');

  /* ---------- A. profile 被占用 ---------- */
  console.log('A. profile 已被另一个实例占用');
  const profA = path.join(base, 'profA');
  fs.mkdirSync(profA, { recursive: true });
  const argsA = buildChromiumArgs({ headless: true, port: 0, profileDir: profA, shellKernel: /headless[-_]shell/.test(exe), userArgs: ['--no-sandbox'] });
  argsA.push('about:blank');
  const holder = spawn(exe, argsA, { stdio: 'ignore' });
  let holderPort = 0;
  for (let i = 0; i < 60; i++) {
    const r = readDevToolsActivePort(profA);
    if (r) { holderPort = r.port; break; }
    await new Promise((res) => setTimeout(res, 200));
  }
  ok(holderPort > 0, '占位实例已起来', holderPort);

  /* 删掉 DevToolsActivePort，让引擎以为是新启动而不是附着到占位实例 */
  const rA = await attempt('A', cfgFor(profA));
  try { fs.unlinkSync(path.join(profA, 'DevToolsActivePort')); } catch (_) { /* ignore */ }
  const rA2 = await attempt('A2', cfgFor(profA));
  ok(!!rA2.err, '占用场景下确实失败（没有静默连上别人的浏览器）');
  ok(rA2.ms < 12000, '失败在 12 秒内返回（不是干等 20 秒）', rA2.ms + 'ms');
  ok(/占用|不可用|profile/i.test(rA2.msg), '错误文案点明 profile 问题', rA2.msg.slice(0, 120));

  try { holder.kill(); } catch (_) { /* ignore */ }
  await new Promise((res) => setTimeout(res, 1500));
  try { holder.kill(); } catch (_) { /* ignore */ }

  /* ---------- B. profile 不可写 ---------- */
  console.log('\nB. profile 目录不可写');
  const profB = path.join(base, 'profB');
  fs.mkdirSync(profB, { recursive: true });
  const acl = fs.existsSync(profB) ? null : null;
  /* Windows 用 ACL 拒绝写入；非 Windows 用 chmod 只读 */
  let aclApplied = false;
  let rule = null;
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process');
      rule = 'DENY_WRITE';
      execFileSync('icacls', [profB, '/deny', (process.env.USERNAME || 'Everyone') + ':(W)'], { stdio: 'ignore' });
      aclApplied = true;
    } catch (_) { aclApplied = false; }
  } else {
    try { fs.chmodSync(profB, 0o500); aclApplied = true; } catch (_) { aclApplied = false; }
  }

  if (aclApplied) {
    const rB = await attempt('B', cfgFor(profB));
    ok(!!rB.err, '不可写 profile 下启动失败');
    ok(rB.ms < 5000, '在启动前就被拦下（<5 秒）', rB.ms + 'ms');
    ok(/不可写|PROFILE_NOT_WRITABLE/i.test(rB.msg), '错误文案明确说「不可写」', rB.msg.slice(0, 120));
    /* 还原权限 */
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('node:child_process');
        execFileSync('icacls', [profB, '/remove:d', (process.env.USERNAME || 'Everyone')], { stdio: 'ignore' });
      } catch (_) { /* ignore */ }
    } else {
      try { fs.chmodSync(profB, 0o700); } catch (_) { /* ignore */ }
    }
  } else {
    console.log('  （跳过：本机无法设置目录权限）');
  }

  /* ---------- C. 内核路径不存在 ---------- */
  console.log('\nC. 内核可执行文件不存在');
  const profC = path.join(base, 'profC');
  fs.mkdirSync(profC, { recursive: true });
  const cfgC = cfgFor(profC, { exe: path.join(base, 'no-such-browser.exe'), attachTimeoutMs: 20000 });
  const rC = await attempt('C', cfgC);
  ok(!!rC.err, '内核缺失时启动失败');
  ok(rC.ms < 8000, '快速失败（<8 秒）', rC.ms + 'ms');
  ok(rC.msg.length > 20, '错误文案非空且有内容', rC.msg.slice(0, 100));

  /* ---------- 汇总 ---------- */
  console.log('\n== 错误文案抽样 ==');
  [rA2, rC].forEach((r) => {
    if (r.err) console.log('  [' + r.label + ' ' + r.ms + 'ms] ' + r.msg.slice(0, 200));
  });

  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log('\n' + (fails.length
    ? '== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==\n' + fails.map((f) => '  - ' + f).join('\n')
    : '== 全部通过（' + pass + ' 项）=='));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack || e));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
