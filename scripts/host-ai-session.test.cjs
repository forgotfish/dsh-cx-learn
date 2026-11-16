#!/usr/bin/env node
/* ============================================================================
 * host-ai-session.test.cjs — /llm-ask 会话窗口通道（v2，task-10）
 * ============================================================================
 * 直接 import ../index.js 拿导出的纯函数/生命周期函数，用 mock ctx 断言：
 *   · extractAssistantText 的取值规则（取最后一条 assistant/message、maxSeq）
 *   · ensureQaSession / askViaSession 的 create → prompt → wait 链路
 *   · 错误码 SESSION_UNAVAILABLE / LLM_TIMEOUT / LLM_EMPTY
 *   · resetQaSession 之后下一次 askViaSession 会重新 create
 *
 * 用法：node scripts/host-ai-session.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// index.js 在 import 时读 DSH_HOME 决定 STATE 目录，先指到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-qasess-'));
process.env.DSH_HOME = TMP;

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

const rec = (type, seq, content) => ({ event: { type, seq, data: { message: { content } } } });

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);
  const { extractAssistantText, ensureQaSession, askViaSession, resetQaSession } = mod;

  ok(typeof extractAssistantText === 'function', '导出了 extractAssistantText');
  ok(typeof ensureQaSession === 'function', '导出了 ensureQaSession');
  ok(typeof askViaSession === 'function', '导出了 askViaSession');
  ok(typeof resetQaSession === 'function', '导出了 resetQaSession');

  console.log('== 1. extractAssistantText 单条 ==');
  {
    const r = extractAssistantText([rec('assistant/message', 1, [{ type: 'text', text: 'A' }])]);
    ok(r.text === 'A', '★ 单条文本取到（实际 "' + r.text + '"）');
    ok(r.maxSeq === 1, 'maxSeq = 1（实际 ' + r.maxSeq + '）');
  }

  console.log('== 2. extractAssistantText 多条取最后一条 ==');
  {
    const r = extractAssistantText([
      rec('assistant/message', 1, [{ type: 'text', text: '早' }]),
      { event: { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'x' }] } } } },
      rec('assistant/message', 3, [{ type: 'text', text: '晚' }]),
    ]);
    ok(r.text === '晚', '★ 取最后一条 assistant/message（实际 "' + r.text + '"）');
    ok(r.maxSeq === 3, 'maxSeq = 3（实际 ' + r.maxSeq + '）');
  }

  console.log('== 3. extractAssistantText 无 text 块 / content 非数组 ==');
  {
    const r1 = extractAssistantText([rec('assistant/message', 5, [{ type: 'thinking', text: '想' }])]);
    ok(r1.text === '', '只有非 text 块 → 空串（实际 "' + r1.text + '"）');
    const r2 = extractAssistantText([{ event: { type: 'assistant/message', seq: 6, data: { message: {} } } }]);
    ok(r2.text === '', '★ content 缺失 → 空串');
    const r3 = extractAssistantText([{ event: { type: 'assistant/message', seq: 7, data: { message: { content: 'not-array' } } } }]);
    ok(r3.text === '', 'content 非数组 → 空串');
  }

  console.log('== 4. extractAssistantText 空 records ==');
  {
    const r0 = extractAssistantText([]);
    ok(r0.text === '' && r0.maxSeq === 0, '★ 空 records → {text:"",maxSeq:0}');
    const rn = extractAssistantText(null);
    ok(rn.text === '' && rn.maxSeq === 0, 'null → 安全回空');
  }

  console.log('== 5. ensureQaSession 无 sessionController → SESSION_UNAVAILABLE ==');
  {
    let code = '';
    try { await ensureQaSession({}, { ai: {} }); } catch (e) { code = e.code; }
    ok(code === 'SESSION_UNAVAILABLE', '★ 抛 code=SESSION_UNAVAILABLE（实际 ' + code + '）');
  }

  console.log('== 6. askViaSession mock：拿到文本 + afterSeq 递增 ==');
  {
    resetQaSession();
    const waits = [];
    let creates = 0;
    const ctx = {
      sessionController: {
        create: async () => { creates++; return { sessionId: 'sess-1' }; },
        state: () => ({}),
        prompt: async () => { /* ok */ },
        wait: async (args) => {
          waits.push(args);
          const base = args.afterSeq || 0;
          return {
            reason: 'done',
            output: { records: [rec('assistant/message', base + 10, [{ type: 'text', text: base === 0 ? '第一批' : '第二批' }])] },
          };
        },
      },
    };
    const cfg = { ai: {} };
    const r1 = await askViaSession(ctx, cfg, { prompt: 'q1', timeoutMs: 1000 });
    ok(r1.text === '第一批', '★ 第一次拿到文本（实际 "' + r1.text + '"）');
    ok(r1.sessionId === 'sess-1', 'sessionId 透出（实际 ' + r1.sessionId + '）');
    ok(waits[0].afterSeq === 0, '★ 首次 wait afterSeq=0（实际 ' + waits[0].afterSeq + '）');
    const r2 = await askViaSession(ctx, cfg, { prompt: 'q2', timeoutMs: 1000 });
    ok(r2.text === '第二批', '第二次拿到文本（实际 "' + r2.text + '"）');
    ok(waits[1].afterSeq === 10, '★ 第二次 wait afterSeq=上次 maxSeq=10（实际 ' + waits[1].afterSeq + '）');
    ok(creates === 1, '会话复用，只 create 一次（实际 ' + creates + '）');
  }

  console.log('== 7. wait 返回 reason:"timeout" → LLM_TIMEOUT ==');
  {
    resetQaSession();
    const ctx = {
      sessionController: {
        create: async () => ({ sessionId: 'sess-to' }),
        state: () => ({}),
        prompt: async () => {},
        wait: async () => ({ reason: 'timeout', output: { records: [] } }),
      },
    };
    let code = '';
    try { await askViaSession(ctx, { ai: {} }, { prompt: 'q', timeoutMs: 10 }); } catch (e) { code = e.code; }
    ok(code === 'LLM_TIMEOUT', '★ 抛 code=LLM_TIMEOUT（实际 ' + code + '）');
  }

  console.log('== 8. 空回复 → LLM_EMPTY ==');
  {
    resetQaSession();
    const ctx = {
      sessionController: {
        create: async () => ({ sessionId: 'sess-empty' }),
        state: () => ({}),
        prompt: async () => {},
        wait: async () => ({ reason: 'done', output: { records: [] } }),
      },
    };
    let code = '';
    try { await askViaSession(ctx, { ai: {} }, { prompt: 'q', timeoutMs: 10 }); } catch (e) { code = e.code; }
    ok(code === 'LLM_EMPTY', '★ 抛 code=LLM_EMPTY（实际 ' + code + '）');
  }

  console.log('== 9. resetQaSession 后再次 askViaSession 重新 create ==');
  {
    resetQaSession();
    let creates = 0;
    const ctx = {
      sessionController: {
        create: async () => { creates++; return { sessionId: 'sess-' + creates }; },
        state: () => ({}),
        prompt: async () => {},
        wait: async () => ({ reason: 'done', output: { records: [rec('assistant/message', 1, [{ type: 'text', text: 'ok' }])] } }),
      },
    };
    await askViaSession(ctx, { ai: {} }, { prompt: 'a', timeoutMs: 10 });
    ok(creates === 1, '首次 create 一次');
    resetQaSession();
    await askViaSession(ctx, { ai: {} }, { prompt: 'b', timeoutMs: 10 });
    ok(creates === 2, '★ reset 后再次 create，计数 +1（实际 ' + creates + '）');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 ==');
    process.exit(1);
  }
  console.log('== 全部通过 ==');
})();
