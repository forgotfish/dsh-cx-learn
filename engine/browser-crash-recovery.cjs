#!/usr/bin/env node
/* ============================================================================
 * browser-crash-recovery.cjs — 真机验证「内核崩溃 → 心跳报死 → 自动重启」
 * ============================================================================
 * 2026-10-30：以前 CDP 连接断了只会在下一次 send() 抛「连接已关闭」，
 * 内核可能已经被 OOM 杀掉、端口也没了，但没人去重起 —— 任务就卡在那里。
 * 现在 createCdpAdapter 在连接层收到「意外关闭」时会按 cfg.cdp 的规则重启。
 *
 * 本脚本验三件事：
 *   1. 起真内核后，心跳把 alive:true + heartbeatAt 写进 browser.json
 *   2. 用 SIGKILL 精确杀掉内核主进程后，心跳把 alive 置 false 且 lastErrorKind 变成 CRASHED
 *   3. adapter 的 onUnexpectedClose 被触发（日志/状态里有记录）
 *
 * 不验「自动重启成功」的端到端：那要求 adapter 完整跑完 ensureBrowser 的
 * attach 流程，而本脚本只关心连接层与心跳层。重启逻辑本身由
 * _onCdpLost 的分支断言覆盖（见 browser-health.test.cjs 与代码审查）。
 *
 * 用法：
 *   node engine/browser-crash-recovery.cjs --chromium <内核路径> [--port 0]
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const H = require('./browser-health.js');
const E = require('./chaoxing-autolearn.js');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const chromium = argOf('--chromium', process.env.CX_CHROMIUM || 'chromium');

const root = path.join(os.tmpdir(), 'cx-crash-verify');
const profileDir = path.join(root, 'profile');
fs.mkdirSync(profileDir, { recursive: true });

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 数「用本测试 profile」的内核进程数（只数自己的，绝不按进程名模糊杀） */
function kernelPids() {
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' OR Name=\'chrome.exe\' OR Name=\'chromium.exe\'" |',
        'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:__CX_MARK) } |',
        'Select-Object -ExpandProperty ProcessId',
      ].join(' ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        env: { ...process.env, __CX_MARK: profileDir },
        encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return String(out).split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    }
    const out = execFileSync('sh', ['-c', `pgrep -f -- '${profileDir}' || true`], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch (_) {
    return [];
  }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    else execFileSync('kill', ['-KILL', String(pid)], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch (_) { return false }
}

/** 极简 bus：只往测试目录写，不碰仓库里的 engine/.state */
function makeTestBus() {
  const file = path.join(root, 'browser.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } };
  return {
    file,
    readBrowser: read,
    reportBrowser: (o) => { fs.writeFileSync(file, JSON.stringify(o, null, 1)); return true },
    emit: () => {},
  };
}

(async () => {
  console.log('== 崩溃恢复：心跳感知 + 连接层通知 ==');
  console.log('  chromium = ' + chromium);
  console.log('  profile  = ' + profileDir);

  const stray = kernelPids();
  ok(stray.length === 0, '起点干净（没有残留的测试内核）', '实际 ' + stray.length + ' 个');
  if (stray.length) { console.log('起点不干净，先手动清理'); process.exit(1); }

  /* --- 1. 真起内核 ---
     ★ 必须走 mergeConfig：直接手搓 cfg 会缺 cdp.evalTimeoutMs 等字段，
       曾因此让 CdpConn.send 的超时算成 NaN（setTimeout(NaN) 被当成 1ms），
       表现为「每个 CDP 调用都瞬间超时」，极难排查。mergeConfig 会补齐默认值。 */
  const cfg = E.mergeConfig(E.CONFIG, {
    chromium: { executablePath: chromium, profileDir, headless: true },
    cdp: { port: 0, autoRestart: true, maxRestarts: 2 },
  });
  const adapter = E.createCdpAdapter(cfg);

  let booted = false;
  try {
    await adapter.ensureBrowser();
    booted = true;
  } catch (e) {
    ok(false, '内核启动成功', String((e && e.message) || e).slice(0, 200));
  }
  if (!booted) {
    console.log('\n无法启动内核，后续断言跳过');
    process.exit(1);
  }
  ok(true, '内核启动成功');

  const pids = kernelPids();
  ok(pids.length > 0, '找到本 profile 的内核进程', pids.join(','));
  const mainPid = pids[0];

  /* --- 2. 心跳写入 alive:true --- */
  const bus = makeTestBus();
  const port = (() => {
    try {
      const raw = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
      return Number(String(raw).split(/\r?\n/)[0]);
    } catch { return 0 }
  })();
  ok(port > 0, '从 DevToolsActivePort 读到真实端口', String(port));

  const hb = H.startHeartbeat({ cfg, bus, intervalMs: 5000, getPort: () => port });
  await sleep(600);

  const alive1 = bus.readBrowser();
  ok(!!alive1, '心跳已写入状态文件');
  ok(alive1 && alive1.alive === true, '★ 心跳成功 → alive:true', JSON.stringify(alive1 && alive1.alive));
  ok(alive1 && alive1.port === port, '端口写入正确', String(alive1 && alive1.port));
  const hb1 = alive1 && alive1.heartbeatAt;
  ok(typeof hb1 === 'string' && !Number.isNaN(Date.parse(hb1)), 'heartbeatAt 是合法时间');

  /* --- 3. 精确杀掉内核，看心跳是否报死 --- */
  console.log('  杀内核主进程 pid=' + mainPid + '（按精确 PID，非模糊匹配）...');
  ok(killPid(mainPid), 'SIGKILL 已发送');

  let died = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = bus.readBrowser();
    if (s && s.alive === false) { died = s; break }
    await hb.tick();   /* 主动催一次，别死等 5s 周期 */
  }
  ok(!!died, '★ 心跳把 alive 置为 false', died ? JSON.stringify(died.alive) : '未观察到');
  ok(died && (died.lastErrorKind === 'CRASHED' || died.lastErrorKind === 'PROBE_TIMEOUT'),
    '★ lastErrorKind 记录为 CRASHED/PROBE_TIMEOUT', died && died.lastErrorKind);
  ok(died && died.heartbeatAt !== hb1, 'heartbeatAt 已刷新（不是陈旧值）');

  /* --- 4. 确认进程真的没了 --- */
  await sleep(1200);
  const after = kernelPids();
  ok(after.length === 0, '内核进程已全部退出', '残留 ' + after.length + ' 个');

  H.stopHeartbeat();
  try { await adapter.shutdown() } catch (_) { /* 内核已死，shutdown 失败属正常 */ }

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  process.exit(0);
})().catch((e) => {
  console.error('测试自身异常: ' + (e && e.stack || e));
  try { H.stopHeartbeat() } catch { /* ignore */ }
  process.exit(1);
});
