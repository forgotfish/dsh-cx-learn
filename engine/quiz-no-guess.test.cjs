#!/usr/bin/env node
/* ============================================================================
 * quiz-no-guess.test.cjs —— D-037 回归：AI 拿不到答案时**绝不许猜**
 *
 * 主人 2026-11-18 指令：AI 挂了就直接不答题，绝不能「盲选第一个」——
 * 章节测验/作业是记分的，猜错实打实扣分。
 *
 * 以前代码：`let pickIdx = 0` 默认值 + 「AI 答题失败，回退首选项」→ 点第一个选项。
 *
 * 本测试用假 adapter 驱动 handleQuiz，断言：
 *   1) AI 返回 -1（无答案）      → 一个选项都不点，留空并切下一节（ADVANCED）
 *   2) AI 抛错                  → 同上（不点）
 *   3) AI 正常给答案            → 点对应选项（对照，证明不是全都不点）
 *   4) submit 档 + 有题没答     → 放弃交卷，绝不「空着交卷」
 *
 * 用法：node engine/quiz-no-guess.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const cfgBase = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  ai: { enabled: true, dryRun: false, timeoutMs: 1000, maxRetries: 0 },
});
E.humanize.configure(cfgBase.humanize);

/** 假 adapter：记录所有 clickFound 调用 */
function makeMachine(opts) {
  const o = opts || {};
  const clicks = [];
  const adapter = {
    engine: 'fake',
    async ensureBrowser() { return {}; },
    async navigate() {},
    async getCurrentUrl() { return ''; },
    getTargetId() { return 't'; },
    async getFrameDocuments() { return []; },
    async getAllCookies() { return null; },
    async evalInFrame() { return null; },
  };
  const m = new E.LearnMachine(adapter, cfgBase);
  /* 拦截点击：只记录，永不真的点 */
  m.clickFound = async (frameId, layer, arg) => {
    clicks.push({ layer, arg });
    return { ok: true, note: 'fake' };
  };
  /* 截图：给个假 base64，走 ai-vision 分支没关系 */
  m.captureQuizBlock = async () => '';
  /* AI：由用例决定 */
  m.askAI = async () => {
    if (o.aiThrow) throw new Error('AI 通道全挂');
    return typeof o.aiIndex === 'number' ? o.aiIndex : -1;
  };
  /* 保存后复核用的状态 */
  m.gatherState = async () => ({ quiz: { present: false } });
  m.advanceSection = async () => ({ progress: true, outcome: 'ADVANCED' });
  m.currentChapterTitle = () => '第一章 测试';
  m.emitDetectedQuestions = () => [];
  return { m, clicks };
}

function stWithBlocks(n) {
  const OPTS = [{ letter: 'A', label: 'a1' }, { letter: 'B', label: 'b1' }, { letter: 'C', label: 'c1' }, { letter: 'D', label: 'd1' }];
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ i, question: 'Q' + (i + 1), options: OPTS });
  }
  /* 注意：handleQuiz 的准入闸门是 `!q.parseable || !(q.options||[]).length`，
     所以顶层必须给 parseable:true 且有 options，否则会走「结构无法识别」分支。 */
  return {
    quiz: { present: true, kind: 'chapter_work', parseable: true, options: OPTS, blocks },
    toc: { items: [{ title: '第一节', current: true }] },
  };
}

(async () => {
  /* ---------- 1. AI 无答案 → 一个选项都不点 ---------- */
  console.log('== 1. AI 返回 -1 → 不点任何选项、留空 ==');
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';   /* 让 useAi=true */
    delete process.env.CX_QUIZ_MODE;                        /* 走配置默认 save */
    const { m, clicks } = makeMachine({ aiIndex: -1 });
    const r = await m.handleQuiz(stWithBlocks(3));
    const optClicks = clicks.filter((c) => c.layer === 'quizBlockOption');
    ok(optClicks.length === 0, '★ 一次选项都没点（实际 ' + optClicks.length + ' 次）');
    ok(r && r.outcome === 'ADVANCED', '★ 留空后照常切下一节 outcome=ADVANCED（实际 ' + (r && r.outcome) + '）');
    ok((m.counters.quizzesSkippedAi || 0) === 3, '★ 计数 quizzesSkippedAi=3（实际 ' + (m.counters.quizzesSkippedAi || 0) + '）');
    const saveClicks = clicks.filter((c) => c.layer === 'quizBlockSave');
    ok(saveClicks.length === 0, '★ 一题都没答成时也不点「保存」');
  }

  /* ---------- 2. AI 抛错 → 同样不点 ---------- */
  console.log('== 2. AI 抛错 → 不点任何选项 ==');
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    delete process.env.CX_QUIZ_MODE;
    const { m, clicks } = makeMachine({ aiThrow: true });
    const r = await m.handleQuiz(stWithBlocks(2));
    ok(clicks.filter((c) => c.layer === 'quizBlockOption').length === 0, '★ AI 抛错时也不点选项');
    ok(r && r.outcome === 'ADVANCED', '★ 同样留空并切下一节（实际 ' + (r && r.outcome) + '）');
  }

  /* ---------- 3. 对照：AI 给答案 → 正常点 ---------- */
  console.log('== 3. 对照：AI 给 index=1 → 点第 2 个选项 ==');
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    delete process.env.CX_QUIZ_MODE;
    const { m, clicks } = makeMachine({ aiIndex: 1 });
    const r = await m.handleQuiz(stWithBlocks(1));
    const opt = clicks.filter((c) => c.layer === 'quizBlockOption');
    ok(opt.length === 1, '★ 点了一次选项（实际 ' + opt.length + '）');
    ok(opt[0] && opt[0].arg && opt[0].arg.o === 1, '★ 点的是 index=1（实际 ' + JSON.stringify(opt[0] && opt[0].arg) + '）');
    ok(!(m.counters.quizzesSkippedAi > 0), '★ 有答案时不计入「留空」计数（实际 ' + (m.counters.quizzesSkippedAi || 0) + '）');
  }

  /* ---------- 4. submit 档 + 有题没答 → 放弃交卷 ---------- */
  console.log('== 4. submit 档下只要有题没答，就放弃交卷 ==');
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    process.env.CX_QUIZ_MODE = 'submit';
    /* 3 题：第 1 题有答案，第 2、3 题让它返回 -1 → 需要可变的 askAI */
    const { m, clicks } = makeMachine({});
    let n = 0;
    m.askAI = async () => (n++ === 0 ? 1 : -1);
    const r = await m.handleQuiz(stWithBlocks(3));
    ok(clicks.filter((c) => c.layer === 'quizBlockSubmit').length === 0, '★ 没有点「提交」');
    ok(r && r.outcome === 'QUIZ_SUBMIT_SKIPPED_INCOMPLETE', '★ outcome=QUIZ_SUBMIT_SKIPPED_INCOMPLETE（实际 ' + (r && r.outcome) + '）');
    delete process.env.CX_QUIZ_MODE;
  }

  /* ---------- 5. 完全没配 AI 通道 → 直接不答（等同 AI 挂了） ---------- */
  console.log('== 5. 没配 AI 通道（AI 按钮关着）→ 直接不答、零点击 ==');
  {
    delete process.env.CX_LLM_ASK_URL;
    delete process.env.CX_LLM_MODEL;
    delete process.env.CX_QUIZ_MODE;
    const { m, clicks } = makeMachine({ aiIndex: 1 });   /* 就算 askAI 能给答案也不该被调用 */
    let aiCalled = 0;
    m.askAI = async () => { aiCalled++; return 1; };
    const r = await m.handleQuiz(stWithBlocks(2));
    ok(clicks.length === 0, '★ 一个按钮都没点（实际 ' + JSON.stringify(clicks.map((c) => c.layer)) + '）');
    ok(aiCalled === 0, '★ 根本没有调用 AI（实际 ' + aiCalled + ' 次）');
    ok(r && r.outcome === 'ADVANCED', '★ 按 skip 语义记录后切下一节（实际 ' + (r && r.outcome) + '）');
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';   /* 复原给后续用例 */
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
