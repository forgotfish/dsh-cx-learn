#!/usr/bin/env node
/* ============================================================================
 * d077-count-by-progress.test.cjs —— 「播过」必须按实际推进量算，不能按「点过播放」
 *
 * 复测证据（v0.3.8 真机，machine.js 旧 3190/3198）：
 *   1.1/1.2 元数据就绪、没点 → played:false → skipped+1（对）
 *   1.3/1.5 readyState=0，WAIT_LOAD 点了 videoToggle 推动加载 → 实际只播 1.9s / 0.2s
 *          → progress 过 0.5% → _markVideoStarted → played:true → completed+1（错）
 *   后果：maxSections=3 的配额被这两节占掉，一轮 3 节预算只兑现 1 节真视频。
 *
 * 本文件钉死：
 *   C1 只「点一下推动加载」（推进 < 阈值）→ skipped，不占 maxSections 配额
 *   C2 真的播够（advance >= completedMinPlayedSec）→ completed
 *   C3 进度维度单独立（maxProgressPct >= completedMinProgressPct）→ completed
 *   C4 端到端：驱动真 tick，视频 currentTime 每拍只走 0.05 秒（近似不动）→ 最终 skipped
 *   C5 端到端：视频正常推进 → completed
 *   C6 主动快照：连续多拍结不了论 → 会调 captureProblemSnapshot（复现包不再是空的）
 *   C7 pluginVersion 进包（能归到某个 release）
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const fs = require('node:fs');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* ★ 测试隔离：必须在 require 引擎之前把状态目录指到临时目录，
   否则 C6 的主动快照会写进**生产** engine/.state/diagnostics（实测污染 23 个文件）。 */
const os = require('node:os');
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d077-'));
process.env.CX_STATE_DIR = TEST_STATE;

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
  m._lastInventory = { at: Date.now(), tasks: [{ kind: 'video', finished: false, objectid: 'h_oid', frameUrl: 'https://repro.invalid/knowledge/cards?knowledgeid=h_k' }] };
  m._cardCollect = { key: 'h_k', state: 'single', startedAt: Date.now(), total: 0, cards: [], title: 'repro' };
  m._cardScan = new Map();
  return m;
}

(async () => {
  /* ---------------- C1~C3：纯计数判据 ---------------- */
  console.log('== C1. 只点一下推动加载（推进不足）→ skipped ==');
  {
    const m = mkMachine();
    m._maxAdvanceThisSection = 1.9;    /* 复测 1.3：1.9s / 3424.4s */
    m._maxProgressThisSection = 0.06;
    m._countSectionOutcome();
    ok(m.counters.sectionsSkipped === 1 && m.counters.sectionsCompleted === 0,
      '★ ★ 1.9 秒 → skipped，不占 maxSections 配额（completed=' + m.counters.sectionsCompleted + ' skipped=' + m.counters.sectionsSkipped + '）');

    const m2 = mkMachine();
    m2._maxAdvanceThisSection = 0.2;   /* 复测 1.5：0.2s / 5211.6s */
    m2._maxProgressThisSection = 0.004;
    m2._countSectionOutcome();
    ok(m2.counters.sectionsSkipped === 1, '★ ★ 0.2 秒 → skipped');
  }

  console.log('== C2/C3. 真播够 / 进度达标 → completed ==');
  {
    const m = mkMachine();
    m._maxAdvanceThisSection = 120;
    m._countSectionOutcome();
    ok(m.counters.sectionsCompleted === 1, '★ 实播 120 秒 → completed');

    const m2 = mkMachine();
    m2._maxAdvanceThisSection = 2;      /* 秒数不够，但进度到 99.6%（如续播到底） */
    m2._maxProgressThisSection = 99.6;
    m2._countSectionOutcome();
    ok(m2.counters.sectionsCompleted === 1, '★ ★ 进度 99.6% → completed（进度维度可独立成立）');
  }

  /* ---------------- C4：端到端「点过但没播」 ---------------- */
  console.log('== C4. 端到端：currentTime 几乎不动 → 最终 skipped ==');
  {
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 100000 } } });
    let t = 0;
    m.gatherState = async () => {
      t += 0.05;   /* 每拍只走 0.05 秒 —— 相当于「点了播放但没真正播」 */
      return mkSt({ found: true, paused: false, ended: false, progress: 0.05, currentTime: t, duration: 3424.4, frameId: 'vf', objectid: 'h_oid', readyState: 4 });
    };
    m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
    m._recordCurrentCard = () => { };
    /* 直接走结算，模拟「本节被判完成」的那一刻 */
    for (let i = 0; i < 40; i += 1) { await m.tick(); if (m.stopReason) break; }
    m._countSectionOutcome();
    ok(m.counters.sectionsSkipped === 1 && m.counters.sectionsCompleted === 0,
      '★ ★ 只推进约 2 秒 → 结算为 skipped（maxAdvance≈' + Math.round((m._maxAdvanceThisSection || 0) * 10) / 10 + '）');
  }

  /* ---------------- C5：端到端「真播」 ---------------- */
  console.log('== C5. 端到端：视频正常推进 → completed ==');
  {
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 100000 } } });
    let t = 0;
    m.gatherState = async () => {
      t += 5;   /* 每拍走 5 秒 */
      return mkSt({ found: true, paused: false, ended: false, progress: Math.min(99, t / 10), currentTime: t, duration: 3600, frameId: 'vf', objectid: 'h_oid', readyState: 4 });
    };
    m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
    m._recordCurrentCard = () => { };
    for (let i = 0; i < 15; i += 1) { await m.tick(); if (m.stopReason) break; }
    m._countSectionOutcome();
    ok(m.counters.sectionsCompleted === 1,
      '★ ★ 实播几十秒 → completed（maxAdvance≈' + Math.round((m._maxAdvanceThisSection || 0) * 10) / 10 + '）');
  }

  /* ---------------- C6：主动快照 ---------------- */
  console.log('== C6. 连续多拍结不了论 → 主动保存诊断快照 ==');
  {
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 100000, proactiveSnapshotTicks: 3 } } });
    const got = [];
    m.captureProblemSnapshot = async (st, reason) => { got.push(reason); };
    m.gatherState = async () => mkSt({ found: true, paused: false, ended: false, progress: 0, currentTime: 0, duration: 0, frameId: 'vf', objectid: 'h_oid', readyState: 0 });
    m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
    m._recordCurrentCard = () => { };
    for (let i = 0; i < 12 && !m.stopReason; i += 1) { await m.tick(); }
    await new Promise((r) => setTimeout(r, 30));
    ok(got.indexOf('section_stuck_proactive') >= 0,
      '★ ★ 空转时会主动拍快照（实际 ' + JSON.stringify(got) + '）—— 复现包不再是空的');
    ok(got.filter((x) => x === 'section_stuck_proactive').length === 1,
      '★ 每节最多拍一次（不刷盘）');
  }

  /* ---------------- C7：pluginVersion 进包 ---------------- */
  console.log('== C7. 复现包带插件版本（可归到某个 release）==');
  {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const pkg = R.sanitizeRepro({ snapshots: [], learn: null, env: { pluginVersion: pkgJson.version, engineVersion: '1.0.0' } });
    ok(pkg.environment.pluginVersion === pkgJson.version,
      '★ ★ environment.pluginVersion = ' + pkg.environment.pluginVersion + '（= package.json）');
    ok(pkg.environment.engineVersion === '1.0.0',
      '★ engineVersion 仍如实反映引擎内部版本（两者不混用）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
  try { fs.rmSync(TEST_STATE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
