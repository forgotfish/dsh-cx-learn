#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.multi.cjs — 多实例并发对照（端口写死 vs 自动选端口）
 * ----------------------------------------------------------------------------
 * 这是「端口不能写死」的实证：
 *   A 组：3 个实例都用 --remote-debugging-port=9223（旧行为）
 *   B 组：3 个实例都用 --remote-debugging-port=0（新行为）
 *
 * 旧行为在 FNOS 上的真实后果：admin + 5 个用户实例共用 9223，
 * 后启动的连不上，或者更糟 —— 连到了别人的浏览器，操作了别人的账号。
 *
 * 用法：node browser-kernel.multi.cjs <浏览器可执行文件路径>
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildChromiumArgs, readDevToolsActivePort, isHeadlessShellKernel } = require('./chaoxing-autolearn.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('用法: node browser-kernel.multi.cjs <浏览器可执行文件路径>');
  process.exit(2);
}

const N = 3;

async function startOne(i, fixedPort) {
  const dir = path.join(os.tmpdir(), 'cx-multi-' + i + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const prof = path.join(dir, 'profile');
  const args = buildChromiumArgs({
    headless: true,
    port: fixedPort ? 9223 : 0,
    profileDir: prof,
    shellKernel: isHeadlessShellKernel(exe),
    userArgs: ['--no-sandbox'],
  });
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore' });

  let port = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fixedPort) {
      /* 写死端口时无从「发现」，只能假定 9223 就是自己的 */
      try {
        const r = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(800) });
        if (r.ok) { port = 9223; break; }
      } catch (_) { /* 还没起来 */ }
    } else {
      const r = readDevToolsActivePort(prof);
      if (r) { port = r.port; break; }
    }
    await new Promise((res) => setTimeout(res, 200));
  }

  /* 关键判据：这个实例自己的 profile 里记录的端口，和它实际连上的端口是否一致。
     写死端口时，所有实例都会「连上 9223」，但只有第一个真正拥有它。 */
  const own = readDevToolsActivePort(prof);
  return { i, child, dir, prof, port, ownPort: own ? own.port : 0 };
}

async function scenario(label, fixedPort) {
  console.log('\n== ' + label + ' ==');
  const procs = [];
  for (let i = 1; i <= N; i++) procs.push(await startOne(i, fixedPort));

  const ports = procs.map((p) => p.port);
  const ownPorts = procs.map((p) => p.ownPort);
  procs.forEach((p) => {
    console.log('  实例' + p.i + ': 连上的端口=' + (p.port || '无') + '  profile 自报端口=' + (p.ownPort || '无'));
  });

  const alive = procs.filter((p) => p.port > 0).length;
  const distinct = new Set(ports.filter((x) => x > 0)).size;
  const owned = procs.filter((p) => p.port > 0 && p.port === p.ownPort).length;

  /* 清理 */
  for (const p of procs) {
    try { p.child.kill(); } catch (_) { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 1200));
  for (const p of procs) {
    try { p.child.kill(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  return { alive, distinct, owned, ports, ownPorts };
}

(async () => {
  console.log('内核：' + exe);

  const fixed = await scenario('A 组：端口写死 9223（旧行为）', true);
  console.log('  → 起来 ' + fixed.alive + '/' + N + ' 个，不同端口数 ' + fixed.distinct
    + '，连到自己实例的 ' + fixed.owned + '/' + N);

  const auto = await scenario('B 组：端口 0 自动选（新行为）', false);
  console.log('  → 起来 ' + auto.alive + '/' + N + ' 个，不同端口数 ' + auto.distinct
    + '，连到自己实例的 ' + auto.owned + '/' + N);

  console.log('\n== 结论 ==');
  console.log('  自动选端口：' + auto.distinct + ' 个互不相同的端口，'
    + auto.owned + '/' + N + ' 个实例连的是自己的浏览器。');
  if (fixed.distinct < N || fixed.owned < N) {
    console.log('  写死 9223：' + fixed.distinct + ' 个端口、' + fixed.owned + '/' + N + ' 个对得上 —— '
      + '多个实例挤同一个端口，后启动的会连到别人的浏览器（跨账号操作风险）。');
  } else {
    console.log('  写死 9223：本次测试中恰好没有冲突（多个实例同时启动时才会暴露）。');
  }
  console.log(auto.owned === N && auto.distinct === N
    ? '  ✓ 新行为通过：多实例互不干扰。'
    : '  ✗ 新行为未达预期。');
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });
