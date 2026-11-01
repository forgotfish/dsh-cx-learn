#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.ab.cjs — 防节流开关的 A/B 对照
 * ----------------------------------------------------------------------------
 * 只做一件事：同一个内核，开/关 --disable-background-timer-throttling 等开关，
 * 各在**后台页面**里数 1 秒内定时器触发次数，用数据说明开关是否有效。
 *
 * 判定口径：50ms 一次、跑 1000ms ⇒ 理想 20 次。
 *   未被降频 ≈ 18~20 次；被降频到 1Hz ⇒ 1~2 次。
 *
 * 用法：node browser-kernel.ab.cjs <浏览器可执行文件路径>
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildChromiumArgs, readDevToolsActivePort, isHeadlessShellKernel } = require('./chaoxing-autolearn.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('用法: node browser-kernel.ab.cjs <浏览器可执行文件路径>');
  process.exit(2);
}

const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/** 起一个无头内核，返回 { child, port, dir } */
async function launch(tag, dropAntiThrottle) {
  const dir = path.join(os.tmpdir(), 'cx-ab-' + tag + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const prof = path.join(dir, 'profile');

  let userArgs = ['--no-sandbox'];
  if (dropAntiThrottle) {
    /* buildChromiumArgs 会把防节流开关强制加进去（引擎必需）。
       对照组的做法：构造后再把它们剔掉，模拟「没有这些开关」的旧行为。 */
  }
  const args = buildChromiumArgs({
    headless: true, port: 0, profileDir: prof,
    shellKernel: isHeadlessShellKernel(exe), userArgs,
  });
  const finalArgs = dropAntiThrottle
    ? args.filter((a) => ANTI_THROTTLE.indexOf(a) < 0
        && !(a.indexOf('--disable-features=') === 0 && a.indexOf('CalculateNativeWinOcclusion') >= 0))
    : args;
  finalArgs.push('about:blank');

  const child = spawn(exe, finalArgs, { stdio: 'ignore' });
  let port = 0;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const r = readDevToolsActivePort(prof);
    if (r) { port = r.port; break; }
    await new Promise((res) => setTimeout(res, 250));
  }
  return { child, port, dir, args: finalArgs };
}

/** 新建一个标签，把它放到后台（再开一个前台页），然后数定时器 */
async function measureTicks(port) {
  const created = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('求值超时')), 20000);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 失败')); });
    ws.addEventListener('open', () => {
      const send = (method, params) => new Promise((res2) => {
        const mid = ++id; pending.set(mid, res2);
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
      });
      (async () => {
        await send('Runtime.enable');
        /* 先把本页 visibilityState 打出来，确认「后台」这个前提成立 */
        const vis = await send('Runtime.evaluate', {
          expression: 'document.visibilityState + "/" + document.hidden', returnByValue: true,
        });
        const r = await send('Runtime.evaluate', {
          expression: `new Promise(function(done){
            var n = 0;
            var h = setInterval(function(){ n++; }, 50);
            setTimeout(function(){ clearInterval(h); done(n); }, 1000);
          })`,
          awaitPromise: true, returnByValue: true,
        });
        clearTimeout(timer);
        resolve({ ticks: r && r.result && r.result.value, visibility: vis && vis.result && vis.result.value });
      })().catch((e) => { clearTimeout(timer); reject(e); });
    });
  });
}

async function run(tag, dropAntiThrottle) {
  const { child, port, dir, args } = await launch(tag, dropAntiThrottle);
  try {
    if (!port) { console.log(tag + ': 内核未起来'); return null; }
    const m = await measureTicks(port);
    console.log('  ' + tag + '  visibility=' + m.visibility + '  定时器 1 秒内触发 ' + m.ticks + ' 次');
    console.log('    防节流开关数：' + args.filter((a) => ANTI_THROTTLE.indexOf(a) >= 0).length + '/3');
    return m.ticks;
  } finally {
    try { child.kill(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('内核：' + exe + '\n');
  console.log('== 对照组：去掉防节流开关 ==');
  const without = await run('without', true);
  console.log('\n== 实验组：保留防节流开关（现行代码）==');
  const withFlags = await run('with', false);

  console.log('\n== 结论 ==');
  console.log('  无开关 ' + without + ' 次 vs 有开关 ' + withFlags + ' 次（理想 20）');
  if (typeof without === 'number' && typeof withFlags === 'number') {
    if (withFlags >= 15 && withFlags > without) {
      console.log('  → 开关有效：无开关时后台定时器被降频，加上后恢复到接近理想值。');
    } else if (withFlags >= 15 && without >= 15) {
      console.log('  → 本机这个内核/版本在 --headless=new 下未启用后台降频，');
      console.log('     开关无害但此刻观察不到差异（仍建议保留：有头模式与旧内核会降频）。');
    } else {
      console.log('  → 未观察到改善，需要复查（可能是内核版本或页面处于前台）。');
    }
  }
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });
