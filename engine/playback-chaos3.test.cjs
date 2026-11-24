#!/usr/bin/env node
/* ============================================================================
 * playback-chaos3.test.cjs —— 第三批破坏测试（D-068 的验收）
 *
 * 本批针对「第一批/第二批都没覆盖、靠读代码才看出来」的地方：
 *
 *   E1  切节清账：上一节有未完成卡 → 新节**没有卡片条**时，_cardsUnionDone 不得被残留数据卡住
 *   E2  切节清账：新节有自己的卡 → 必须重新开始扫描（不沿用旧 cardid）
 *   E3  倍速与起播解耦：setRate 只设 playbackRate，**不调用 play()**
 *   E4  倍速在多视频帧里 oid 匹配不上 → 明确失败并带 videoCount（不静默）
 *   E5  stall 边界：连续 8 拍不放弃、第 9 拍才放弃（有界、不早不晚）
 *   E6  直播任务点不得走 playByObjectId 兜底（live 不是 <video>）
 *   E7  破坏：setRate 传非法 rate（0/负/NaN/字符串）→ 明确失败不崩
 *   E8  破坏：matchVideo 在 document 抛错时不崩
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

const OID = 'ce7e74d32326c2bb443bdf2b46e03971';
const OID2 = '1857487a82a1e07f1a2d072765de7542';

function mkVideo(o) {
  const opt = o || {};
  return {
    _src: opt.src === undefined ? ('https://x/' + OID + '/sd.mp4') : opt.src,
    muted: false, playbackRate: 1, paused: true, readyState: 4, playCalls: 0,
    get currentSrc() { return this._src; },
    getAttribute() { return null; },
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
  };
}

function loadProbe(videos, opts) {
  const o = opts || {};
  const sb = {};
  sb.window = sb; sb.top = sb; sb.parent = sb;
  sb.document = { querySelectorAll(s) { if (o.throwOnQuery && s === 'video') throw new Error('boom'); return s === 'video' ? videos : []; } };
  sb.console = console;
  sb.__CX_SEL = sel.SELECTORS; sb.__CX_KWS = []; sb.__CX_PATTERN = 'x';
  sb.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  vm.createContext(sb);
  vm.runInContext(sel.PAGE_PROBE_SRC, sb, { filename: 'PAGE_PROBE_SRC.js' });
  return sb;
}

const cfgBase = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
});

function mkMachine(o) {
  const opt = o || {};
  E.humanize.configure(cfgBase.humanize);
  const rec = { attachPolls: 0, findCalls: 0, clicks: 0 };
  const a = {
    engine: 'fake',
    async evalInFrame(fid, expr) {
      const e = String(expr);
      if (e.indexOf('cardsInfo') >= 0) return opt.cardsInfo || { ok: true, total: 0, cards: [] };
      if (e.indexOf('__cx.find(') >= 0) { rec.findCalls += 1; return { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'cardsTab' }; }
      if (e.indexOf('ans-attach-ct') >= 0) { rec.attachPolls += 1; return opt.attachCount === undefined ? 3 : opt.attachCount; }
      return null;
    },
    async click() { rec.clicks += 1; return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  const m = new E.LearnMachine(a, cfgBase);
  m._lastInventory = { tasks: [{ kind: 'video', finished: false, objectid: 'A', frameUrl: 'https://x/knowledge/cards?knowledgeid=K2' }] };
  return { m, rec };
}

function stFor(chapterId, hasCards) {
  const frames = [{ frameId: 'top', url: 'https://mooc1/x/mycourse/studentstudy?chapterId=' + chapterId, isTop: true }];
  if (hasCards) frames.push({ frameId: 'cards', url: 'https://mooc1/x/knowledge/cards?knowledgeid=' + chapterId + '&num=0', isTop: false });
  return { frames, toc: { found: true, items: [{ chapterId, current: true }] }, video: { found: false } };
}

(async () => {
  /* ---------- E1：上一节残留不得卡住「没有卡片条」的新节 ---------- */
  console.log('== E1. 切节清账：新节无卡片条时不得被上节残留卡住 ==');
  {
    const { m } = mkMachine({ cardsInfo: { ok: true, total: 0, cards: [] } });
    /* 模拟上一节：2 张卡，1 张还有 pending */
    m._cardScanKey = 'K1';
    m._cardScan = new Map([['CARD_A', { media: 3, finished: 1 }], ['CARD_B', { media: 2, finished: 2 }]]);
    m._cardScanTotal = 2;
    await m._ensureCardsScanned(stFor('K2', false));       /* 新节 K2，无卡片条 */
    ok(m._cardScan.size === 0, '★ 新节清空上一节的卡片账（实际 size=' + m._cardScan.size + '）');
    ok(m._cardsUnionDone({}) === null, '★ 清空后并集判定回 null（不拦切节，实际 ' + JSON.stringify(m._cardsUnionDone({})) + '）');
  }

  /* ---------- E2：新节有自己的卡 → 重新扫描 ---------- */
  console.log('== E2. 新节有自己的卡 → 重置为 0 张、重新开始 ==');
  {
    const TWO = { ok: true, total: 2, cards: [
      { i: 0, seq: 1, num: 0, total: 2, cardid: 'K2_A', title: 'a' },
      { i: 1, seq: 2, num: 1, total: 2, cardid: 'K2_B', title: 'b' }] };
    const { m } = mkMachine({ cardsInfo: TWO });
    m._cardScanKey = 'K1';
    m._cardScan = new Map([['CARD_A', { media: 3, finished: 3 }]]);
    m._cardScanTotal = 1;
    const step = await m._ensureCardsScanned(stFor('K2', true));
    ok(!!step && step.outcome === 'CARD_SWITCHED', '★ 新节重新开始扫（实际 ' + JSON.stringify(step) + '）');
    ok(m._cardCollect && m._cardCollect.total === 2, '★ 采集到 total=2（实际 ' + JSON.stringify(m._cardCollect && m._cardCollect.total) + '）');
    ok(!m._cardScan.has('CARD_A'), '★ 旧 cardid 不残留');
  }

  /* ---------- E3：setRate 不得调用 play() ---------- */
  console.log('== E3. setRate 只设倍速，不调用 play() ==');
  {
    const v = mkVideo({});
    const win = loadProbe([v]);
    const r = win.__cx.setRate(OID, 1.5);
    ok(r.ok === true && v.playbackRate === 1.5, '★ 倍速已设置（实际 ' + JSON.stringify(r) + '）');
    ok(v.playCalls === 0, '★ ★ 没有调用 play()（实际 ' + v.playCalls + '）—— 这是 D-068 的核心');
  }

  /* ---------- E4：多视频帧 oid 匹配不上 → 明确失败 ---------- */
  console.log('== E4. 多视频帧 oid 不匹配 → setRate 明确失败并带 videoCount ==');
  {
    const win = loadProbe([mkVideo({ src: 'https://x/' + OID2 + '/sd.mp4' }), mkVideo({ src: '' })]);
    const r = win.__cx.setRate(OID, 1.5);
    ok(r.ok === false && r.videoCount === 2, '★ 不静默：返回失败 + videoCount（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- E5：stall 边界 8 拍不放弃、第 9 拍放弃 ---------- */
  console.log('== E5. D-069：点过的卡「等待采集」而不是连点；超时停机 ==');
  {
    /* 2 张卡，第 2 张点了但任务点始终读不到 → 不再重复点，超时后停机报错 */
    const TWO = { ok: true, total: 2, cards: [
      { i: 0, seq: 1, num: 0, total: 2, cardid: 'CA', title: 'a' },
      { i: 1, seq: 2, num: 1, total: 2, cardid: 'CB', title: 'b' }] };
    const { m, rec } = mkMachine({ cardsInfo: TWO, attachCount: 3 });
    E.humanize.configure(cfgBase.humanize);
    /* 把超时压到很小，便于测试 */
    m.cfg.safety.cardDetectTimeoutMs = 120;
    const st = stFor('K1', true);

    /* 第 1 拍：采集到 multi，切到 CB → 进入 await */
    m._cardScanKey = 'K1';
    m._cardScan = new Map([['CA', { media: 3, finished: 3 }]]);
    const step1 = await m._ensureCardsScanned(st);
    ok(!!step1 && step1.outcome === 'CARD_SWITCHED', '★ 首次切到未采集的卡（实际 ' + JSON.stringify(step1) + '）');
    ok(rec.findCalls === 1, '★ 只点了 1 次（实际 ' + rec.findCalls + '）');

    /* 第 2~4 拍：在等采集 → 不许再点（这是复测里「952ms 又切一次同一张卡」的修复） */
    for (let t = 0; t < 3; t += 1) {
      await m._ensureCardsScanned(st);
    }
    ok(rec.findCalls === 1, '★ ★ 等待期间不再重复点击同一张卡（实际 ' + rec.findCalls + ' 次）');

    /* 超过超时 → 停机 card_detect_timeout（可见的失败，不是静默跳过） */
    await new Promise((r) => setTimeout(r, 200));
    const step2 = await m._ensureCardsScanned(st);
    ok(step2 && step2.outcome === 'STOPPED', '★ 超时即停机（实际 ' + JSON.stringify(step2) + '）');
    ok(m.stopReason === 'card_detect_timeout', '★ 停机原因 card_detect_timeout（实际 ' + String(m.stopReason) + '）');
    ok(rec.findCalls === 1, '★ 全程只点 1 次（实际 ' + rec.findCalls + '）');
  }

  /* ---------- E6：直播任务点不走 playByObjectId ---------- */
  console.log('== E6. 直播任务点不得走 playByObjectId 兜底 ==');
  {
    const { m } = mkMachine({});
    const liveTask = { kind: 'live', liveId: '1583740', objectid: '', frameUrl: 'https://x/ananas/modules/live/index.html' };
    const pv = m._sectionPendingVideos({ frames: [], toc: { found: true, items: [{ chapterId: 'K1', current: true }] } });
    /* live 不计入 media pending（sectionPendingVideos 只看 video/audio）*/
    ok(!pv || !Array.isArray(pv.pending) || !pv.pending.some((x) => x.kind === 'live'),
      '★ live 不进 media pending（实际 ' + JSON.stringify(pv && pv.pending) + '）');
    /* 且 playSectionVideo 对没有 frameId 的任务直接返回 no-frame，不会误调兜底 */
    const r = await m.playSectionVideo({}, liveTask);
    ok(r && r.ok === false && r.reason === 'no-frame', '★ live（无 frameId）→ no-frame，不误走兜底（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- E7：setRate 非法 rate ---------- */
  console.log('== E7. setRate 非法 rate（0/负/NaN/字符串）==');
  {
    const v = mkVideo({});
    const win = loadProbe([v]);
    for (const bad of [0, -1, NaN, 'abc']) {
      const r = win.__cx.setRate(OID, bad);
      ok(r.ok === false && v.playbackRate === 1, '★ rate=' + String(bad) + ' → 拒绝且不改页面（实际 ' + JSON.stringify(r) + '）');
    }
  }

  /* ---------- E8：document 抛错不崩 ---------- */
  console.log('== E8. querySelectorAll 抛错 → setRate/playByObjectId 都不崩 ==');
  {
    const win = loadProbe([], { throwOnQuery: true });
    let threw = false; let r1 = null; let r2 = null;
    try { r1 = win.__cx.setRate(OID, 1.5); r2 = win.__cx.playByObjectId(OID, 1); } catch (_) { threw = true; }
    ok(!threw, '★ 不抛错');
    ok(r1 && r1.ok === false && r2 && r2.ok === false, '★ 都明确失败（实际 ' + JSON.stringify([r1, r2]) + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项（真洞）=='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });


