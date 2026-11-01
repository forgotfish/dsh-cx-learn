#!/usr/bin/env node
/* ============================================================================
 * host-smoke.test.cjs — 宿主半端冒烟测试（不装进 DSH，零风险）
 * ============================================================================
 *
 * 【为什么这么测】
 *   把插件装进 DSH profile 需要重启 DSH 才生效 —— 而 agent 正跑在那个
 *   DSH 里，重启会掐断会话。所以「装进去试试」不能当验证手段。
 *
 *   替代方案：`index.js` 的 `apply(ctx)` 只依赖一个 ctx 对象。
 *   造一个假 ctx，就能把**真实的路由代码**整条跑一遍 ——
 *   恰好覆盖历史上三次事故：
 *     ① inject 声明了宿主没有的服务 → 插件 pending → DSH 起不来
 *     ② apply 里访问 ctx.webServer 抛错 → 插件崩 → 设置页全空
 *     ③ sendJson 丢 Buffer → 每个请求都 400
 *
 * 【与 health-route.cjs 的区别】
 *   那个是**复刻**路由逻辑来测（测的是副本，不是产品）。
 *   这个是**导入真身**，调真 apply、真 handler。
 *
 * 【安全】
 *   · DSH_HOME 指到临时目录，不碰真实配置
 *   · 只调用只读路由；/start /stop /login /courses /session/end 一律不调
 *     （它们会起内核、杀进程、删 profile）
 *
 * 运行：node scripts/host-smoke.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

/* DSH_HOME 必须在 import 之前设好：index.js 在模块加载时就算 STATE 路径 */
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-host-smoke-'));
process.env.DSH_HOME = TMP_HOME;
process.env.CX_INJECT_MINIMAL = '1';

/** 假响应：收集 writeHead / end */
function fakeRes() {
  const out = { code: 0, headers: null, body: '', };
  return {
    writeHead(code, headers) { out.code = code; out.headers = headers || {} },
    end(chunk) { out.isBuffer = Buffer.isBuffer(chunk); out.body = chunk ? String(chunk) : ''; out.done = true },
    _out: out,
  };
}

/** 假请求：GET 无体；POST 给一个 async iterable 的 body */
function fakeReq(method, url, bodyObj) {
  const text = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text);
    },
  };
  return req;
}

async function callRoute(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  let json = null;
  try { json = JSON.parse(res._out.body) } catch (_) { json = null }
  return { code: res._out.code, json, raw: res._out.body, headers: res._out.headers, isBuffer: res._out.isBuffer };
}

async function main() {
  const indexUrl = 'file:///' + path.resolve(__dirname, '..', 'index.js').replace(/\\/g, '/');
  let mod;
  try {
    mod = await import(indexUrl);
  } catch (e) {
    ok(false, 'index.js 可加载', String((e && e.message) || e).slice(0, 160));
    return finish();
  }
  ok(true, 'index.js 可加载');

  /* ---- 1. inject 声明 ---- */
  console.log('== 1. inject 声明 ==');
  ok(Array.isArray(mod.inject), 'inject 是数组（cordis 只认数组，对象形式会被忽略）',
    typeof mod.inject);
  ok(mod.inject.every((x) => typeof x === 'string'), 'inject 每项都是字符串');
  ok(typeof mod.apply === 'function', '导出 apply()');
  ok(typeof mod.name === 'string' && mod.name.length > 0, '导出 name（实际 ' + mod.name + '）');

  /* ---- 2. 有 webServer 时能注册路由 ---- */
  console.log('== 2. 正常环境：注册路由 ==');
  const routes = [];
  const cleanups = [];
  const ctx = {
    webServer: { register(spec) { routes.push(spec); return () => {} } },
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      async *stream() { /* 空流 */ },
    },
    attachments: { admitPromptContent: async () => [] },
  };

  let applyThrew = null;
  try { mod.apply(ctx, {}) } catch (e) { applyThrew = e }
  ok(applyThrew === null, 'apply() 不抛错', applyThrew && String(applyThrew.message).slice(0, 120));
  ok(routes.length === 1, '注册了 1 个路由（实际 ' + routes.length + '）');
  ok(routes[0] && routes[0].path === '/api/cx-learn', '路由前缀正确（实际 ' + (routes[0] && routes[0].path) + '）');
  ok(routes[0] && typeof routes[0].handler === 'function', 'handler 是函数');

  if (!routes.length) return finish();
  const H = routes[0].handler;

  /* ---- 3. 只读路由逐个跑 ---- */
  console.log('== 3. 只读路由 ==');

  const health = await callRoute(H, 'GET', '/api/cx-learn/health');
  ok(health.code === 200, '/health 返回 200（实际 ' + health.code + '）');
  ok(health.json && health.json.ok === true, '/health body ok:true');
  ok(health.json && health.json.engine && typeof health.json.engine.ready === 'boolean', '/health 有 engine.ready');
  ok(health.json && 'chromium' in health.json, '/health 有 chromium');
  ok(health.json && 'browser' in health.json, '/health 有 browser');
  ok(health.json && health.json.task && typeof health.json.task.running === 'boolean', '/health 有 task.running');
  ok(health.json && 'session' in health.json, '★ /health 有 session 字段（B-精简新增）');
  ok(health.json && typeof health.json.home === 'string', '/health 有 home');
  ok(health.headers && /application\/json/.test(health.headers['content-type'] || ''), '/health 是 JSON content-type');
  ok(health.isBuffer === true, '★ res.end 收到的是 Buffer（sendJson 丢 Buffer 那次事故）');
  ok(health.headers && Number(health.headers['content-length']) === Buffer.byteLength(health.raw),
    '★ content-length 与实际字节数一致（sendJson 丢 Buffer 那次就是这个错）');

  const status = await callRoute(H, 'GET', '/api/cx-learn/status');
  ok(status.code === 200 && status.json && status.json.ok === true, '/status 200 + ok:true');
  ok(status.json && status.json.config && typeof status.json.config === 'object', '/status 有 config');
  ok(status.json && Array.isArray(status.json.browsers), '/status 有 browsers 数组');
  ok(status.json && 'session' in status.json, '★ /status 有 session 字段');

  /* ---- 3b. ★ L5：AI 答题链路必须已经删干净 ----
   * 这些接口是死代码，留着会让后来者以为插件会答题（SPEC §3.2 N2）。
   * 断言方向反过来：它们必须 404，而不是「还能用」。 */
  console.log('== 3b. AI 答题链路已删除（L5）==');
  const rmModels = await callRoute(H, 'GET', '/api/cx-learn/models');
  ok(rmModels.code === 404, '★ GET /models 已删除 → 404（实际 ' + rmModels.code + '）');
  const rmHealth = await callRoute(H, 'POST', '/api/cx-learn/models/health', {});
  ok(rmHealth.code === 404, '★ POST /models/health 已删除 → 404（实际 ' + rmHealth.code + '）');
  const rmAsk = await callRoute(H, 'POST', '/api/cx-learn/ask-test', {});
  ok(rmAsk.code === 404, '★ POST /ask-test 已删除 → 404（实际 ' + rmAsk.code + '）');
  for (const f of ['quizModels', 'builtinModels', 'quizModelActive', 'quizModelLabel', 'zhipuReady', 'llmReady']) {
    ok(status.json && !(f in status.json), '★ /status 不再有 ' + f);
  }

  /* ---- 3c. ★ status() 在 child === null 时仍返回 200 ----
   * 插件重启后 child 为 null，但 state.json 里的 pid 可能还活着；
   * 旧写法 `running() ? child.pid : null` 会在这里抛 TypeError → 500。 */
  console.log('== 3c. status() 在 child 为 null 时不许抛 ==');
  {
    const stPath = path.join(TMP_HOME, 'cx-learn', 'state.json');
    fs.mkdirSync(path.dirname(stPath), { recursive: true });
    fs.writeFileSync(stPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const s2 = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(s2.code === 200 && s2.json && s2.json.ok === true, '★ 内核 pid 活着但 child 为 null 时 /status 仍 200（实际 ' + s2.code + '）');
    ok(s2.json && s2.json.running === true, '  ↳ running 按 pid 探活为 true');
    ok(s2.json && s2.json.pid === null, '  ↳ pid 字段安全降级为 null');
    fs.unlinkSync(stPath);
    const s3 = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(s3.code === 200 && s3.json && s3.json.running === false, '  ↳ 清掉 state.json 后 running 回到 false');
  }

  const cfg = await callRoute(H, 'GET', '/api/cx-learn/config');
  ok(cfg.code === 200 && cfg.json && cfg.json.config, '/config GET 返回 config');
  ok(cfg.json.config.courseUrl !== undefined, 'config 有 courseUrl');
  ok(cfg.json.config.mode !== undefined, 'config 有 mode');

  const br = await callRoute(H, 'GET', '/api/cx-learn/browsers');
  ok(br.code === 200 && br.json && Array.isArray(br.json.browsers), '/browsers 返回数组');
  ok(br.json && typeof br.json.root === 'string', '/browsers 返回 root');

  const log = await callRoute(H, 'GET', '/api/cx-learn/log');
  ok(log.code === 200 && log.json && typeof log.json.log === 'string', '/log 返回 log 字符串');

  const ls = await callRoute(H, 'GET', '/api/cx-learn/login-state');
  ok(ls.code === 200 && ls.json && typeof ls.json.state === 'string', '/login-state 返回 state（实际 ' + (ls.json && ls.json.state) + '）');

  const qr = await callRoute(H, 'GET', '/api/cx-learn/qr');
  ok(qr.code === 200 && qr.json && typeof qr.json.ok === 'boolean', '/qr 返回 ok 布尔（没有码时 ok:false）');

  const qs = await callRoute(H, 'GET', '/api/cx-learn/questions');
  ok(qs.code === 200 && qs.json && Array.isArray(qs.json.questions), '/questions 返回数组');

  const nf = await callRoute(H, 'GET', '/api/cx-learn/definitely-not-a-route');
  ok(nf.code === 404, '★ 未知路由返回 404（不是 500、不是挂起）');
  ok(nf.json && nf.json.ok === false, '未知路由 body ok:false');

  /* ---- 4. 降级：没有 webServer 的宿主不能崩 ---- */
  console.log('== 4. 降级：宿主没有 webServer 时不许崩 ==');
  {
    /* cordis 里访问 ctx.webServer 这个**动作本身**就可能抛（未 inject）。
       用 getter 模拟这种抛出，验证 apply 里用 try/catch 包住取值是必要的。 */
    const ctxNoWeb = {
      effect() { return () => {} },
      llm: { listProviders: () => [] },
      get webServer() { throw new Error('cannot get property "webServer" without inject') },
    };
    let threw = null;
    try { mod.apply(ctxNoWeb, {}) } catch (e) { threw = e }
    ok(threw === null, '★ 取 ctx.webServer 抛错时 apply 不崩（降级为仅 CLI）',
      threw && String(threw.message).slice(0, 120));
  }
  {
    /* 完全没有 webServer 属性（不是抛错，是 undefined） */
    const ctxUndef = { effect() { return () => {} }, llm: {} };
    let threw = null;
    try { mod.apply(ctxUndef, {}) } catch (e) { threw = e }
    ok(threw === null, 'ctx.webServer 为 undefined 时 apply 不崩',
      threw && String(threw.message).slice(0, 120));
  }

  /* ---- 5. 清理钩子 ---- */
  console.log('== 5. 卸载钩子 ==');
  ok(cleanups.length >= 1, '注册了卸载清理函数（实际 ' + cleanups.length + ' 个）');
  let cleanThrew = null;
  for (const fn of cleanups) { try { fn() } catch (e) { cleanThrew = e } }
  ok(cleanThrew === null, '执行清理函数不抛错', cleanThrew && String(cleanThrew.message).slice(0, 120));

  /* ---- 6. ★ 查询状态不得启动浏览器 ----
   * Windows 上 `chrome.exe --version` 会启动一个完整浏览器（实测 10 个进程、
   * 且不退出），而 status() 被 UI 每 3 秒调一次 → 每 3 秒弹一堆窗口。
   * 这是 2026-10-31 用户报「装了插件就一直在弹窗」的真因。
   * 用「进程数不变」作为回归闸门。 */
  console.log('== 6. 查询状态不得启动浏览器 ==');
  if (process.platform === 'win32') {
    const countBrowsers = () => {
      try {
        const out = require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command',
          "(Get-Process msedge,chrome -ErrorAction SilentlyContinue | Measure-Object).Count"],
          { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
        return Number(String(out).trim()) || 0;
      } catch { return -1 }
    };
    const c0 = countBrowsers();
    for (let i = 0; i < 3; i++) await callRoute(H, 'GET', '/api/cx-learn/status');
    await callRoute(H, 'GET', '/api/cx-learn/health');
    await callRoute(H, 'GET', '/api/cx-learn/browsers');
    const c1 = countBrowsers();
    ok(c0 >= 0 && c1 === c0,
      '★ 连查 3 次状态后浏览器进程数不变（' + c0 + ' → ' + c1 + '）—— --version 不得启动浏览器');
  } else {
    ok(true, '非 Windows 平台跳过（--version 在 POSIX 上是正常行为）');
  }

  /* ---- 7. ★ 预留的 AI 答题接口：存在、形状固定、当前不答题 ----
   * 主人要求「只给个接口，以后再用」：路径与响应形状现在就要钉住，
   * 免得以后实现时又改一次契约；同时确认它不会偷偷调模型答题。 */
  console.log('== 7. 预留 AI 答题接口（D-015）==');
  const askOk = await callRoute(H, 'POST', '/api/cx-learn/ask', { question: '1+1=?', options: ['1', '2'] });
  ok(askOk.code === 200 && askOk.json && askOk.json.ok === false, '★ POST /ask 存在且当前不答题（ok:false）');
  ok(askOk.json && askOk.json.code === 'AI_ANSWER_DISABLED', '★ /ask 固定返回 code=AI_ANSWER_DISABLED');
  ok(askOk.json && !('answer' in askOk.json), '★ /ask 不返回 answer（现在不答题）');
  const askBad = await callRoute(H, 'POST', '/api/cx-learn/ask', {});
  ok(askBad.code === 400, '★ /ask 缺 question 与 image 时 400（契约已校验，实际 ' + askBad.code + '）');

  return finish();
}

function finish() {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch (_) { /* ignore */ }
  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    return 1;
  }
  console.log('== 全部通过 ==');
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('测试自身出错：' + ((e && e.stack) || e));
  process.exit(2);
});
