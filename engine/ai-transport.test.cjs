#!/usr/bin/env node
/* ============================================================================
 * ai-transport.test.cjs —— 引擎→宿主回调（/llm-ask）通路的破坏性测试
 *
 * 为什么要有：AI 会话通道挂了**绝不能拖垮看课**。这条链是
 *   引擎 _aiTransport → HTTP /llm-ask → 宿主 askViaSession → DSH 会话窗口
 * 前面三处（宿主侧）已经连炸两次，这里补最后一环：**引擎收到异常响应时的行为**。
 *
 * 覆盖（起真 HTTP server，不是 mock fetch）：
 *   1) 503            → 不抛，返回失败信号（调用方可回退逐题）
 *   2) 200 但 ok:false → 不抛，返回失败信号
 *   3) 200 正常文本    → 正常返回文本
 *   4) 200 但非 JSON   → 不抛
 *   5) 连接被拒/端口空 → 不抛
 *
 * 用法：node engine/ai-transport.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const http = require('node:http');
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const cfg = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
});
const AI_CFG = Object.assign({}, cfg, { ai: Object.assign({}, cfg.ai, { enabled: true, dryRun: false, maxRetries: 0, timeoutMs: 3000 }) });

/* 极简假 adapter：本测试不碰浏览器，全部方法空实现 */
const fakeAdapter = {
  engine: 'fake',
  async ensureBrowser() { return {}; },
  async navigate() {},
  async getCurrentUrl() { return ''; },
  getTargetId() { return 't'; },
  async getFrameDocuments() { return []; },
  async getAllCookies() { return null; },
};

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const ITEM = {
  id: 'q1',
  type: 'single',
  question: '1+1 等于几？',
  options: [{ letter: 'A', label: '1' }, { letter: 'B', label: '2' }],
};

(async () => {
  /* ---------- 1. 503 ---------- */
  console.log('== 1. /llm-ask 返回 503 → 不抛，给出失败信号 ==');
  {
    const { srv, port } = await startServer((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'SESSION_UNAVAILABLE', error: 'sessionController 不可用' }));
    });
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:' + port + '/api/cx-learn/llm-ask';
    process.env.CX_LLM_ASK_TOKEN = 't';
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    let threw = false, r = null;
    try { r = await m.askAIBatch([ITEM]); } catch (e) { threw = true; }
    ok(!threw, '★ 503 时 askAIBatch 不抛错');
    ok(!r || r.ok !== true, '★ 返回失败信号（null 或 ok:false），调用方可回退逐题（实际 ' + JSON.stringify(r && r.ok) + '）');
    let t2 = false;
    try { await m.askAI(ITEM.question, ITEM.options, '', 'chapter_work'); } catch (e) { t2 = true; }
    ok(!t2, '★ 逐题 askAI 同样不抛（返回 null/失败对象）');
    srv.close();
  }

  /* ---------- 2. 200 但 ok:false ---------- */
  console.log('== 2. 200 + {ok:false} → 不抛，判为失败 ==');
  {
    const { srv, port } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '会话应答超时' }));
    });
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:' + port + '/x';
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    let threw = false, r = null;
    try { r = await m.askAIBatch([ITEM]); } catch { threw = true; }
    ok(!threw, '★ ok:false 不抛错');
    ok(!r || r.ok !== true, '★ 判为失败（实际 ' + JSON.stringify(r && r.ok) + '）');
    srv.close();
  }

  /* ---------- 3. 200 正常 ---------- */
  console.log('== 3. 200 + 正常 JSON → 拿到答案 ==');
  {
    const { srv, port } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: '{"answers":[{"id":"q1","choice":"B"}]}', model: 'm' }));
    });
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:' + port + '/x';
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    const r = await m.askAIBatch([ITEM]);
    ok(r && r.ok === true, '★ 正常返回 ok:true');
    ok(r && Array.isArray(r.answers) && r.answers.length === 1, '★ 解析出 1 条答案');
    ok(r && r.answers && r.answers[0] && r.answers[0].id === 'q1', '★ 答案 id 正确');
    srv.close();
  }

  /* ---------- 4. 200 但非 JSON ---------- */
  console.log('== 4. 200 + 非 JSON 正文 → 不抛 ==');
  {
    const { srv, port } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    });
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:' + port + '/x';
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    let threw = false, r = null;
    try { r = await m.askAIBatch([ITEM]); } catch { threw = true; }
    ok(!threw, '★ 非 JSON 不抛错');
    ok(!r || r.ok !== true, '★ 判为失败');
    srv.close();
  }

  /* ---------- 5. 端口不通 ---------- */
  console.log('== 5. 连接被拒（端口无监听）→ 不抛 ==');
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:9/x';   /* 9 = discard，通常无人监听 */
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    let threw = false, r = null;
    try { r = await m.askAIBatch([ITEM]); } catch { threw = true; }
    ok(!threw, '★ 连接失败不抛错');
    ok(!r || r.ok !== true, '★ 判为失败');
  }

  /* ---------- 6. 没配任何通路 ---------- */
  console.log('== 6. 未配置 CX_LLM_ASK_URL / BASE → 直接 null ==');
  {
    delete process.env.CX_LLM_ASK_URL;
    delete process.env.CX_LLM_BASE;
    delete process.env.CX_LLM_KEY;
    const m = new E.LearnMachine(fakeAdapter, AI_CFG);
    const r = await m.askAIBatch([ITEM]);
    ok(r === null, '★ 无通路时返回 null（零网络开销，实际 ' + JSON.stringify(r) + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
