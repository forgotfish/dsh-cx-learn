#!/usr/bin/env node
/* ============================================================================
 * session-reuse.test.cjs — 跨任务复用同一个内核（B-精简的核心承诺）
 * ============================================================================
 *
 * 【用户诉求（2026-10-31 原话）】
 *   「整个刷课过程里不死，刷完再死」
 *   也就是：刷完第一门课，接着刷第二门，**不该重新扫码**。
 *
 * 【这个测试证明什么】
 *   用 detach（而不是 shutdown）结束一次任务后：
 *     1. 内核还活着
 *     2. 下一次任务能连上**同一个内核**（pid / port 完全一致）
 *     3. 再下一次也一样
 *     4. 只有会话真正结束（owner shutdown）才关
 *
 * 【为什么必须真机跑】
 *   detach 的价值就在于「进程退出后内核还在」，这件事单测（Mock）证明不了 ——
 *   Mock 里根本没有独立的内核进程。
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 run.js 的 CX_KEEP_BROWSER 分支改成仍然 shutdown
 *   → 或者把 detach 改成调用 shutdown → 第 2 段「第二个任务连上同一个内核」变红。
 *
 * 不登录、不访问学习通，只开 about:blank。
 * 用法：node scripts/session-reuse.test.cjs
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
    console.log('  （本机没有 Chromium 系内核，跳过）');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-reuse-'));
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

  /* A 扮演「登录进程」：起内核后 detach（模拟会话开始） */
  const A = createCdpAdapter(cfgOf());
  let port = null;
  let kernelPid = null;
  const alive = [];

  try {
    console.log('== 1. 登录进程起内核（会话开始）==');
    await A.ensureBrowser();
    const s0 = readState();
    port = s0 && s0.port;
    kernelPid = s0 && s0.pid;
    ok(Number.isInteger(port) && port > 0, '内核端口 ' + port);
    ok(Number.isInteger(kernelPid) && kernelPid > 0, '内核 pid ' + kernelPid);
    await A.detach();
    ok(await portAlive(port), '★ detach 之后内核仍然活着（这正是「会话期间不死」）');

    console.log('== 2. 第一门课：另一个任务连上同一个内核 ==');
    const B = createCdpAdapter(cfgOf());
    await B.ensureBrowser();
    const s1 = readState();
    ok(s1 && s1.port === port, '★ 连上的是同一个内核（port 期望 ' + port + '，实际 ' + (s1 && s1.port) + '）');
    ok(s1 && s1.pid === kernelPid, '★ 内核 pid 未变（期望 ' + kernelPid + '，实际 ' + (s1 && s1.pid) + '）');
    await B.detach();
    alive.push(await portAlive(port));
    ok(alive[alive.length - 1], '第一门课结束后内核仍在');

    console.log('== 3. 第二门课：仍然复用同一个内核，没有重起 ==');
    const C = createCdpAdapter(cfgOf());
    await C.ensureBrowser();
    const s2 = readState();
    ok(s2 && s2.port === port, '★ 第二门课还是同一个内核（port ' + (s2 && s2.port) + '）');
    ok(s2 && s2.pid === kernelPid, '★ 内核 pid 仍未变（' + (s2 && s2.pid) + '）');
    await C.detach();
    alive.push(await portAlive(port));
    ok(alive[alive.length - 1], '第二门课结束后内核仍在');

    console.log('== 4. 读课程（第三个任务）也不重启内核 ==');
    const D = createCdpAdapter(cfgOf());
    await D.ensureBrowser();
    const s3 = readState();
    ok(s3 && s3.pid === kernelPid, '★ 读课程用的还是同一个内核（pid ' + (s3 && s3.pid) + '）');
    await D.detach();

    console.log('== 5. 会话结束：这次才真正关掉 ==');
    /* 用一个 fresh adapter 连上去，然后 shutdown（owner 语义）——
       但 D 是附着方，shutdown 不会关。所以这里直接用 A 的 shutdown：
       A 是真正 spawn 内核的 owner。 */
    await A.shutdown();
    await new Promise((r) => setTimeout(r, 2500));
    const afterAlive = await portAlive(port);
    ok(afterAlive === false, 'owner shutdown 之后内核才关掉');
    const s4 = readState();
    ok(s4 && s4.alive === false, 'browser.json 如实标记 alive:false');
  } finally {
    try { await A.shutdown() } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  }

  console.log('\n  内核生命周期：起 1 次 → ' + alive.length + ' 次任务复用 → 结束 1 次');
  console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
  if (fails.length) { for (const f of fails) console.log('  - ' + f); return 1 }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('测试自身出错：' + ((e && e.stack) || e));
  process.exit(2);
});
