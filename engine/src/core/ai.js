/* ============================================================================
 * engine/src/core/ai.js — AI 答题策略层：范围锁、prompt 构造、严格解析、审计
 * ----------------------------------------------------------------------------
 * 契约见 docs/AI-ANSWER-FRAMEWORK.md（§1 分层 / §2 策略 / §5 解析 / §6 审计）。
 *
 * ★ 本模块只做「文本 → 选项下标」，永远不会碰页面。
 *   点不点、提不提交由 machine.js 决定，这是原有边界，不放宽。
 * ==========================================================================*/
'use strict';

const crypto = require('node:crypto');
const { fs, path, sleep } = require('./base.js');

/* ============================================================================
 * 第 1 节 · 策略层（硬边界，代码锁死）
 * ============================================================================
 * Object.freeze 防运行时篡改。任何 kind 不在白名单 → decide()/decideBatch()
 * 直接拒绝，不发网络请求。
 * ★ 2026-11-15 D-020 解开章节测验：chapterQuiz 放开，白名单只留
 *   'chapter_work'（作业/章节测验页）与 'popup_quiz'（非视频内嵌弹层题）。
 * ★ 2026-11-15 主人：视频随堂题永不用 AI（不计成绩，纯浪费）→ videoQuiz 锁 false。 */
const AI_SCOPE = Object.freeze({ videoQuiz: false, chapterQuiz: true });

/* 白名单：只有「章节测验」系的两个 kind。★ 视频随堂题明确不在内
   （2026-11-15 主人：随堂题不计成绩，用 AI 纯浪费）——即使有人误调也一律 SCOPE_DENIED。 */
const ALLOWED_KINDS = Object.freeze(['chapter_work', 'popup_quiz']);

/* ============================================================================
 * 第 2 节 · buildPrompt —— 构造 prompt（两态：有图 / 无图）
 * ============================================================================
 * 超星题干用 font-cxsecret 加密字体渲染，DOM 里是密文，只有截图才是明文；
 * 因此有图时只发图，无图时退回「题目 + 选项列表」（文本此时价值有限）。 */
function buildPrompt(input) {
  const { question, options, image } = input || {};
  const opts = Array.isArray(options) ? options : [];
  const labels = opts.map(function (o, i) {
    return (o && (o.letter || String.fromCharCode(65 + i))) + '. ' + ((o && o.label) || '');
  }).join('\n');
  if (image) {
    return '这是考试题目的截图（超星用加密字体渲染，截图里才是明文）。\n' +
      '请读出题干和全部选项，判断正确答案是哪一个。\n' +
      '只输出正确选项的字母（A/B/C/D），不要任何解释。';
  }
  return '题目：' + (question || '') + '\n选项：\n' + labels +
    '\n\n只输出正确选项的字母（A/B/C/D…），不要任何解释。';
}

/* ============================================================================
 * 第 3 节 · parseAnswer —— 严格解析（宁可放弃不猜）
 * ============================================================================
 * 合法： "B" / "b" / "答案：B" / "B." / "（B）"
 * 非法： "A或B" / "AB" / 空 / 无字母 / 两个以上不同字母
 *   → index = -1，code:'AI_AMBIGUOUS'
 * 置信度：high = 回复去空白后长度 ≤ 6 且恰含 1 个 A-Z 字母；否则 low。 */
function parseAnswer(text, optionCount) {
  const count = Number(optionCount) > 0 ? Number(optionCount) : 26;
  const s = String(text == null ? '' : text).trim();
  const fail = { index: -1, letter: '', confidence: 'low', code: 'AI_AMBIGUOUS' };
  if (!s) return fail;
  /* 全串必须恰好出现一个英文字母（大小写合计）——多一个即歧义 */
  const hits = s.match(/[A-Za-z]/g) || [];
  if (hits.length !== 1) return fail;
  const letter = hits[0].toUpperCase();
  const idx = letter.charCodeAt(0) - 65;
  if (idx < 0 || idx >= count) return fail;
  const compact = s.replace(/\s+/g, '');
  const high = compact.length <= 6;
  return { index: idx, letter, confidence: high ? 'high' : 'low' };
}

/* ============================================================================
 * 第 4 节 · audit —— 审计记录（不落盘 prompt 与图片，只存 hash 与长度）
 * ============================================================================
 * 追加到 CX_QUESTION_FILE（questions.jsonl）。★ 只写 rawHash 与 rawLen，
 * 绝不写 prompt 正文 / 图片 / base64，避免题库与隐私泄漏。 */
function audit(record) {
  const file = process.env.CX_QUESTION_FILE || '';
  if (!file || !record) return '';
  const raw = String(record.raw == null ? '' : record.raw);
  const rec = {
    event: 'ai_answer',
    id: record.id || '',
    kind: record.kind || '',
    provider: record.provider || '',
    model: record.model || '',
    letter: record.letter || '',
    confidence: record.confidence || 'low',
    ms: Math.max(0, Math.round(Number(record.ms) || 0)),
    dryRun: !!record.dryRun,
    rawHash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12),
    rawLen: raw.length,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (_) {
    /* 审计失败不影响主链路（与其他 JSONL 事件一致：只降级不抛） */
  }
  return rec.id;
}

/* ============================================================================
 * 第 5 节 · decide —— 决策：范围检查 → transport → 严格解析 → 审计
 * ============================================================================
 * kind 不在白名单 → 立即 {ok:false, code:'AI_SCOPE_DENIED'}，★ 不调用 transport。 */
async function decide(input) {
  const { kind, question, options, image, cfg, transport } = input || {};
  const ai = (cfg && cfg.ai) || {};
  const provider = ai.provider || 'host';
  const dryRun = ai.dryRun !== false;
  const model0 = ai.model || '';
  const optCount = Array.isArray(options) ? options.length : 0;

  /* —— 策略闸门：非白名单 kind 零成本拒绝，绝不触达 transport —— */
  if (ALLOWED_KINDS.indexOf(kind) < 0) {
    return { ok: false, index: -1, letter: '', confidence: 'low', model: '', ms: 0, code: 'AI_SCOPE_DENIED' };
  }
  if (!optCount) {
    return { ok: false, index: -1, letter: '', confidence: 'low', model: '', ms: 0, code: 'AI_NO_OPTIONS' };
  }
  if (typeof transport !== 'function') {
    return { ok: false, index: -1, letter: '', confidence: 'low', model: '', ms: 0, code: 'AI_NO_TRANSPORT' };
  }

  const started = Date.now();
  const prompt = buildPrompt({ kind, question, options, image });
  const maxRetries = Number.isFinite(Number(ai.maxRetries)) ? Number(ai.maxRetries) : 2;
  const timeoutMs = Number(ai.timeoutMs) > 0 ? Number(ai.timeoutMs) : 20000;
  const attempts = Math.max(1, maxRetries + 1);

  let text = '';
  let usedModel = model0;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    text = '';
    try {
      const r = await transport({ prompt, image: image || '', model: model0, provider, timeoutMs, kind });
      const t = typeof r === 'string' ? r : (r && r.text) || '';
      if (r && r.model) usedModel = r.model;
      text = String(t || '');
    } catch (e) {
      lastErr = e;
    }
    if (text.trim()) break;
    /* 上游偶尔「成功返回但正文为空」，重试；用尽才判定失败 */
    if (attempt < attempts) await sleep(800 * attempt);
  }
  const ms = Date.now() - started;

  if (!text.trim()) {
    audit({ kind, provider, model: usedModel, letter: '', confidence: 'low', ms, dryRun, raw: text });
    return {
      ok: false, index: -1, letter: '', confidence: 'low', model: usedModel, ms,
      code: lastErr ? 'AI_TRANSPORT_ERROR' : 'AI_EMPTY',
    };
  }

  const parsed = parseAnswer(text, optCount);
  let ok = parsed.index >= 0;
  let code = ok ? undefined : 'AI_AMBIGUOUS';
  /* low 置信度是否放弃，由配置决定（默认 false = 仍采纳） */
  if (ok && parsed.confidence === 'low' && ai.requireHighConfidence) {
    ok = false;
    code = 'AI_LOW_CONFIDENCE';
  }

  audit({
    kind, provider, model: usedModel, letter: parsed.letter,
    confidence: parsed.confidence, ms, dryRun, raw: text,
  });

  return {
    ok,
    index: ok ? parsed.index : -1,
    letter: ok ? parsed.letter : '',
    confidence: parsed.confidence,
    model: usedModel,
    ms,
    ...(code ? { code } : {}),
  };
}

/* ============================================================================
 * 第 6 节 · buildBatchPrompt —— 批量答题 prompt（纯文本，见 §13 模板）
 * ============================================================================
 * items: [{ id, type:'single'|'judge'|'multi', question, options:[{letter,label}] }]
 * ★ 必须内联 JSON.stringify(items)，不做额外包裹（宿主是哑管道）。 */
function buildBatchPrompt(items) {
  const list = Array.isArray(items) ? items : [];
  return '你是答题助手。下面是一批题目（JSON）。只输出 JSON，不要解释、不要 Markdown 代码块。\n' +
    '格式：{"answers":[{"id":"q1","choice":"B"},{"id":"q2","choice":""}]}\n' +
    '规则：\n' +
    '- 单选题/判断题只填一个字母；\n' +
    '- 多选填多个字母连写（如 "AC"）；\n' +
    '- 完全不确定就留空字符串，不要猜；\n' +
    '- id 必须原样回填。\n' +
    '题目：' + JSON.stringify(list);
}

/* ============================================================================
 * 第 7 节 · parseBatchAnswer —— 批量答复严格解析（§13 步骤 1–5）
 * ============================================================================
 * 1. 去三重反引号围栏 → 取第一个 { 到最后一个 } → JSON.parse（失败 AI_BAD_JSON）
 * 2. 逐条校验：id 存在、字母都在该题选项范围内、非 multi 只能 1 个字母；
 *    非法 → dropped[{id,reason}]；choice 为空/纯空白 → unresolved[id]
 * 3. 成功项 { id, letters:'B', index:<0基下标>, indexList:[...] }；multi 的 index 取 indexList[0]
 * 4. 大写化（b→B）；id 去首尾空白；重复 id 只保留第一次出现。 */
function parseBatchAnswer(text, items) {
  const list = Array.isArray(items) ? items : [];
  const fail = { ok: false, code: 'AI_BAD_JSON', answers: [], unresolved: [], dropped: [] };

  let s = String(text == null ? '' : text);
  /* 去掉三重反引号围栏（含可选语言标记），只保留正文 */
  s = s.replace(/```[A-Za-z0-9_-]*[ \t]*\r?\n?/g, '').replace(/```/g, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < first) return fail;

  let parsed;
  try { parsed = JSON.parse(s.slice(first, last + 1)); } catch (_) { return fail; }
  if (!parsed || !Array.isArray(parsed.answers)) return fail;

  /* id → item */
  const byId = new Map();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it && it.id != null) byId.set(String(it.id).trim(), it);
  }

  const answers = [];
  const unresolved = [];
  const dropped = [];
  const seen = new Set();

  for (let i = 0; i < parsed.answers.length; i++) {
    const a = parsed.answers[i];
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id == null ? '' : a.id).trim();
    const item = byId.get(id);
    if (!item) { dropped.push({ id, reason: 'unknown_id' }); continue; }
    if (seen.has(id)) { dropped.push({ id, reason: 'duplicate_id' }); continue; }
    seen.add(id);

    const type = String(item.type || '').toLowerCase();
    const opts = Array.isArray(item.options) ? item.options : [];
    const letterToIdx = {};
    for (let j = 0; j < opts.length; j++) {
      const L = String((opts[j] && opts[j].letter) || String.fromCharCode(65 + j)).toUpperCase();
      if (letterToIdx[L] === undefined) letterToIdx[L] = j;
    }

    const compact = String(a.choice == null ? '' : a.choice).replace(/\s+/g, '').toUpperCase();
    if (!compact) { unresolved.push(id); continue; }

    const letters = compact.split('');
    if (!letters.every((c) => /^[A-Z]$/.test(c))) { dropped.push({ id, reason: 'bad_letter' }); continue; }
    if (letters.some((c) => letterToIdx[c] === undefined)) { dropped.push({ id, reason: 'letter_out_of_range' }); continue; }

    const uniq = [];
    for (let k = 0; k < letters.length; k++) if (uniq.indexOf(letters[k]) < 0) uniq.push(letters[k]);
    if (type !== 'multi' && uniq.length !== 1) { dropped.push({ id, reason: 'single_multiple_letters' }); continue; }

    const indexList = uniq.map((c) => letterToIdx[c]);
    answers.push({ id, letters: uniq.join(''), index: indexList[0], indexList });
  }

  return { ok: true, answers, unresolved, dropped };
}

/* ============================================================================
 * 第 8 节 · decideBatch —— 批量决策：范围检查 → transport → 解析 → 审计
 * ============================================================================
 * 与 decide() 同类语义（maxRetries/timeoutMs/空正文重试）。
 * 策略闸门：任一「非 multi」项带 kind 且不在白名单 → 整批 AI_SCOPE_DENIED（零 transport）。 */
async function decideBatch(input) {
  const { items, cfg, transport } = input || {};
  const list = Array.isArray(items) ? items : [];
  const empty = { answers: [], unresolved: [], dropped: [] };

  if (!list.length) return { ok: false, code: 'AI_NO_ITEMS', ...empty };

  /* —— 策略闸门：任一项若声明 kind，必须在白名单内 ——
     ★ 2026-11-15 修 BUG：原来 `type==='multi'` 直接 continue，导致「多选题」完全
     绕过 kind 检查——随堂题若以 multi 形态进来就永不拒绝。现在对**所有**项检查 kind。 */
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const k = it && it.kind;
    if (k && ALLOWED_KINDS.indexOf(k) < 0) {
      return { ok: false, code: 'AI_SCOPE_DENIED', ...empty };
    }
  }

  if (typeof transport !== 'function') return { ok: false, code: 'AI_NO_TRANSPORT', ...empty };

  const ai = (cfg && cfg.ai) || {};
  const provider = ai.provider || 'host';
  const dryRun = ai.dryRun !== false;
  const model0 = ai.model || '';
  const maxRetries = Number.isFinite(Number(ai.maxRetries)) ? Number(ai.maxRetries) : 2;
  const timeoutMs = Number(ai.timeoutMs) > 0 ? Number(ai.timeoutMs) : 20000;
  const attempts = Math.max(1, maxRetries + 1);

  const started = Date.now();
  const prompt = buildBatchPrompt(list);
  let text = '';
  let usedModel = model0;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    text = '';
    try {
      const r = await transport({ prompt, image: '', model: model0, provider, timeoutMs });
      const t = typeof r === 'string' ? r : (r && r.text) || '';
      if (r && r.model) usedModel = r.model;
      text = String(t || '');
    } catch (e) {
      lastErr = e;
    }
    if (text.trim()) break;
    if (attempt < attempts) await sleep(800 * attempt);
  }
  const ms = Date.now() - started;

  if (!text.trim()) {
    return {
      ok: false, code: lastErr ? 'AI_TRANSPORT_ERROR' : 'AI_EMPTY',
      answers: [], unresolved: [], dropped: [], model: usedModel, ms,
    };
  }

  const parsed = parseBatchAnswer(text, list);
  for (let i = 0; i < parsed.answers.length; i++) {
    const a = parsed.answers[i];
    /* ★ 2026-11-15 修 BUG：原来 letter/confidence 硬编码 'B'/'high'，审计永远记错。
       现在记真实解析出的字母；置信度按「单字母=high、多字母=low」给保守值。 */
    const letters = String((a && a.letters) || '');
    audit({
      kind: 'batch', id: a.id, provider, model: usedModel,
      letter: letters, confidence: letters.length === 1 ? 'high' : 'low',
      ms, dryRun, raw: text,
    });
  }
  return { ...parsed, model: usedModel, ms };
}

module.exports = {
  AI_SCOPE,
  ALLOWED_KINDS,
  buildPrompt,
  parseAnswer,
  decide,
  audit,
  buildBatchPrompt,
  parseBatchAnswer,
  decideBatch,
};
