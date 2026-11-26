#!/usr/bin/env node
/* ============================================================================
 * d076-playing-no-progress.test.cjs —— 播放中「毫无进展」必须停机，不得空转
 *
 * 复现形态（真实存在，自测里观测到 41 拍仍在转）：
 *   video.found = true，paused = false（看起来在播）
 *   但 currentTime 恒为 0、duration 也为 0（播放器没真正起播 / 元数据没加载）
 *
 * 为什么不收敛：_progressStalled 里有 `prev > 1` 守卫 ——
 *   prev 恒为 0 时永不进入停滞判定，_stallTicks 每轮被清零 → 永远返回 false。
 *
 * 本文件钉死：
 *   P1 持续不前进 → 有限拍内 stop('section_stuck')，不许无限转
 *   P2 真的在前进（currentTime 递增）→ 不许误杀（长视频不能因为「久了」就停）
 *   P3 停滞后再恢复前进 → 计时复位，不误停
 *   P4 停机日志带可诊断字段（duration / readyState / currentTime）
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

function mkCfg(over) {
  const cfg = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  });
  E.humanize.configure(cfg.humanize);
  return over ? E.mergeConfig(cfg, over) : cfg;
}

/** 造一个「有视频元素、看起来在播、但不前进」的状态 */
function makeSt(v) {
  const K = 'h_repro';
  return {
    url: 'https://repro.invalid/x?chapterId=' + K,
    topUrl: 'https://repro.invalid/x?chapterId=' + K,
    frames: [
      { frameId: 'top', url: 'https://repro.invalid/x?chapterId=' + K, isTop: true },
      { frameId: 'vf', url: 'https://repro.invalid/knowledge/cards?knowledgeid=' + K + '&num=0', isTop: false },
    ],
    toc: { found: true, layer: 1, items: [{ chapterId: K, current: true, title: 'repro', done: false, unfinish: 1 }] },
    video: v,
    videoFrameId: 'vf',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };
}

function mkMachine(opts) {
  const o = opts || {};
  const a = {
    engine: 'repro',
    async evalInFrame() { return { ok: false, noProbe: true }; },
    async click() { return { mode: 'repro' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };
  const m = new E.LearnMachine(a, mkCfg(o.cfg));
  m.gatherState = async () => makeSt(o.video || { found: true, paused: false, ended: false, progress: 0, currentTime: 0, duration: 0, frameId: 'vf', objectid: 'h_oid', readyState: 0 });
  m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
  /* 本节有未完成视频任务点（避免走「无视频卡」分支） */
  m._lastInventory = { at: Date.now(), tasks: [{ kind: 'video', finished: false, objectid: 'h_oid', frameUrl: 'https://repro.invalid/knowledge/cards?knowledgeid=h_repro' }] };
  m._cardCollect = { key: 'h_repro', state: 'single', startedAt: Date.now(), total: 0, cards: [], title: 'repro' };
  m._cardScan = new Map();
  return { m };
}

(async () => {
  console.log('== P1. 持续不前进 → 有限拍内 stop(section_stuck) ==');
  {
    const { m } = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 80 } } });
    let ticks = 0;
    for (; ticks < 200 && !m.stopReason; ticks += 1) await m.tick();
    ok(m.stopReason === 'section_stuck',
      '★ ★ 停机且原因是 section_stuck（实际 ' + String(m.stopReason) + '，ticks=' + (ticks + 1) + '）');
    ok(ticks < 200, '★ ★ 不是靠拍数上限兜底（实际 ' + (ticks + 1) + ' 拍）');
  }

  console.log('== P2. 真的在前进 → 不许误杀（长视频不能因「久了」就停）==');
  {
    let t = 0;
    const { m } = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 60 } } });
    m.gatherState = async () => {
      t += 2;   /* 每拍前进 2 秒 */
      return makeSt({ found: true, paused: false, ended: false, progress: Math.min(99, t), currentTime: t, duration: 7200, frameId: 'vf', objectid: 'h_oid', readyState: 4 });
    };
    let ticks = 0;
    for (; ticks < 60 && !m.stopReason; ticks += 1) await m.tick();
    ok(!m.stopReason, '★ ★ 一直在前进 → 不停机（实际 ' + String(m.stopReason) + '）');
    ok(ticks >= 20, '★ 确实跑了足够多拍（实际 ' + (ticks + 1) + ' 拍，远超 60ms 阈值）');
  }

  console.log('== P3. 停滞后又恢复前进 → 计时复位 ==');
  {
    let t = 0;
    let tickNo = 0;
    const { m } = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 120 } } });
    m.gatherState = async () => {
      tickNo += 1;
      if (tickNo > 5) t += 5;   /* 前 5 拍卡住，之后恢复前进 */
      return makeSt({ found: true, paused: false, ended: false, progress: 10, currentTime: t, duration: 3600, frameId: 'vf', objectid: 'h_oid', readyState: 4 });
    };
    let ticks = 0;
    for (; ticks < 80 && !m.stopReason; ticks += 1) await m.tick();
    ok(!m.stopReason, '★ ★ 恢复前进后不被误停（实际 ' + String(m.stopReason) + '）');
  }

  console.log('== P4. 停机日志带可诊断字段 ==');
  {
    const orig = logger.error;
    let captured = null;
    logger.error = function (tag, msg, data) {
      if (String(msg).indexOf('毫无进展') >= 0) captured = { tag, msg, data };
      return orig.apply(logger, arguments);
    };
    try {
      const { m } = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 60 } } });
      for (let i = 0; i < 200 && !m.stopReason; i += 1) await m.tick();
      ok(!!captured, '★ 打出了「视频长时间毫无进展」日志');
      if (captured) {
        const d = captured.data || {};
        ok(d.duration === 0, '★ ★ 日志带 duration（实际 ' + d.duration + '）');
        ok(typeof d.currentTime === 'number', '★ 日志带 currentTime');
        ok(typeof d.readyState === 'number', '★ 日志带 readyState');
        ok(typeof d.waitedMs === 'number' && d.waitedMs >= 0, '★ 日志带 waitedMs');
      }
    } finally {
      logger.error = orig;
    }
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
