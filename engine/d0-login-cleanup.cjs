#!/usr/bin/env node
/* ============================================================================
 * d0-login-cleanup.cjs — D0 回归验证：登录失败必须关掉浏览器
 * ============================================================================
 * 背景（2026-10-30）：
 *   扫码超时后，引擎 process.exit(2)，但 runLogin 的 finally **无条件**保留浏览器。
 *   浏览器是 detached + unref 起的，于是留下一个没登录的 headless 实例。
 *   实测一次泄漏 13 个进程 / 1335 MB RSS，profile 被占用后 purgeEphemeralProfile()
 *   也删不掉 —— 这是飞牛「内存被压满」的主要来源。
 *
 * 修法：finally 里只有 loginOk === true 才保留浏览器，否则 shutdownBrowser()。
 *
 * 本脚本验证的是「超时失败」这条路径：
 *   1. 起一个真内核，跑 runLogin 但把扫码窗口压到几秒
 *   2. 断言 runLogin 返回 { ok:false, reason:'timeout' }
 *   3. 等内核退出后断言：该 profile 的内核进程数为 0
 *
 * 用法：
 *   node d0-login-cleanup.cjs --chromium <内核路径> [--sec 6]
 * 需要联网（会打开学习通登录页，只是取二维码，不涉及任何账号操作）。
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const E = require('./chaoxing-autolearn.js');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const chromium = argOf('--chromium', process.env.CX_CHROMIUM || 'chromium');
const sec = Number(argOf('--sec', '6'));

const profileDir = path.join(os.tmpdir(), 'cx-d0-verify', 'session');
const shotDir = path.join(os.tmpdir(), 'cx-d0-verify', 'shots');
const resultPath = path.join(shotDir, 'result.json');
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });
process.env.CX_LOGIN_RESULT = resultPath;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/**
 * 数出「使用本测试 profile」的浏览器进程数。
 * Windows 上按命令行匹配 --user-data-dir；Linux 上用 pgrep -f。
 * 只数自己的 profile，绝不按进程名模糊匹配。
 */
function countKernelProcs() {
  const marker = profileDir.replace(/\\/g, '\\');
  try {
    if (process.platform === 'win32') {
      const ps = [
        '$m = $env:__CX_MARK;',
        'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' OR Name=\'chrome.exe\' OR Name=\'chromium.exe\'" |',
        '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) } |',
        '  Measure-Object | Select-Object -ExpandProperty Count',
      ].join(' ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        env: { ...process.env, __CX_MARK: profileDir },
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return Number(String(out).trim()) || 0;
    }
    const out = execFileSync('sh', ['-c', `ps -eo args | grep -F -- '${marker}' | grep -vc grep || true`], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(String(out).trim()) || 0;
  } catch (_) {
    return -1; /* 无法判定 */
  }
}

(async () => {
  console.log('== D0 回归：登录超时后必须清掉内核 ==');
  console.log('  chromium = ' + chromium);
  console.log('  profile  = ' + profileDir);

  const before = countKernelProcs();
  console.log('  起始内核进程数 = ' + before);
  ok(before === 0, '起点干净（没有残留的测试内核）', '实际 ' + before);
  if (before !== 0) { console.log('\n起点不干净，先手动清理再跑'); process.exit(1); }

  let result = null;
  let thrown = null;
  const t0 = Date.now();
  try {
    result = await E.runLogin({
      chromium: { executablePath: chromium, profileDir, headless: true },
      login: { ephemeral: false, timeoutMs: sec * 1000, shotDir },
      cdp: { port: 0, host: '127.0.0.1' },
    });
  } catch (e) {
    thrown = e;
  }
  const elapsed = Date.now() - t0;
  console.log('  runLogin 返回（' + Math.round(elapsed / 1000) + 's）: ' + JSON.stringify(result));

  ok(!thrown, 'runLogin 未抛异常', thrown && (thrown.message || String(thrown)));
  ok(result && result.ok === false, '返回 ok === false');
  ok(result && result.reason === 'timeout', '失败原因是 timeout（扫码窗口被压到 ' + sec + 's）',
    result && result.reason);

  /* 内核对 Browser.close 需要一点时间落盘；给足 15 秒观察窗 */
  let after = -1;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    after = countKernelProcs();
    if (after === 0) break;
  }
  console.log('  结束后内核进程数 = ' + after + '（等待 ' + 15 + 's 内）');

  ok(after === 0, '★ 登录失败后内核进程数为 0（D0 的核心断言）', '实际 ' + after);

  const lr = (() => { try { return JSON.parse(fs.readFileSync(resultPath, 'utf8')) } catch { return null } })();
  ok(lr && lr.ok === false && lr.reason === 'timeout', 'result.json 记录 ok:false / timeout',
    JSON.stringify(lr));

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  process.exit(0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack || e));
  process.exit(1);
});
