#!/usr/bin/env node
/* ============================================================================
 * cards-switch.test.cjs —— D-064「一节多知识卡片（num=0/1/…）」的测试
 *
 * 依据复测者实测（跨 6 节）：
 *   · 切换条在最外层 studentstudy：ul.prev_ul > li[cardid][onclick=changeDisplayContent(seq,total,...)]
 *   · 与「章内子任务」的 ul.prev_ul **同名不同实例**，必须靠 onclick+cardid 鉴别，否则误点章节测验
 *   · 单卡节是常态（6 节 4 节只有 1 张卡）；单卡 ≠ 单任务点
 *   · 切卡后 cards frame id 不变，只有子 frame 全死；任务点 ~883ms 后可读 → 轮询而非固定 sleep
 *
 * 覆盖：
 *   A. 探针层：cardsInfo 只认 cardid+changeDisplayContent；resolve('cardsTab') 定位/越界
 *   B. 机器层：单卡退化不切 / 双卡切到未扫卡 / 播放中不切 / 切卡失败只试一次（不循环）
 *              / 并集判定（全绿 true、有 pending false、failed 卡忽略、空 null）
 *
 * 用法：node engine/cards-switch.test.cjs
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const vm = require('node:vm');
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
const sel = require(path.join(__dirname, 'src', 'learn', 'selectors.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* ---------------- A. 探针层 ---------------- */
function makeLi(opts) {
  const o = opts || {};
  return {
    _attrs: o.attrs || {},
    _text: o.text || '',
    getAttribute(n) { return this._attrs[n] === undefined ? null : this._attrs[n]; },
    get innerText() { return this._text; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 40, height: 20 }; },
    querySelector(s) {
      if (s === '.spanText') return { innerText: o.spanText || this._text };
      return null;
    },
    scrollIntoView() { },
    click() { },
  };
}

function loadProbe(lis) {
  const doc = {
    querySelectorAll(s) { return s === sel.SELECTORS.cardsTabSel ? lis : []; },
  };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.top = sandbox;        /* 顶层窗口：真实浏览器里 window.top === window */
  sandbox.parent = sandbox;
  sandbox.document = doc;
  sandbox.console = console;
  sandbox.__CX_SEL = sel.SELECTORS;
  sandbox.__CX_KWS = [];
  sandbox.__CX_PATTERN = 'x';
  sandbox.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  vm.createContext(sandbox);
  vm.runInContext(sel.PAGE_PROBE_SRC, sandbox, { filename: 'PAGE_PROBE_SRC.js' });
  return sandbox;
}

console.log('== A1. cardsInfo 只认「cardid + changeDisplayContent」的 li（不误点章内子任务/章节测验）==');
{
  const quizTab = makeLi({ text: '2章节测验', attrs: { title: '章节测验' } });   // 章内子任务：无 cardid
  const videoTab = makeLi({ text: '1视频', attrs: { title: '视频' } });          // 章内子任务：无 cardid
  const cardA = makeLi({ text: '2教学课件', spanText: '教学课件', attrs: { cardid: 'CARD_A', onclick: "changeDisplayContent(2,4,'K1','CO1','CL1','');" } });
  const cardB = makeLi({ text: '3教案', spanText: '教案', attrs: { cardid: 'CARD_B', onclick: "changeDisplayContent(3,4,'K1','CO1','CL1','');" } });
  const noOnclick = makeLi({ text: '4其他', attrs: { cardid: 'CARD_C' } });      // 有 cardid 但无 onclick → 排除
  const win = loadProbe([quizTab, videoTab, cardA, cardB, noOnclick]);
  const info = win.__cx.cardsInfo();
  ok(info.ok === true, '  cardsInfo ok');
  ok(info.total === 2, '★ 只认 2 张真卡片（实际 ' + info.total + '）');
  ok(info.cards.map((c) => c.cardid).join(',') === 'CARD_A,CARD_B', '★ cardid 只含 A/B（实际 ' + info.cards.map((c) => c.cardid).join(',') + '）');
  ok(info.cards[0].seq === 2 && info.cards[0].num === 1, '★ seq=2 → num=1（实际 seq=' + info.cards[0].seq + ' num=' + info.cards[0].num + '）');
  ok(info.cards[0].total === 4, '★ total 取自 onclick 第2参=4（实际 ' + info.cards[0].total + '）');
  ok(info.cards[1].title === '教案', '★ 标题取 .spanText（实际 ' + info.cards[1].title + '）');
}

console.log('== A2. resolve(cardsTab)：按过滤后的下标定位，越界返回 null ==');
{
  const quizTab = makeLi({ text: '2章节测验', attrs: { title: '章节测验' } });
  const cardA = makeLi({ text: '2教学课件', attrs: { cardid: 'CARD_A', onclick: 'changeDisplayContent(2,2,\'K\',\'C\',\'L\',\'\');' } });
  const cardB = makeLi({ text: '3教案', attrs: { cardid: 'CARD_B', onclick: 'changeDisplayContent(3,3,\'K\',\'C\',\'\',\'\');' } });
  const win = loadProbe([quizTab, cardA, cardB]);
  const r0 = win.__cx.find('cardsTab', { index: 0 });
  const r1 = win.__cx.find('cardsTab', { index: 1 });
  const r9 = win.__cx.find('cardsTab', { index: 9 });
  ok(!!r0 && r0.ok && r0.note === 'cardsTab#0', '★ index0 → cardsTab#0（实际 ' + JSON.stringify(r0 && r0.note) + '）');
  ok(!!r1 && r1.ok && r1.note === 'cardsTab#1', '★ index1 → cardsTab#1（实际 ' + JSON.stringify(r1 && r1.note) + '）');
  ok(!!r9 && r9.ok === false && r9.reason === 'not-found', '★ 越界 → not-found（实际 ' + JSON.stringify(r9 && r9.reason) + '）');
}

/* ---------------- B. 机器层 ---------------- */
const cfg = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
});
E.humanize.configure(cfg.humanize);

const CARDS_URL_0 = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=K1&num=0&ut=s';

function mkAdapter(opts) {
  const o = opts || {};
  const st = { clicks: [], findCalls: null, infoCalls: 0, attachPolls: 0 };
  const a = {
    engine: 'fake',
    async evalInFrame(fid, expr) {
      const e = String(expr);
      if (e.indexOf('cardsInfo') >= 0) { st.infoCalls += 1; return o.cardsInfo; }
      if (e.indexOf('__cx.find(') >= 0) {
        st.findCalls = (st.findCalls || 0) + 1;
        if (o.findFails) return { ok: false, reason: 'not-found' };
        return { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'cardsTab' };
      }
      if (e.indexOf('ans-attach-ct') >= 0) { st.attachPolls += 1; return o.attachCount === undefined ? 3 : o.attachCount; }
      return null;
    },
    async click(fid, rect) { st.clicks.push({ fid, rect }); return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  return { a, st };
}

function mkSt(opts) {
  const o = opts || {};
  return {
    frames: [
      { frameId: 'top', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=K1', isTop: true },
      { frameId: 'cards', url: o.cardsUrl || CARDS_URL_0, isTop: false },
    ],
    toc: { found: true, layer: 2, items: [{ title: '1.1', chapterId: 'K1', current: true, done: false }] },
    video: o.video || { found: false },
    dialogs: [], human: [], quiz: null, videoQuiz: null, quizTab: null,
  };
}

function mkMachine(o) {
  const { a, st } = mkAdapter(o);
  const m = new E.LearnMachine(a, cfg);
  m._lastInventory = {
    tasks: (o.tasks !== undefined ? o.tasks : [{ kind: 'video', finished: false, objectid: 'A', frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }]),
  };
  return { m, st };
}

const TWO_CARDS = { ok: true, total: 2, cards: [
  { i: 0, seq: 1, num: 0, total: 2, cardid: 'CARD_A', title: '视频' },
  { i: 1, seq: 2, num: 1, total: 2, cardid: 'CARD_B', title: '教学课件' },
] };
const ONE_CARD = { ok: true, total: 1, cards: [{ i: 0, seq: 1, num: 0, total: 1, cardid: 'CARD_S', title: '1' }] };

(async () => {
  console.log('== B1. 单卡节：退化，不切卡 ==');
  {
    const { m, st } = mkMachine({ cardsInfo: ONE_CARD });
    const r = await m._ensureCardsScanned(mkSt());
    ok(r === null, '★ 返回 null（不切卡，实际 ' + JSON.stringify(r) + '）');
    ok(st.findCalls === null || st.findCalls === 0, '★ 一次 find/点击都没发（实际 findCalls=' + st.findCalls + '）');
  }

  console.log('== B2. 双卡节：切到「未扫过」的那张卡 ==');
  {
    const { m, st } = mkMachine({ cardsInfo: TWO_CARDS });
    const step = await m._ensureCardsScanned(mkSt());
    ok(!!step && step.outcome === 'CARD_SWITCHED', '★ 返回 CARD_SWITCHED（实际 ' + JSON.stringify(step) + '）');
    ok(st.clicks.length === 1 && st.clicks[0].fid === 'top', '★ 在外层文档点击 1 次（实际 ' + JSON.stringify(st.clicks.map((c) => c.fid)) + '）');
    ok(m._cardScan.has('CARD_A'), '  当前卡 CARD_A 已记录（media/finished）');
    // 已切过 CARD_B 后（模拟下一拍：curNum=1 且 B 已记）→ 不再切
    const { m: m2, st: st2 } = mkMachine({ cardsInfo: TWO_CARDS });
    m2._cardScanKey = 'K1';
    m2._cardScan = new Map([['CARD_A', { media: 3, finished: 3 }], ['CARD_B', { media: 7, finished: 2 }]]);
    const stx = mkSt({ cardsUrl: CARDS_URL_0.replace('num=0', 'num=1') });
    const step2 = await m2._ensureCardsScanned(stx);
    ok(step2 === null && (st2.clicks.length === 0), '★ 两卡都已扫过 → 不再切（实际 ' + JSON.stringify(step2) + '）');
  }

  console.log('== B3. 播放中不切卡（避免打断）==');
  {
    const { m, st } = mkMachine({ cardsInfo: TWO_CARDS });
    const step = await m._ensureCardsScanned(mkSt({ video: { found: true, paused: false, ended: false } }));
    ok(step === null, '★ 正在播 → 不切（实际 ' + JSON.stringify(step) + '）');
    ok(st.clicks.length === 0, '★ 无点击（实际 ' + st.clicks.length + '）');
  }

  console.log('== B4. 切卡失败：只试一次、记 failed、不循环 ==');
  {
    const { m, st } = mkMachine({ cardsInfo: TWO_CARDS, findFails: true });
    const step1 = await m._ensureCardsScanned(mkSt());
    ok(step1 === null, '★ 失败返回 null（实际 ' + JSON.stringify(step1) + '）');
    ok(st.findCalls === 1, '★ find 只调 1 次（实际 ' + st.findCalls + '）');
    ok(m._cardScan.get('CARD_B') && m._cardScan.get('CARD_B').failed === true, '★ 该卡记为 failed');
    const step2 = await m._ensureCardsScanned(mkSt());
    ok(step2 === null, '★ 下一拍不再重试同一张卡（实际 ' + JSON.stringify(step2) + '）');
    ok(st.findCalls === 1, '★ find 仍然只 1 次（不循环，实际 ' + st.findCalls + '）');
  }

  console.log('== B5. 并集判定 _cardsUnionDone ==');
  {
    const { m } = mkMachine({ cardsInfo: TWO_CARDS });
    ok(m._cardsUnionDone({}) === null, '  空 Map → null（无法判定）');
    m._cardScan = new Map([['A', { media: 3, finished: 3 }], ['B', { media: 7, finished: 7 }]]);
    ok(m._cardsUnionDone({}) === true, '★ 全部 finished → true');
    m._cardScan = new Map([['A', { media: 3, finished: 3 }], ['B', { media: 7, finished: 2 }]]);
    ok(m._cardsUnionDone({}) === false, '★ 有卡片未完成 → false（不许切节）');
    m._cardScan = new Map([['A', { media: 3, finished: 3 }], ['B', { media: 0, finished: 0, failed: true }]]);
    ok(m._cardsUnionDone({}) === true, '★ 切不过去的卡（failed）忽略 → true');
    m._cardScan = new Map([['A', { media: 0, finished: 0 }]]);
    ok(m._cardsUnionDone({}) === true, '★ 纯文档卡（media=0）不算未完成 → true');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });

