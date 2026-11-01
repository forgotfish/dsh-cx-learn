#!/usr/bin/env node
/* ============================================================================
 * l2-probe-ownership.cjs — 取证：浏览器的「所有权」现在是什么语义
 * ============================================================================
 *
 * 【要验证的假设】
 *   现状是「谁 spawn 谁负责关」，附着方（_spawnedByUs=false）在 shutdown 时
 *   提前 return，不关浏览器 —— 但它**已经先把 browser.json 的 alive 写成 false**。
 *   如果真的如此，那就是：内核明明还活着，UI 却显示「已停止」。
 *
 * 【怎么验】
 *   同一个进程里造两个 adapter，指向同一个 profile：
 *     A = 先起内核（spawnedByUs = true）
 *     B = 再连上去（spawnedByUs = false，模拟 --list-courses / 看课进程）
 *   然后 B.shutdown()，检查：
 *     1. browser.json 的 alive 变成什么
 *     2. 内核端口还响不响应（真死了还是假死了）
 *
 * 【只读】
 *   不登录、不访问学习通，只开 about:blank。用独立临时目录，不碰生产状态。
 *
 * 用法：node scripts/l2-probe-ownership.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'engine');

function findKernel() {
  const explicit = (process.argv.slice(2).find((a) => a.startsWith('--chromium=')) || '').slice(11);
  if (explicit) return explicit;
  const cands = [];
  if (process.platform === 'win32') {
    for (const r of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!r) continue;
      cands.push(path.join(r, 'Microsoft\\Edge\\Application\\msedge.exe'));
      cands.push(path.join(r, 'Google\\Chrome\\Application\\chrome.exe'));
    }
  } else {
    cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c } catch (_) {} }
  return '';
}

async function portAlive(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false }
}

async function main() {
  const chromium = findKernel();
  if (!chromium) { console.log('找不到内核'); return 2 }

  const tmp = path.join(os.tmpdir(), 'cx-l2-probe-' + process.pid);
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  process.env.CX_STATE_DIR = tmp;
  process.env.CX_CHROMIUM = chromium;
  process.env.CX_PROFILE_DIR = profile;
  process.env.CX_CDP_PORT = '0';

  const { createCdpAdapter } = require(path.join(ENGINE_DIR, 'src', 'browser', 'cdp.js'));
  const { CONFIG, mergeConfig } = require(path.join(ENGINE_DIR, 'src', 'core', 'config.js'));
  const base = { chromium: { executablePath: chromium, headless: true, profileDir: profile }, cdp: { port: 0, attachTimeoutMs: 45000 } };

  const stateFile = path.join(tmp, 'engine', '.state', 'browser.json');
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null } };

  const A = createCdpAdapter(mergeConfig(CONFIG, base));
  let B = null;
  const out = [];
  const say = (s) => { console.log(s); out.push(s) };

  try {
    say('== 1. A 起内核（模拟 --login 进程）==');
    await A.ensureBrowser();
    const st1 = readState();
    const port = st1 && st1.port;
    say('  A 启动完成，port=' + port + ' pid=' + (st1 && st1.pid));
    say('  端口此刻响应：' + (await portAlive(port)));

    say('\n== 2. B 附着到同一个内核（模拟 --list-courses / 看课进程）==');
    B = createCdpAdapter(mergeConfig(CONFIG, base));
    await B.ensureBrowser();
    const st2 = readState();
    say('  B 附着完成，port=' + (st2 && st2.port) + '（应与 A 相同：' + port + '）');
    say('  端口此刻响应：' + (await portAlive(port)));

    say('\n== 3. B 结束（模拟读课程/看课任务收尾）==');
    await B.shutdown();
    B = null;

    const st3 = readState();
    const aliveNow = await portAlive(port);
    say('  B.shutdown() 之后：');
    say('    browser.json alive = ' + (st3 && st3.alive));
    say('    内核端口是否仍响应 = ' + aliveNow);
    say('    browser.json pid   = ' + (st3 && st3.pid));

    say('\n== 4. 判定 ==');
    const lying = (st3 && st3.alive === false) && aliveNow === true;
    if (lying) {
      say('  ✗ 确认缺陷：内核**仍然活着**（端口有响应），但 browser.json 写的是 alive:false');
      say('    → 设置页会显示「内核：已停止」，而实际上它还在跑、还占着内存');
    } else if (aliveNow === false) {
      say('  ✓ 内核确实被关掉了（B 关掉了不属于它的内核？那也是一种缺陷）');
    } else {
      say('  ✓ 状态与实际一致（alive=' + (st3 && st3.alive) + '，端口响应=' + aliveNow + '）');
    }
  } finally {
    if (B) { try { await B.shutdown() } catch (_) {} }
    try { await A.shutdown() } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  }

  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('探测出错：' + ((e && e.stack) || e));
  process.exit(2);
});
