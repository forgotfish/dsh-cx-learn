/* ============================================================================
 * engine/src/core/questions.js — 题目事件（识别 → 人工审阅）JSONL 写入与去重
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { fs, path } = require('./base.js');
const { logger } = require('./logging.js');

/* 题目事件只用于「识别 -> 人工审阅」链路：不带答案，不触发页面动作。
 * 文件路径每次调用时从环境变量读取：宿主经 spawn 注入；独立运行/自测可动态指定。 */
const emittedQuestionKeys = new Set();
function questionEventId(kind, question, options) {
  const raw = [kind, question, ...(options || []).map((o) => (o && (o.label || o.letter)) || '')].join('|');
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'q-' + (h >>> 0).toString(16);
}
function emitQuestionEvent(event) {
  const questionFile = process.env.CX_QUESTION_FILE || '';
  if (!questionFile || !event || !event.kind) return '';
  const id = event.id || questionEventId(event.kind, event.question, event.options);
  if (emittedQuestionKeys.has(id)) return id;
  emittedQuestionKeys.add(id);
  const record = {
    event: 'question_detected', id, detectedAt: new Date().toISOString(),
    ...event, id,
  };
  try {
    fs.mkdirSync(path.dirname(questionFile), { recursive: true });
    fs.appendFileSync(questionFile, JSON.stringify(record) + '\n');
  } catch (e) {
    logger.warn('QUIZ', '题目事件写入失败', { error: String(e && e.message || e).slice(0, 160) });
  }
  return id;
}

module.exports = {
  emittedQuestionKeys,
  questionEventId,
  emitQuestionEvent
};
