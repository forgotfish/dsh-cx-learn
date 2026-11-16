#!/usr/bin/env node
/* ============================================================================
 * scripts/ai-core.test.cjs — AI 策略层纯函数测试（无网络、不碰浏览器）
 * ----------------------------------------------------------------------------
 * 契约 docs/AI-ANSWER-FRAMEWORK.md §5/§7。覆盖：
 *   · AI_SCOPE 不可写（Object.isFrozen）与取值（D-020 后 chapterQuiz 放开）
 *   · buildPrompt 文本/图片两态
 *   · parseAnswer 8 个正反例（严格：只认单个字母，歧义即放弃）
 *   · decide 在 chapter_work / popup_quiz 下已放开（白名单内，正常走 transport）
 *   · decide 正常通路返回下标；歧义返回 AI_AMBIGUOUS
 *   · audit 只落 rawHash/rawLen，绝不落 prompt/图片/base64
 *
 * 用法：node scripts/ai-core.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ai = require(path.join(__dirname, '..', 'engine', 'src', 'core', 'ai.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const OPTS = [
  { letter: 'A', label: '选项甲' },
  { letter: 'B', label: '选项乙' },
  { letter: 'C', label: '选项丙' },
  { letter: 'D', label: '选项丁' },
];

(async () => {
  /* ---------------- 1. 策略层不可篡改 ---------------- */
  console.log('== 1. AI_SCOPE 锁死 ==');
  ok(Object.isFrozen(ai.AI_SCOPE), 'AI_SCOPE 是 frozen');
  ok(ai.AI_SCOPE.videoQuiz === false, '★ videoQuiz 锁死（随堂题永不用 AI）');
  ok(ai.AI_SCOPE.chapterQuiz === true, '★ chapterQuiz 放开（D-020）');
  ok(ai.ALLOWED_KINDS.indexOf('chapter_work') >= 0, 'chapter_work 在白名单');
  ok(ai.ALLOWED_KINDS.indexOf('popup_quiz') >= 0, 'popup_quiz 在白名单');
  {
    let threw = false;
    try { 'use strict'; ai.AI_SCOPE.chapterQuiz = false; } catch (e) { threw = true; }
    ok(threw || ai.AI_SCOPE.chapterQuiz === true, '★ 运行时改不动 chapterQuiz');
  }

  /* ---------------- 2. buildPrompt 两态 ---------------- */
  console.log('== 2. buildPrompt 文本 / 图片 ==');
  const pText = ai.buildPrompt({ kind: 'chapter_work', question: '1+1=?', options: OPTS });
  ok(typeof pText === 'string' && pText.indexOf('1+1=?') >= 0, '无图模式含题干');
  ok(pText.indexOf('A. 选项甲') >= 0 && pText.indexOf('D. 选项丁') >= 0, '无图模式含选项列表');
  ok(/只输出正确选项的字母/.test(pText), '无图模式含"只输出字母"约束');
  const pImg = ai.buildPrompt({ kind: 'chapter_work', question: '', options: OPTS, image: 'BASE64DATA' });
  ok(/截图/.test(pImg) && pImg.indexOf('BASE64DATA') < 0, '有图模式引用截图且不内联 base64');
  ok(pImg !== pText, '两态 prompt 不同');

  /* ---------------- 3. parseAnswer 正反例 ---------------- */
  console.log('== 3. parseAnswer 严格解析 ==');
  const cases = [
    ['B', 4, 1, 'B', 'high', '单个大写 B'],
    ['b', 4, 1, 'B', 'high', '单个小写 b'],
    ['答案：B', 4, 1, 'B', 'high', '带提示词「答案：B」'],
    ['B.', 4, 1, 'B', 'high', '带句点「B.」'],
    ['（B）', 4, 1, 'B', 'high', '带括号「（B）」'],
    ['A或B', 4, -1, '', 'low', '歧义「A或B」'],
    ['AB', 4, -1, '', 'low', '歧义「AB」'],
    ['', 4, -1, '', 'low', '空串'],
  ];
  for (const [txt, cnt, idx, letter, conf, label] of cases) {
    const r = ai.parseAnswer(txt, cnt);
    const passCase = r.index === idx && r.letter === letter && r.confidence === conf && (idx < 0 ? r.code === 'AI_AMBIGUOUS' : true);
    ok(passCase, label + ' → index=' + r.index + ' letter=' + r.letter + ' ' + r.confidence + (r.code ? ' ' + r.code : ''));
  }
  ok(ai.parseAnswer('E', 4).index === -1, '★ 越界字母 E（选项只有 A-D）→ 放弃');
  ok(ai.parseAnswer('A', 4).index === 0 && ai.parseAnswer('D', 4).index === 3, '边界 A=0 / D=3');

  /* ---------------- 4. decide 范围放开：chapter_work / popup_quiz 允许 ---------------- */
  console.log('== 4. decide 范围放开（chapter_work / popup_quiz 允许）==');
  {
    let calls = 0;
    const transport = async () => { calls += 1; return { ok: true, text: 'B', model: 'm' }; };
    const r1 = await ai.decide({ kind: 'chapter_work', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(calls === 1, '★ chapter_work：transport 被调用（已放开）', 'calls=' + calls);
    ok(r1.ok === true && r1.index === 1 && r1.letter === 'B', 'chapter_work 正常返回 index=1 letter=B');
    const r2 = await ai.decide({ kind: 'popup_quiz', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(calls === 2, '★ popup_quiz：transport 被调用（已放开）', 'calls=' + calls);
    ok(r2.ok === true && r2.index === 1, 'popup_quiz 正常返回 index=1');
    const r3 = await ai.decide({ kind: 'other_unknown', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(calls === 2 && r3.code === 'AI_SCOPE_DENIED', '未知 kind 仍被拒且不调 transport');
  }

  /* ---------------- 5. decide 正常通路 ---------------- */
  console.log('== 5. decide 正常 / 歧义通路 ==');
  {
    let calls = 0;
    const transport = async () => { calls += 1; return { ok: true, text: 'B', model: 'test-model' }; };
    const r = await ai.decide({ kind: 'chapter_work', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(calls === 1, 'chapter_work：transport 被调用 1 次', 'calls=' + calls);
    ok(r.ok === true && r.index === 1 && r.letter === 'B', '正常返回 index=1 letter=B');
    ok(r.confidence === 'high' && r.model === 'test-model', '置信度 high 且回传 model');
    /* ★ 视频随堂题必须被策略层挡住，连 transport 都不许调 */
    const rv = await ai.decide({ kind: 'video_embedded_quiz', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(calls === 1 && rv.code === 'AI_SCOPE_DENIED', '★ video_embedded_quiz 被拒且不调 transport');
  }
  {
    const transport = async () => ({ ok: true, text: 'A或B', model: 'm' });
    const r = await ai.decide({ kind: 'chapter_work', question: 'q', options: OPTS, cfg: { ai: {} }, transport });
    ok(r.ok === false && r.index === -1 && r.code === 'AI_AMBIGUOUS', '歧义答复 → AI_AMBIGUOUS，index=-1');
  }
  {
    const transport = async () => { throw new Error('boom'); };
    const r = await ai.decide({ kind: 'chapter_work', question: 'q', options: OPTS, cfg: { ai: { maxRetries: 0 } }, transport });
    ok(r.ok === false && r.code === 'AI_TRANSPORT_ERROR', '传输异常 → AI_TRANSPORT_ERROR');
  }

  /* ---------------- 6. audit 只落 hash/长度 ---------------- */
  console.log('== 6. audit 脱敏（只写 rawHash/rawLen）==');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-ai-'));
    const file = path.join(dir, 'questions.jsonl');
    process.env.CX_QUESTION_FILE = file;
    const secretPrompt = '题目正文 SECRET-PROMPT-XYZ';
    const secretImage = 'data:image/png;base64,AAAA';
    ai.audit({ id: 'q-1', kind: 'video_embedded_quiz', provider: 'host', model: 'm', letter: 'B', confidence: 'high', ms: 12, dryRun: true, raw: 'B', prompt: secretPrompt, image: secretImage });
    const line = fs.readFileSync(file, 'utf8').trim();
    const rec = JSON.parse(line);
    ok(rec.event === 'ai_answer' && rec.letter === 'B' && rec.id === 'q-1', '写出 ai_answer 记录');
    ok(typeof rec.rawHash === 'string' && rec.rawHash.length === 12, 'rawHash 为 sha256 前 12 位');
    ok(rec.rawLen === 1, 'rawLen 等于回复长度');
    ok(line.indexOf('SECRET-PROMPT') < 0 && line.indexOf('base64') < 0, '★ 不写 prompt 正文、不写图片/base64');
    delete process.env.CX_QUESTION_FILE;
  }

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  process.exit(0);
})();
