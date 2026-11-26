#!/usr/bin/env node
/* ============================================================================
 * d074-no-target-card.test.cjs —— 复测 U4：末卡无任务点 → 本节结不了论 → 空转
 *
 * 复测（v0.3.5 真机）现象：1.5 节末卡是「教学课件」（0 个任务点），
 * 43.659 切卡 → 8.1 秒豁免窗口（cardSwitchSettleMs=8000）→ 之后掉进
 * 「当前卡没有目标视频」分支，每 40ms 一条，共 1240 条、6 分 50 秒，只能等 12 小时兜底。
 *
 * 根因（复测者定位）：**循环依赖**
 *   _cardsUnionDone 是唯一知道「本节全绿」的判据，但它只在 doneNow.ok === true 时被调用；
 *   doneNow ← isVideoTaskDone，要求「当前卡有目标类任务点且全绿」；
 *   末卡 0 个任务点 → done:false（by:'nothing'）→ 并集永远轮不到。
 *
 * ★ 前提：isVideoTaskDone 对空清单返回 false 是**正确**的，不许改
 *   （judge.test.cjs:85-87 已固化；否则「卡片 frame 还没渲染出任务点」的一瞬会被判完成 = 漏刷）。
 *
 * 本文件钉死：
 *   U4a 末卡无任务点 + 并集全绿 → 有限拍内必须产出结论（advance/stop），计数 +1
 *   U4b 末卡无任务点 + 并集未全绿 → 不许 advance，且必须有限拍内 stop('section_stuck')
 *   U4c 同一 outcome 日志限流（10 秒内最多 1 条），避免 1240 条把有效信息淹掉
 *   U4d 停机前必须有可分辨的收尾日志（toc_end_reached / toc_all_done）
 * ==========================================================================*/
'use strict';
const path = require('node:path');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
const { logger } = require(path.join(__dirname, 'src', 'core', 'logging.js'));
const judge = require(path.join(__dirname, 'src', 'learn', 'judge.js'));

function mkCfg(over) {
  const cfg = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  });
  E.humanize.configure(cfg.humanize);
  return over ? E.mergeConfig(cfg, over) : cfg;
}

/** 造一个「末卡无任务点、已挂在课件卡上」的状态 */
function makeSt() {
  const K1 = 'https://mooc1/x/knowledge/cards?knowledgeid=K1&num=1';
  return {
    url: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1',
    topUrl: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1',
    frames: [
      { frameId: 'top', url: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1', isTop: true },
      { frameId: 'cards', url: K1, isTop: false },
    ],
    toc: { found: true, layer: 1, items: [{ chapterId: 'K1', current: true, title: '1.5', done: false, unfinish: 1 }] },
    /* 末卡（教学课件）没有 <video> 元素 —— 这正是复测里的形态 */
    video: { found: false },
    videoFrameId: '',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };
}

/** 造一台已采集完两卡的机器，末卡 0 条任务点 */
function mkMachine(opts) {
  const o = opts || {};
  const adv = { calls: 0 };
  const a = {
    engine: 'fake',
    async evalInFrame() { return { ok: false, noProbe: true }; },
    async click() { return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  const m = new E.LearnMachine(a, mkCfg(o.cfg));
  m.gatherState = async () => makeSt();
  m.advanceSection = async () => { adv.calls += 1; return { progress: true, outcome: 'SECTION_ADVANCED' }; };

  /* 本节 2 卡：CA（视频 1/1 绿）、CB（教学课件，0 条任务点） */
  m._cardCollect = {
    key: 'K1', state: 'multi', startedAt: Date.now(), total: 2, title: '1.5',
    cards: [
      { i: 0, seq: 1, num: 0, total: 2, cardid: 'CA', title: '1' },
      { i: 1, seq: 2, num: 1, total: 2, cardid: 'CB', title: '教学课件' },
    ],
  };
  m._cardScan = new Map([
    ['CA', { media: 1, finished: 1 }],
    ['CB', { media: o.cbMedia === undefined ? 0 : o.cbMedia, finished: o.cbFinished === undefined ? 0 : o.cbFinished }],
  ]);
  /* 末卡 = 0 条任务点（复测 1.5 的真机形态） */
  m._lastInventory = { at: Date.now(), tasks: [] };
  /* 视频「曾经出现过又消失」：卡 0 见过视频 */
  m._videoSeenThisSection = true;
  m._cardSwitchAt = Date.now() - 30000;   /* 早已过 8 秒豁免窗口（复测 22:04 之后的形态） */
  return { m, adv };
}

(async () => {
  /* ---------------- U4a：并集全绿 → 必须产出结论 ---------------- */
  console.log('== U4a. 末卡无任务点 + 并集全绿 → 有限拍内产出结论 ==');
  {
    const { m, adv } = mkMachine();
    const before = m.counters.sectionsCompleted + m.counters.sectionsSkipped;
    for (let i = 0; i < 20 && !m.stopReason && adv.calls === 0; i += 1) {
      await m.tick();
    }
    const after = m.counters.sectionsCompleted + m.counters.sectionsSkipped;
    ok(adv.calls >= 1 || !!m.stopReason,
      '★ ★ 20 拍内产出结论（advance 或 stop）',
      'advance=' + adv.calls + ' stop=' + String(m.stopReason));
    ok(after === before + 1,
      '★ ★ 计数正好 +1（不重复计、不漏计）',
      'before=' + before + ' after=' + after);
    ok(m.counters.sectionsSkipped === 1 && m.counters.sectionsCompleted === 0,
      '★ 本节没播过视频（卡 0 进节已绿）→ 记为 skipped',
      'completed=' + m.counters.sectionsCompleted + ' skipped=' + m.counters.sectionsSkipped);
  }

  /* ---------------- U4b：并集未全绿 → 不许 advance，但必须有限拍停机 ---------------- */
  console.log('== U4b. 末卡无任务点 + 并集未全绿 → 不 advance，但有限拍内 stop(section_stuck) ==');
  {
    const { m, adv } = mkMachine({ cbMedia: 3, cbFinished: 0, cfg: { safety: { sectionStuckTimeoutMs: 60 } } });
    /* 防止当期卡片被「当前库存（空）」重录成 0/0 —— 否则并集会变成全绿，测不到「未全绿」这条 */
    m._recordCurrentCard = () => { };
    for (let i = 0; i < 400 && !m.stopReason && adv.calls === 0; i += 1) {
      await m.tick();
    }
    ok(adv.calls === 0, '★ ★ 并集未全绿 → 不许切节（实际 advance=' + adv.calls + '）');
    ok(m.stopReason === 'section_stuck',
      '★ ★ 有限拍内停机，且原因是 section_stuck（实际 ' + String(m.stopReason) + '）');
  }

  /* ---------------- U4c：同 outcome 日志限流 ---------------- */
  console.log('== U4c. 同一 outcome 日志限流（10 秒内最多 1 条）==');
  {
    const orig = logger.info;
    let noTargetCount = 0;
    logger.info = function (tag, msg, data) {
      if (String(msg).indexOf('没有目标视频') >= 0) noTargetCount += 1;
      return orig.apply(logger, arguments);
    };
    try {
      const { m } = mkMachine({ cbMedia: 3, cbFinished: 0, cfg: { safety: { sectionStuckTimeoutMs: 100000 } } });
      m._recordCurrentCard = () => { };
      for (let i = 0; i < 30 && !m.stopReason; i += 1) await m.tick();
      ok(noTargetCount <= 1,
        '★ ★ 30 拍里「没有目标视频」日志不超过 1 条（实际 ' + noTargetCount + '）');
    } finally {
      logger.info = orig;
    }
  }

  /* ---------------- U4d：收尾原因可分 ---------------- */
  console.log('== U4d. 收尾停机原因可分（toc_end_reached / toc_all_done）==');
  {
    /* 只剩当前节且已完成 → 后面没有节了 → toc_end_reached */
    const r1 = judge.pickNextSection({ items: [{ i: 0, title: 'a', done: true }], curIdx: 0, mode: 'continue_chapters', completed: 0, maxSections: 10 });
    ok(r1.action === 'stop' && r1.stopReason === 'toc_end_reached',
      '★ 后面没节了 → toc_end_reached（实际 ' + JSON.stringify(r1.stopReason) + '）');

    /* 后面还有节但都已完成 → toc_all_done */
    const r2 = judge.pickNextSection({ items: [{ i: 0, title: 'a', done: true }, { i: 1, title: 'b', done: true }], curIdx: 0, mode: 'continue_chapters', completed: 0, maxSections: 10 });
    ok(r2.action === 'stop' && r2.stopReason === 'toc_all_done',
      '★ 后面还有节但全完成 → toc_all_done（实际 ' + JSON.stringify(r2.stopReason) + '）');

    const src = require('node:fs').readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
    ok(/NORMAL_STOP\s*=\s*\[[^\]]*toc_end_reached/.test(src) && /NORMAL_STOP\s*=\s*\[[^\]]*toc_all_done/.test(src),
      '★ 两种收尾都在 NORMAL_STOP 里（不当作异常退出）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
