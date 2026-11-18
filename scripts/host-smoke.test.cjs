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
/* ★ D-031：浏览器层状态文件默认在仓库 engine/.state/ 下，测试里指到临时目录做隔离 */
const TMP_BROWSER_STATE = path.join(TMP_HOME, 'browser.json');
process.env.CX_BROWSER_STATE_FILE = TMP_BROWSER_STATE;

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

/** 与 callRoute 同，但可自定义请求头（用于 /llm-ask 的 x-cx-token 校验）。 */
async function callRouteH(handler, method, url, body, headers) {
  const res = fakeRes();
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method, url, headers: headers || {},
    async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text) },
  };
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res._out.body) } catch (_) { json = null }
  return { code: res._out.code, json, raw: res._out.body };
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

  /* ---- 3c. ★ status() 在 child === null 时仍返回 200（D-031 后判据升级） ----
   * 插件重启后 child 为 null，但引擎可能还在跑。判据从「pid 活着」升级为
   * 「pid 活着 + 浏览器层心跳的 ownerPid 匹配且新鲜」，见 D-031。 */
  console.log('== 3c. status() 在 child 为 null 时不许抛 ==');
  {
    const stPath = path.join(TMP_HOME, 'cx-learn', 'state.json');
    fs.mkdirSync(path.dirname(stPath), { recursive: true });
    fs.writeFileSync(stPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const s2 = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(s2.code === 200 && s2.json && s2.json.ok === true, '★ 内核 pid 活着但 child 为 null 时 /status 仍 200（实际 ' + s2.code + '）');
    ok(s2.json && s2.json.running === false, '  ↳ 仅 pid 无心跳证据 → running=false（D-031）');
    ok(s2.json && s2.json.pid === null, '  ↳ pid 字段安全降级为 null');
    /* 补上匹配的新鲜心跳 → 认出「引擎还在跑」 */
    fs.writeFileSync(TMP_BROWSER_STATE, JSON.stringify({
      alive: true, port: 1, pid: process.pid, ownerPid: process.pid,
      heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const s2b = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(s2b.code === 200 && s2b.json && s2b.json.running === true, '  ↳ pid + 匹配的新鲜心跳 → running=true');
    try { fs.unlinkSync(TMP_BROWSER_STATE) } catch { /* ignore */ }
    fs.unlinkSync(stPath);
    const s3 = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(s3.code === 200 && s3.json && s3.json.running === false, '  ↳ 清掉 state.json 后 running 回到 false');
  }

  /* ---- 3d. ★ D-023：引擎自终止时 clearStatePid() 清掉死 pid ----
   * 根因：start() 写 pid、只有 stop() 删 pid，自终止的运行留下死 pid；
   * 被系统复用后 running() 误判在跑 → 「开始」假绿灯。exit 处理器现调 clearStatePid()。 */
  console.log('== 3d. D-023 引擎自终止清 pid ==');
  {
    const stPath = path.join(TMP_HOME, 'cx-learn', 'state.json');
    fs.mkdirSync(path.dirname(stPath), { recursive: true });
    ok(typeof mod.clearStatePid === 'function', '导出 clearStatePid()');
    fs.writeFileSync(stPath, JSON.stringify({ phase: 'stopped', pid: 999999, startedAt: Date.now() }));
    mod.clearStatePid();
    const after = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    ok(after.pid === undefined, '★ 清前有 pid → 清后无 pid（实际 ' + JSON.stringify(after) + '）');
    ok(after.phase === 'stopped', '  ↳ 不误伤其它字段（phase 保留）');
    // 幂等：没有 pid 时再调一次不报错、不改内容
    let threw = false
    try { mod.clearStatePid() } catch { threw = true }
    ok(!threw, '  ↳ 幂等：无 pid 时再调不抛');
    fs.unlinkSync(stPath);
  }

  /* ---- 3e. ★ D-024：「开始」假绿灯真根因 —— 只有看课任务才算 running ---- */
  console.log('== 3e. D-024 只有看课任务才登记为在跑 ==');
  {
    ok(typeof mod.isWatchRun === 'function', '导出 isWatchRun()');
    ok(mod.isWatchRun(['--login']) === false, '★ --login 不算看课任务（登录时 running() 应为 false）');
    ok(mod.isWatchRun(['--check-login']) === false, '  ↳ --check-login（预检）不算');
    ok(mod.isWatchRun(['--list-courses']) === false, '  ↳ --list-courses（读课程）不算');
    ok(mod.isWatchRun(['--self-test']) === false, '  ↳ --self-test 不算');
    ok(mod.isWatchRun(['--mode=continue_chapters', '--max-sections=5', '--course-url=x']) === true,
      '★ 正常看课参数算看课任务（登录时才是 false）');
  }

  /* ---- 3f. ★ D-030 / D-031：破坏性测试暴露的两处健壮性问题 ---- */
  console.log('== 3f. state.json 坏值不 500；假 pid 不误判 running ==');
  {
    const stPath = path.join(TMP_HOME, 'cx-learn', 'state.json');
    fs.mkdirSync(path.dirname(stPath), { recursive: true });

    /* D-030：state.json 内容为 null → 以前 readJson 返回 null，.pid 抛 TypeError → 500 */
    fs.writeFileSync(stPath, 'null');
    const rNull = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(rNull.code === 200, '★ state.json = null → /status 仍 200（实际 ' + rNull.code + '）');
    ok(rNull.json && rNull.json.ok === true, '  ↳ 返回 ok:true');
    ok(rNull.json && rNull.json.state && typeof rNull.json.state === 'object' && !Array.isArray(rNull.json.state),
      '  ↳ state 归一化成对象（实际 ' + JSON.stringify(rNull.json && rNull.json.state) + '）');

    /* 其它坏值同样不许 500 */
    for (const bad of ['"str"', '123', 'false']) {
      fs.writeFileSync(stPath, bad);
      const r1 = await callRoute(H, 'GET', '/api/cx-learn/status');
      ok(r1.code === 200, '★ state.json = ' + bad + ' → /status 200（实际 ' + r1.code + '）');
    }

    /* D-031：pid 指向「真实存在但与我们无关」的进程 → 不许判成在跑。
       用本进程 pid 模拟：它一定活着，但 browser.json 里没有匹配的 ownerPid 心跳。 */
    fs.writeFileSync(stPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const rAlive = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(rAlive.code === 200 && rAlive.json && rAlive.json.running === false,
      '★ 活着的无关 pid 不再误判 running（实际 ' + JSON.stringify(rAlive.json && rAlive.json.running) + '）');
    ok(rAlive.json && rAlive.json.pid === null, '  ↳ pid 字段仍安全降级为 null');

    const hAlive = await callRoute(H, 'GET', '/api/cx-learn/health');
    ok(hAlive.code === 200 && hAlive.json && hAlive.json.task && hAlive.json.task.running === false,
      '★ /health 的 task.running 同样不误判');

    /* 反例：ownerPid 与 pid 一致且心跳新鲜 → 必须仍然认出「在跑」 */
    const brPath = TMP_BROWSER_STATE;
    fs.mkdirSync(path.dirname(brPath), { recursive: true });
    fs.writeFileSync(brPath, JSON.stringify({
      alive: true, port: 1234, pid: process.pid, ownerPid: process.pid,
      heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const rHbd = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(rHbd.code === 200 && rHbd.json && rHbd.json.running === true,
      '★ pid + 匹配的新鲜心跳 → 仍判在跑（实际 ' + JSON.stringify(rHbd.json && rHbd.json.running) + '）');

    /* 心跳过期 → 不再算在跑 */
    fs.writeFileSync(brPath, JSON.stringify({
      alive: true, port: 1234, pid: process.pid, ownerPid: process.pid,
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }));
    const rStale = await callRoute(H, 'GET', '/api/cx-learn/status');
    ok(rStale.code === 200 && rStale.json && rStale.json.running === false,
      '★ 心跳过期（10 分钟前）→ 不算在跑（实际 ' + JSON.stringify(rStale.json && rStale.json.running) + '）');

    try { fs.unlinkSync(brPath) } catch { /* ignore */ }
    try { fs.unlinkSync(stPath) } catch { /* ignore */ }
  }


  /* ---- 3g. ★ D-032：会话闲置结束不许谎报「扫码被中断」 ---- */
  console.log('== 3g. D-032 登录态文案按真实原因 ==');
  {
    const sesPath = path.join(TMP_HOME, 'cx-learn', 'session.json');
    fs.mkdirSync(path.dirname(sesPath), { recursive: true });
    /* 闲置超时正常结束：profile 目录仍在，旧代码会报 stale「上次扫码流程被中断」 */
    fs.writeFileSync(sesPath, JSON.stringify({
      active: false, reason: 'idle_timeout', closedAt: new Date().toISOString(),
      loginVerified: true, port: null, kernelPid: null,
    }));
    const r1 = await callRoute(H, 'GET', '/api/cx-learn/login-state');
    ok(r1.code === 200, '/login-state 200（实际 ' + r1.code + '）');
    ok(r1.json && r1.json.state === 'idle', '★ idle_timeout → state=idle（实际 ' + (r1.json && r1.json.state) + '）');
    ok(r1.json && /闲置/.test(r1.json.hint || ''), '★ 文案点明「闲置超时」而不是「扫码被中断」（实际 ' + (r1.json && r1.json.hint) + '）');

    /* 手动结束 */
    fs.writeFileSync(sesPath, JSON.stringify({ active: false, reason: 'user', loginVerified: true }));
    const r2 = await callRoute(H, 'GET', '/api/cx-learn/login-state');
    ok(r2.json && r2.json.state === 'idle', '★ reason=user → state=idle（实际 ' + (r2.json && r2.json.state) + '）');

    /* 真·扫码被中断（没有任何会话原因）→ 仍报 stale */
    try { fs.unlinkSync(sesPath) } catch { /* ignore */ }
    const profDir = path.join(require('node:os').tmpdir(), 'cx-learn-ephemeral', 'session');
    let madeDir = false;
    try { fs.mkdirSync(profDir, { recursive: true }); madeDir = true } catch { /* ignore */ }
    const r3 = await callRoute(H, 'GET', '/api/cx-learn/login-state');
    ok(r3.json && (r3.json.state === 'stale' || r3.json.state === 'idle'),
      '★ 无会话记录时 state 合法（实际 ' + (r3.json && r3.json.state) + '）');
    if (madeDir) { try { fs.rmSync(profDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }


  /* ---- 3h. ★ D-033：AI 会话通道自检端点 ---- */
  console.log('== 3h. D-033 /ai-selftest 闸门与真路径 ==');
  {
    /* ① AI 未启用 → 必须 403，不许触发任何模型调用 */
    const off = await callRoute(H, 'POST', '/api/cx-learn/ai-selftest', {});
    ok(off.code === 403, '★ ai.enabled=false → 403（实际 ' + off.code + '）');
    ok(off.json && off.json.code === 'AI_ANSWER_DISABLED', '  ↳ 返回 AI_ANSWER_DISABLED');

    /* ② 启用 AI 后，本假宿主没有 sessionController → 503 + steps 报出缺哪个服务
          （证明它真的走了 ensureQaSession 真路径，不是空壳） */
    await callRoute(H, 'POST', '/api/cx-learn/config', { ai: { enabled: true } });
    const on = await callRoute(H, 'POST', '/api/cx-learn/ai-selftest', { prompt: 'ping' });
    ok(on.code === 503, '★ 缺 sessionController → 503（实际 ' + on.code + '）');
    ok(on.json && on.json.code === 'SESSION_UNAVAILABLE', '  ↳ code=SESSION_UNAVAILABLE（实际 ' + (on.json && on.json.code) + '）');
    ok(on.json && Array.isArray(on.json.steps) && on.json.steps.length >= 1, '  ↳ 带 steps 便于排障');
    ok(on.json && on.json.steps && on.json.steps[0] && on.json.steps[0].sessionController === false,
      '  ↳ steps[0].sessionController=false（确认探到服务缺失）');

    /* ③ 复原 */
    await callRoute(H, 'POST', '/api/cx-learn/config', { ai: { enabled: false } });
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

  /* ---- 8. ★ AI 答题实现：/llm-ask 令牌校验 + spawn env 注入 ----
   * /llm-ask 只服务引擎子进程，凭每轮 spawn 新生成的 x-cx-token 校验；
   * 未 spawn 过（_askToken 为空）或令牌不符，一律 401，绝不进模型调用。
   * spawn env：enabled=false 时**一条 CX_LLM_* 都不许有**（引擎靠
   * `CX_LLM_ASK_URL || CX_LLM_MODEL` 判 useAi，多设一条引擎就会以为自己能答题）。 */
  console.log('== 8. /llm-ask 令牌 + spawn env 注入 ==');
  const noTok = await callRoute(H, 'POST', '/api/cx-learn/llm-ask', { prompt: '1+1=?' });
  ok(noTok.code === 401, '★ /llm-ask 无 token → 401（实际 ' + noTok.code + '）');
  const wrongTok = await callRouteH(H, 'POST', '/api/cx-learn/llm-ask', { prompt: '1+1=?' }, { 'x-cx-token': 'deadbeef' });
  ok(wrongTok.code === 401, '★ /llm-ask 错 token → 401（实际 ' + wrongTok.code + '）');

  ok(typeof mod.buildSpawnEnv === 'function', '★ 导出 buildSpawnEnv()（spawn env 可单测）');

  const cfgPath = path.join(TMP_HOME, 'cx-learn', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  // (a) enabled=false：不含任何 CX_LLM_ / CX_AI_
  fs.writeFileSync(cfgPath, JSON.stringify({ ai: { enabled: false } }));
  {
    const envOff = mod.buildSpawnEnv(['--mode=continue_chapters', '--course-url=http://example.com']);
    const llmKeys = Object.keys(envOff).filter((k) => /^CX_LLM_/.test(k));
    const aiKeys = Object.keys(envOff).filter((k) => /^CX_AI_/.test(k));
    ok(llmKeys.length === 0, '★ ai.enabled=false 时 spawn env 不含任何 CX_LLM_（实际 ' + JSON.stringify(llmKeys) + '）');
    ok(aiKeys.length === 0, '★ ai.enabled=false 时 spawn env 不含任何 CX_AI_（实际 ' + JSON.stringify(aiKeys) + '）');
    ok(!('CX_LLM_ASK_URL' in envOff) && !('CX_LLM_MODEL' in envOff),
      '★ 引擎 useAi 判据（CX_LLM_ASK_URL || CX_LLM_MODEL）均未设置');
  }
  // (b) enabled=true：六条变量齐全且取值正确
  fs.writeFileSync(cfgPath, JSON.stringify({
    ai: { enabled: true, provider: 'xlapi', model: 'deepseek-v4.1-flash', dryRun: true, vision: false, timeoutMs: 15000 },
  }));
  process.env.CX_PLUGIN_PORT = '12345';
  {
    const envOn = mod.buildSpawnEnv(['--mode=continue_chapters']);
    ok(envOn.CX_LLM_ASK_URL === 'http://127.0.0.1:12345/api/cx-learn/llm-ask',
      '★ 启用后 CX_LLM_ASK_URL = http://127.0.0.1:<port>/api/cx-learn/llm-ask（实际 ' + envOn.CX_LLM_ASK_URL + '）');
    ok(/^[0-9a-f]{32}$/.test(String(envOn.CX_LLM_ASK_TOKEN || '')),
      '★ CX_LLM_ASK_TOKEN 是 32 位 hex（实际 ' + envOn.CX_LLM_ASK_TOKEN + '）');
    ok(envOn.CX_LLM_PROVIDER === 'xlapi', '★ CX_LLM_PROVIDER = 配置 provider（实际 ' + envOn.CX_LLM_PROVIDER + '）');
    ok(envOn.CX_LLM_MODEL === 'deepseek-v4.1-flash', '★ CX_LLM_MODEL = 配置 model（实际 ' + envOn.CX_LLM_MODEL + '）');
    ok(envOn.CX_AI_DRYRUN === '1', '★ CX_AI_DRYRUN = 1（dryRun:true）');
    ok(envOn.CX_AI_VISION === '0', '★ CX_AI_VISION = 0（vision:false）');
  }
  delete process.env.CX_PLUGIN_PORT;

  // == 9. LLM 流解析与路由解析（不用真模型，用文档记载的 chunk 形状）==
  console.log('== 9. LLM 流解析与路由解析 ==');
  {
    const { collectStream, resolveRoute } = mod;

    // 9.1 纯 text-delta 累加
    async function* genA() {
      yield { type: 'text-delta', index: 0, text: '答案：' };
      yield { type: 'text-delta', index: 0, text: 'B' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '答案：B' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const rA = await collectStream(genA());
    ok(rA.text === '答案：B', '★ text-delta 逐块累加得到「答案：B」（实际 ' + JSON.stringify(rA.text) + '）');
    ok(rA.finish && rA.finish.kind === 'stop', '★ finish.reason.kind 被读到（stop）');

    // 9.2 没有 delta 时用 block-end 的完整文本兜底
    async function* genB() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'C' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const rB = await collectStream(genB());
    ok(rB.text === 'C', '★ 无 text-delta 时用 block-end 文本兜底（实际 ' + JSON.stringify(rB.text) + '）');

    // 9.3 空流不抛错、返回空串
    async function* genC() { /* 什么都不 yield */ }
    const rC = await collectStream(genC());
    ok(rC.text === '' && rC.finish === null, '★ 空流返回空串且 finish=null（不抛错）');

    // 9.4 finish.kind=error → 抛带 code 的错误（DSH 自己不 throw，必须我们抛）
    async function* genD() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: '没有 key' } } };
    }
    let errD = null;
    try { await collectStream(genD()); } catch (e) { errD = e; }
    ok(!!errD && errD.code === 'MISSING_CREDENTIAL', '★ finish=error 时抛出 code=MISSING_CREDENTIAL（实际 ' + (errD && errD.code) + '）');

    // 9.5 finish.kind=aborted 也要抛（否则会当成正常空回答）
    async function* genE() { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'TIMEOUT' } } }; }
    let errE = null;
    try { await collectStream(genE()); } catch (e) { errE = e; }
    ok(!!errE, '★ finish=aborted 也抛错（不冒充正常空回答）');

    // 9.6 resolveRoute：provider 空 → 取宿主第一个 provider
    const fakeLlm = {
      async listProviders() { return [{ id: 'xlapi' }, { id: 'dsh3' }]; },
      async listModels(p) { return p === 'xlapi' ? [{ id: 'deepseek-v4.1-flash' }] : []; },
    };
    const route1 = await resolveRoute(fakeLlm, '', '');
    ok(route1.provider === 'xlapi' && route1.model === 'deepseek-v4.1-flash',
      '★ 留空 provider/model → 自动取宿主首个 provider 与模型（实际 ' + route1.provider + '/' + route1.model + '）');

    // 9.7 占位 'host' 与留空等价（UI 默认值就是 host）
    const route2 = await resolveRoute(fakeLlm, 'host', '');
    ok(route2.provider === 'xlapi', '★ provider 填占位 host 时也能解析出真实 provider（实际 ' + route2.provider + '）');

    // 9.8 显式给了就不覆盖
    const route3 = await resolveRoute(fakeLlm, 'dsh3', 'my-model');
    ok(route3.provider === 'dsh3' && route3.model === 'my-model', '★ 显式 provider/model 不被自动探测覆盖');

    // 9.9 探测失败返回空串（由 doStream 报 LLM_UNAVAILABLE），不抛错
    const deadLlm = { async listProviders() { throw new Error('boom'); }, async listModels() { throw new Error('boom'); } };
    let errF = null;
    let route4 = null;
    try { route4 = await resolveRoute(deadLlm, '', ''); } catch (e) { errF = e; }
    ok(!errF && route4 && route4.provider === '' && route4.model === '',
      '★ provider 探测抛错时返回空串而不抛错（交给 doStream 报 LLM_UNAVAILABLE）');
  }

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
