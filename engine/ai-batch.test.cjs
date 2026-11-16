#!/usr/bin/env node
/* ============================================================================
 * engine/ai-batch.test.cjs — 批量答题协议测试（§13）
 * ----------------------------------------------------------------------------
 * 覆盖 buildBatchPrompt / parseBatchAnswer / decideBatch：
 *   · prompt 模板（中文说明 + JSON 格式 + 4 条规则 + 内联 JSON.stringify）
 *   · 正常单选 / 判断题 / 多选（indexList 两个）/ 小写 b / 三重反引号围栏 /
 *     前后夹带解释文字 / 坏 JSON / 字母越界 / 未知 id / 空 choice / 重复 id
 *   · decideBatch：空 items / kind 白名单 / multi 不误拒 / 空正文 / 抛错
 *   · AI_SCOPE frozen 且 chapterQuiz===true
 *
 * 纯函数，不连浏览器、不发网络。运行：node engine/ai-batch.test.cjs
 * ==========================================================================*/
'use strict';

const ai = require('./src/core/ai.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  \u2713 ' + name);
  else { console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); fails.push(name); }
}
function eq(actual, want, name) {
  ok(actual === want, name, '实际 ' + JSON.stringify(actual) + ' 期望 ' + JSON.stringify(want));
}

const OPTS4 = [
  { letter: 'A', label: '甲' }, { letter: 'B', label: '乙' },
  { letter: 'C', label: '丙' }, { letter: 'D', label: '丁' },
];
const OPTS2 = [{ letter: 'A', label: '对' }, { letter: 'B', label: '错' }];

const ITEMS = [
  { id: 'q1', type: 'single', question: '单选', options: OPTS4 },
  { id: 'q2', type: 'judge', question: '判断', options: OPTS2 },
  { id: 'q3', type: 'multi', question: '多选', options: OPTS4 },
];

(async () => {
  /* ---------------- 1. buildBatchPrompt 模板 ---------------- */
  console.log('== 1. buildBatchPrompt 模板 ==');
  {
    const p = ai.buildBatchPrompt(ITEMS);
    ok(typeof p === 'string', '返回字符串');
    ok(p.indexOf('你是答题助手') >= 0, '含中文说明');
    ok(p.indexOf('{"answers":[{"id":"q1","choice":"B"}') >= 0, '含输出格式示例');
    ok(p.indexOf('单选题/判断题只填一个字母') >= 0 && p.indexOf('多选填多个字母连写') >= 0, '含规则 1/2');
    ok(p.indexOf('完全不确定就留空字符串') >= 0 && p.indexOf('id 必须原样回填') >= 0, '含规则 3/4');
    /* 内联 JSON.stringify(items)，不额外包裹 */
    ok(p.indexOf('题目：' + JSON.stringify(ITEMS)) >= 0, '★ 末尾内联 JSON.stringify(items)');
  }

  /* ---------------- 2. parseBatchAnswer 正常单选 ---------------- */
  console.log('== 2. 正常单选 ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"B"}]}', ITEMS);
    ok(r.ok === true, 'ok=true');
    eq(r.answers.length, 1, 'answers 1 条');
    eq(r.answers[0].id, 'q1', 'id=q1');
    eq(r.answers[0].letters, 'B', 'letters=B');
    eq(r.answers[0].index, 1, 'index=1（B 是 0 基下标 1）');
    eq(r.answers[0].indexList.length, 1, 'indexList 长度 1');
  }

  /* ---------------- 3. 判断题 ---------------- */
  console.log('== 3. 判断题 ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q2","choice":"A"}]}', ITEMS);
    eq(r.answers.length, 1, 'answers 1 条');
    eq(r.answers[0].index, 0, '判断题 A → index=0');
  }

  /* ---------------- 4. 多选 indexList 两个 ---------------- */
  console.log('== 4. 多选 ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q3","choice":"AC"}]}', ITEMS);
    eq(r.answers.length, 1, 'answers 1 条');
    eq(r.answers[0].letters, 'AC', 'letters=AC');
    eq(r.answers[0].indexList.length, 2, '★ 多选 indexList 2 个');
    eq(r.answers[0].indexList[0], 0, 'indexList[0]=0');
    eq(r.answers[0].indexList[1], 2, 'indexList[1]=2');
    eq(r.answers[0].index, 0, 'multi 的 index 取 indexList[0]');
  }

  /* ---------------- 5. 小写 b 大写化 ---------------- */
  console.log('== 5. 小写 b → 大写 B ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"b"}]}', ITEMS);
    eq(r.answers[0].letters, 'B', 'b 规范化为 B');
    eq(r.answers[0].index, 1, 'index=1');
  }

  /* ---------------- 6. 三重反引号围栏 ---------------- */
  console.log('== 6. 三重反引号围栏 ==');
  {
    const txt = '```json\n{"answers":[{"id":"q1","choice":"C"}]}\n```';
    const r = ai.parseBatchAnswer(txt, ITEMS);
    ok(r.ok === true, '围栏去除后正常解析');
    eq(r.answers[0].index, 2, 'choice C → index=2');
  }

  /* ---------------- 7. 前后夹带解释文字 ---------------- */
  console.log('== 7. 前后有解释文字 ==');
  {
    const txt = '好的，答案如下：\n{"answers":[{"id":"q1","choice":"D"}]}\n以上，请核对。';
    const r = ai.parseBatchAnswer(txt, ITEMS);
    ok(r.ok === true, '取第一个 { 到最后一个 } 正常解析');
    eq(r.answers[0].index, 3, 'choice D → index=3');
  }

  /* ---------------- 8. 坏 JSON ---------------- */
  console.log('== 8. 坏 JSON ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1",}]}oops', ITEMS);
    eq(r.ok, false, 'ok=false');
    eq(r.code, 'AI_BAD_JSON', 'code=AI_BAD_JSON');
    eq(r.answers.length, 0, 'answers 空');
    ok(Array.isArray(r.unresolved) && Array.isArray(r.dropped), '含 unresolved/dropped 数组');
  }

  /* ---------------- 9. 字母越界（选 Z 但只有 A-D/3 个） ---------------- */
  console.log('== 9. 字母越界 ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"Z"}]}', ITEMS);
    eq(r.answers.length, 0, '越界字母不进 answers');
    eq(r.dropped.length, 1, '进入 dropped');
    eq(r.dropped[0].id, 'q1', 'dropped id=q1');
    eq(r.dropped[0].reason, 'letter_out_of_range', 'reason=letter_out_of_range');
  }

  /* ---------------- 10. 未知 id ---------------- */
  console.log('== 10. 未知 id ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"qX","choice":"A"}]}', ITEMS);
    eq(r.answers.length, 0, '未知 id 不进 answers');
    eq(r.dropped.length, 1, '进入 dropped');
    eq(r.dropped[0].reason, 'unknown_id', 'reason=unknown_id');
  }

  /* ---------------- 11. 空 choice → unresolved ---------------- */
  console.log('== 11. 空 choice → unresolved ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"  "}]}', ITEMS);
    eq(r.unresolved.length, 1, 'unresolved 1 条');
    eq(r.unresolved[0], 'q1', 'unresolved 含 q1');
    eq(r.answers.length, 0, '不进 answers');
  }

  /* ---------------- 12. 重复 id 只留第一个 ---------------- */
  console.log('== 12. 重复 id ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"B"},{"id":"q1","choice":"C"}]}', ITEMS);
    eq(r.answers.length, 1, '★ 重复 id 只保留第一个');
    eq(r.answers[0].letters, 'B', '保留第一次的 B');
    eq(r.dropped.length, 1, '第二个进 dropped');
    eq(r.dropped[0].reason, 'duplicate_id', 'reason=duplicate_id');
  }

  /* ---------------- 13. 单选却给了两个字母 ---------------- */
  console.log('== 13. 非 multi 多字母被拒 ==');
  {
    const r = ai.parseBatchAnswer('{"answers":[{"id":"q1","choice":"AB"}]}', ITEMS);
    eq(r.answers.length, 0, '单选给 AB 不进 answers');
    eq(r.dropped[0].reason, 'single_multiple_letters', 'reason=single_multiple_letters');
  }

  /* ---------------- 14. decideBatch 空 items ---------------- */
  console.log('== 14. decideBatch 空 items ==');
  {
    const r = await ai.decideBatch({ items: [], cfg: { ai: {} }, transport: async () => 'x' });
    eq(r.ok, false, 'ok=false');
    eq(r.code, 'AI_NO_ITEMS', 'code=AI_NO_ITEMS');
    eq(r.answers.length, 0, 'answers 空');
  }

  /* ---------------- 15. decideBatch 正常通路 ---------------- */
  console.log('== 15. decideBatch 正常通路 ==');
  {
    let calls = 0;
    const transport = async () => { calls += 1; return { text: '{"answers":[{"id":"q1","choice":"B"}]}', model: 'm1' }; };
    const r = await ai.decideBatch({ items: ITEMS, cfg: { ai: {} }, transport });
    eq(calls, 1, 'transport 调用 1 次');
    eq(r.ok, true, 'ok=true');
    eq(r.answers.length, 1, 'answers 1 条');
    eq(r.answers[0].index, 1, 'index=1');
    eq(r.model, 'm1', '回传 model=m1');
    ok(typeof r.ms === 'number', '带 ms');
  }

  /* ---------------- 16. decideBatch scope：非白名单 kind 被拒（含 multi）/ 白名单放行 ---------------- */
  console.log('== 16. decideBatch 范围闸门 ==');
  {
    let calls = 0;
    const transport = async () => { calls += 1; return '{"answers":[]}'; };
    const denied = await ai.decideBatch({
      items: [{ id: 'q1', type: 'single', kind: 'other_unknown', question: 'x', options: OPTS4 }],
      cfg: { ai: {} }, transport,
    });
    eq(denied.code, 'AI_SCOPE_DENIED', '非白名单 kind → AI_SCOPE_DENIED');
    eq(calls, 0, '★ 被拒时 transport 不调用');

    /* ★ 2026-11-15 修 BUG 后：多选题不再绕过 kind 检查 —— 随堂题(multi)也必须被拒。 */
    const multiDenied = await ai.decideBatch({
      items: [{ id: 'q3', type: 'multi', kind: 'video_quiz', question: 'x', options: OPTS4 }],
      cfg: { ai: {} }, transport,
    });
    eq(multiDenied.code, 'AI_SCOPE_DENIED', '★ multi + 非白名单 kind(video_quiz) 也必须拒');
    eq(calls, 0, '★ multi 被拒时 transport 仍不调用');

    /* 白名单 kind（章节测验批量题）照常放行。 */
    const multiOk = await ai.decideBatch({
      items: [{ id: 'q4', type: 'multi', kind: 'chapter_work', question: 'x', options: OPTS4 }],
      cfg: { ai: {} }, transport,
    });
    ok(multiOk.code !== 'AI_SCOPE_DENIED', '★ multi + 白名单 kind(chapter_work) 放行');
    eq(calls, 1, 'multi 白名单批次照常调 transport');
  }

  /* ---------------- 17. decideBatch 空正文 / 抛错 ---------------- */
  console.log('== 17. decideBatch 空正文 / 抛错 ==');
  {
    const emptyR = await ai.decideBatch({ items: ITEMS, cfg: { ai: { maxRetries: 0 } }, transport: async () => ({ text: '' }) });
    eq(emptyR.code, 'AI_EMPTY', '空正文 → AI_EMPTY');
    const errR = await ai.decideBatch({ items: ITEMS, cfg: { ai: { maxRetries: 0 } }, transport: async () => { throw new Error('boom'); } });
    eq(errR.code, 'AI_TRANSPORT_ERROR', '抛错 → AI_TRANSPORT_ERROR');
    const noT = await ai.decideBatch({ items: ITEMS, cfg: { ai: {} } });
    eq(noT.code, 'AI_NO_TRANSPORT', 'transport 非函数 → AI_NO_TRANSPORT');
  }

  /* ---------------- 18. AI_SCOPE frozen 且 chapterQuiz===true ---------------- */
  console.log('== 18. AI_SCOPE ==');
  {
    ok(Object.isFrozen(ai.AI_SCOPE), 'AI_SCOPE frozen');
    eq(ai.AI_SCOPE.chapterQuiz, true, '★ chapterQuiz===true');
    ok(ai.ALLOWED_KINDS.indexOf('chapter_work') >= 0 && ai.ALLOWED_KINDS.indexOf('popup_quiz') >= 0, '白名单含 chapter_work / popup_quiz');
  }

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过 ==');
  process.exit(0);
})();
