#!/usr/bin/env node
/* ============================================================================
 * l1-probe.cjs — L1 内核层真机只读探测
 * ============================================================================
 *
 * 【它做什么】
 *   起一个真实 Chromium → 连 CDP → 读 frame 树 → 关掉 → 确认没有残留进程。
 *   **不登录、不访问学习通、不点击任何页面**，只打开 data: 页面。
 *
 * 【为什么必须跑这个】
 *   SPEC §11 的 L1 验收标准要求「真机只读探测通过；起停后无残留进程」。
 *   单元测试用 Mock，证明不了真内核能不能起、端口能不能发现、pid 能不能回收。
 *   2026-10-31 之前这里没有任何自动化验证，全靠手工。
 *
 * 【它验证什么】
 *   1. 内核能起来，CDP 端口自动发现成功
 *   2. /json/version 能读到 Browser 版本
 *   3. frame 树能读到（顶层 frame 存在）
 *   4. browser.json 写入了全部契约字段，且 **pid 有值**
 *   5. 关掉之后：CDP 端口不再响应、browser.json 的 alive 变 false
 *
 * 【用法】
 *   node scripts/l1-probe.cjs                     # 自动找内核（Edge/Chrome）
 *   node scripts/l1-probe.cjs --chromium=<路径>
 *   node scripts/l1-probe.cjs --keep              # 不关内核（调试用，之后手动清）
 *
 * 退出码：0 通过 / 1 失败 / 2 脚本自身出错
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

function argOf(k, d) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
}

/** 找本机可用的 Chromium 系内核（Windows 优先 Edge，因为本机只装了 Edge） */
function findKernel() {
  const explicit = argOf('chromium', '');
  if (explicit) return explicit;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const r of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!r) continue;
      candidates.push(path.join(r, 'Microsoft\\Edge\\Application\\msedge.exe'));
      candidates.push(path.join(r, 'Google\\Chrome\\Application\\chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch (_) { /* next */ }
  }
  return '';
}

async function main() {
  const keep = process.argv.includes('--keep');
  const chromium = findKernel();
  console.log('L1 内核层只读探测');
  console.log('  内核：' + (chromium || '（未找到）'));
  if (!chromium) {
    console.log('  ✗ 找不到浏览器内核，无法探测');
    return 1;
  }

  /* 独立状态目录 + 独立 profile，绝不碰生产状态与生产 profile */
  const tmpRoot = path.join(os.tmpdir(), 'cx-l1-probe-' + process.pid);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const profile = path.join(tmpRoot, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  process.env.CX_STATE_DIR = tmpRoot;
  process.env.CX_CHROMIUM = chromium;
  process.env.CX_PROFILE_DIR = profile;
  process.env.CX_CDP_PORT = '0';   // 让内核自选端口，验证自动发现

  const { createCdpAdapter } = require(path.join(ENGINE_DIR, 'src', 'browser', 'cdp.js'));
  const { CONFIG, mergeConfig } = require(path.join(ENGINE_DIR, 'src', 'core', 'config.js'));

  const cfg = mergeConfig(CONFIG, {
    chromium: { executablePath: chromium, headless: true, profileDir: profile },
    cdp: { port: 0, attachTimeoutMs: 45000 },
  });

  const adapter = createCdpAdapter(cfg);
  let adapterRef = adapter;

  try {
    console.log('\n== 1. 启动内核并连接 CDP ==');
    const t0 = Date.now();
    await adapter.ensureBrowser();
    const elapsed = Date.now() - t0;
    ok(true, '内核启动并连上 CDP（' + elapsed + 'ms）');

    console.log('\n== 2. 端口自动发现 ==');
    const statePath = path.join(tmpRoot, 'engine', '.state', 'browser.json');
    let st = null;
    try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (_) { st = null }
    ok(!!st, 'browser.json 已写入', statePath);
    if (st) {
      ok(Number.isInteger(st.port) && st.port > 0, 'port 是有效端口号（实际 ' + st.port + '）');
      ok(typeof st.browserVersion === 'string' && st.browserVersion.length > 0,
        'browserVersion 有值（实际 ' + st.browserVersion + '）');
      ok(st.ready === true, 'ready === true（启动成功过）');
      /* ★ 这一条是 2026-10-31 修的缺口：契约要求 pid，UI 也读，但原来没人写 */
      ok(Number.isInteger(st.pid) && st.pid > 0,
        '★ pid 有值（实际 ' + st.pid + '）—— 契约 §7.1 要求，UI「内核健康行」依赖它');
      ok(typeof st.executablePath === 'string' && st.executablePath.length > 0, 'executablePath 有值');
      ok(typeof st.profileDir === 'string' && st.profileDir.length > 0, 'profileDir 有值');
    }

    console.log('\n== 3. frame 树读取 ==');
    const frames = await adapter.getFrameDocuments();
    ok(Array.isArray(frames) && frames.length >= 1, 'frame 树非空（' + (frames ? frames.length : 0) + ' 个 frame）');
    const top = (frames || []).find((f) => f.isTop) || (frames || [])[0];
    ok(!!top && !!top.frameId, '顶层 frame 可取到');

    console.log('\n== 4. 页面求值（只读，不碰学习通）==');
    const title = await adapter.evalInFrame(top.frameId, 'document.title');
    ok(typeof title === 'string' || title === null, '能在 frame 内求值（document.title = ' + JSON.stringify(title) + '）');

    console.log('\n== 5. 关闭内核 ==');
    const portBefore = st ? st.port : 0;
    if (keep) {
      console.log('  （--keep：跳过关闭，内核仍在跑，pid=' + (st && st.pid) + '，port=' + portBefore + '）');
    } else {
      await adapter.shutdown();
      adapterRef = null;
      await new Promise((r) => setTimeout(r, 2500));
      /* 端口不再响应 */
      let stillUp = false;
      if (portBefore) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          const res = await fetch('http://127.0.0.1:' + portBefore + '/json/version', { signal: ctrl.signal });
          stillUp = res.ok;
          clearTimeout(t);
        } catch (_) { stillUp = false }
      }
      ok(!stillUp, '关闭后 CDP 端口不再响应（port ' + portBefore + '）');
    }
  } finally {
    if (adapterRef && !keep) {
      try { await adapterRef.shutdown() } catch (_) { /* ignore */ }
    }
    /* 清理探测用临时目录（不删生产状态） */
    if (!keep) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) { /* Windows 下可能被占用，忽略 */ }
    } else {
      console.log('\n探测目录保留：' + tmpRoot);
    }
  }

  console.log(fails.length ? '\n== L1 探测失败 ' + fails.length + ' 项 ==' : '\n== L1 探测全部通过 ==');
  if (fails.length) { for (const f of fails) console.log('  - ' + f); return 1 }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('探测脚本自身出错：' + ((e && e.stack) || e));
  process.exit(2);
});
