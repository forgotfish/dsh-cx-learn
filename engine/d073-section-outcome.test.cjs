#!/usr/bin/env node
/* ============================================================================
 * d073-section-outcome.test.cjs —— 「本节是否完成」收口 + 白播/振荡修复的回归护栏
 *
 * 复测报告（v0.3.2 真机）：
 *   1. sectionsCompleted 恒 0 → maxSections 判据永不成立（33 分钟走 4 节，一次没触发）
 *   2. A 类：已绿视频被 greenEarly 推着白播（1.3 卡0 从 85.9% → 98.4%，白播 7 分 19 秒）
 *   3. B 类：1.5 收尾振荡 → UNRECOGNIZED_PAGE exit 2
 *   4. failed 卡曾参与并集通过（漏刷 + 虚增计数）
 *
 * 本文件钉死：
 *   G1 计数唯一出口：本次起播过 → completed；纯跳过 → skipped
 *   G2 进节即绿（entry 进度已达判定线）→ 不算 greenEarly（不白播）
 *   G3 切卡守卫按「本卡目标是否判定完成」，不看播放器 ended/98.5
 *   G4 换卡后的视频消失 → 豁免失败计数（不触发 FATAL）
 *   G5 无目标视频的卡 → 不当异常，交回卡片驱动
 *   G6 采集失败 → 停机 card_collect_failed（可配关掉，但绝不 +1）
 *   G7 learn.json 的 sections[] 不被 reportLearn 冲掉
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

const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

function mkCfg(over) {
  const cfg = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  });
  E.humanize.configure(cfg.humanize);
  return over ? E.mergeConfig(cfg, over) : cfg;
}

function mkMachine(o) {
  const opt = o || {};
  const rec = { find: 0, clicks: 0 };
  const a = {
    engine: 'fake',
    async evalInFrame(fid, expr) {
      const e = String(expr);
      if (e.indexOf('cardsInfo') >= 0) return opt.cardsInfo || { ok: false, noProbe: true };
      if (e.indexOf('__cx.find(') >= 0) { rec.find += 1; return opt.findFail ? { ok: false, reason: 'not-found' } : { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'cardsTab' }; }
      if (e.indexOf('ans-attach-ct') >= 0) return 3;
      return null;
    },
    async click() { rec.clicks += 1; return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  const m = new E.LearnMachine(a, mkCfg(opt.cfg));
  return { m, rec };
}

function st(opts) {
  const o = opts || {};
  const frames = [{ frameId: 'top', url: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1', isTop: true }];
  if (o.cards !== false) frames.push({ frameId: 'cards', url: 'https://mooc1/x/knowledge/cards?knowledgeid=K1&num=0', isTop: false });
  return {
    url: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1',
    topUrl: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1',
    frames,
    toc: { found: true, items: [{ chapterId: 'K1', current: true, title: '1.1', done: false, unfinish: 1 }] },
    video: o.video || { found: false },
    videoFrameId: (o.video && o.video.frameId) || '',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };
}

const VIDEO = { found: true, paused: false, ended: false, progress: 90, currentTime: 90, duration: 100, frameId: 'vf', objectid: 'OID_A', src: 'https://x/OID_A/sd.mp4' };

(async () => {
  /* ---------------- G1 计数唯一出口 ---------------- */
  console.log('== G1. 计数唯一出口：起播过=completed / 纯跳过=skipped ==');
  {
    const { m } = mkMachine();
    m._playedThisSection = false;
    m._countSectionOutcome();
    ok(m.counters.sectionsSkipped === 1 && m.counters.sectionsCompleted === 0,
      '★ 未起播 → skipped+1（实际 completed=' + m.counters.sectionsCompleted + ' skipped=' + m.counters.sectionsSkipped + '）');

    const { m: m2 } = mkMachine();
    m2._playedThisSection = true;
    m2._countSectionOutcome();
    ok(m2.counters.sectionsCompleted === 1 && m2.counters.sectionsSkipped === 0,
      '★ 起播过 → completed+1（实际 completed=' + m2.counters.sectionsCompleted + '）');

    /* 不能借 _startedVideoSrcs（跨节不清的坑） */
    const { m: m3 } = mkMachine();
    m3._startedVideoSrcs.add('https://x/OID_A/sd.mp4');
    m3._playedThisSection = false;
    m3._countSectionOutcome();
    ok(m3.counters.sectionsSkipped === 1,
      '★ ★ 只认本节专用标志，不认跨节的 _startedVideoSrcs（实际 skipped=' + m3.counters.sectionsSkipped + '）');
  }

  /* ---------------- G2 进节即绿不白播 ---------------- */
  console.log('== G2. 进节时进度已达判定线 → 不算 greenEarly（不白播）==');
  {
    /* 复测案例：进节 85.9% 但**平台已标绿** → 判为「早已看完」，不该再播 */
    const { m } = mkMachine();
    m._lastInventory = { at: Date.now(), tasks: [
      { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    ] };
    const v = Object.assign({}, VIDEO, { paused: true, progress: 85.9 });
    m._noteVideoEntry(v, st({ video: v }));   /* 进节快照：平台已绿 */
    ok(m._doneAtEntry(v) === true, '★ ★ 进节 85.9% + 平台已绿 → 判为「早已看完」（不白播）');

    /* 对照：进节时平台未绿 → 不是「早已看完」 */
    const { m: m2 } = mkMachine();
    m2._lastInventory = { at: Date.now(), tasks: [
      { kind: 'video', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    ] };
    const v2 = Object.assign({}, VIDEO, { progress: 10 });
    m2._noteVideoEntry(v2, st({ video: v2 }));
    ok(m2._doneAtEntry(v2) === false, '★ 进节时平台未绿 → 不是「早已看完」');
  }

  /* ---------------- G3 切卡守卫 ---------------- */
  console.log('== G3. 切卡守卫按「目标是否判定完成」，不看 98.5/ended ==');
  {
    /* 平台已绿（任务点全 finished）→ 允许切，即使播放器还在播 */
    const { m } = mkMachine();
    m._lastInventory = { at: Date.now(), tasks: [
      { kind: 'video', finished: true, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    ] };
    const s = st({ video: Object.assign({}, VIDEO, { paused: false, progress: 85.9 }) });
    ok(m._currentCardTargetsSettled(s) === true,
      '★ 平台已绿 + 还在播 → 允许切卡（复测 1.3 卡0 就该这样，别再白播到 98.4%）');

    /* 未完成且未绿 → 不许切 */
    const { m: m2 } = mkMachine();
    m2._lastInventory = { at: Date.now(), tasks: [
      { kind: 'video', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' },
    ] };
    ok(m2._currentCardTargetsSettled(st({ video: VIDEO })) === false,
      '★ 有未完成且未绿 → 不许切卡（继续播）');

    /* 没有播放器元素 → 不阻塞 */
    ok(m2._currentCardTargetsSettled(st({ video: { found: false } })) === true,
      '★ 无播放器元素 → 不阻塞切卡');
  }

  /* ---------------- G4 换卡豁免 ---------------- */
  console.log('== G4. 换卡后的视频消失 → 豁免失败计数 ==');
  {
    const { m } = mkMachine();
    m._cardSwitchAt = Date.now();
    ok(m._recentlySwitchedCard() === true, '★ 刚切卡 → 在豁免窗口内');
    m._cardSwitchAt = Date.now() - 20000;
    ok(m._recentlySwitchedCard() === false, '★ 20 秒前切过 → 不在窗口内（默认 8s）');
  }

  /* ---------------- G5 无目标视频的卡 ---------------- */
  console.log('== G5. 当前卡没有目标视频 → 不是异常 ==');
  {
    const { m } = mkMachine();
    m._lastInventory = { at: Date.now(), tasks: [] };
    ok(m._currentCardHasNoTargetVideo(st()) === true, '★ 空任务点 → 判定本卡无目标视频');
    m._lastInventory = { at: Date.now(), tasks: [{ kind: 'video', finished: false, frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }] };
    ok(m._currentCardHasNoTargetVideo(st()) === false, '★ 有视频任务点 → 不是无目标卡');
  }

  /* ---------------- G6 采集失败停机 ---------------- */
  console.log('== G6. 卡片采集失败 → 停机 card_collect_failed（可配关掉，但绝不 +1）==');
  {
    const TWO = { ok: true, total: 2, cards: [
      { i: 0, seq: 1, num: 0, total: 2, cardid: 'CA', title: 'a' },
      { i: 1, seq: 2, num: 1, total: 2, cardid: 'CB', title: 'b' }] };
    const { m } = mkMachine({ cardsInfo: TWO, findFail: true });
    m._cardCollect = { key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, cards: TWO.cards, title: 't' };
    m._cardScan = new Map([['CA', { media: 1, finished: 1 }]]);
    await m._ensureCardsScanned(st({ video: { found: false } }));
    ok(m.stopReason === 'card_collect_failed', '★ 默认停机（实际 ' + String(m.stopReason) + '）');
    ok(m.counters.sectionsCompleted === 0 && m.counters.sectionsSkipped === 0, '★ 绝不计入任何计数');

    /* 关掉开关 → 不停机，但并集仍 fail-closed（不判完成） */
    const { m: m2 } = mkMachine({ cardsInfo: TWO, findFail: true, cfg: { safety: { stopOnCardCollectFailed: false } } });
    m2._cardCollect = { key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, cards: TWO.cards, title: 't' };
    m2._cardScan = new Map([['CA', { media: 1, finished: 1 }]]);
    await m2._ensureCardsScanned(st({ video: { found: false } }));
    ok(!m2.stopReason, '★ 关掉开关后不停机（实际 ' + String(m2.stopReason) + '）');
    ok(m2._cardsUnionDone(st()) === false, '★ ★ 但仍不许判本节完成（fail-closed）');
  }

  /* ---------------- G7 reportLearn 不冲掉 sections ---------------- */
  console.log('== G7. learn.json 的 sections[] 不被 reportLearn 冲掉 ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d073-'));
    process.env.CX_STATE_DIR = tmp;
    delete require.cache[require.resolve(path.join(__dirname, 'state-bus.js'))];
    const bus = require(path.join(__dirname, 'state-bus.js'));
    bus.reportSection({ chapterId: 'K1', total: 2, cards: [{ cardid: 'A' }] });
    bus.reportLearn({ phase: 'running', section: '1.1' });
    const j = JSON.parse(fs.readFileSync(path.join(tmp, 'engine', '.state', 'learn.json'), 'utf8'));
    ok(Array.isArray(j.sections) && j.sections.length === 1,
      '★ ★ reportLearn 之后 sections[] 仍在（实际 ' + (j.sections || []).length + ' 条）');
    ok(j.phase === 'running', '  其它字段照常写入');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
