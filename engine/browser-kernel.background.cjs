#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.background.cjs — 真正的「后台标签」降频对照
 * ----------------------------------------------------------------------------
 * 上一版 A/B 没测出差异，原因是单标签页在 --headless=new 里就是前台
 * （visibilityState=visible），Chromium 根本不会触发后台降频。
 *
 * 本脚本造出真正会降频的场景：
 *   1. 开两个标签 A、B，把 A 设为被测页
 *   2. 用 Target.activateTarget 把 B 切到前台 ⇒ A 变 hidden
 *   3. 在 A 里数 1 秒内定时器触发次数
 *   4. 分别在有/无防节流开关的情况下各做一次
 *
 * 判定：50ms×1000ms ⇒ 理想 20 次；被降频到 1Hz ⇒ 1~2 次。
 *
 * 用法：node browser-kernel.background.cjs <浏览器可执行文件路径>
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildChromiumArgs, readDevToolsActivePort, isHeadlessShellKernel } = require('./chaoxing-autolearn.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('用法: node browser-kernel.background.cjs <浏览器可执行文件路径>');
  process.exit(2);
}

const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

function stripAntiThrottle(args) {
  return args.filter((a) => ANTI_THROTTLE.indexOf(a) < 0
    && !(a.indexOf('--disable-features=') === 0 && a.indexOf('CalculateNativeWinOcclusion') >= 0));
}

/** 连一个 target 的 WebSocket，返回 { send, close } */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS 失败')); });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return {
    send: (method, params, sessionId) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      const p = { id: mid, method, params: params || {} };
      if (sessionId) p.sessionId = sessionId;
      ws.send(JSON.stringify(p));
    }),
    close: () => { try { ws.close(); } catch (_) { /* ignore */ } },
  };
}

async function scenario(tag, dropAntiThrottle) {
  const dir = path.join(os.tmpdir(), 'cx-bg-' + tag + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const prof = path.join(dir, 'profile');

  let args = buildChromiumArgs({
    headless: true, port: 0, profileDir: prof,
    shellKernel: isHeadlessShellKernel(exe), userArgs: ['--no-sandbox'],
  });
  if (dropAntiThrottle) args = stripAntiThrottle(args);
  args.push('about:blank');

  const child = spawn(exe, args, { stdio: 'ignore' });
  let port = 0;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const r = readDevToolsActivePort(prof);
    if (r) { port = r.port; break; }
    await new Promise((res) => setTimeout(res, 250));
  }
  if (!port) {
    try { child.kill(); } catch (_) { /* ignore */ }
    console.log('  ' + tag + ': 内核未起来');
    return null;
  }

  try {
    /* 浏览器级连接，用来 activateTarget 切前台 */
    const ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    const browser = await connect(ver.webSocketDebuggerUrl);

    /* 被测页 A */
    const a = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
    /* 抢焦点页 B */
    const b = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();

    const at = await connect(a.webSocketDebuggerUrl);
    await at.send('Runtime.enable');
    const bt = await connect(b.webSocketDebuggerUrl);
    await bt.send('Runtime.enable');

    /* 先把 B 切到前台，让 A 变 hidden */
    await browser.send('Target.activateTarget', { targetId: b.id });
    await new Promise((res) => setTimeout(res, 700));

    const visNow = await at.send('Runtime.evaluate', {
      expression: 'document.visibilityState + "/" + document.hidden', returnByValue: true,
    });
    const visibility = visNow && visNow.result && visNow.result.result && visNow.result.result.value;

    const measured = await at.send('Runtime.evaluate', {
      expression: `new Promise(function(done){
        var n = 0;
        var h = setInterval(function(){ n++; }, 50);
        setTimeout(function(){ clearInterval(h); done(n); }, 1000);
      })`,
      awaitPromise: true, returnByValue: true,
    });
    const ticks = measured && measured.result && measured.result.result && measured.result.result.value;

    const flags = ANTI_THROTTLE.filter((f) => args.indexOf(f) >= 0).length
      + (args.some((x) => x.indexOf('--disable-features=') === 0 && x.indexOf('CalculateNativeWinOcclusion') >= 0) ? 1 : 0);

    console.log('  ' + tag.padEnd(8) + ' visibility=' + visibility + '  定时器 ' + ticks + ' 次/秒（理想 20）  防节流开关 ' + flags + '/4');

    at.close(); bt.close(); browser.close();
    return { ticks, visibility };
  } finally {
    try { child.kill(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('内核：' + exe);
  console.log('场景：两个标签，被测标签被切到后台（hidden）后计时\n');

  console.log('== 对照组：去掉防节流开关 ==');
  const without = await scenario('without', true);
  console.log('\n== 实验组：保留防节流开关（现行代码）==');
  const withFlags = await scenario('with', false);

  console.log('\n== 结论 ==');
  if (!without || !withFlags) {
    console.log('  测试未完成（内核未起来）。');
    return;
  }
  const w = without.ticks, f = withFlags.ticks;
  console.log('  无开关 ' + w + ' 次  →  有开关 ' + f + ' 次（理想 20）');
  console.log('  被测页可见性：无开关时 ' + without.visibility + '，有开关时 ' + withFlags.visibility);
  if (f >= 15 && w < 10) {
    console.log('  → 开关确证有效：后台标签被降频到约 ' + w + ' 次/秒，加上开关后恢复 ' + f + ' 次/秒。');
  } else if (f >= 15 && w >= 15) {
    console.log('  → 该内核版本在无头下即使 hidden 也不降频，开关无害但此处观察不到差异。');
  } else {
    console.log('  → 结果不符合预期，需复查测试构造。');
  }
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });
