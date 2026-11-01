#!/usr/bin/env node
/* ============================================================================
 * session.test.cjs — 会话生命周期（B-精简的核心逻辑）
 * ============================================================================
 *
 * 【这个模块决定什么】
 *   「浏览器什么时候可以死」。原来死得太早（任务一结束就死），
 *   导致刷完一门课想刷第二门必须重新扫码。
 *
 * 【要钉住的语义】
 *   1. 会话未开 → 任何「刷新/闲置」操作都不许把它凭空变成 active
 *   2. 开会话 → active，且重复开不重置 startedAt（否则闲置计时永远不触发）
 *   3. 每次使用刷新 lastUsedAt（否则正在用也会被判闲置）
 *   4. 闲置超阈值 → 该过期；未超 → 不该过期
 *   5. 关会话 → active:false 且留下 reason（排查时要知道为什么关的）
 *   6. 文件缺失/损坏 → 一律返回 null，绝不抛错
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 touchSession 改成空实现 → 「使用后 lastUsedAt 被刷新」变红。
 *   把 shouldExpire 的 >= 改成 > 并设 limit=idleMs → 边界断言变红。
 *   已实测：改坏退出 1，恢复退出 0。
 *
 * 运行：node engine/session.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('./src/session.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-session-'));

console.log('== 1. 文件不存在 → null，不抛错 ==');
ok(S.readSession(stateDir) === null, '没开过会话时读出来是 null');
ok(S.readSession(path.join(stateDir, 'nonexistent-dir')) === null, '目录不存在也返回 null 而不是抛错');

console.log('== 2. 未开会话时，刷新不该凭空造出会话 ==');
S.touchSession(stateDir);
ok(S.readSession(stateDir) === null, 'touch 不会无中生有');

console.log('== 3. 开启会话 ==');
S.openSession(stateDir, { loginVerified: true, port: 12345, kernelPid: 999 });
const s1 = S.readSession(stateDir);
ok(s1 && s1.active === true, 'active === true');
ok(s1 && s1.loginVerified === true, 'loginVerified 被记录');
ok(s1 && s1.port === 12345, 'port 被记录');
ok(s1 && s1.kernelPid === 999, 'kernelPid 被记录');
ok(s1 && typeof s1.startedAt === 'string' && !Number.isNaN(Date.parse(s1.startedAt)), 'startedAt 是合法时间');

console.log('== 3b. ★ 登录成功路径：openSession 不得把已写入的 port 覆盖成 null ==');
/* 2026-10-31 真机事故：宿主先写 port 再 openSession，openSession 的默认值把它抹成 null，
   watcher 随即判 kernel_dead 并删 profile —— 扫码成功 2.4 秒后登录态就没了。 */
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-session-port-'));
  S.writeSession(d2, { active: false, reason: 'login_failed', port: 33567, kernelPid: 4242 });
  S.openSession(d2, { loginVerified: true, verifiedAt: new Date().toISOString() });
  const sp = S.readSession(d2);
  ok(sp && sp.active === true, '会话已开启');
  ok(sp && sp.port === 33567, '★ 已写入的 port 被保留（不再被默认 null 覆盖）');
  ok(sp && sp.kernelPid === 4242, '★ 已写入的 kernelPid 被保留');
  ok(sp && sp.loginVerified === true, 'loginVerified 被记录');
  ok(sp && sp.reason === '', '★ 开会话清掉上一次的关闭原因（不再残留 kernel_dead）');
  /* 显式传入时以传入为准 */
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-session-port2-'));
  S.writeSession(d3, { active: false, port: 1111 });
  S.openSession(d3, { port: 2222 });
  ok(S.readSession(d3).port === 2222, '显式传入的 port 覆盖旧值');
  fs.rmSync(d2, { recursive: true, force: true });
  fs.rmSync(d3, { recursive: true, force: true });
}

console.log('== 4. 重复开启不重置 startedAt ==');
const startedAt1 = s1.startedAt;
S.openSession(stateDir, { port: 54321 });
const s2 = S.readSession(stateDir);
ok(s2.startedAt === startedAt1, '★ startedAt 不被重置（否则闲置计时永远不触发）');
ok(s2.port === 54321, 'port 允许更新');

console.log('== 5. 每次使用刷新 lastUsedAt ==');
/* ★ 先把 lastUsedAt 人为改老，再 touch，然后要求**严格变新**。
   曾经这里写成 `after >= before`，而「完全不刷新」时 after === before 也满足 >=，
   于是把 touchSession 改成空实现，测试照样全绿 —— 一条典型的假网。
   现在用「先改老 + 严格大于」，不刷新就必然红。 */
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();
S.writeSession(stateDir, { lastUsedAt: OLD });
S.touchSession(stateDir);
const after = S.readSession(stateDir).lastUsedAt;
ok(Date.parse(after) > Date.parse(OLD),
  '★ lastUsedAt 被刷新到更新（旧 ' + OLD + ' → 新 ' + after + '）');
ok(S.readSession(stateDir).active === true, '刷新不会把会话关掉');

console.log('== 6. 闲置超时判定 ==');
ok(S.shouldExpire(stateDir, 60 * 60 * 1000).expire === false, '阈值 1 小时 → 刚用完不过期');
ok(S.shouldExpire(stateDir, 1).expire === true, '阈值 1ms → 立刻判过期');
ok(S.shouldExpire(stateDir, 1).idleMs >= 0, 'idleMs 是非负数');
/* 手工把 lastUsedAt 改老，验证真的按时间算而不是按「有没有值」算 */
S.writeSession(stateDir, { lastUsedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
const ex10 = S.shouldExpire(stateDir, 5 * 60 * 1000);
ok(ex10.expire === true, '闲置 10 分钟 > 阈值 5 分钟 → 过期（实际 idle ' + Math.round(ex10.idleMs / 1000) + 's）');
const ex30 = S.shouldExpire(stateDir, 30 * 60 * 1000);
ok(ex30.expire === false, '闲置 10 分钟 < 阈值 30 分钟 → 不过期');

console.log('== 7. 关闭会话 ==');
S.closeSession(stateDir, 'user');
const s3 = S.readSession(stateDir);
ok(s3.active === false, 'active === false');
ok(s3.reason === 'user', 'reason 记录了关闭原因（实际 ' + s3.reason + '）');
ok(typeof s3.closedAt === 'string', 'closedAt 被记录');
ok(s3.port === null && s3.kernelPid === null, '关闭后清空 port/kernelPid（避免指向已死内核）');
ok(S.shouldExpire(stateDir, 1).expire === false, '已关闭的会话不再判过期（不该重复触发收尾）');

console.log('== 8. 坏文件 → null，不抛错 ==');
fs.writeFileSync(S.sessionFile(stateDir), '{ this is not json');
ok(S.readSession(stateDir) === null, '坏 JSON 返回 null');
ok(S.shouldExpire(stateDir, 1).expire === false, '坏文件时 shouldExpire 返回 false 而不是抛错');
S.touchSession(stateDir);
ok(true, '坏文件时 touch 不抛错');

console.log('== 9. 原子写：不会读到半个文件 ==');
S.openSession(stateDir, { note: 'atomic' });
ok(!fs.existsSync(S.sessionFile(stateDir) + '.tmp'), '临时文件已被 rename 掉，不留 .tmp');

/* 清理 */
try { fs.rmSync(stateDir, { recursive: true, force: true }) } catch (_) { /* ignore */ }

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
process.exit(0);
