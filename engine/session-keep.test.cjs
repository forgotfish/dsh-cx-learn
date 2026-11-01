#!/usr/bin/env node
/* ============================================================================
 * session-keep.test.cjs — CX_KEEP_BROWSER 真的改变了收尾行为吗
 * ============================================================================
 *
 * 【背景】
 *   B-精简的核心是：任务结束时**不关内核**，交给会话管。
 *   这件事在代码里表现为：run() 的 finally 走 detach 而不是 shutdown。
 *   如果这个开关没生效，那「会话期间不死」就是空话 —— 用户还是每门课重扫。
 *
 * 【测什么】
 *   1. CX_KEEP_BROWSER=1        → 调 detach，**不调** shutdown
 *   2. 不设 CX_KEEP_BROWSER     → 调 shutdown（向后兼容）
 *   3. CX_KEEP_BROWSER=1 但登录失效 → 仍然调 shutdown
 *      （不能留一个没登录的内核占内存）
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 run.js 里 keepBrowser 的条件改成恒 false
 *   → 第 1 组「会话模式走 detach」变红。已实测：改坏退出 1，恢复退出 0。
 *
 * 纯 Mock，不启浏览器、不登录、不访问网络。
 * 运行：node engine/session-keep.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const { createMockAdapter } = require('./src/selftest.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

const RUN_OVERRIDES = {
  mode: 'continue_chapters',
  maxSections: 1,
  humanize: {
    clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1],
    longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1],
  },
};

/**
 * 把 Mock 包一层，记录到底调了 detach 还是 shutdown。
 *
 * ★ 必须把 engine 改成 'cdp'：`shutdownBrowser()` 只对 CDP 适配器生效
 *   （`if (!adapter || adapter.engine !== 'cdp') return`）。
 *   第一版忘了改，于是「兼容旧行为走 shutdown」那条判定为假失败 ——
 *   实际是产品按设计跳过了 Mock，不是缺陷。
 */
function instrumented(opts) {
  const base = createMockAdapter(opts || {});
  const calls = [];
  const adapter = Object.assign({}, base, {
    engine: 'cdp',
    detach: async () => { calls.push('detach') },
    shutdown: async () => { calls.push('shutdown') },
  });
  adapter._calls = calls;
  return adapter;
}

async function main() {
  const { run } = require('./src/learn/run.js');

  console.log('== 1. CX_KEEP_BROWSER=1 → 会话模式，只 detach ==');
  {
    const a = instrumented({});
    const saved = process.env.CX_KEEP_BROWSER;
    process.env.CX_KEEP_BROWSER = '1';
    try {
      await run(RUN_OVERRIDES, { adapter: a });
    } finally {
      if (saved === undefined) delete process.env.CX_KEEP_BROWSER; else process.env.CX_KEEP_BROWSER = saved;
    }
    ok(a._calls.includes('detach'), '调用了 detach（实际调用：' + JSON.stringify(a._calls) + '）');
    ok(!a._calls.includes('shutdown'), '★ 没有调用 shutdown —— 内核不会被关掉');
  }

  console.log('== 2. 不设 CX_KEEP_BROWSER → 兼容旧行为，shutdown ==');
  {
    const a = instrumented({});
    const saved = process.env.CX_KEEP_BROWSER;
    delete process.env.CX_KEEP_BROWSER;
    try {
      await run(RUN_OVERRIDES, { adapter: a });
    } finally {
      if (saved !== undefined) process.env.CX_KEEP_BROWSER = saved;
    }
    ok(a._calls.includes('shutdown'), '调用了 shutdown（实际：' + JSON.stringify(a._calls) + '）');
    ok(!a._calls.includes('detach'), '没有调用 detach');
  }

  console.log('== 3. 会话模式 + 登录失效 → 仍然 shutdown（不留无主内核）==');
  {
    const a = instrumented({ loginInvalid: true });
    const saved = process.env.CX_KEEP_BROWSER;
    process.env.CX_KEEP_BROWSER = '1';
    try {
      const r = await run(RUN_OVERRIDES, { adapter: a });
      ok(r.stopReason === 'LOGIN_REQUIRED', '因登录失效停止（实际 ' + r.stopReason + '）');
    } finally {
      if (saved === undefined) delete process.env.CX_KEEP_BROWSER; else process.env.CX_KEEP_BROWSER = saved;
    }
    ok(a._calls.includes('shutdown'),
      '★ 登录已失效时仍走 shutdown（实际：' + JSON.stringify(a._calls) + '）—— 不能留一个没登录的内核占内存');
    ok(!a._calls.includes('detach'), '登录失效时不 detach');
  }

  console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
  if (fails.length) { for (const f of fails) console.log('  - ' + f); return 1 }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('测试自身出错：' + ((e && e.stack) || e));
  process.exit(2);
});
