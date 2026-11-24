#!/usr/bin/env node
/* ============================================================================
 * d069-union-gate.test.cjs —— 复测报告（v0.2.8, 1.3 漏刷）的回归护栏
 *
 * 报告指出的三处 fail-open，本文件逐条钉死：
 *   F1 新节沿用上一节 _cardScan（读不到卡片条就 return 且无日志）→ 必须清账
 *   F2 _cardsUnionDone 不校验 chapterId、只遍历「扫到过的卡」→ 必须 fail-closed
 *   F3 进节第一拍卡片条未渲染 + 播放中不切卡 → 整节再无切卡机会
 *   F4 平台 ~86% 标绿就直接切节 → 必须继续播到判定线（不跳过连播/记账/计数）
 *
 * 真机事实（复测者提供）：1.3 多卡节 pending 从 7 到 7（25 分钟一次没减），
 * 后卡 6 个任务点一个没播 —— 这就是 F2 的形态。
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
  safety: { cardDetectTimeoutMs: 15000 },
});

const TWO_CARDS = { ok: true, total: 2, cards: [
  { i: 0, seq: 1, num: 0, total: 2, cardid: 'CARD_A', title: '视频' },
  { i: 1, seq: 2, num: 1, total: 2, cardid: 'CARD_B', title: '教学课件' },
]};

function mkSt(opts) {
  const o = opts || {};
  const frames = [{ frameId: 'top', url: 'https://mooc1/x/mycourse/studentstudy?chapterId=' + (o.chapterId || 'K1'), isTop: true }];
  if (o.hasCardsFrame !== false) {
    frames.push({ frameId: 'cards', url: 'https://mooc1/x/knowledge/cards?knowledgeid=' + (o.chapterId || 'K1') + '&num=' + (o.num || 0), isTop: false });
  }
  return {
    url: 'https://mooc1/x/mycourse/studentstudy?chapterId=' + (o.chapterId || 'K1'),
    topUrl: 'https://mooc1/x/mycourse/studentstudy?chapterId=' + (o.chapterId || 'K1'),
    frames,
    toc: { found: true, items: [{ chapterId: o.chapterId || 'K1', current: true, title: '当前节' }] },
    video: o.video || { found: false },
    videoFrameId: (o.video && o.video.frameId) || '',
    /* tick 的安全闸门会读这些字段，缺了会 TypeError */
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false },
    quizTab: { present: false },
  };
}

function mkMachine(o) {
  const opt = o || {};
  E.humanize.configure(cfgBase.humanize);
  const rec = { findCalls: 0, clicks: 0 };
  const a = {
    engine: 'fake',
    async evalInFrame(fid, expr) {
      const e = String(expr);
      if (e.indexOf('cardsInfo') >= 0) {
        if (opt.cardsInfo === undefined) return { ok: false, noProbe: true };
        return opt.cardsInfo;
      }
      if (e.indexOf('__cx.find(') >= 0) { rec.findCalls += 1; return { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'cardsTab' }; }
      if (e.indexOf('ans-attach-ct') >= 0) return opt.attachCount === undefined ? 3 : opt.attachCount;
      return null;
    },
    async click() { rec.clicks += 1; return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  const m = new E.LearnMachine(a, cfgBase);
  m._lastInventory = { at: Date.now(), tasks: (opt.tasks !== undefined ? opt.tasks
    : [{ kind: 'video', finished: false, objectid: 'A', frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }]) };
  return { m, rec };
}

(async () => {
  /* ---------- F1：新节必须清账（不能沿用上一节的 7/7） ---------- */
  console.log('== F1. 进入新版页/无卡片条的新节，必须清掉上一节账本 ==');
  {
    const { m } = mkMachine({ cardsInfo: { ok: true, total: 0, cards: [] } });
    /* 模拟 1.1 留下的账（复测里正是 {media:7, finished:7}） */
    m._cardCollect = { key: 'K_OLD', state: 'multi', startedAt: Date.now(), total: 1, cards: [{ cardid: 'OLD', num: 0, i: 0, title: 'o' }], title: 'old' };
    m._cardScan = new Map([['OLD', { media: 7, finished: 7 }]]);
    await m._ensureCardsScanned(mkSt({ chapterId: 'K_NEW' }));
    ok(m._cardScan.size === 0, '★ 新节的卡账为空（实际 size=' + m._cardScan.size + '）');
    ok(m._cardsUnionDone(mkSt({ chapterId: 'K_NEW' })) === null, '★ 新节并集判定 null（老页面/无卡片条 → 交回旧逻辑）');
  }

  /* ---------- F1b：单卡节必须「不介入」（不切卡、不点击）---------- */
  {
    const ONE = { ok: true, total: 1, cards: [{ i: 0, seq: 1, num: 0, total: 1, cardid: 'ONLY', title: '唯一' }] };
    const { m, rec } = mkMachine({ cardsInfo: ONE });
    const step = await m._ensureCardsScanned(mkSt({ chapterId: 'K1' }));
    ok(step === null, '★ 单卡节：_ensureCardsScanned 返回 null（实际 ' + JSON.stringify(step) + '）');
    ok(rec.findCalls === 0 && rec.clicks === 0, '★ 单卡节：一次点击都没发（实际 find=' + rec.findCalls + ' click=' + rec.clicks + '）');
    ok(m._cardsUnionDone(mkSt({ chapterId: 'K1' })) === null, '★ 单卡节：并集 null（交回旧逻辑）');
  }

  /* ---------- F1c：读到 ok 但列表为空 → 立即「确认无」，不等超时 ---------- */
  {
    const { m } = mkMachine({ cardsInfo: { ok: true, total: 0, cards: [] } });
    const t0 = Date.now();
    const step = await m._ensureCardsScanned(mkSt({ chapterId: 'K1' }));
    const dt = Date.now() - t0;
    ok(step === null, '★ 返回 null（不介入）');
    ok(m._cardCollect && m._cardCollect.state === 'none',
      '★ ★ 立即判 none（不是 pending）—— 否则已看完的小节会被拖到超时停机（实际 ' + JSON.stringify(m._cardCollect && m._cardCollect.state) + '）');
    ok(dt < 2000, '★ 没有等到超时（耗时 ' + dt + 'ms）');
  }

  /* ---------- F1d：同一张卡点满 3 次仍采不到 → 记 failed 并继续（不无限重试）---------- */
  {
    const TWO = { ok: true, total: 2, cards: [
      { i: 0, seq: 1, num: 0, total: 2, cardid: 'CA', title: 'a' },
      { i: 1, seq: 2, num: 1, total: 2, cardid: 'CB', title: 'b' }] };
    const { m, rec } = mkMachine({ cardsInfo: TWO, attachCount: 0 });
    const st = mkSt({ chapterId: 'K1' });
    m._cardCollect = { key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, cards: TWO.cards, title: 't' };
    m._cardScan = new Map([['CA', { media: 1, finished: 1 }]]);

    /* 反复「点完立刻清掉 _cardAwait」以模拟每次都没采集到（强制走限次分支） */
    for (let i = 0; i < 6; i += 1) {
      await m._ensureCardsScanned(st);
      m._cardAwait = null;                       /* 模拟等待失败/被清空 */
    }
    ok(rec.findCalls === 3, '★ ★ 同一张卡最多点 3 次（实际 ' + rec.findCalls + ' 次）');
    ok(m._cardScan.get('CB') && m._cardScan.get('CB').failed === true,
      '★ 第 3 次后记为 failed 并继续（实际 ' + JSON.stringify(m._cardScan.get('CB')) + '）');
  }

  /* ---------- F2：并集必须 fail-closed（复测报告 1.3 漏刷的核心）---------- */
  console.log('== F2. 并集判定 fail-closed（复测报告 1.3 漏刷的核心）==');
  {
    const { m } = mkMachine({ cardsInfo: TWO_CARDS });
    const st = mkSt({ chapterId: 'K1' });
    /* 采集到 multi，但只采集了第 1 张卡，且它已全绿 */
    m._cardCollect = { key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, cards: TWO_CARDS.cards, title: 't' };
    m._cardScan = new Map([['CARD_A', { media: 7, finished: 7 }]]);
    ok(m._cardsUnionDone(st) === false,
      '★ ★ 只采了 1/2 张卡（另一张不在表里）→ false，不许切节');
    /* 补采第 2 张，仍有未完成 → false */
    m._cardScan.set('CARD_B', { media: 6, finished: 0 });
    ok(m._cardsUnionDone(st) === false, '★ 两张都采了但后卡 0/6 → false');
    /* 两张都完成 → true */
    m._cardScan.set('CARD_B', { media: 6, finished: 6 });
    ok(m._cardsUnionDone(st) === true, '★ 两张都完成 → true');
    /* 换到别的节 → 立刻 fail-closed（不能拿旧节数据放行） */
    ok(m._cardsUnionDone(mkSt({ chapterId: 'K9' })) === false, '★ ★ 换节后立刻 false（chapterId 绑定）');

    /* 采集未完成（pending）/ 超时 → 必须 false（不许静默放行） */
    m._cardCollect = { key: 'K1', state: 'pending', startedAt: Date.now(), total: 2, cards: TWO_CARDS.cards, title: 't' };
    ok(m._cardsUnionDone(st) === false, '★ ★ state=pending → false（采集没完成不许切节）');
    m._cardCollect.state = 'timeout';
    ok(m._cardsUnionDone(st) === false, '★ ★ state=timeout → false');
    m._cardCollect.state = 'multi';
    m._cardScan = new Map([['CARD_A', { media: 1, finished: 1 }], ['CARD_B', { media: 1, finished: 1 }]]);
  }

  /* ---------- F3：点过就等，不重复点（复测里 952ms 又切同一张卡） ---------- */
  console.log('== F3. 切卡后「等待采集」，不重复点击同一张卡 ==');
  {
    const { m, rec } = mkMachine({ cardsInfo: TWO_CARDS, attachCount: 0 });
    m.cfg.safety.cardDetectTimeoutMs = 3000;
    const st = mkSt({ chapterId: 'K1' });
    /* 第 1 拍：采集 multi → 切到 CARD_B（CARD_A 已被记录） */
    m._cardScan = new Map([['CARD_A', { media: 1, finished: 1 }]]);
    const s1 = await m._ensureCardsScanned(st);
    ok(s1 && s1.outcome === 'CARD_SWITCHED', '★ 第 1 拍切卡（实际 ' + JSON.stringify(s1) + '）');
    ok(rec.findCalls === 1, '★ 只点 1 次');
    /* 之后连跑 5 拍：都在等采集 → 绝不能再点 */
    for (let i = 0; i < 5; i += 1) await m._ensureCardsScanned(st);
    ok(rec.findCalls === 1, '★ ★ 5 拍内没有重复点击（实际 ' + rec.findCalls + ' 次）');
    ok(m._cardsUnionDone(st) === false, '★ 采集未完成期间并集为 false（不切节）');
  }

  /* ---------- F4：平台提前标绿 → 不切节，继续播 ---------- */
  console.log('== F4. 平台 ~86% 标绿不得直接切节（greenEarly）==');
  {
    /* 视频本轮起播、进度 86%、平台任务点已绿 → tick 不应 advanceSection */
    const { m } = mkMachine({
      cardsInfo: { ok: true, total: 0, cards: [] },
      tasks: [{ kind: 'video', finished: true, objectid: 'OID1', frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }],
    });
    let advanced = 0;
    m.advanceSection = async () => { advanced += 1; return { progress: true, outcome: 'ADVANCED' }; };
    const st = mkSt({ chapterId: 'K1', video: { found: true, paused: false, ended: false, progress: 86.1, currentTime: 100, duration: 116, frameId: 'vf', objectid: 'OID1', src: 'https://x/OID1/sd.mp4' } });
    m.gatherState = async () => st;
    /* 标记「本次已起播」 */
    m._startedVideoSrcs.add('https://x/OID1/sd.mp4');
    m._lastCurIdx = 0;
    await m.tick();
    ok(advanced === 0, '★ ★ 86% 标绿时不切节（实际 advanced=' + advanced + '）');

    /* 对照：已经播到 99%（超判定线）→ 应允许走完成流程 */
    let advanced2 = 0;
    const { m: m2 } = mkMachine({
      cardsInfo: { ok: true, total: 0, cards: [] },
      tasks: [{ kind: 'video', finished: true, objectid: 'OID1', frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }],
    });
    m2.advanceSection = async () => { advanced2 += 1; return { progress: true, outcome: 'ADVANCED' }; };
    m2.gatherState = async () => mkSt({ chapterId: 'K1', video: { found: true, paused: true, ended: true, progress: 100, currentTime: 116, duration: 116, frameId: 'vf', objectid: 'OID1', src: 'https://x/OID1/sd.mp4' } });
    m2._startedVideoSrcs.add('https://x/OID1/sd.mp4');
    m2._lastCurIdx = 0;
    await m2.tick();
    ok(advanced2 >= 1, '★ 对照：已播完（ended）→ 正常走完成流程（实际 advanced=' + advanced2 + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
