#!/usr/bin/env node
/* ============================================================================
 * d079-cross-video-stuck.test.cjs —— section_stuck 不得跨视频误杀（复测 v0.3.9 真机）
 *
 * 现场（UTC）：
 *   17:07:36  视频1 currentTime 348.7 / 521.7（66.8%）
 *   17:07:45  点 vjs-big-play-button → 页面换成视频2
 *   17:07:49  视频2 currentTime 3.1 / 212.4    ← 从 348.7 掉回 3.1
 *   17:08:58  视频2 currentTime 63.7           ← 一直在正常推进
 *   17:10:52  停机 section_stuck  waitedMs 182977（180s 上限）
 *
 * 根因：复位条件是 curT > _lastPlayingTime + 0.2（超过历史最大值的高水位线）。
 *   换视频后 currentTime 必然回退，高水位线再也越不过 → 计时器永不复位 → 误杀。
 *   不是运气：**任何一节有两个任务点都必然被打断**。
 *
 * 本文件钉死：
 *   V1 换视频（currentTime 回退）→ 不得停机，计时必须复位
 *   V2 同一视频真卡住（currentTime 不动）→ 仍然要停（不能因为修 V1 把这条废掉）
 *   V3 pct 判据用增量：进节 10% → 涨到 12% 只算 +2%，不满足 5%
 *   V4 repro 导出多节（不再只剩最后一节）+ --section 选节
 *   V5 主动快照不 pause 健康播放
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d079-'));
process.env.CX_STATE_DIR = TEST_STATE;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
const R = require(path.join(__dirname, 'src', 'repro.js'));

function mkCfg(over) {
  const cfg = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  });
  E.humanize.configure(cfg.humanize);
  return over ? E.mergeConfig(cfg, over) : cfg;
}

function mkSt(video) {
  const K = 'h_k';
  return {
    url: 'https://repro.invalid/x?chapterId=' + K,
    topUrl: 'https://repro.invalid/x?chapterId=' + K,
    frames: [
      { frameId: 'top', url: 'https://repro.invalid/x?chapterId=' + K, isTop: true },
      { frameId: 'vf', url: 'https://repro.invalid/knowledge/cards?knowledgeid=' + K + '&num=0', isTop: false },
    ],
    toc: { found: true, layer: 1, items: [{ chapterId: K, current: true, title: 'repro', done: false, unfinish: 1 }] },
    video, videoFrameId: 'vf',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };
}

function mkMachine(opts) {
  const o = opts || {};
  const a = {
    engine: 'repro', async evalInFrame() { return { ok: false, noProbe: true }; },
    async click() { return { mode: 'repro' }; }, async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; }, shutdown() { },
  };
  const m = new E.LearnMachine(a, mkCfg(o.cfg));
  m._lastInventory = { at: Date.now(), tasks: [
    { kind: 'video', finished: true, objectid: 'oidA', frameUrl: 'https://repro.invalid/knowledge/cards?knowledgeid=h_k' },
    { kind: 'video', finished: false, objectid: 'oidB', frameUrl: 'https://repro.invalid/knowledge/cards?knowledgeid=h_k' },
  ] };
  m._cardCollect = { key: 'h_k', state: 'single', startedAt: Date.now(), total: 0, cards: [], title: 'repro' };
  m._cardScan = new Map();
  m._recordCurrentCard = () => { };
  m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
  return m;
}

(async () => {
  console.log('== V1. 换视频（currentTime 回退）→ 不得误判 section_stuck ==');
  {
    /* 复刻真机时序：先播视频1 到 348.7，然后换视频2 从 3.1 起持续推进 */
    /* ★ 阈值必须小于「测试真的跑过的时间」，否则「不漏停」是空过（V1 曾因此抓不到变异）。 */
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 50 } } });
    let phase = 0;      /* 0=视频1，1=视频2 */
    let t2 = 3.1;
    m.gatherState = async () => {
      if (phase === 0) {
        /* 视频1：播到 348.7 后平台判完成，切到视频2 */
        if (!m._switched) { m._switched = true; phase = 1; }
        return mkSt({ found: true, paused: false, ended: false, progress: 66.8, currentTime: 348.7, duration: 521.7, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 4 });
      }
      t2 += 8;          /* 视频2：每拍推进 8 秒 */
      return mkSt({ found: true, paused: false, ended: false, progress: 30, currentTime: t2, duration: 212.4, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 4 });
    };

    let ticks = 0;
    for (; ticks < 200 && !m.stopReason; ticks += 1) await m.tick();
    ok(!m.stopReason, '★ ★ 换视频后正常推进 → 不停机（实际 ' + String(m.stopReason) + '，ticks=' + (ticks + 1) + '）');
    ok(ticks >= 60, '★ 跨过 50ms 阈值仍未误杀（实际 ' + (ticks + 1) + ' 拍）');

    /* ★ 确定性断言（不靠时序）：真机那个 bug 的本质是「节级计时器跨视频没复位」。
       这里直接验证：视频1 期间把计时器走到非零，换视频2 后**必须归零**。
       —— 只断言「没停机」是不够的：视频一直推进时根本进不了等待分支，
          漏复位也看不出来（M28 曾因此漏测）。 */
    const m2 = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 100000 } } });
    let p2 = 0;
    m2.gatherState = async () => {
      if (p2 === 0) { p2 = 1; return mkSt({ found: true, paused: false, ended: false, progress: 66.8, currentTime: 348.7, duration: 521.7, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 4 }); }
      return mkSt({ found: true, paused: false, ended: false, progress: 1, currentTime: 3.1, duration: 212.4, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 4 });
    };
    /* 先跑一拍识别视频1 */
    await m2.tick();
    /* 人为把计时器「污染」成视频1 已等待很久（模拟真机：视频1 播到末段计过时） */
    m2._sectionStuckSince = Date.now() - 90000;
    ok(m2._sectionStuckSince > 0, '  前置：计时器非零（模拟视频1 期间已累计 90s）');
    /* 换到视频2 */
    await m2.tick();
    ok(m2._sectionStuckSince === 0 || m2._sectionStuckSince > Date.now() - 1000,
      '★ ★ ★ 换视频 → 节级计时器被复位（实际 ' + (m2._sectionStuckSince === 0 ? '0' : (Date.now() - m2._sectionStuckSince) + 'ms 前') + '）');
  }

  console.log('== V2. 同一视频真卡住 → 仍然要停（修 V1 不能把这条废掉）==');
  {
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 120 } } });
    m.gatherState = async () => mkSt({ found: true, paused: false, ended: false, progress: 50, currentTime: 200.0, duration: 400, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 4 });
    let ticks = 0;
    for (; ticks < 300 && !m.stopReason; ticks += 1) await m.tick();
    ok(m.stopReason === 'section_stuck', '★ ★ 同一视频 currentTime 不动 → 仍停 section_stuck（实际 ' + String(m.stopReason) + '）');
  }

  console.log('== V3. pct 判据用增量（进节就在 10% 的续播节不该占配额）==');
  {
    const m = mkMachine();
    const v = { found: true, paused: false, ended: false, progress: 10, currentTime: 100, duration: 3600, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4' };
    m._noteVideoEntry(v, mkSt(v));
    /* 进节 10% → 涨到 12%，只涨 2 个百分点，没到 5% */
    m._noteSectionProgress(Object.assign({}, v, { progress: 12, currentTime: 200 }));
    m._maxAdvanceThisSection = 0;   /* adv 不满足 */
    m._countSectionOutcome();
    ok(m.counters.sectionsSkipped === 1,
      '★ ★ 进节 10%→12% 只算 +2% → skipped（实际 skipped=' + m.counters.sectionsSkipped + '，maxProgressPct=' + m._maxProgressThisSection + '）');
  }

  console.log('== V4. repro 导出多节 + --section 选节 ==');
  {
    const mkSec = (id, title, media, finished) => ({
      chapterId: id, title, kind: 'single', total: 1,
      cards: [{ cardid: id + '_c', num: 0, title, collected: true, media, finished, failed: false }],
    });
    const learn = { sections: [
      mkSec('S1', '1.6.4 某课件', 0, 0),
      mkSec('S2', '1.6.5 某教案', 0, 0),
      mkSec('S3', '1.7.1 某视频', 1, 1),
      mkSec('S4', '1.7.2 某视频', 2, 1),
    ] };
    const pkg = R.sanitizeRepro({ snapshots: [], learn, env: {} });
    ok(Array.isArray(pkg.sections) && pkg.sections.length === 4,
      '★ ★ 导出 4 节（原来只有 1 节，实际 ' + (pkg.sections ? pkg.sections.length : 0) + '）');
    ok(pkg.sections[0].cards[0].media === 0 && pkg.sections[0].cards[0].finished === 0,
      '★ 前面的 document 卡（media:0/finished:0）也在包里了');
    ok(pkg.section.chapterHash === pkg.sections[3].chapterHash,
      '★ 默认 section = 最后一节（兼容 --replay）');

    const pkg2 = R.sanitizeRepro({ snapshots: [], learn, env: {} }, { sectionIndex: 1 });
    ok(pkg2.section.chapterHash === pkg2.sections[0].chapterHash, '★ ★ --section=1 选中第一节');
    const pkg3 = R.sanitizeRepro({ snapshots: [], learn, env: {} }, { sectionIndex: -2 });
    ok(pkg3.section.chapterHash === pkg3.sections[2].chapterHash, '★ --section=-2 从末尾倒数第 2 节');
    const pkg4 = R.sanitizeRepro({ snapshots: [], learn, env: {} }, { maxSectionsInBundle: 2 });
    ok(pkg4.sections.length === 2 && pkg4.sections[1].chapterHash === pkg4.sections[1].chapterHash,
      '★ --sections=2 只导最近 2 节（实际 ' + pkg4.sections.length + '）');
    /* 多节时脱敏仍成立 */
    const txt = JSON.stringify(pkg);
    ok(txt.indexOf('S1') < 0 && txt.indexOf('1.7.2 某视频') < 0, '★ ★ 多节导出里也没有原文（只有 h_ / hashed:）');
  }

  console.log('== V5. 主动快照不在健康播放上 pause ==');
  {
    const m = mkMachine();
    const src = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
    ok(/reason !== 'section_stuck_proactive'/.test(src),
      '★ ★ 源码：只有非主动快照才 pause（主动快照只读，不打断播放）');
  }

  console.log('');
  try { fs.rmSync(TEST_STATE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
