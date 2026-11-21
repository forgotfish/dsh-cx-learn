#!/usr/bin/env node
/* ============================================================================
 * multi-video-iframe.test.cjs —— D-054：多视频节的反查补齐能力
 *
 * 真机实测结构（2.2 流体的状态方程，2 个视频）：
 *   studentstudy → knowledge/cards?knowledgeid=643076150&num=0
 *                   ├ ananas/modules/video/index.html  (video oid=1857487a… 已播完)
 *                   └ ananas/modules/video/index.html  (video oid=ce7e74d3… 未播)
 * cards frame 自身 querySelectorAll('video') = 0
 * ⇒ 常规探针汇总得空 videos，_pickUnplayedVideo 挑不出候选 → 直接收口。
 *
 * 本测试用假 adapter 复刻这个结构，断言：
 *   1) _lastVideos 缺候选时，_enrichVideosFromFrames 能按 objectid 反查并补齐
 *   2) 补齐后 _pickUnplayedVideo 能挑到第 2 个视频（frameId 指向 video 子 iframe）
 *   3) 已完成的第 1 个不会被挑（它不在 pending 里）
 *   4) playSectionVideo 会把点击下发到 video 子 iframe，并在该 frame 内验证起播
 *   5) 起播成功后记入 _startedVideoIds
 *
 * 用法：node engine/multi-video-iframe.test.cjs
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

const cfg = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
});
E.humanize.configure(cfg.humanize);

const OID_DONE = '1857487a82a1e07f1a2d072765de7542';
const OID_TODO = 'ce7e74d32326c2bb443bdf2b46e03971';
const CARDS_URL = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=72947192&courseid=227957344&knowledgeid=643076150&num=0';
const VID_URL = 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=2026-1113-2201';

/* 假 adapter：复刻真机 frame 结构（cards + 两个 video 子 iframe） */
function makeAdapter(opts) {
  const o = opts || {};
  const state = { playingOid: '', clicks: [], evalLog: [] };
  const a = {
    engine: 'fake',
    clicks: [],
    async ensureBrowser() { return {}; },
    async navigate() {},
    async getCurrentUrl() { return 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150'; },
    getTargetId() { return 'top'; },
    async getFrameDocuments() {
      return [
        { frameId: 'top', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150', isTop: true, depth: 0 },
        { frameId: 'cards', url: CARDS_URL, isTop: false, depth: 1 },
        { frameId: 'vframe1', url: VID_URL, isTop: false, depth: 2 },
        { frameId: 'vframe2', url: VID_URL, isTop: false, depth: 2 },
      ];
    },
    async evalInFrame(frameId, expr) {
      state.evalLog.push({ frameId, expr: String(expr).slice(0, 60) });
      const e = String(expr);
      /* clickFound 先调 __cx.find() 解析元素 → 必须返回带 rect 的结果 */
      if (/__cx\.find\(/.test(e)) {
        if (frameId === 'vframe2') {
          return { ok: true, text: '', rect: { x: 100, y: 100, w: 400, h: 300 }, layer: 2, note: 'video-element(targeted)' };
        }
        return { ok: false, reason: 'not-visible' };
      }
      /* 反查：读 <video>.currentSrc 抽 objectid */
      if (/currentSrc/.test(e) && /return m \? m\[0\]/.test(e)) {
        if (frameId === 'vframe1') return OID_DONE;
        if (frameId === 'vframe2') return OID_TODO;
        return '';
      }
      /* 起播验证：读 currentTime/paused */
      if (/paused: v\.paused/.test(e)) {
        if (frameId === 'vframe2') {
          const playing = state.playingOid === OID_TODO;
          return JSON.stringify({ t: playing ? 5 : 0, dur: playing ? 834 : null, paused: !playing, rs: playing ? 4 : 0 });
        }
        return '';
      }
      /* 进度基线：读 currentTime */
      if (/return v \? String\(v\.currentTime\) : ''/.test(e)) {
        if (frameId === 'vframe2') return state.playingOid === OID_TODO ? '4' : '0';
        return '834';
      }
      return null;
    },
    async click(frameId, rect) { state.clicks.push({ frameId, rect }); return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false }; },
    async attachTarget() {},
    async closeTarget() {},
    async getAllCookies() { return null; },
    async getText() { return ''; },
    shutdown() {},
  };
  return { a, state };
}

function state(over) {
  return Object.assign({
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150',
    topUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150',
    frames: [], dialogs: [], human: [], loginInvalid: false,
    video: { found: false }, videoFrameId: null, videoQuiz: null,
    quiz: { present: false }, quizTab: { present: false },
    videos: [], tasks: [],
    toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: [{ title: '2.2 流体的状态方程', chapterId: '643076150', current: true, done: false, unfinish: 2 }] },
  }, over || {});
}

(async () => {
  /* ---------- 1. 反查补齐 ---------- */
  console.log('== 1. _lastVideos 缺候选 → 按 objectid 反查 video 子 iframe 补齐 ==');
  {
    const { a, state: st } = makeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m._currentTitle = '2.2 流体的状态方程';
    m._currentChapterIdValue = '643076150';
    m._lastVideos = [];   /* 关键：模拟「常规探针汇总为空」 */
    const pv = { ok: true, pending: [{ objectid: OID_TODO, frameUrl: CARDS_URL }], total: 2, finished: 1 };
    await m._enrichVideosFromFrames(pv);
    ok(Array.isArray(m._lastVideos) && m._lastVideos.length === 1, '★ 补齐 1 条候选（实际 ' + (m._lastVideos || []).length + '）');
    ok(m._lastVideos[0] && m._lastVideos[0].objectid === OID_TODO, '★ 补的是未完成的 ce7e74d3（实际 ' + (m._lastVideos[0] && m._lastVideos[0].objectid) + '）');
    ok(m._lastVideos[0] && m._lastVideos[0].frameId === 'vframe2', '★ frameId 指向 video 子 iframe（实际 ' + (m._lastVideos[0] && m._lastVideos[0].frameId) + '）');
    ok(!st.playingOid, '没有误启动');
  }

  /* ---------- 2. 补齐后能挑到候选 ---------- */
  console.log('== 2. 补齐后 _pickUnplayedVideo 能挑到第 2 个（已完成的第 1 个不挑）==');
  {
    const { a } = makeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m._lastVideos = [];
    const pv = { ok: true, pending: [{ objectid: OID_TODO }], total: 2, finished: 1 };
    await m._enrichVideosFromFrames(pv);
    const pick = m._pickUnplayedVideo({}, pv);
    ok(!!pick, '★ 能挑到候选（实际 ' + JSON.stringify(pick) + '）');
    ok(pick && pick.objectid === OID_TODO, '★ 挑的是 ce7e74d3（实际 ' + (pick && pick.objectid) + '）');
    ok(pick && pick.objectid !== OID_DONE, '  ↳ 绝不挑已完成的 1857487a');
  }

  /* ---------- 3. 起播下发到正确的 frame 并验证 ---------- */
  console.log('== 3. playSectionVideo 点对 frame + 在该 frame 内验证起播 ==');
  {
    const { a, state: st } = makeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m._lastVideos = [];
    const pv = { ok: true, pending: [{ objectid: OID_TODO }], total: 2, finished: 1 };
    await m._enrichVideosFromFrames(pv);
    const cand = m._pickUnplayedVideo({}, pv);
    /* 模拟「点了之后真的起播」 */
    st.playingOid = OID_TODO;
    const r = await m.playSectionVideo({ videos: [] }, cand);
    ok(r.ok === true, '★ 起播验证通过（实际 ' + JSON.stringify(r) + '）');
    ok(st.clicks.length === 1 && st.clicks[0].frameId === 'vframe2', '★ 点击下发到 vframe2（实际 ' + JSON.stringify(st.clicks.map((c) => c.frameId)) + '）');
    ok(m._startedVideoIds.has(OID_TODO), '★ 记入 _startedVideoIds');
  }

  /* ---------- 4. 起播失败仍要记 unstartable（不静默） ---------- */
  console.log('== 4. 点了但没起播 → 记 unstartable、不记 started ==');
  {
    const { a } = makeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m._lastVideos = [];
    const pv = { ok: true, pending: [{ objectid: OID_TODO }], total: 2, finished: 1 };
    await m._enrichVideosFromFrames(pv);
    const cand = m._pickUnplayedVideo({}, pv);
    const r = await m.playSectionVideo({ videos: [] }, cand);   /* playingOid 保持空 → 不起播 */
    ok(r.ok === false && r.reason === 'not-started', '★ 判 not-started（实际 ' + JSON.stringify(r) + '）');
    ok(!m._startedVideoIds.has(OID_TODO), '★ 不记 started');
    ok((m._unstartableVideoIds.get(OID_TODO) || 0) === 1, '★ 记 1 次 unstartable（实际 ' + (m._unstartableVideoIds.get(OID_TODO) || 0) + '）');
  }

  /* ---------- 5. 没有 video 子 iframe 时不崩 ---------- */
  console.log('== 5. 没有 video 子 iframe（老页面）→ 不崩、不补 -------------');
  {
    const { a } = makeAdapter();
    a.getFrameDocuments = async () => [{ frameId: 'top', url: 'https://x/studentstudy', isTop: true, depth: 0 }];
    const m = new E.LearnMachine(a, cfg);
    m._lastVideos = [];
    let threw = false;
    try { await m._enrichVideosFromFrames({ ok: true, pending: [{ objectid: OID_TODO }], total: 2, finished: 1 }); } catch { threw = true; }
    ok(!threw, '★ 不抛错');
    ok(m._lastVideos.length === 0, '  不补任何东西（维持老行为）');
  }

  /* ---------- 6. D-055：videoToggle 命中失败绝不降级 el.click ---------- */
  console.log('== 6. videoToggle 命中失败 → 不偷偷 el.click，直接失败（D-055）==');
  {
    const { a } = makeAdapter();
    let jsClickCalls = 0;
    a.evalInFrame = async () => ({ ok: false, reason: 'hit-test-blocked' });
    a.jsClick = async () => { jsClickCalls += 1; return { ok: true }; };
    const m = new E.LearnMachine(a, cfg);
    const r = await m.clickFound('vframe2', 'videoToggle', { objectid: OID_TODO });
    ok(r.ok === false, '★ 结果 ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(jsClickCalls === 0, '★ 一次都没调用 jsClick（实际 ' + jsClickCalls + ' 次）');
    ok(r.reason === 'hit-test-blocked', '★ 透出 hit-test-blocked（实际 ' + r.reason + '）');
  }

  /* ---------- 7. D-055 源码锁：多帧滚动 + 目标优先大播放按钮 ---------- */
  console.log('== 7. 源码锁：scrollChainIntoView + vjs-big-play-button(targeted)（D-055）==');
  {
    const fs = require('node:fs');
    const selSrc = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'selectors.js'), 'utf8');
    const macSrc = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
    ok(/function scrollChainIntoView/.test(selSrc), '★ selectors 定义 scrollChainIntoView（把整条 frame 链滚进视口）');
    ok(/scrollChainIntoView\(r\.el\)/.test(selSrc), '★ find() 里改用 scrollChainIntoView');
    ok(/vjs-big-play-button\(targeted\)/.test(selSrc), '★ 按 objectid 命中未起播视频时改为点它的大播放按钮');
    ok(/kind === 'videoToggle'[\s\S]{0,220}return \{ ok: false/.test(macSrc), '★ machine.clickFound 对 videoToggle 直接失败、不降级');
  }

  /* ---------- 8. D-056 源码锁：WAIT_VIDEO_CONFIRM 不被当成无进展误杀 ---------- */
  console.log('== 8. 源码锁：WAIT_VIDEO_CONFIRM 豁免「无进展」+ 专用上限（D-056）==');
  {
    const fs = require('node:fs');
    const runSrc = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'run.js'), 'utf8');
    const cfgSrc = fs.readFileSync(path.join(__dirname, 'src', 'core', 'config.js'), 'utf8');
    ok(/step\.outcome === 'WAIT_VIDEO_CONFIRM'/.test(runSrc), '★ run.js 单独处理 WAIT_VIDEO_CONFIRM');
    ok(/maxVideoConfirmTicks/.test(runSrc) && /maxVideoConfirmTicks/.test(cfgSrc), '★ 有专用上限 maxVideoConfirmTicks（防无限空等）');
    ok(/video_confirm_timeout/.test(runSrc), '★ 超限走 video_confirm_timeout（不误报 UNRECOGNIZED_PAGE）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
