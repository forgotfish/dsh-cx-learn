#!/usr/bin/env node
/* ============================================================================
 * d080-video-scope.test.cjs —— 视频级状态必须按视频隔离（防 D-079 类回归）
 *
 * 这是「反复回归」的结构性防线：
 *   D-069→D-074、D-073→D-077、D-076→D-079 三次都是「节级单槽位做视频级判断」。
 *   本文件直接测**状态隔离**本身，而不是测某一个症状。
 *
 *   W1 换视频 → _stallTicks / _lastProgressTime / _resumeAttempts / _lastPlayingTime 全部归零/更新
 *   W2 两个视频各失败 1 次 resume，**不得**累计到 2 触发 reload（跨视频不累计）
 *   W3 换视频不被判 stuck（_stallTicks 路径）
 *   W4 同一视频内失败 2 次 → 仍然要触发 reload（正向没被废掉）
 *   W5 不变量文档与代码清单一致（INVARIANTS.md I1）
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-d080-'));
process.env.CX_STATE_DIR = TEST_STATE;

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

function mkSt(videoFields) {
  const K = 'h_k';
  return {
    url: 'https://repro.invalid/x?chapterId=' + K,
    topUrl: 'https://repro.invalid/x?chapterId=' + K,
    frames: [
      { frameId: 'top', url: 'https://repro.invalid/x?chapterId=' + K, isTop: true },
      { frameId: 'vf', url: 'https://repro.invalid/knowledge/cards?knowledgeid=' + K + '&num=0', isTop: false },
    ],
    toc: { found: true, layer: 1, items: [{ chapterId: K, current: true, title: 'repro', done: false, unfinish: 1 }] },
    video: videoFields, videoFrameId: 'vf',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };
}

function mkMachine(opts) {
  const o = opts || {};
  const a = {
    engine: 'repro', async evalInFrame() { const r = o.onEval ? o.onEval() : null; return r === undefined ? { ok: false, noProbe: true } : r; },
    async click() { return { mode: 'repro' }; }, async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; }, shutdown() { },
  };
  const m = new E.LearnMachine(a, mkCfg(o.cfg));
  m._lastInventory = { at: Date.now(), tasks: [{ kind: 'video', finished: false, objectid: 'oidB', frameUrl: 'https://repro.invalid/knowledge/cards?knowledgeid=h_k' }] };
  m._cardCollect = { key: 'h_k', state: 'single', startedAt: Date.now(), total: 0, cards: [], title: 'repro' };
  m._cardScan = new Map();
  m._recordCurrentCard = () => { };
  m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
  return m;
}

(async () => {
  console.log('== W1. 换视频 → 视频级计数器全部复位/更新 ==');
  {
    const m = mkMachine();
    let phase = 0;
    m.gatherState = async () => {
      if (phase === 0) {
        return mkSt({ found: true, paused: false, ended: false, progress: 66.8, currentTime: 348.7, duration: 521.7, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 4 });
      }
      return mkSt({ found: true, paused: false, ended: false, progress: 1, currentTime: 3.1, duration: 212.4, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 4 });
    };
    await m.tick();                 /* 第一拍：识别视频1（首拍本身算「从无到有」的切换，会复位） */
    ok(m._lastVideoKey === 'oidA', '  第一拍识别为 oidA（实际 ' + m._lastVideoKey + '）');
    /* ★ 计数在首拍**之后**设，否则会被首拍的「从无到有」复位掉 */
    m._stallTicks = 3;
    m._lastProgressTime = 348.7;
    m._resumeAttempts = 1;
    m._lastPlayingTime = 348.7;
    ok(m._resumeAttempts === 1, '  视频1 已有自己的计数状态（1）');

    phase = 1;
    await m.tick();                 /* 第二拍：换成视频2 */
    ok(m._lastVideoKey === 'oidB', '★ 第二拍识别为 oidB（实际 ' + m._lastVideoKey + '）');
    ok(m._resumeAttempts === 0, '★ ★ 换视频 → _resumeAttempts 归零（实际 ' + m._resumeAttempts + '）');
    ok(m._stallTicks === 0, '★ ★ 换视频 → _stallTicks 归零（实际 ' + m._stallTicks + '）');
    /* 换视频先把 _lastProgressTime 清空，随后同一拍里 _progressStalled 会用**新视频**的
       currentTime 重新播种 —— 这正是正确行为（不再是旧视频的 348.7）。 */
    ok(m._lastProgressTime === 3.1, '★ ★ 换视频 → _lastProgressTime 重新播种为新视频位置 3.1（实际 ' + String(m._lastProgressTime) + '）');
    ok(m._lastPlayingTime === 3.1, '★ 换视频 → _lastPlayingTime 更新到新视频当前位置（实际 ' + m._lastPlayingTime + '）');
  }

  console.log('== W2. 两视频各失败 1 次 → 不累加到 2（跨视频不累计）==');
  {
    const m = mkMachine();
    m.clickFound = async () => ({ ok: true, layer: 1 });   /* 点击成功但视频仍不 ready */
    let phase = 0;
    m.gatherState = async () => {
      if (phase === 0) return mkSt({ found: true, paused: true, ended: false, progress: 10, currentTime: 10, duration: 100, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 1 });
      return mkSt({ found: true, paused: true, ended: false, progress: 1, currentTime: 1, duration: 100, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 1 });
    };
    m._stallTicks = 0;
    await m.tick();          /* 视频1：点播放，假设没起来 → resumeAttempts=1 */
    const a1 = m._resumeAttempts;
    ok(a1 >= 1, '  视频1 累计失败 1 次（实际 ' + a1 + '）');
    phase = 1;
    await m.tick();          /* 换视频2 → 应清零 */
    ok(m._resumeAttempts <= 1,
      '★ ★ 换视频后不继承视频1 的失败次数（实际 ' + m._resumeAttempts + '，清零后最多 1）');
  }

  console.log('== W3. 换视频不被判 stuck（_stallTicks 路径）==');
  {
    /* ★ 同 V1：阈值要小于测试实际耗时，才能真正验证「不停」 */
    const m = mkMachine({ cfg: { safety: { sectionStuckTimeoutMs: 50 } } });
    let phase = 0;
    let t2 = 3.1;
    m.gatherState = async () => {
      if (phase === 0) { phase = 1; return mkSt({ found: true, paused: false, ended: false, progress: 66.8, currentTime: 348.7, duration: 521.7, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 4 }); }
      t2 += 8;
      return mkSt({ found: true, paused: false, ended: false, progress: 30, currentTime: t2, duration: 212.4, frameId: 'vf', objectid: 'oidB', src: 'https://x/oidB.mp4', readyState: 4 });
    };
    let ticks = 0;
    for (; ticks < 120 && !m.stopReason; ticks += 1) await m.tick();
    ok(!m.stopReason, '★ ★ 换视频后持续推进 → 不停机（实际 ' + String(m.stopReason) + '，' + (ticks + 1) + ' 拍）');
  }

  console.log('== W4. 同一视频内失败 2 次 → 仍然触发 reload（正向没废）==');
  {
    const m = mkMachine();
    m.clickFound = async () => ({ ok: true, layer: 1 });
    let reloads = 0;
    m.reloadForFreshVideo = async () => { reloads += 1; return true; };
    m.gatherState = async () => mkSt({ found: true, paused: true, ended: false, progress: 10, currentTime: 10, duration: 100, frameId: 'vf', objectid: 'oidA', src: 'https://x/oidA.mp4', readyState: 1 });
    for (let i = 0; i < 6; i += 1) { await m.tick(); if (reloads > 0) break; }
    ok(reloads >= 1, '★ ★ 同一视频失败 2 次仍会 reload（实际 reload ' + reloads + ' 次）');
  }

  console.log('== W5. 不变量文档与代码清单一致 ==');
  {
    const inv = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INVARIANTS.md'), 'utf8');
    const src = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
    for (const f of ['_stallTicks', '_resumeAttempts', '_lastProgressTime', '_lastPlayingTime', '_lastPlayingKey', '_lastVideoKey']) {
      ok(inv.indexOf(f) >= 0 && src.indexOf(f) >= 0, '  ' + f + ' 在文档与代码中都存在');
    }
    ok(/I1/.test(inv) && /唯一的换视频判定点/.test(inv), '★ 文档写明 I1「唯一换视频判定点」');
  }

  console.log('');
  try { fs.rmSync(TEST_STATE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
