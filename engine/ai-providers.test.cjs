#!/usr/bin/env node
/* ============================================================================
 * ai-providers.test.cjs —— D-065 provider 注册表 + 回退链
 *
 * 覆盖：
 *   1. 注册表：内置 host/direct；registerProvider 可加自定义；_resetProviders 复原
 *   2. resolveOrder：默认 host→direct；channel=direct → direct→host；显式 providers 数组优先；未注册名被忽略
 *   3. available()：缺地址/缺 key 的通道被跳过（不进链）
 *   4. 回退链：第 1 个抛错 → 用第 2 个；第 1 个返回空文本 → 也用第 2 个
 *   5. 全部失败 → 抛 ALL_PROVIDERS_FAILED（带每个通道的原因）
 *   6. 没有任何可用通道 → 抛 NO_AVAILABLE_PROVIDER（不静默成功）
 *   7. 破坏：供应商构造抛错不影响其它；返回非字符串；超时 Abort；自定义供应商接入
 *
 * 用法：node engine/ai-providers.test.cjs
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const P = require(path.join(__dirname, 'src', 'core', 'ai-providers.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* 假 fetch：按 url 决定行为 */
function mkFetch(map) {
  return async (url, init) => {
    const key = Object.keys(map).find((k) => String(url).indexOf(k) >= 0);
    const beh = key ? map[key] : { status: 500, body: 'no route' };
    if (beh.throws) throw new Error(beh.throws);
    return {
      ok: (beh.status || 200) < 400,
      status: beh.status || 200,
      async json() { return beh.json || {}; },
      async text() { return beh.body || ''; },
    };
  };
}

(async () => {
  /* ---------- 1. 注册表 ---------- */
  console.log('== 1. 注册表 ==');
  {
    ok(P.listProviders().join(',') === 'direct,host', '★ 内置只有 host/direct（实际 ' + P.listProviders().join(',') + '）');
    ok(typeof P.PROVIDER_REGISTRY.host === 'function', '  host 工厂存在');
    const n = P.registerProvider('mybank', () => ({ name: 'mybank', available: () => true, async ask() { return 'B'; } }));
    ok(n === 'mybank' && P.listProviders().includes('mybank'), '★ registerProvider 可加自定义（实际 ' + P.listProviders().join(',') + '）');
    let threw = false;
    try { P.registerProvider('', () => ({ })); } catch (_) { threw = true; }
    ok(threw, '  空名字抛错');
    threw = false;
    try { P.registerProvider('x', 123); } catch (_) { threw = true; }
    ok(threw, '  非函数工厂抛错');
    P._resetProviders();
    ok(!P.listProviders().includes('mybank'), '★ _resetProviders 清掉自定义');
  }

  /* ---------- 2. resolveOrder ---------- */
  console.log('== 2. resolveOrder（通道顺序） ==');
  {
    ok(P.resolveOrder({}).join(',') === 'host,direct', '★ 默认 host→direct（实际 ' + P.resolveOrder({}).join(',') + '）');
    ok(P.resolveOrder({ channel: 'direct' }).join(',') === 'direct,host', '★ channel=direct → direct→host（实际 ' + P.resolveOrder({ channel: 'direct' }).join(',') + '）');
    ok(P.resolveOrder({ channel: 'session' }).join(',') === 'host,direct', '★ channel=session → host→direct');
    ok(P.resolveOrder({ providers: ['direct'] }).join(',') === 'direct', '★ 显式 providers 优先（实际 ' + P.resolveOrder({ providers: ['direct'] }).join(',') + '）');
    ok(P.resolveOrder({ providers: ['nope', 'host'] }).join(',') === 'host', '★ 未注册名被忽略（实际 ' + P.resolveOrder({ providers: ['nope', 'host'] }).join(',') + '）');
  }

  /* ---------- 3. available 过滤 ---------- */
  console.log('== 3. available() 过滤：缺配置的通道不进链 ==');
  {
    /* 只有 host（有 ask url）→ direct 缺 key 被跳过 */
    const t = P.createTransport({
      env: { CX_LLM_ASK_URL: 'http://host/ask' },
      cfgAi: {},
      fetchImpl: mkFetch({ 'http://host/ask': { json: { ok: true, text: 'A' } } }),
    });
    const r = await t({ prompt: 'p' });
    ok(r.ok && r.text === 'A' && r.by === 'host', '★ 只有 host 可用时走 host（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- 4. 回退链 ---------- */
  console.log('== 4. 回退链：第 1 个失败/空 → 用第 2 个 ==');
  {
    const env = { CX_LLM_ASK_URL: 'http://host/ask', CX_LLM_BASE: 'http://llm/v1', CX_LLM_KEY: 'k', CX_LLM_MODEL: 'm' };
    /* 4a：host 抛错 → direct 兜底 */
    const t1 = P.createTransport({
      env, cfgAi: {},
      fetchImpl: mkFetch({
        'http://host/ask': { throws: 'ECONNREFUSED' },
        'http://llm/v1': { json: { choices: [{ message: { content: 'C' } }] } },
      }),
    });
    const r1 = await t1({ prompt: 'p' });
    ok(r1.ok && r1.text === 'C' && r1.by === 'direct', '★ host 抛错 → 回退 direct（实际 ' + JSON.stringify(r1) + '）');

    /* 4b：host 返回空文本 → direct 兜底 */
    const t2 = P.createTransport({
      env, cfgAi: {},
      fetchImpl: mkFetch({
        'http://host/ask': { json: { ok: true, text: '   ' } },
        'http://llm/v1': { json: { choices: [{ message: { content: 'D' } }] } },
      }),
    });
    const r2 = await t2({ prompt: 'p' });
    ok(r2.ok && r2.text === 'D' && r2.by === 'direct', '★ host 空文本 → 回退 direct（实际 ' + JSON.stringify(r2) + '）');

    /* 4c：channel=direct 时先 direct */
    const t3 = P.createTransport({
      env, cfgAi: { channel: 'direct' },
      fetchImpl: mkFetch({
        'http://host/ask': { json: { ok: true, text: 'H' } },
        'http://llm/v1': { json: { choices: [{ message: { content: 'DD' } }] } },
      }),
    });
    const r3 = await t3({ prompt: 'p' });
    ok(r3.by === 'direct' && r3.text === 'DD', '★ channel=direct 优先 direct（实际 ' + JSON.stringify(r3) + '）');
  }

  /* ---------- 5. 全部失败 ---------- */
  console.log('== 5. 全部通道失败 → 抛 ALL_PROVIDERS_FAILED ==');
  {
    const env = { CX_LLM_ASK_URL: 'http://host/ask', CX_LLM_BASE: 'http://llm/v1', CX_LLM_KEY: 'k', CX_LLM_MODEL: 'm' };
    const t = P.createTransport({ env, cfgAi: {}, fetchImpl: mkFetch({ 'http://host/ask': { status: 500, body: 'boom' }, 'http://llm/v1': { status: 502, body: 'bad' } }) });
    let err = null;
    try { await t({ prompt: 'p' }); } catch (e) { err = e; }
    ok(!!err && err.code === 'ALL_PROVIDERS_FAILED', '★ 抛 ALL_PROVIDERS_FAILED（实际 ' + (err && err.code) + '）');
    ok(!!err && /host:/.test(err.message) && /direct:/.test(err.message), '★ 错误里带每个通道原因（实际 ' + (err && err.message.slice(0, 80)) + '）');
  }

  /* ---------- 6. 无可用通道 ---------- */
  console.log('== 6. 没有任何可用通道 → 抛 NO_AVAILABLE_PROVIDER（不静默成功） ==');
  {
    const t = P.createTransport({ env: {}, cfgAi: {}, fetchImpl: mkFetch({}) });
    let err = null;
    try { await t({ prompt: 'p' }); } catch (e) { err = e; }
    ok(!!err && err.code === 'NO_AVAILABLE_PROVIDER', '★ 抛 NO_AVAILABLE_PROVIDER（实际 ' + (err && err.code) + '）');
  }

  /* ---------- 7. 破坏性 ---------- */
  console.log('== 7. 破坏场景 ==');
  {
    /* 7a：某个供应商构造抛错 → 不影响其它 */
    P.registerProvider('explode', () => { throw new Error('boom on construct'); });
    const t = P.createTransport({
      env: { CX_LLM_ASK_URL: 'http://host/ask' },
      cfgAi: { providers: ['explode', 'host'] },
      fetchImpl: mkFetch({ 'http://host/ask': { json: { ok: true, text: 'Z' } } }),
    });
    const r = await t({ prompt: 'p' });
    ok(r.ok && r.text === 'Z', '★ 供应商构造抛错不影响其它（实际 ' + JSON.stringify(r) + '）');

    /* 7b：自定义供应商接入，且能返回非标准文本 */
    P.registerProvider('weird', () => ({ name: 'weird', available: () => true, async ask() { return 12345; } }));
    const t2 = P.createTransport({ env: {}, cfgAi: { providers: ['weird'] }, fetchImpl: mkFetch({}) });
    const r2 = await t2({ prompt: 'p' });
    ok(r2.ok && r2.text === '12345' && r2.by === 'weird', '★ 非字符串返回被转成文本（实际 ' + JSON.stringify(r2) + '）');

    /* 7c：自定义供应商 available=false → 不进链 */
    P.registerProvider('off', () => ({ name: 'off', available: () => false, async ask() { throw new Error('should not call'); } }));
    const t3 = P.createTransport({ env: {}, cfgAi: { providers: ['off'] }, fetchImpl: mkFetch({}) });
    let err3 = null;
    try { await t3({ prompt: 'p' }); } catch (e) { err3 = e; }
    ok(!!err3 && err3.code === 'NO_AVAILABLE_PROVIDER', '★ available=false 的供应商不进链（实际 ' + (err3 && err3.code) + '）');

    /* 7d：image 透传（host 侧 payload.image 存在） */
    let seen = null;
    const captureFetch = async (url, init) => { seen = JSON.parse(init.body); return { ok: true, status: 200, async json() { return { ok: true, text: 'A' }; }, async text() { return ''; } }; };
    const t4 = P.createTransport({ env: { CX_LLM_ASK_URL: 'http://host/ask' }, cfgAi: {}, fetchImpl: captureFetch });
    await t4({ prompt: 'p', image: 'QUJD' });
    ok(!!seen && String(seen.image).indexOf('data:image/png;base64,QUJD') === 0, '★ 图片按 data URL 透传（实际 ' + (seen && String(seen.image).slice(0, 30)) + '）');

    P._resetProviders();
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
