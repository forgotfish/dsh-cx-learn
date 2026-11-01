#!/usr/bin/env node
/* ============================================================================
 * _browser-kernel.test.js — 浏览器内核静默控制的独立测试
 * ----------------------------------------------------------------------------
 * 只覆盖 2026-10-29 那一批「内核启动 / 端口发现」改动，不碰业务状态机。
 * 这些开关的失效方式很隐蔽：不报错、不崩溃，只是长任务越跑越慢、定时器被降频、
 * 播放器不再推进。所以必须有断言把它们钉住。
 *
 * 用法：node _browser-kernel.test.js [--live <浏览器可执行文件路径>]
 *   不带 --live  → 只跑纯函数（毫秒级，可进 CI）
 *   带  --live   → 额外真起一个无头内核，验证端口自选 + 防节流开关真的生效
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const E = require('./chaoxing-autolearn.js');
const {
  buildChromiumArgs, mergeChromiumArgs, readDevToolsActivePort,
  isHeadlessShellKernel, resolveCdpPort, CONFIG,
} = E;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}
function eq(actual, expected, name) { ok(actual === expected, name, '\u5b9e\u9645 ' + JSON.stringify(actual)); }
const has = (arr, v) => arr.indexOf(v) >= 0;

/* ---------------------------------------------------------------- 1. 参数构造 */
console.log('== 1/4 启动参数构造（无头常规内核）==');
const a = buildChromiumArgs({ headless: true, port: 0, profileDir: '', shellKernel: false, userArgs: [] });

eq(a.filter((x) => x.indexOf('--remote-debugging-port=') === 0).length, 1, '调试端口参数只出现一次');
ok(has(a, '--remote-debugging-port=0'), '端口 0 = 交给浏览器自选（多实例不互抢）');
ok(has(a, '--remote-debugging-address=127.0.0.1'), '调试端口只绑本机回环，不对外暴露');
ok(has(a, '--headless=new'), '完整 Chrome 用 --headless=new');

console.log('  -- 防节流三件套（长任务的生死线）--');
ok(has(a, '--disable-background-timer-throttling'), '关闭后台定时器降频');
ok(has(a, '--disable-backgrounding-occluded-windows'), '关闭遮挡导致的窗口降级');
ok(has(a, '--disable-renderer-backgrounding'), '关闭渲染进程后台降级');
const feat = a.filter((x) => x.indexOf('--disable-features=') === 0);
eq(feat.length, 1, '--disable-features 只出现一次');
ok(feat.length === 1 && feat[0].indexOf('CalculateNativeWinOcclusion') >= 0,
  '禁用 Windows 原生遮挡判定（browser-use 指出的停渲染元凶）');

/* ★ 2026-10-30：/dev/shm 兜底。
   容器默认只给 64MB，无头内核的 renderer 会直接 SIGABRT（exit -6 / stderr 空）。
   生产机（飞牛）是 4.9G 并不需要这条，但它是幂等的低成本保险，换容器部署不用改代码。 */
ok(has(a, '--disable-dev-shm-usage'), '/dev/shm 兜底（容器 64MB 默认值的解药）');
ok(has(buildChromiumArgs({ headless: false, port: 0 }), '--disable-dev-shm-usage'),
  '有头模式下也带 /dev/shm 兜底（同样会崩）');

/* 只出现一次：mergeChromiumArgs 的去重必须对它也生效 */
const shmTwice = buildChromiumArgs({ headless: true, port: 0, userArgs: ['--disable-dev-shm-usage'] });
eq(shmTwice.filter((x) => x === '--disable-dev-shm-usage').length, 1,
  '用户重复传 /dev/shm 参数也只保留一份');

console.log('  -- 播放与静默 --');
ok(has(a, '--autoplay-policy=no-user-gesture-required'), '允许无手势自动播放');
ok(has(a, '--mute-audio'), '无头下静音（无音频设备，避免音频线程空转）');
ok(has(a, '--no-first-run') && has(a, '--no-default-browser-check'), '不弹首启向导');
ok(has(a, '--disable-session-crashed-bubble'), '不弹「恢复页面」气泡');
ok(has(a, '--disable-breakpad'), '不启动崩溃上报');
ok(has(a, '--no-service-autorun'), '不后台自启服务');

/* ------------------------------------------------------- 2. 内核形态与有头模式 */
console.log('== 2/4 内核形态识别 / 有头模式 ==');
const shell = buildChromiumArgs({ headless: true, port: 0, shellKernel: true });
ok(has(shell, '--headless'), 'chrome-headless-shell 用 --headless');
ok(!has(shell, '--headless=new'), 'chrome-headless-shell 不带 --headless=new（它不是新无头）');
ok(isHeadlessShellKernel('/opt/browsers/chrome-headless-shell-linux64/chrome-headless-shell'), '按文件名识别 chrome-headless-shell');
ok(isHeadlessShellKernel('C:\\b\\headless_shell'), '按文件名识别 headless_shell');
ok(!isHeadlessShellKernel('C:\\browsers\\chrome-linux64\\chrome.exe'), '完整 chrome 不误判');
ok(!isHeadlessShellKernel('/usr/bin/chromium-browser'), 'chromium-browser 不误判');

const headful = buildChromiumArgs({ headless: false, port: 9223 });
ok(!headful.some((x) => x.indexOf('--headless') === 0), '有头模式不带任何 --headless');
ok(!has(headful, '--mute-audio'), '有头模式不强制静音');
ok(has(headful, '--remote-debugging-port=9223'), '显式端口原样透传');

console.log('== 3/4 参数合并与去重（防御用户填错）==');
const dup = buildChromiumArgs({
  headless: true, port: 0,
  userArgs: ['--remote-debugging-port=9222', '--window-size=800,600', '--window-size=1920,1080',
    '--mute-audio', '--mute-audio', '--no-first-run', '--user-data-dir=/tmp/other'],
});
eq(dup.filter((x) => x.indexOf('--remote-debugging-port=') === 0).length, 1, '端口参数去重');
ok(has(dup, '--remote-debugging-port=0'), '引擎端口口径胜出（用户写的 9222 被覆盖）');
eq(dup.filter((x) => x.indexOf('--window-size=') === 0).length, 1, '窗口尺寸去重');
ok(has(dup, '--window-size=1920,1080'), '同类单值参数后者覆盖前者');
eq(dup.filter((x) => x === '--mute-audio').length, 1, '布尔参数不重复');

console.log('  -- --disable-features 必须取并集，不能覆盖 --');
const union = buildChromiumArgs({ headless: true, port: 0, userArgs: ['--disable-features=IsolateOrigins'] });
const uline = union.filter((x) => x.indexOf('--disable-features=') === 0);
eq(uline.length, 1, '合并后仍只有一条');
ok(uline[0].indexOf('IsolateOrigins') >= 0 && uline[0].indexOf('CalculateNativeWinOcclusion') >= 0,
  '用户条目与引擎条目都在（并集）');

const m = mergeChromiumArgs(['--lang=zh-CN'], ['--lang=en-US', '--foo']);
eq(m.filter((x) => x.indexOf('--lang=') === 0).length, 1, 'mergeChromiumArgs 单值去重');
ok(has(m, '--lang=en-US'), '后组覆盖前组');
ok(has(m, '--foo'), '未登记参数原样保留');

console.log('  -- enable/disable features 不能串味（回归：曾共用同一个集合）--');
const mix = buildChromiumArgs({ headless: true, port: 0, userArgs: ['--enable-features=FooBar'] });
const dLine = mix.filter((x) => x.indexOf('--disable-features=') === 0);
const eLine = mix.filter((x) => x.indexOf('--enable-features=') === 0);
eq(dLine.length, 1, 'disable 行仍存在');
eq(eLine.length, 1, 'enable 行仍存在');
ok(dLine[0].indexOf('CalculateNativeWinOcclusion') >= 0, '引擎的防遮挡项留在 disable 行');
ok(dLine[0].indexOf('FooBar') < 0, '用户的 enable 项没有被塞进 disable 行');
ok(eLine[0].indexOf('FooBar') >= 0, '用户的 enable 项留在 enable 行');
ok(eLine[0].indexOf('CalculateNativeWinOcclusion') < 0,
  '防遮挡项没有同时出现在 enable 行（否则 enable 优先会抵消修复）');

/* --------------------------------------------------------- 4. 端口发现（纯函数） */
console.log('== 4/4 DevToolsActivePort 解析 ==');
const dir = path.join(os.tmpdir(), 'cx-kernel-test-' + process.pid);
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'DevToolsActivePort'),
  '54195\n/devtools/browser/5c80ab5f-690a-4294-a449-6178518687c7\n');
const ap = readDevToolsActivePort(dir);
ok(ap !== null, '能读出端口文件');
eq(ap && ap.port, 54195, '端口号正确');
ok(ap && ap.browserPath === '/devtools/browser/5c80ab5f-690a-4294-a449-6178518687c7', '浏览器级 WebSocket 路径正确');

fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '54195\n'); // 只有端口行
eq(readDevToolsActivePort(dir).port, 54195, '只有端口行时也能解析');

fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '???\n'); // 非法
eq(readDevToolsActivePort(dir), null, '内容非法返回 null（不瞎猜端口）');

fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '0\n'); // 0 不是可连接端口
eq(readDevToolsActivePort(dir), null, '端口 0 视为无效');

fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '70000\n'); // 越界
eq(readDevToolsActivePort(dir), null, '越界端口视为无效');

eq(readDevToolsActivePort(path.join(dir, 'nope')), null, '文件不存在返回 null');
eq(readDevToolsActivePort(''), null, '空目录返回 null');

console.log('  -- resolveCdpPort 的优先级 --');
eq(resolveCdpPort({ cdp: { port: 9222 }, chromium: { profileDir: dir } }), 9222, '显式端口优先');
eq(resolveCdpPort({ cdp: { port: 0 }, chromium: { profileDir: dir } }), 0, '端口 0 且文件非法 → 返回 0（端点未知）');
fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '41234\n/devtools/browser/x\n');
eq(resolveCdpPort({ cdp: { port: 0 }, chromium: { profileDir: dir } }), 41234, '端口 0 时回落到文件里的真实端口');
eq(resolveCdpPort({ cdp: { port: 0 }, chromium: { profileDir: '' } }), 0, '没有 profile 目录时返回 0');

console.log('  -- 默认配置口径 --');
eq(CONFIG.cdp.port, process.env.CX_CDP_PORT === undefined ? 0 : Number(process.env.CX_CDP_PORT), 'CONFIG.cdp.port 默认自动选端口');
ok(CONFIG.chromium.extraArgs.indexOf('--no-proxy-server') >= 0, '国内站点直连（不走系统代理）的既有设定保持');

/* ------------------------------------------------------------- 5. 真机（可选） */
const liveIdx = process.argv.indexOf('--live');
if (liveIdx >= 0) {
  const exe = process.argv[liveIdx + 1];
  if (!exe || !fs.existsSync(exe)) {
    console.log('\n== 5/5 真机验证：跳过（未提供有效 --live <路径>）==');
  } else {
    (async () => {
      console.log('\n== 5/5 真机验证：' + exe + ' ==');
      const prof = path.join(dir, 'profile');
      const args = buildChromiumArgs({
        headless: true, port: 0, profileDir: prof,
        shellKernel: isHeadlessShellKernel(exe), userArgs: ['--no-sandbox'],
      });
      args.push('about:blank');
      console.log('  启动参数：' + args.join(' '));

      const child = spawn(exe, args, { stdio: 'ignore' });
      let port = 0;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const r = readDevToolsActivePort(prof);
        if (r) { port = r.port; break; }
        await new Promise((res) => setTimeout(res, 250));
      }
      ok(port > 0, '无头内核自行选定了调试端口', '端口 ' + port);
      ok(port !== 9223 && port !== 9222, '端口不是写死值（说明真的自选了）', '端口 ' + port);

      if (port > 0) {
        let version = null;
        try {
          const res = await fetch('http://127.0.0.1:' + port + '/json/version');
          version = await res.json();
        } catch (e) { version = null; }
        ok(version && !!version.webSocketDebuggerUrl, '/json/version 可达并返回 WebSocket 端点');
        const ua = String((version && version['User-Agent']) || '');
        console.log('  UA: ' + ua);
        ok(/HeadlessChrome|headless/i.test(ua), 'UA 中可识别为无头（平台侧唯一稳定信号，非隐蔽性保证）');

        /* 真机验证防节流：在后台页面里数 1 秒内定时器触发次数。
           没有 --disable-background-timer-throttling 时，后台页会明显少于 20 次。 */
        try {
          const created = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
          const ws = new WebSocket(created.webSocketDebuggerUrl);
          const ticks = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('首帧求值超时')), 15000);
            let id = 0;
            const pending = new Map();
            ws.addEventListener('open', () => {
              const send = (method, params) => new Promise((res2) => {
                const mid = ++id; pending.set(mid, res2);
                ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
              });
              ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
              });
              (async () => {
                await send('Runtime.enable');
                const r = await send('Runtime.evaluate', {
                  expression: `new Promise(function(done){
                    var n = 0;
                    var h = setInterval(function(){ n++; }, 50);
                    setTimeout(function(){ clearInterval(h); done(n); }, 1000);
                  })`,
                  awaitPromise: true, returnByValue: true,
                });
                resolve(r && r.result && r.result.value);
              })().catch(reject);
            });
            ws.addEventListener('error', () => reject(new Error('WebSocket 失败')));
          });
          /* 50ms 一次、跑 1000ms，理想 20 次。被降频到 1s 时会掉到 1~2 次。 */
          ok(typeof ticks === 'number' && ticks >= 15,
            '后台页面定时器未被降频（1 秒内触发 ' + ticks + ' 次，理想 20）');
        } catch (e) {
          ok(false, '定时器节流验证执行失败', e.message);
        }
      }

      try { child.kill(); } catch (_) { /* ignore */ }
      await new Promise((res) => setTimeout(res, 800));
      try { child.kill(); } catch (_) { /* ignore */ }
    })().then(finish).catch((e) => { ok(false, '真机验证异常', e.message); finish(); });
  }
} else {
  console.log('\n（未指定 --live，跳过真机验证）');
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  console.log('\n' + (fails.length
    ? '== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==\n' + fails.map((f) => '  - ' + f).join('\n')
    : '== 全部通过（' + pass + ' 项）=='));
  process.exit(fails.length ? 1 : 0);
}
if (liveIdx < 0) finish();
