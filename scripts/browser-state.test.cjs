#!/usr/bin/env node
/* ============================================================================
 * browser-state.test.cjs — browser.json 对账（2026-11-02 事故回归）
 * ============================================================================
 * 事故：心跳停在 29 小时前、pid 2991258 已不存在、端口不监听，
 *       /health 仍报 alive:true，与 session.json（kernel_dead）互相矛盾。
 * 修复：读 browser.json 时先对账，心跳过期 / 无端口 / pid 已死 → alive:false。
 *
 * 用法：node scripts/browser-state.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-bstate-'));
process.env.DSH_HOME = TMP;

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);
  const { reconcileBrowser } = mod;
  ok(typeof reconcileBrowser === 'function', '导出了 reconcileBrowser');

  console.log('== 1. 心跳过期（29 小时）→ 不再 alive ==');
  {
    const stale = { alive: true, port: 33061, pid: 2991258, heartbeatAt: iso(29 * 3600 * 1000), ready: true };
    const r = reconcileBrowser(stale);
    ok(r.alive === false, '★ 29 小时前的心跳 → alive:false（实际 ' + r.alive + '）');
    ok(r.staleReason === 'heartbeat_stale', '★ 原因 heartbeat_stale（实际 ' + r.staleReason + '）');
    ok(r.ready === true, 'ready 语义保留（启动成功过）');
    ok(r.heartbeatAgeMs > 3600 * 1000, 'heartbeatAgeMs 合理');
  }

  console.log('== 2. 心跳新鲜但 pid 已死 → 不再 alive ==');
  {
    const deadPid = 99999999;
    const b = { alive: true, port: 33061, pid: deadPid, heartbeatAt: iso(5 * 1000) };
    const r = reconcileBrowser(b);
    ok(r.alive === false, '★ pid 不存在 → alive:false（实际 ' + r.alive + '）');
    ok(r.staleReason === 'pid_dead', '★ 原因 pid_dead（实际 ' + r.staleReason + '）');
  }

  console.log('== 3. 心跳新鲜 + pid 活着 → 保持 alive ==');
  {
    const b = { alive: true, port: 33061, pid: process.pid, heartbeatAt: iso(5 * 1000) };
    const r = reconcileBrowser(b);
    ok(r.alive === true, '★ 活着的 pid → alive:true');
    ok(r.staleReason === '', '没有 staleReason');
  }

  console.log('== 4. 没有端口 → 不再 alive ==');
  {
    const b = { alive: true, port: null, pid: process.pid, heartbeatAt: iso(5 * 1000) };
    const r = reconcileBrowser(b);
    ok(r.alive === false && r.staleReason === 'no_port', '★ 无端口 → no_port');
  }

  console.log('== 5. 已经是 false 的保持 false，并保留原因 ==');
  {
    const r = reconcileBrowser({ alive: false, lastErrorKind: 'KILLED', heartbeatAt: iso(1000) });
    ok(r.alive === false, 'alive 仍为 false');
    ok(r.staleReason === 'KILLED', 'staleReason 取 lastErrorKind（实际 ' + r.staleReason + '）');
  }

  console.log('== 6. 空值安全 ==');
  {
    ok(reconcileBrowser(null) === null, 'null → null');
    ok(reconcileBrowser(undefined) === null, 'undefined → null');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 ==');
    process.exit(1);
  }
  console.log('== 全部通过 ==');
})();
