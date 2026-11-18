#!/usr/bin/env node
'use strict';
/* ============================================================================
 * ai-session-chaos.test.cjs —— AI 会话通道（v2）破坏性测试
 *
 * 为什么单独一个文件：这条链路已经连炸两次（D-034 state() 崩 host、
 * D-035 缺 AbortSignal 503），都是「喂异常形状的 sessionController」才暴露的。
 * 这里把 sessionController 当成不可信的第三方，逐个砸它的失败模式。
 *
 * 覆盖：
 *   · create 抛错 / 返回空对象 / 返回后 prompt 立刻失败
 *   · wait 超时 / 空回复 / 抛错 —— 会话该不该重置
 *   · 并发两路 askViaSession（会不会重复 create 出两个窗口）
 *   · workspaceRegistry 抛错（不该阻断）
 *   · prompt 根本不是函数（服务形状不对）
 * ==========================================================================*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fails.push(msg); console.log('  ✗ ' + msg) }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-ai-chaos-'));
process.env.DSH_HOME = TMP;

const rec = (type, seq, blocks) => ({ event: { type, seq, data: { message: { content: blocks } } } });

/* 可复用的「正常」sessionController 骨架，按需覆盖某个方法 */
function scBase(over) {
  const st = { creates: 0, prompts: 0, waits: 0 };
  const base = {
    create: async () => { st.creates++; return { sessionId: 'sess-' + st.creates } },
    state: () => { throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')") },
    prompt: async () => { st.prompts++ },
    wait: async () => ({ reason: 'done', output: { records: [rec('assistant/message', 1, [{ type: 'text', text: '好' }])] } }),
  };
  const merged = Object.assign({}, base, over || {});
  return { sc: merged, st };
}

(async () => {
  const indexUrl = 'file:///' + path.resolve(__dirname, '..', 'index.js').replace(/\\/g, '/');
  const mod = await import(indexUrl);
  const { askViaSession, ensureQaSession, resetQaSession } = mod;

  /* ---------------------------------------------------------------- 1. create 抛错 */
  console.log('== 1. create() 抛错：向上抛、不缓存、下次能恢复 ==');
  {
    resetQaSession();
    let n = 0;
    const { sc } = scBase({
      create: async () => { n++; if (n === 1) throw new Error('create boom'); return { sessionId: 'sess-ok' } },
    });
    let threw = false;
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch { threw = true }
    ok(threw, '★ create 抛错会向上抛（不吞）');
    const r = await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 });
    eq(r.sessionId, 'sess-ok', '★ 失败后下一次能正常创建并成功');
  }

  /* ---------------------------------------------------------------- 2. create 返回空对象 */
  console.log('== 2. create() 返回空对象（没有 sessionId）==');
  {
    resetQaSession();
    const { sc } = scBase({ create: async () => ({}) });
    let code = '', threw = false;
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch (e) { threw = true; code = e.code || e.message }
    ok(threw, '★ 没有 sessionId 时必须报错，不能带着 undefined 往下走（实际 code=' + code + '）');
  }

  /* ---------------------------------------------------------------- 3. wait 超时 */
  console.log('== 3. wait 超时 → LLM_TIMEOUT，且**不**重置会话 ==');
  {
    resetQaSession();
    let creates = 0;
    let timedOut = true;
    const sc = {
      create: async () => { creates++; return { sessionId: 's' + creates } },
      state: () => { throw new Error('不该调用') },
      prompt: async () => {},
      wait: async () => (timedOut
        ? { reason: 'timeout' }
        : { reason: 'done', output: { records: [rec('assistant/message', 1, [{ type: 'text', text: '好' }])] } }),
    };
    let code = '';
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch (e) { code = e.code }
    eq(code, 'LLM_TIMEOUT', '★ 超时归类为 LLM_TIMEOUT');
    eq(creates, 1, '首次 create 一次');
    /* 超时只是「模型没答」，会话本身还活着 → 下一次必须复用，不重建 */
    timedOut = false;
    const r = await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q2', timeoutMs: 1000 });
    eq(r.text, '好', '★ 超时后下一次仍能拿到文本');
    eq(creates, 1, '★ 超时不重置会话（create 仍为 1，实际 ' + creates + '）');
  }

  /* ---------------------------------------------------------------- 4. wait 空回复 */
  console.log('== 4. wait 空回复 → LLM_EMPTY ==');
  {
    resetQaSession();
    const { sc } = scBase({ wait: async () => ({ reason: 'done', output: { records: [] } }) });
    let code = '';
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch (e) { code = e.code }
    eq(code, 'LLM_EMPTY', '★ 空回复归类为 LLM_EMPTY');
  }

  /* ---------------------------------------------------------------- 5. wait 抛错 → 重置 */
  console.log('== 5. wait 抛错 → 重置会话，下次重建 ==');
  {
    resetQaSession();
    let creates = 0, fail = true;
    const sc = {
      create: async () => { creates++; return { sessionId: 's' + creates } },
      state: () => { throw new Error('不该调用') },
      prompt: async () => {},
      wait: async () => { if (fail) throw new Error('wait boom'); return { reason: 'done', output: { records: [rec('assistant/message', 1, [{ type: 'text', text: '好' }])] } } },
    };
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch { /* expected */ }
    fail = false;
    const r = await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q2', timeoutMs: 1000 });
    eq(r.text, '好', '★ wait 抛错后下一次成功');
    eq(creates, 2, '★ 并且是重建的会话（create=2）');
  }

  /* ---------------------------------------------------------------- 6. 并发两路 */
  console.log('== 6. 并发两路 askViaSession（会不会建出两个窗口）==');
  {
    resetQaSession();
    let creates = 0;
    const sc = {
      create: async () => { creates++; await new Promise((r) => setTimeout(r, 20)); return { sessionId: 's' + creates } },
      state: () => { throw new Error('不该调用') },
      prompt: async () => {},
      wait: async () => ({ reason: 'done', output: { records: [rec('assistant/message', 1, [{ type: 'text', text: '好' }])] } }),
    };
    const [a, b] = await Promise.all([
      askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q1', timeoutMs: 1000 }),
      askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q2', timeoutMs: 1000 }),
    ]);
    ok(a.text === '好' && b.text === '好', '两路都拿到文本');
    eq(creates, 1, '★ 并发时只创建一个会话（不重复开窗）');
  }

  /* ---------------------------------------------------------------- 7. workspaceRegistry 抛错 */
  console.log('== 7. workspaceRegistry 抛错不该阻断 ==');
  {
    resetQaSession();
    const { sc } = scBase();
    const ctx = {
      sessionController: sc,
      workspaceRegistry: { create: async () => { throw new Error('wr boom') } },
    };
    const r = await askViaSession(ctx, { ai: {} }, { prompt: 'q', timeoutMs: 1000 });
    eq(r.text, '好', '★ 建项目失败仍能正常答题');
  }

  /* ---------------------------------------------------------------- 8. 服务形状不对 */
  console.log('== 8. sessionController 形状不对（prompt 不是函数）==');
  {
    resetQaSession();
    const sc = { create: async () => ({ sessionId: 's1' }), state: () => ({}), prompt: null, wait: async () => ({}) };
    let threw = false, msg = '';
    try { await askViaSession({ sessionController: sc }, { ai: {} }, { prompt: 'q', timeoutMs: 1000 }) } catch (e) { threw = true; msg = String((e && e.message) || e) }
    ok(threw, '★ 形状不对会抛错而不是静默成功（实际 msg=' + msg.slice(0, 60) + '）');
  }

  /* ---------------------------------------------------------------- 9. 无 sessionController */
  console.log('== 9. 宿主没有 sessionController → SESSION_UNAVAILABLE ==');
  {
    resetQaSession();
    let code = '';
    try { await ensureQaSession({}, { ai: {} }) } catch (e) { code = e.code }
    eq(code, 'SESSION_UNAVAILABLE', '★ 明确回 SESSION_UNAVAILABLE（引擎据此降级）');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2) });
