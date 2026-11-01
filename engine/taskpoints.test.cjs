#!/usr/bin/env node
/* ============================================================================
 * taskpoints.test.cjs — 任务点注册表（扩展点 E1）
 * ============================================================================
 *
 * 【这个模块存在的意义】
 *   现在只推进视频。文档/阅读/音频类任务点一律跳过 —— 因为**没有实测样本**，
 *   不知道「文档怎么算看完」，不能猜。
 *   所以我们不实现它，只留接口：将来拿到样本，注册一个 handler 就能接上。
 *
 * 【本测试钉住两件事】
 *   1. 当前行为：除 video 外一律 skip，quiz 永远 never
 *   2. 扩展点：注册 handler 后真的会被调用；但 quiz 的红线覆盖不了
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 decideTaskPoint 里 QUIZ 的分支删掉 → 「章节测验永不触碰」变红。
 *   把未注册分支的 skip 改成 done → 「未注册类型一律跳过」变红。
 *   已实测：改坏退出 1，恢复退出 0。
 *
 * 纯函数，不需要浏览器。
 * 运行：node engine/taskpoints.test.cjs
 * ==========================================================================*/
'use strict';

const T = require('./src/learn/taskpoints.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

async function main() {
  T._resetHandlers();

  console.log('== 1. 当前行为：只有 video 会被推进 ==');
  {
    const r = await T.decideTaskPoint(T.TASK_KIND.VIDEO);
    ok(r.action === 'play', 'video → play（实际 ' + r.action + '）');
  }
  for (const k of [T.TASK_KIND.AUDIO, T.TASK_KIND.DOCUMENT, T.TASK_KIND.DISCUSSION, T.TASK_KIND.UNKNOWN]) {
    const r = await T.decideTaskPoint(k);
    ok(r.action === 'skip', k + ' → skip（未注册处理器，实际 ' + r.action + '）');
    ok(/未注册/.test(r.reason), k + ' 的 reason 写明「未注册」，不会被误读成已支持', r.reason);
  }

  console.log('== 2. 红线：章节测验永不触碰 ==');
  {
    const r = await T.decideTaskPoint(T.TASK_KIND.QUIZ);
    ok(r.action === 'never', 'quiz → never（实际 ' + r.action + '）');

    /* 即使有人注册了 quiz 处理器，也不能覆盖这条红线 */
    let called = false;
    T.registerHandler(T.TASK_KIND.QUIZ, async () => { called = true; return { action: 'play' } });
    const r2 = await T.decideTaskPoint(T.TASK_KIND.QUIZ);
    ok(r2.action === 'never', '★ 注册了 quiz 处理器也不得改变 never（实际 ' + r2.action + '）');
    ok(called === false, '★ quiz 的 handler 根本不会被调用');
    T._resetHandlers();
  }

  console.log('== 3. 扩展点：注册 handler 后真的会被调用 ==');
  {
    let got = null;
    T.registerHandler(T.TASK_KIND.DOCUMENT, async (ctx) => { got = ctx; return { action: 'wait', reason: '文档还没加载完' } });
    const r = await T.decideTaskPoint(T.TASK_KIND.DOCUMENT, { section: '1.1', task: { kind: 'document' } });
    ok(r.action === 'wait', 'document handler 的 action 被采纳（实际 ' + r.action + '）');
    ok(r.reason === '文档还没加载完', 'handler 的 reason 被透传');
    ok(got && got.section === '1.1', 'handler 收到了 ctx（section=' + (got && got.section) + '）');
    ok(got && got.kind === 'document', 'handler 收到了 kind');
    T._resetHandlers();
  }

  console.log('== 4. 扩展点必须安全：handler 出错/返回垃圾不能让整轮崩 ==');
  {
    T.registerHandler(T.TASK_KIND.DOCUMENT, async () => { throw new Error('boom') });
    const r = await T.decideTaskPoint(T.TASK_KIND.DOCUMENT);
    ok(r.action === 'skip', 'handler 抛错 → 降级 skip（实际 ' + r.action + '）');
    ok(/handler 异常/.test(r.reason), 'reason 写明异常来源', r.reason);

    T.registerHandler(T.TASK_KIND.DOCUMENT, async () => ({ nothing: true }));
    const r2 = await T.decideTaskPoint(T.TASK_KIND.DOCUMENT);
    ok(r2.action === 'skip', 'handler 返回无 action → 降级 skip（实际 ' + r2.action + '）');
    T._resetHandlers();
  }

  console.log('== 5. 注册表完整性 ==');
  {
    const d = T.describe();
    ok(Array.isArray(d.supported) && d.supported.length === 1 && d.supported[0] === 'video',
      'supported 只有 video（实际 ' + JSON.stringify(d.supported) + '）');
    ok(d.neverTouch.includes('quiz'), 'neverTouch 含 quiz');
    ok(d.defaultForUnknown === 'skip', '未知类型默认 skip');

    let threw = false;
    try { T.registerHandler('', () => {}) } catch (_) { threw = true }
    ok(threw, 'registerHandler 参数非法时抛错，不静默吞掉');
  }

  console.log('== 6. kindOf 容错 ==');
  {
    ok(T.kindOf({ kind: 'video' }) === 'video', '正常 kind 原样返回');
    ok(T.kindOf({ kind: 'weird' }) === 'unknown', '未知 kind → unknown');
    ok(T.kindOf(null) === 'unknown', 'null 任务点 → unknown');
    ok(T.kindOf({}) === 'unknown', '缺 kind → unknown');
  }

  console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
  if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
  process.exit(0);
}

main().catch((e) => { console.error('测试自身出错：' + ((e && e.stack) || e)); process.exit(2) });
