#!/usr/bin/env node
/* ============================================================================
 * d070-targetkinds-state.test.cjs —— D-070 的两项：
 *   A) targetKinds 可配置（复测建议 (4)）
 *   B) 本节卡片采集表落盘到 learn.json sections[]（复测建议 (2) 后半段）
 *
 * 重点钉住两件事：
 *   · targetKinds 默认必须仍是 ['video','audio']（**不许悄悄改掉历史行为**）
 *   · 落盘只作提示，**不许反过来影响切节判定**（判据仍以平台任务点为准）
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const ENGINE = path.join(__dirname);
const J = require(path.join(ENGINE, 'src', 'learn', 'judge.js'));

/* ================= A. targetKinds ================= */
console.log('== A1. 默认行为不变（video+audio 都算目标）==');
{
  ok(Array.isArray(J.DEFAULT_TARGET_KINDS) && J.DEFAULT_TARGET_KINDS.join(',') === 'video,audio',
    '★ 默认 targetKinds = video,audio（实际 ' + JSON.stringify(J.DEFAULT_TARGET_KINDS) + '）');
  const tasks = [
    { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    { kind: 'audio', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
  ];
  const r = J.pendingSectionVideos(tasks, 'K1');
  ok(r.total === 2 && r.finished === 1, '★ 不传 targetKinds 时 audio 也算目标（实际 total=' + r.total + ' finished=' + r.finished + '）');
  ok(J.areTargetTasksDone(tasks, 'K1').ok === false, '★ 有 audio 未完成 → 未完成');
}

console.log('== A2. 显式 targetKinds=[video] 时忽略 audio ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    { kind: 'audio', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
  ];
  const r = J.pendingSectionVideos(tasks, 'K1', ['video']);
  ok(r.total === 1 && r.finished === 1, '★ 只统计 video（实际 total=' + r.total + '）');
  const done = J.areTargetTasksDone(tasks, 'K1', ['video']);
  ok(done.ok === true && done.kinds.join(',') === 'video', '★ 只按 video 判 → 已完成，且 kinds 回显（实际 ' + JSON.stringify(done) + '）');
}

console.log('== A3. 接答题用 [video,quiz] ==');
{
  const tasks = [
    { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    { kind: 'quiz', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
  ];
  ok(J.areTargetTasksDone(tasks, 'K1', ['video']).ok === true, '  只认 video → 已完成');
  ok(J.areTargetTasksDone(tasks, 'K1', ['video', 'quiz']).ok === false, '★ 加上 quiz 后 → 未完成（答题接入后能生效）');
}

console.log('== A4. 破坏：空/非法 targetKinds 回落到默认，不崩 ==');
{
  /* 空/非数组/全空白 → 回落默认；含垃圾项时**不崩**，且绝不能因此误判「已完成」 */
  for (const bad of [[], null, undefined, [''], ['  '], 'video']) {
    let threw = false; let r = null;
    try { r = J.normalizeKinds(bad); } catch (_) { threw = true; }
    ok(!threw && Array.isArray(r) && r.length === 2 && r.join(',') === 'video,audio',
      '★ normalizeKinds(' + JSON.stringify(bad) + ') → 回落默认（实际 ' + JSON.stringify(r) + '）');
  }
  {
    let threw = false; let r = null;
    try { r = J.normalizeKinds([null, 3]); } catch (_) { threw = true; }
    ok(!threw && Array.isArray(r), '★ 含垃圾项不崩（实际 ' + JSON.stringify(r) + '）');
    const t = [{ kind: 'video', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }];
    const d = J.areTargetTasksDone(t, 'K1', [null, 3]);
    ok(d.ok === false, '★ ★ 垃圾 kinds 下绝不能判「已完成」（has-video 未播，实际 ' + JSON.stringify(d) + '）');
  }
  const tasks = [{ kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }];
  ok(J.areTargetTasksDone(null, 'K1').stale === false && J.areTargetTasksDone(null, 'K1').ok === false,
    '★ null tasks：不崩、不算完成');
}

console.log('== A5. stale（任务点属于别的节）→ 不给结论 ==');
{
  /* 注意：knowledgeIdOf 只认数字知识号，用 OTHER 不会构成 stale —— 必须用别的数字号 */
  const tasks = [{ kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=999999' }];
  const r = J.areTargetTasksDone(tasks, 'K1', ['video']);
  ok(r.stale === true && r.ok === false, '★ stale → ok:false（实际 ' + JSON.stringify(r) + '）');
}

/* ================= B. 落盘 ================= */
console.log('== B1. reportSection：按 chapterId upsert、跨节共存 ==');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d070-b1-'));
  process.env.CX_STATE_DIR = tmp;
  delete require.cache[require.resolve(path.join(ENGINE, 'state-bus.js'))];
  const bus = require(path.join(ENGINE, 'state-bus.js'));

  bus.reportSection({ chapterId: 'K1', title: '1.1', kind: 'multi', total: 2, cards: [{ cardid: 'A', media: 3, finished: 1 }] });
  bus.reportSection({ chapterId: 'K1', title: '1.1', kind: 'multi', total: 2, cards: [{ cardid: 'A', media: 3, finished: 3 }] });
  bus.reportSection({ chapterId: 'K2', title: '1.2', kind: 'single', total: 1, cards: [{ cardid: 'C', media: 1, finished: 1 }] });

  const file = path.join(tmp, 'engine', '.state', 'learn.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(Array.isArray(j.sections) && j.sections.length === 2, '★ sections 两条（K1/K2），实际 ' + (j.sections || []).length);
  const k1 = j.sections.filter((x) => x.chapterId === 'K1');
  ok(k1.length === 1, '★ ★ K1 只保留一条（upsert 而不是追加）实际 ' + k1.length);
  ok(k1[0].cards[0].finished === 3, '★ K1 被最后一次写入覆盖（finished=3，实际 ' + k1[0].cards[0].finished + '）');
  ok(!!k1[0].collectedAt, '  带 collectedAt 时间戳');
  ok(j.layer === 'learn', '  保留 layer=learn（不破坏既有字段）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('== B2. 破坏：无 chapterId → 不写、不崩 ==');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d070-b2-'));
  process.env.CX_STATE_DIR = tmp;
  delete require.cache[require.resolve(path.join(ENGINE, 'state-bus.js'))];
  const bus = require(path.join(ENGINE, 'state-bus.js'));
  let threw = false; let r = null;
  try { r = bus.reportSection({ title: 'x' }); } catch (_) { threw = true; }
  ok(!threw && r === false, '★ 无 chapterId → 返回 false 不崩（实际 ' + JSON.stringify(r) + '）');
  ok(!fs.existsSync(path.join(tmp, 'engine', '.state', 'learn.json')), '★ 没有凭空创建 learn.json');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('== B3. 上限：最多保留 50 节 ==');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d070-b3-'));
  process.env.CX_STATE_DIR = tmp;
  delete require.cache[require.resolve(path.join(ENGINE, 'state-bus.js'))];
  const bus = require(path.join(ENGINE, 'state-bus.js'));
  for (let i = 0; i < 60; i += 1) bus.reportSection({ chapterId: 'K' + i, total: 1, cards: [] });
  const j = JSON.parse(fs.readFileSync(path.join(tmp, 'engine', '.state', 'learn.json'), 'utf8'));
  ok(j.sections.length === 50, '★ 截断到 50（实际 ' + j.sections.length + '）');
  ok(j.sections[j.sections.length - 1].chapterId === 'K59', '★ 保留最新一节 K59（实际 ' + j.sections[j.sections.length - 1].chapterId + '）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('== B4. 落盘不得影响切节判定（只作提示）==');
{
  const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
  const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
  E.humanize.configure(cfg.humanize);
  const m = new E.LearnMachine({ engine: 'fake', getTargetId() { return 'top'; }, shutdown() { }, async evalInFrame() { return { ok: false, noProbe: true }; } }, cfg);
  const st = { frames: [], toc: { found: true, items: [{ chapterId: 'K9', current: true }] }, video: { found: false }, dialogs: [], human: [], quiz: { present: false }, videoQuiz: { present: false }, quizTab: { present: false } };
  /* learn.json 里就算有 K9 的“全绿”历史，也不该让 _cardsUnionDone 放行 */
  m._cardCollect = null;
  m._cardScan = new Map();
  ok(m._cardsUnionDone(st) === false, '★ ★ 无本节采集记录 → false（历史 sections 不参与判定）');
}

console.log('== B5. machine 采集后真的调了 reportSection（端到端串联）==');
{
  const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
  const { BUS } = require(path.join(ENGINE, 'src', 'core', 'base.js'));
  const seen = [];
  const orig = BUS.reportSection;
  BUS.reportSection = (e) => { seen.push(e); return true; };
  try {
    const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
    E.humanize.configure(cfg.humanize);
    const m = new E.LearnMachine({ engine: 'fake', getTargetId() { return 'top'; }, shutdown() { }, async evalInFrame() { return null; } }, cfg);
    m._lastInventory = { at: Date.now(), tasks: [
      { kind: 'video', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
      { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    ] };
    const st = {
      frames: [{ frameId: 'cards', url: 'https://x/knowledge/cards?knowledgeid=K1&num=0', isTop: false }],
      toc: { found: true, items: [{ chapterId: 'K1', current: true, title: '1.1' }] },
      video: { found: false }, dialogs: [], human: [], quiz: { present: false }, videoQuiz: { present: false }, quizTab: { present: false },
    };
    const col = { key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, title: '1.1',
      cards: [{ i: 0, num: 0, cardid: 'CA', title: 'a' }, { i: 1, num: 1, cardid: 'CB', title: 'b' }] };
    m._recordCurrentCard(st, col);
    ok(seen.length === 1, '★ 记录当前卡后调了 1 次 reportSection（实际 ' + seen.length + '）');
    const e0 = seen[0] || {};
    ok(e0.chapterId === 'K1', '★ 落盘带 chapterId（实际 ' + String(e0.chapterId) + '）');
    ok(e0.kind === 'multi' && e0.total === 2, '★ 带 kind=multi / total=2（实际 ' + JSON.stringify({ kind: e0.kind, total: e0.total }) + '）');
    ok(Array.isArray(e0.cards) && e0.cards.length === 2, '★ cards 两条（实际 ' + (e0.cards || []).length + '）');
    const ca = (e0.cards || []).find((c) => c.cardid === 'CA') || {};
    ok(ca.collected === true && ca.media === 2 && ca.finished === 1,
      '★ ★ CA 采集结果正确（media=2/finished=1，实际 ' + JSON.stringify(ca) + '）');
    const cb = (e0.cards || []).find((c) => c.cardid === 'CB') || {};
    ok(cb.collected === false, '★ CB 未采集（collected=false，实际 ' + JSON.stringify(cb) + '）');
  } finally {
    BUS.reportSection = orig;
  }
}

console.log('');
if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('== 全部通过（' + pass + ' 项）==');
