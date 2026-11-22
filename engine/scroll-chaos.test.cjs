#!/usr/bin/env node
/* ============================================================================
 * scroll-chaos.test.cjs —— 滚动路径的**破坏性**测试（D-061 的验收）
 *
 * 为什么要有：D-061 第一版只跑了「正向数学」单测就说修好了 —— 这违反本仓库
 * 历史教训（§9-6 别急着说修好了；D-048：滚动是异步的，滚完不能立刻量）。
 * 本文件专砸边角：
 *   1) 页面带 scroll-behavior:smooth（平滑动效未完成）→ 必须用 instant 才收得住
 *   2) 顶层 scrollBy 抛错 → 不崩
 *   3) 跨域帧（拿不到绝对坐标）→ 不崩、不乱滚
 *   4) 视口尺寸为 0 → 不崩、不乱滚
 *   5) 滚动「无效」（容器滚不动）→ 有界，不死循环
 *   6) 已居中 → 一次都不滚
 *   7) 引擎侧：页面侧滚动异步落位 → clickFound 必须等 450ms 重查一次并成功
 *
 * 用法：node engine/scroll-chaos.test.cjs
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const vm = require('node:vm');
const sel = require(path.join(__dirname, 'src', 'learn', 'selectors.js'));
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* 构造一个可控的三层窗口链（video iframe ← cards iframe ← top 文档）。
 * scrollMode:
 *   'instant' —— 只有 behavior:'instant' 才立即落位；否则只落一半（模拟平滑动画未完成）
 *   'throw'   —— 顶层 scrollBy 直接抛错
 *   'stuck'   —— 滚了也不动（容器不可滚）
 * crossFrame: cardsWin.frameElement = null（模拟跨域取不到）
 * vh: 顶层视口高
 */
function makeWorld(opts) {
  const o = opts || {};
  const state = { scroll: 0, calls: 0, behaviors: [] };
  const vh = o.vh === undefined ? 802 : o.vh;
  const vw = o.vw === undefined ? 1344 : o.vw;
  const elX = o.elX === undefined ? 492 : o.elX;   /* 默认非水平居中；elX:642 = 水平居中 */
  const el = { getBoundingClientRect() { return { x: elX, y: 0, width: 60, height: 60 }; }, scrollIntoView() { } };
  const videoFrameEl = { getBoundingClientRect() { return { x: 0, y: 1250, width: 844, height: 3302 }; }, scrollIntoView() { } };
  const cardsFrameEl = { getBoundingClientRect() { return { x: 0, y: 151 - state.scroll, width: 1344, height: 3302 }; }, scrollIntoView() { } };
  const topWin = {
    innerHeight: vh, innerWidth: vw,
    get top() { return topWin; }, get parent() { return topWin; },
    scrollBy(a, b) {
      state.calls += 1;
      let dy; let behavior = 'legacy';
      if (typeof a === 'object' && a) { dy = a.top || 0; behavior = a.behavior || 'auto'; }
      else { dy = b || 0; }
      state.behaviors.push(behavior);
      if (o.scrollMode === 'throw') throw new Error('scrollBy blew up');
      if (o.scrollMode === 'stuck') return;                       // 滚不动
      const effective = (o.scrollMode === 'instant' && behavior === 'instant') ? dy : dy * 0.5;
      state.scroll += effective;
    },
  };
  const cardsWin = {
    innerHeight: 3302, innerWidth: 1344,
    frameElement: o.crossFrame ? null : cardsFrameEl,
    get top() { return topWin; }, get parent() { return topWin; }, scrollBy() { },
  };
  const videoWin = {
    innerHeight: 474, innerWidth: 844, frameElement: videoFrameEl, document: { querySelectorAll() { return []; } },
    get top() { return topWin; }, get parent() { return cardsWin; }, scrollBy() { },
  };
  videoWin.window = videoWin;
  videoWin.__CX_SEL = sel.SELECTORS;
  videoWin.__CX_KWS = []; videoWin.__CX_PATTERN = 'x';
  vm.createContext(videoWin);
  vm.runInContext(sel.PAGE_PROBE_SRC, videoWin, { filename: 'PAGE_PROBE_SRC.js' });
  return { videoWin, state, el, vh };
}

function runScroll(world) {
  let threw = null;
  try { world.videoWin.__cx._scrollChain(world.el); } catch (e) { threw = e; }
  const centerAfter = 0 + 1250 + (151 - world.state.scroll) + 30;
  return { threw, centerAfter };
}

(async () => {
  /* ---------- 1. 平滑滚动：只有 instant 才收得住（破坏：模拟动画未完成） ---------- */
  console.log('== 1. scroll-behavior:smooth 场景 —— 必须用 behavior:instant ==');
  {
    const w = makeWorld({ scrollMode: 'instant', elX: 642 });   // 水平居中，排除 dx 干扰
    const r = runScroll(w);
    ok(!r.threw, '  不抛错');
    ok(w.state.behaviors.every((b) => b === 'instant'), '★ 每次 scrollBy 都带 behavior=instant（实际 ' + JSON.stringify(w.state.behaviors) + '）');
    ok(Math.abs(r.centerAfter - (w.vh / 2)) <= 5, '★ smooth 场景也收敛到视口中心（实际 ' + r.centerAfter + '）');
  }

  /* ---------- 2. 顶层 scrollBy 抛错 → 不崩 ---------- */
  console.log('== 2. 顶层 scrollBy 抛错 → 不崩 ==');
  {
    const w = makeWorld({ scrollMode: 'throw' });
    const r = runScroll(w);
    ok(!r.threw, '★ 不向外抛错（实际 ' + (r.threw && r.threw.message) + '）');
  }

  /* ---------- 3. 跨域帧 → 不崩、不乱滚 ---------- */
  console.log('== 3. 跨域（frameElement 取不到）→ 不崩、不乱滚 ==');
  {
    const w = makeWorld({ crossFrame: true });
    const r = runScroll(w);
    ok(!r.threw, '★ 不抛错');
    ok(w.state.calls === 0, '★ 拿不到绝对坐标时不盲目滚动（实际调用 ' + w.state.calls + ' 次）');
  }

  /* ---------- 4. 视口尺寸为 0 → 不崩、不乱滚 ---------- */
  console.log('== 4. 视口 0×0 → 不崩、不乱滚 ==');
  {
    const w = makeWorld({ vh: 0, vw: 0 });
    const r = runScroll(w);
    ok(!r.threw, '★ 不抛错');
    ok(w.state.calls === 0, '★ 视口为 0 时不滚动（实际 ' + w.state.calls + ' 次）');
  }

  /* ---------- 5. 容器滚不动 → 有界（不死循环） ---------- */
  console.log('== 5. 滚动无效（容器不可滚）→ 有界，不死循环 ==');
  {
    const w = makeWorld({ scrollMode: 'stuck' });
    const r = runScroll(w);
    ok(!r.threw, '★ 不抛错');
    ok(w.state.calls <= 2, '★ scrollBy 调用有界（≤2 次，实际 ' + w.state.calls + '）');
  }

  /* ---------- 6. 已居中 → 一次都不滚 ---------- */
  console.log('== 6. 目标已居中 → 不滚动 ==');
  {
    const w = makeWorld({ scrollMode: 'instant', elX: 642 });   // 水平居中，排除 dx 干扰
    // 让初始就居中：abs 中心 = 401 ⇒ 0+1250+(151-0)+30 = 1431 ≠ 401，故先滚一次到居中，再调用应 0 次
    runScroll(w);
    const callsAfterFirst = w.state.calls;
    w.state.calls = 0;
    const r2 = runScroll(w);
    ok(!r2.threw, '  不抛错');
    ok(w.state.calls === 0, '★ 已居中后不再滚动（实际 ' + w.state.calls + ' 次；首轮 ' + callsAfterFirst + ' 次）');
  }

  /* ---------- 7. 引擎侧：异步落位 → clickFound 等 450ms 重查一次并成功 ---------- */
  console.log('== 7. clickFound：页面侧滚动异步落位 → 等 450ms 重查一次 ==');
  {
    const cfg = E.mergeConfig(E.CONFIG, {
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    });
    E.humanize.configure(cfg.humanize);
    let findCalls = 0; const clicks = [];
    const adapter = {
      engine: 'fake',
      async evalInFrame() {
        findCalls += 1;
        if (findCalls === 1) return { ok: false, reason: 'still-outside-viewport', note: 'vjs-big-play-button', rect: { x: 0, y: 1401, w: 60, h: 60 } };
        return { ok: true, rect: { x: 492, y: 398, w: 60, h: 60 }, layer: 1, note: 'vjs-big-play-button' };
      },
      async click(frameId, rect) { clicks.push({ frameId, rect }); return { mode: 'cdp-input' }; },
      async jsClick() { return { ok: false }; },
      getTargetId() { return 'top'; },
      shutdown() { },
    };
    const m = new E.LearnMachine(adapter, cfg);
    const t0 = Date.now();
    const r = await m.clickFound('vf1', 'videoToggle', { objectid: 'x' });
    const dt = Date.now() - t0;
    ok(r.ok === true, '★ 重查后成功（实际 ' + JSON.stringify(r) + '）');
    ok(findCalls === 2, '★ 恰好重查 1 次（evalFind 共 ' + findCalls + ' 次）');
    ok(clicks.length === 1, '★ 只真实点击 1 次（实际 ' + clicks.length + '）');
    ok(dt >= 400, '★ 确实等待了约 450ms（实际 ' + dt + 'ms）');
  }

  /* ---------- 8. clickFound：一直出界 → 不无限重试，最终失败并带 reason ---------- */
  console.log('== 8. clickFound：持续出界 → 有界失败、带 reason ==');
  {
    const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
    E.humanize.configure(cfg.humanize);
    let n = 0;
    const adapter = {
      engine: 'fake',
      async evalInFrame() { n += 1; return { ok: false, reason: 'still-outside-viewport', note: 'vjs-big-play-button', rect: { x: 0, y: 1401, w: 60, h: 60 }, vw: 1344, vh: 802 }; },
      async click() { throw new Error('should not click'); },
      async jsClick() { throw new Error('videoToggle 不应降级 jsClick'); },
      getTargetId() { return 'top'; }, shutdown() { },
    };
    const m = new E.LearnMachine(adapter, cfg);
    const r = await m.clickFound('vf1', 'videoToggle', { objectid: 'x' });
    ok(r.ok === false, '★ 判失败');
    ok(r.reason === 'still-outside-viewport', '★ reason 透出 still-outside-viewport（实际 ' + r.reason + '）');
    ok(!!r.rect, '★ 失败时带 rect（便于定位，实际 ' + JSON.stringify(r.rect) + '）');
    ok(n === 2, '★ 只重查 1 次、有界（evalFind ' + n + ' 次）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });


