#!/usr/bin/env node
/* ============================================================================
 * browser-ownership.test.cjs — 附着方不许篡改 owner 的内核状态
 * ============================================================================
 *
 * 【测什么】（L2 契约 §3.1）
 *   1. owner 起内核 → browser.json 有 pid / ownerPid / alive:true
 *   2. 附着方连上 → **不改** pid / ownerPid
 *   3. 附着方 shutdown → 内核还活着，alive 仍为 true，pid 仍在
 *   4. owner shutdown → 内核真的关掉，alive 变 false，pid 清空
 *
 * 【为什么必须测】
 *   2026-10-31 实测过原实现的缺陷：
 *     B 附着后 pid → null；B 结束后 alive=false 但端口仍在响应。
 *   也就是说 UI 显示「内核已停止」，实际内核还在跑、还占内存。
 *   这个测试把那三个数字钉死，任何人改回去都会红。
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 cdp.js 的 shutdown 改回「先写 alive:false 再判断 _spawnedByUs」
 *   → 第 3 组断言变红（alive 变 false）。已实测：改坏退出 1，恢复退出 0。
 *
 * 需要真实内核（会起一个 headless 实例），但**不登录、不访问学习通**。
 * 用法：node scripts/browser-ownership.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'engine');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

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
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
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
  if (!chromium) {
    console.log('  （本机没有 Chromium 系内核，跳过真机用例）');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-own-'));
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  process.env.CX_STATE_DIR = tmp;
  process.env.CX_CHROMIUM = chromium;
  process.env.CX_PROFILE_DIR = profile;
  process.env.CX_CDP_PORT = '0';

  const { createCdpAdapter } = require(path.join(ENGINE_DIR, 'src', 'browser', 'cdp.js'));
  const { CONFIG, mergeConfig } = require(path.join(ENGINE_DIR, 'src', 'core', 'config.js'));
  const cfgOf = () => mergeConfig(CONFIG, {
    chromium: { executablePath: chromium, headless: true, profileDir: profile },
    cdp: { port: 0, attachTimeoutMs: 45000 },
  });

  const stateFile = path.join(tmp, 'engine', '.state', 'browser.json');
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null } };

  const A = createCdpAdapter(cfgOf());
  let B = null;
  let ownerPid = null;
  let kernelPid = null;
  let port = null;

  try {
    console.log('== 1. owner 起内核 ==');
    await A.ensureBrowser();
    const s1 = readState();
    port = s1 && s1.port;
    kernelPid = s1 && s1.pid;
    ownerPid = s1 && s1.ownerPid;
    ok(Number.isInteger(kernelPid) && kernelPid > 0, 'owner 写入内核 pid（' + kernelPid + '）');
    ok(Number.isInteger(ownerPid) && ownerPid > 0, 'owner 写入 ownerPid（' + ownerPid + '）');
    ok(s1 && s1.alive !== false, 'alive 不为 false');
    ok(await portAlive(port), '端口响应');

    console.log('== 2. 附着方连上，不许改 pid / ownerPid ==');
    B = createCdpAdapter(cfgOf());
    await B.ensureBrowser();
    const s2 = readState();
    ok(s2 && s2.pid === kernelPid, '★ 附着后内核 pid 未被覆盖（期望 ' + kernelPid + '，实际 ' + (s2 && s2.pid) + '）');
    ok(s2 && s2.ownerPid === ownerPid, '★ 附着后 ownerPid 未被覆盖（期望 ' + ownerPid + '，实际 ' + (s2 && s2.ownerPid) + '）');

    console.log('== 3. 附着方 shutdown：内核必须还活着，状态必须如实 ==');
    await B.shutdown();
    B = null;
    const s3 = readState();
    const alive3 = await portAlive(port);
    ok(alive3 === true, '★ 附着方结束后内核仍然活着（端口响应 ' + alive3 + '）');
    ok(s3 && s3.alive !== false,
      '★ alive 不得被附着方写成 false（实际 ' + (s3 && s3.alive) + '）—— 这是 UI 谎报「已停止」的根因');
    ok(s3 && s3.pid === kernelPid, '★ pid 不得被附着方清空（实际 ' + (s3 && s3.pid) + '）');

    console.log('== 4. owner shutdown：内核真的关掉，状态跟着变 ==');
    await A.shutdown();
    await new Promise((r) => setTimeout(r, 2000));
    const s4 = readState();
    const alive4 = await portAlive(port);
    ok(alive4 === false, 'owner 关闭后端口不再响应');
    ok(s4 && s4.alive === false, 'owner 关闭后 alive === false');
    ok(s4 && s4.pid === null, 'owner 关闭后 pid 清空（不再指向已死进程）');
  } finally {
    if (B) { try { await B.shutdown() } catch (_) {} }
    try { await A.shutdown() } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  }

  console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
  if (fails.length) { for (const f of fails) console.log('  - ' + f); return 1 }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('测试自身出错：' + ((e && e.stack) || e));
  process.exit(2);
});
