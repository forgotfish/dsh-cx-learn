#!/usr/bin/env node
/* ============================================================================
 * browser-kernel.integration.cjs — 走引擎真实启动路径的集成测试
 * ----------------------------------------------------------------------------
 * 前面的 test.cjs 只测纯函数，ab/background 只测参数效果。
 * 本脚本验证「引擎自己拉起内核 → 自己发现端口 → 自己连上 CDP」这条完整链路，
 * 也就是用户点「开始看课」时真正会走的代码路径。
 *
 * 用 createCdpAdapter().ensureBrowser() 而不是自己 spawn，因此覆盖：
 *   · buildChromiumArgs 的最终拼装
 *   · --remote-debugging-port=0 后的 DevToolsActivePort 发现
 *   · waitForCdpEndpoint 的轮询
 *   · Target.attachToTarget / Page.enable / Runtime.enable 的真实握手
 *   · shutdown() 对 Browser.close 的清理
 *
 * 不做任何业务动作：不导航超星、不登录、不播放。
 *
 * 用法：node browser-kernel.integration.cjs <浏览器可执行文件路径>
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createCdpAdapter, mergeConfig, CONFIG, resolveCdpPort, readDevToolsActivePort, buildChromiumArgs } = require('./chaoxing-autolearn.js');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('用法: node browser-kernel.integration.cjs <浏览器可执行文件路径>');
  process.exit(2);
}

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

(async () => {
  const dir = path.join(os.tmpdir(), 'cx-integ-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const prof = path.join(dir, 'profile');

  /* 用自动端口 + 独立 profile，模拟真实使用 */
  const cfg = mergeConfig(CONFIG, {
    chromium: {
      executablePath: exe,
      headless: true,
      profileDir: prof,
      extraArgs: ['--no-sandbox', '--no-proxy-server'],
    },
    cdp: { port: 0, attachTimeoutMs: 25000 },
  });

  console.log('内核：' + exe);
  console.log('profile：' + prof);
  console.log('== 集成测试：引擎自起内核 → 自选端口 → 连上 CDP ==\n');

  const adapter = createCdpAdapter(cfg);
  let res = null;
  try {
    res = await adapter.ensureBrowser();
  } catch (e) {
    ok(false, 'ensureBrowser 成功', (e && e.message) || String(e));
  }

  if (res) {
    ok(!!res.targetId, 'ensureBrowser 返回了 targetId');
    ok(res.engine === 'cdp', '适配器引擎标识为 cdp');

    /* 端口是通过 DevToolsActivePort 发现的，而不是写死的 9223 */
    const active = readDevToolsActivePort(prof);
    ok(!!active && active.port > 0, 'profile 下生成了 DevToolsActivePort', active && active.port);
    ok(!!active && active.port !== 9223, '端口不是写死的 9223', active && active.port);
    ok(resolveCdpPort(cfg) === (active && active.port), 'resolveCdpPort 与文件端口一致', resolveCdpPort(cfg));

    /* 真实 CDP 往返：取浏览器版本与 target 列表 */
    const ver = await (await fetch('http://127.0.0.1:' + active.port + '/json/version')).json();
    ok(!!ver.webSocketDebuggerUrl, '/json/version 可达');
    console.log('     Browser: ' + ver.Browser);
    console.log('     UA: ' + ver['User-Agent']);

    const list = await (await fetch('http://127.0.0.1:' + active.port + '/json/list')).json();
    ok(Array.isArray(list) && list.length >= 1, 'target 列表非空', list && list.length);

    /* 业务原语冒烟：求值 / 取 URL（不涉及超星） */
    const url = await adapter.getCurrentUrl().catch((e) => 'ERR:' + e.message);
    ok(typeof url === 'string' && url.indexOf('ERR:') !== 0, 'getCurrentUrl 可读', String(url).slice(0, 60));

    const title = await adapter.evalInFrame(null, 'document.title + "|" + document.visibilityState')
      .catch((e) => 'ERR:' + e.message);
    ok(typeof title === 'string' && title.indexOf('ERR:') !== 0, 'evalInFrame 可求值', title);
    ok(String(title).indexOf('visible') >= 0, '无头页 visibilityState=visible（故不能靠它判断无头）', title);
  }

  /* 关闭并确认端口释放 */
  console.log('\n== 清理 ==');
  try { await adapter.shutdown(); ok(true, 'shutdown 未抛错'); }
  catch (e) { ok(false, 'shutdown 未抛错', e.message); }

  await new Promise((r) => setTimeout(r, 1500));
  let stillUp = false;
  try {
    const active = readDevToolsActivePort(prof);
    if (active) { await fetch('http://127.0.0.1:' + active.port + '/json/version'); stillUp = true; }
  } catch (_) { stillUp = false; }
  ok(!stillUp, 'shutdown 后调试端口已释放');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log('\n' + (fails.length
    ? '== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==\n' + fails.map((f) => '  - ' + f).join('\n')
    : '== 全部通过（' + pass + ' 项）=='));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack || e));
  process.exit(1);
});
