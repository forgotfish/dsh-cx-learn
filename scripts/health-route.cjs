#!/usr/bin/env node
/* ============================================================================
 * health-route.cjs — 真起一个 HTTP 服务验证 /api/cx-learn/health 路由
 * ============================================================================
 * 为什么不用「直接 import collectHealth」：
 *   index.js 是 ESM 且依赖 cordis 的 ctx / 宿主 webServer 服务，脱离宿主 import
 *   会连带拉起一堆宿主依赖。这里改用**最小复刻**的方式验证路由契约：
 *   把 index.js 里 /health 分支的写法原样搬过来，配一个真 HTTP server，
 *   断言外部调用拿到的 JSON 符合契约 §3.2，且异常时是 200 + ok:false。
 *
 * 注意：这是「路由层契约」测试，不覆盖 collectHealth 内部的字段采集
 *       （那部分由 scripts/health-shape.cjs 覆盖）。
 *
 * 用法：node scripts/health-route.cjs
 * ==========================================================================*/
'use strict';

const http = require('node:http');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* ---- 与 index.js /health 分支一致的写法（异常折叠成 200 + ok:false）---- */
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(b.length),
    'cache-control': 'no-store',
  });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const path = u.pathname.replace(/^\/api\/cx-learn/, '') || '/';
  if (path === '/health' && req.method === 'GET') {
    try {
      if (process.env.__CX_FORCE_THROW === '1') throw new Error('模拟采集异常');
      return sendJson(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        engine: { ready: true, path: '/x/engine.js' },
        chromium: { path: '/x/chrome', ready: true, version: 'Chrome/158.0.8122.0' },
        browser: null,
        task: { running: false, pid: null, startedAt: null },
        home: '/x/cx-learn',
      });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        at: new Date().toISOString(),
        error: String(e?.message ?? e).slice(0, 200),
      });
    }
  }
  return sendJson(res, 404, { ok: false, error: 'unknown' });
});

function get(port, p) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    http.get('http://127.0.0.1:' + port + p, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(t);
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw) } catch { /* 保持 null */ }
        resolve({ status: res.statusCode, raw, json, headers: res.headers });
      });
    }).on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

(async () => {
  console.log('== /health 路由契约 ==');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('  监听 127.0.0.1:' + port);

  const r = await get(port, '/api/cx-learn/health');
  ok(r.status === 200, 'HTTP 200', String(r.status));
  ok(r.json && r.json.ok === true, 'ok === true');
  ok(typeof r.json.at === 'string' && !Number.isNaN(Date.parse(r.json.at)), 'at 是 ISO 时间戳');
  ok(r.json.engine && typeof r.json.engine.ready === 'boolean', 'engine.ready 是布尔');
  ok(r.json.chromium && typeof r.json.chromium.ready === 'boolean', 'chromium.ready 是布尔');
  ok(r.json.browser === null || typeof r.json.browser === 'object', 'browser 是对象或 null');
  ok(r.json.task && typeof r.json.task.running === 'boolean', 'task.running 是布尔');
  ok(typeof r.json.home === 'string', 'home 是字符串');
  ok(r.headers['cache-control'] === 'no-store', '带 cache-control: no-store（监测不读缓存）');

  /* 契约 §3.2 明确要求：异常也必须是 200 */
  process.env.__CX_FORCE_THROW = '1';
  const bad = await get(port, '/api/cx-learn/health');
  delete process.env.__CX_FORCE_THROW;
  ok(bad.status === 200, '★ 内部异常时 HTTP 仍是 200（监测脚本靠体里的 ok 判断）', String(bad.status));
  ok(bad.json && bad.json.ok === false, '异常时 ok === false');
  ok(bad.json && typeof bad.json.error === 'string' && bad.json.error.length > 0, '异常时带 error 文案');
  ok(!bad.json.engine, '异常时不返回半截字段（避免前端读 undefined）');

  const nf = await get(port, '/api/cx-learn/nonexistent');
  ok(nf.status === 404, '未知路径仍返回 404（不被 /health 吞掉）', String(nf.status));

  server.close();
  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
})();
