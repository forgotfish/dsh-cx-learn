#!/usr/bin/env node
/* ============================================================================
 * state-isolation.test.cjs — 测试不得污染生产状态
 * ============================================================================
 *
 * 【为什么需要】
 *   实测过：跑一次 `--self-test`，`engine/.state/learn.json` 与
 *   `events.ndjson` 的 mtime 立刻变成自测时间。设置页里「上次停止原因」
 *   于是显示自测留下的假数据 —— 排查真实问题时会被这个假值带偏。
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 `engine/chaoxing-autolearn.js` 顶部那段 `CX_STATE_DIR` 预置代码删掉
 *   → 本测试必须变红（生产 learn.json 的 mtime 会变）。
 *   已实测：删除后退出码 1，恢复后退出码 0。
 *
 * 运行：node scripts/state-isolation.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'chaoxing-autolearn.js');
const STATE = path.join(ROOT, 'engine', '.state');
const LEARN = path.join(STATE, 'learn.json');
const EVENTS = path.join(STATE, 'events.ndjson');

const fails = [];
function ok(cond, name) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name); fails.push(name); }
}

function snapshot() {
  const out = { exists: fs.existsSync(LEARN) };
  try {
    const st = fs.statSync(LEARN);
    out.mtime = st.mtimeMs;
    out.size = st.size;
  } catch (_) { out.mtime = 0; out.size = 0 }
  try { out.eventsSize = fs.statSync(EVENTS).size } catch (_) { out.eventsSize = 0 }
  return out;
}

/* ★ 2026-10-31 新增：自测也不许删掉**在线的登录 profile**。
   危险性：自测调 run()，run() 的 finally 里原本无条件 cleanupEphemeralProfile()，
   那会把 $TMPDIR/cx-learn-ephemeral/session 整个删掉 ——
   用户刚扫完的码、正在用的会话，被一次自测直接作废。
   下面放一个「哨兵文件」进去，跑完必须还在。 */
const EPHEMERAL = path.join(os.tmpdir(), 'cx-learn-ephemeral', 'session');
let sentinel = null;
try {
  fs.mkdirSync(EPHEMERAL, { recursive: true });
  sentinel = path.join(EPHEMERAL, '.cx-sentinel-' + process.pid);
  fs.writeFileSync(sentinel, 'keep-me');
} catch (_) { sentinel = null }

console.log('== 1. --self-test 不得改生产 learn.json ==');
const before = snapshot();
console.log('  运行前：learn.json ' + (before.exists ? before.size + ' bytes' : '不存在') + '，events ' + before.eventsSize + ' bytes');

/* 等 1.1 秒：文件 mtime 精度是 1 秒，不留间隔会把「写过了」看成「没写」 */
const wait = Date.now() + 1100;
while (Date.now() < wait) { /* busy-ish wait，只等一秒 */ }

try {
  execFileSync(process.execPath, [ENGINE, '--self-test'], {
    cwd: ROOT, timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  ok(false, '--self-test 执行失败：' + String(e && e.message || e).slice(0, 120));
}

const after = snapshot();
console.log('  运行后：learn.json ' + (after.exists ? after.size + ' bytes' : '不存在') + '，events ' + after.eventsSize + ' bytes');

ok(after.mtime === before.mtime, 'learn.json mtime 未变（期望 ' + before.mtime + '，实际 ' + after.mtime + '）');
ok(after.size === before.size, 'learn.json 大小未变（期望 ' + before.size + '，实际 ' + after.size + '）');
ok(after.eventsSize === before.eventsSize, 'events.ndjson 未被追加（期望 ' + before.eventsSize + '，实际 ' + after.eventsSize + '）');

console.log('== 1b. --self-test 不得删掉在线登录 profile ==');
if (sentinel) {
  const kept = fs.existsSync(sentinel);
  ok(kept, '★ 自测没有删掉 $TMPDIR/cx-learn-ephemeral/session（哨兵文件仍在）');
  ok(fs.existsSync(EPHEMERAL), '★ profile 目录整体仍然存在');
  try { fs.unlinkSync(sentinel) } catch (_) { /* ignore */ }
} else {
  ok(false, '无法在临时 profile 目录放哨兵（环境异常）');
}

console.log('== 2. 隔离目录确实产生了（证明测试真的跑了，不是早退）==');
const dirs = fs.readdirSync(os.tmpdir())
  .filter((n) => n.startsWith('cx-selftest-'))
  .map((n) => path.join(os.tmpdir(), n));
ok(dirs.length > 0, '临时隔离目录存在（' + dirs.length + ' 个）');
if (dirs.length) {
  const newest = dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const files = fs.readdirSync(newest);
  ok(files.length > 0, '隔离目录里有状态文件（' + files.join(', ') + '）');
  console.log('  → ' + newest);
}

console.log('== 3. 生产状态目录未被新建垃圾 ==');
try {
  const junk = fs.readdirSync(STATE).filter((n) => /selftest|test|tmp/i.test(n));
  ok(junk.length === 0, '生产 .state 目录无测试残留（实际：' + (junk.join(', ') || '无') + '）');
} catch (_) {
  ok(true, '生产 .state 目录不存在（从未运行过，属正常）');
}

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
process.exit(0);
