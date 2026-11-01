#!/usr/bin/env node
/* ============================================================================
 * browser-health.test.cjs — 心跳与崩溃归因的纯函数测试
 * ----------------------------------------------------------------------------
 * 覆盖 engine/browser-health.js 与 describeLaunchExit 的 2026-10-30 新增分支。
 * 全部用假 bus / 本地 HTTP 服务，不需要真内核，毫秒级，可进 CI。
 *
 * 为什么这些断言重要：
 *   · probeKernel 如果会抛错，心跳定时器就会把宿主进程带崩
 *   · 心跳如果覆盖写 browser.json，会把旧版本写的字段（profileDir 等）冲掉，
 *     设置页立刻显示「内核路径为空」
 *   · recordCrash 的 restarts 如果从 0 重算，UI 永远显示「重启 0 次」，
 *     真实崩溃被掩盖
 *
 * 用法：node engine/browser-health.test.cjs
 * ==========================================================================*/
'use strict';

const http = require('node:http');

const H = require('./browser-health.js');
const { describeLaunchExit } = require('./chaoxing-autolearn.js');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}
const eq = (a, b, name) => ok(a === b, name, '实际 ' + JSON.stringify(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 假 bus */
function makeBus(initial) {
  const box = { data: initial || null, writes: 0 };
  return {
    box,
    readBrowser: () => box.data,
    reportBrowser: (o) => { box.writes += 1; box.data = o; return true },
    emit: () => {},
  };
}

(async () => {
  /* ============================================================ 1. probeKernel */
  console.log('== 1/5 probeKernel ==');

  /* 1a. 端口非法：直接返回，不发请求 */
  const bad = await H.probeKernel({ port: 0 });
  eq(bad.ok, false, '端口 0 → ok:false');
  ok(typeof bad.error === 'string' && bad.error.includes('port'), '错误信息点明 port', bad.error);

  const bad2 = await H.probeKernel({ port: 70000 });
  eq(bad2.ok, false, '端口越界 → ok:false');

  /* 1b. 连接拒绝：不抛错 */
  const refused = await H.probeKernel({ host: '127.0.0.1', port: 1, timeoutMs: 1500 });
  eq(refused.ok, false, '★ 连接被拒 → ok:false（不抛错）');

  /* 1c. 超时：服务端不响应 */
  const hang = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const hangPort = hang.address().port;
  const t0 = Date.now();
  const timedOut = await H.probeKernel({ host: '127.0.0.1', port: hangPort, timeoutMs: 600 });
  const dt = Date.now() - t0;
  eq(timedOut.ok, false, '★ 服务端不响应 → ok:false（不抛错）');
  ok(/timeout/i.test(String(timedOut.error)), '错误信息标明 timeout', timedOut.error);
  ok(dt < 3000, '在超时预算内返回（不挂死）', dt + 'ms');
  hang.close();

  /* 1d. 正常响应 */
  const good = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/158.0.8122.0', 'Protocol-Version': '1.3' }));
  });
  await new Promise((r) => good.listen(0, '127.0.0.1', r));
  const goodPort = good.address().port;
  const alive = await H.probeKernel({ host: '127.0.0.1', port: goodPort, timeoutMs: 2000 });
  eq(alive.ok, true, '★ 正常响应 → ok:true');
  eq(alive.version, 'Chrome/158.0.8122.0', '带回内核版本');

  /* 1e. 500 错误 */
  const err5 = http.createServer((req, res) => { res.writeHead(500); res.end('x') });
  await new Promise((r) => err5.listen(0, '127.0.0.1', r));
  const errPort = err5.address().port;
  const e500 = await H.probeKernel({ host: '127.0.0.1', port: errPort, timeoutMs: 2000 });
  eq(e500.ok, false, 'HTTP 500 → ok:false');
  ok(/500/.test(String(e500.error)), '错误信息带状态码', e500.error);
  err5.close();

  /* ============================================================ 2. 心跳字段 */
  console.log('== 2/5 心跳字段形状 ==');

  const bus = makeBus({
    layer: 'browser',
    executablePath: '/vol1/browsers/chrome-linux64/chrome',
    profileDir: '/tmp/prof',
    headless: true,
    ready: true,
    /* 启动时写入的内核 pid（契约 §7.1）。心跳是「读回来合并写」，
       必须原样保留它，否则 UI 的「内核健康行」永远显示不出 pid。 */
    pid: 4242,
  });

  const hb = H.startHeartbeat({
    cfg: { cdp: { host: '127.0.0.1' }, chromium: {} },
    bus,
    intervalMs: 60000,
    isOwner: true,
    getPort: () => goodPort,
  });
  await sleep(250);   /* 等首轮 tick（startHeartbeat 会立刻探一次） */

  const written = bus.box.data;
  ok(!!written, '心跳写入了 browser.json');
  eq(written.alive, true, '★ alive === true（探测成功）');
  eq(written.port, goodPort, 'port 写入');
  ok(typeof written.heartbeatAt === 'string' && !Number.isNaN(Date.parse(written.heartbeatAt)),
    'heartbeatAt 是合法 ISO 时间');
  ok(typeof written.uptimeMs === 'number' && written.uptimeMs >= 0, 'uptimeMs 是数字且 >= 0',
    String(written.uptimeMs));
  eq(written.restarts, 0, 'restarts 初始为 0');
  eq(written.lastErrorKind, '', '探测成功时 lastErrorKind 为空');

  /* ← 关键：旧字段必须原样保留，否则设置页会显示内核路径为空 */
  eq(written.executablePath, '/vol1/browsers/chrome-linux64/chrome', '★ 旧字段 executablePath 保留');
  eq(written.profileDir, '/tmp/prof', '★ 旧字段 profileDir 保留');
  eq(written.headless, true, '★ 旧字段 headless 保留');
  eq(written.ready, true, '★ ready 不被心跳覆盖（语义是「启动成功过」）');
  /* ★ 2026-10-31 新增：pid 必须被心跳保留。
     契约 §7.1 要求 browser.json 带 pid，插件「内核健康行」也读它
     （`内核：就绪 pid 1234 · CDP …`）。但原来启动路径根本不写 pid，
     心跳又是合并写，两处都不覆盖 → UI 那一段永远显示不出 pid。 */
  eq(written.pid, 4242, '★ 心跳保留启动时写入的 pid');

  /* 失败时也不许把 ready 抹掉 */
  H.stopHeartbeat();
  const bus2 = makeBus({ layer: 'browser', ready: true, executablePath: '/x/chrome' });
  const hb2 = H.startHeartbeat({
    cfg: { cdp: { host: '127.0.0.1' }, chromium: {} },
    bus: bus2, intervalMs: 60000, getPort: () => 1,
    /* owner 才有资格宣告死亡；附着方的用例在 2b 段 */
    isOwner: true,
  });
  await sleep(300);   /* 第 1 次失败：PROBE_TIMEOUT */
  eq(bus2.box.data.alive, false, '探测失败 → alive:false');
  eq(bus2.box.data.lastErrorKind, 'PROBE_TIMEOUT', '第 1 次失败标 PROBE_TIMEOUT（不立刻判死）');
  eq(bus2.box.data.ready, true, '★ 失败时 ready 仍保留（不覆盖）');
  await hb2.tick();   /* 第 2 次失败：CRASHED */
  eq(bus2.box.data.lastErrorKind, 'CRASHED', '★ 连续 2 次失败 → CRASHED');
  H.stopHeartbeat();

  /* ============================================ 2b. 附着方不得宣告内核死亡
   * ★ 2026-10-31 实测缺陷：附着方（读课程/取证/看课）进程退出时，
   *   它这一轮心跳探测失败，就把 browser.json 写成 alive:false + CRASHED；
   *   而内核实际还活着（端口 200、pid 未变）。UI 于是谎报「已停止」。
   *   规则：只有 owner 才有资格宣告死亡；附着方探不到就什么都不写。 */
  console.log('== 2b/5 附着方不得宣布内核死亡 ==');
  const busOwner = makeBus({ layer: 'browser', ready: true, alive: true, pid: 1234 });
  H.startHeartbeat({ cfg: { cdp: { host: '127.0.0.1' } }, bus: busOwner, intervalMs: 60000, getPort: () => 1, isOwner: true });
  await sleep(300);
  eq(busOwner.box.data.alive, false, 'owner 探不到 → 可以写 alive:false（正常）');
  H.stopHeartbeat();

  const busAttach = makeBus({ layer: 'browser', ready: true, alive: true, pid: 1234 });
  const hbAttach = H.startHeartbeat({ cfg: { cdp: { host: '127.0.0.1' } }, bus: busAttach, intervalMs: 60000, getPort: () => 1, isOwner: false });
  await sleep(300);
  await hbAttach.tick();
  await hbAttach.tick();
  eq(busAttach.box.data.alive, true, '★ 附着方探不到时不得把 alive 改成 false');
  eq(busAttach.box.data.lastErrorKind === 'CRASHED', false, '★ 附着方不得写 CRASHED');
  eq(busAttach.box.data.pid, 1234, '★ 附着方不得动 pid');
  H.stopHeartbeat();

  /* ============================================================ 3. stop 幂等 */
  console.log('== 3/5 stopHeartbeat 幂等 ==');
  const bus3 = makeBus({ ready: true });
  H.startHeartbeat({ cfg: { cdp: {} }, bus: bus3, intervalMs: 60000, getPort: () => goodPort });
  eq(H.isRunning(), true, '启动后 isRunning === true');
  H.stopHeartbeat();
  eq(H.isRunning(), false, '停止后 isRunning === false');
  H.stopHeartbeat();
  H.stopHeartbeat();
  ok(true, '★ 重复 stop 不抛错（幂等）');

  /* 重复 start 只保留一个定时器 */
  H.startHeartbeat({ cfg: { cdp: {} }, bus: bus3, intervalMs: 60000, getPort: () => goodPort });
  H.startHeartbeat({ cfg: { cdp: {} }, bus: bus3, intervalMs: 60000, getPort: () => goodPort });
  H.startHeartbeat({ cfg: { cdp: {} }, bus: bus3, intervalMs: 60000, getPort: () => goodPort });
  eq(H.isRunning(), true, '★ 重复 start 3 次仍只有一个定时器');
  H.stopHeartbeat();

  /* ============================================================ 4. recordCrash */
  console.log('== 4/5 recordCrash ==');
  const bus4 = makeBus({ layer: 'browser', ready: true, restarts: 0 });
  H.recordCrash({ bus: bus4, code: 21, signal: null, kind: 'CRASHED' });
  eq(bus4.box.data.restarts, 1, '第 1 次崩溃 → restarts=1');
  eq(bus4.box.data.alive, false, '崩溃后 alive:false');
  eq(bus4.box.data.lastErrorKind, 'CRASHED', 'lastErrorKind=CRASHED');
  ok(bus4.box.data.lastExit && bus4.box.data.lastExit.code === 21, 'lastExit.code 记录退出码 21',
    JSON.stringify(bus4.box.data.lastExit));

  H.recordCrash({ bus: bus4, code: null, signal: 'SIGKILL', kind: 'CRASHED' });
  eq(bus4.box.data.restarts, 2, '★ 第 2 次崩溃 → restarts 累加到 2（不是重置）');
  eq(bus4.box.data.lastExit.signal, 'SIGKILL', 'lastExit.signal 记录 SIGKILL');

  /* bus 不可用时不抛错 */
  let threw = false;
  try { H.recordCrash({ bus: null, code: 1 }); } catch { threw = true }
  eq(threw, false, 'bus 为 null 时 recordCrash 不抛错');

  /* ============================================================ 5. 归因 */
  console.log('== 5/5 describeLaunchExit 新增归因 ==');

  const oom = describeLaunchExit(null, '', { chromium: { profileDir: '/p', executablePath: '/c' } }, '', 'SIGKILL');
  ok(/OOM|内存/.test(oom.reason), '★ signal=SIGKILL → 归因到 OOM / 内存不足', oom.reason);
  ok(/dmesg/.test(oom.hint), '提示用 dmesg 确认', oom.hint);

  const sig9 = describeLaunchExit(137, '', { chromium: {} }, '', '');
  ok(/SIGKILL|OOM|内存/.test(sig9.reason), '退出码 137 → 同样归因到 SIGKILL/OOM', sig9.reason);

  const enospc = describeLaunchExit(1, 'Failed to write file: No space left on device', { chromium: {} }, '');
  ok(/磁盘|空间/.test(enospc.reason), '★ ENOSPC → 磁盘不足', enospc.reason);

  const shm = describeLaunchExit(1, 'Failed to open /dev/shm/xyz', { chromium: {} }, '');
  ok(/共享内存|\/dev\/shm/.test(shm.reason), '★ /dev/shm → 共享内存不足', shm.reason);
  ok(/disable-dev-shm-usage/.test(shm.hint), '提示加 --disable-dev-shm-usage', shm.hint);

  const abrt = describeLaunchExit(-6, '', { chromium: {} }, '');
  ok(/SIGABRT|初始化阶段/.test(abrt.reason), '退出码 -6 → 初始化阶段崩溃（SIGABRT）', abrt.reason);

  /* 向后兼容：不传 signal 也必须工作 */
  const legacyCall = describeLaunchExit(21, '', { chromium: { profileDir: '/p' } }, '');
  ok(typeof legacyCall.reason === 'string' && legacyCall.reason.length > 0,
    '★ 向后兼容：不传 signal 仍正常归因', legacyCall.reason);
  ok(legacyCall.code === 21, 'code 原样返回');
  ok('detail' in legacyCall && 'hint' in legacyCall, '返回形状不变（code/reason/hint/detail）');

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  /* 显式退出：测试里起过 http server 与心跳定时器，即使都 close 了，
     Node 的事件循环也可能因 keep-alive 连接残留而挂住（实测卡了 3 分钟）。 */
  process.exit(0);
})().catch((e) => {
  console.error('测试自身异常: ' + (e && e.stack || e));
  try { H.stopHeartbeat() } catch { /* ignore */ }
  process.exit(1);
});
