#!/usr/bin/env node
/* ============================================================================
 * probe-contract.test.cjs —— 真探针「契约」测试（不是手写 mock 返回）
 *
 * 背景：过去 50+ 个修复大多靠「假 adapter 手写 probe 返回」的单测收工。
 * 那种单测验证的是「状态机对假设的推理」，**不验证真实 DOM 探针会产出什么字段**。
 * 于是「真探针漏字段 / 结构与 mock 不一致」的 bug 全绿也照漏。
 *
 * 本文件专门盯这类「契约」：
 *   1) 真实执行 PAGE_PROBE_SRC 里的 videoState()，断言它带出 objectid。
 *      —— 这是多视频节「st.video 永远指向已播完视频」的根因。
 *   2) 走真实 gatherState()，断言返回体里有 st.videos（数组）。
 *      —— 现状 st.videos 从未赋值，所有读取都是 undefined。
 *
 * 用法：node engine/probe-contract.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const vm = require('node:vm');
const E2 = require(path.join(__dirname, 'chaoxing-autolearn.js'));
const sel = require(path.join(__dirname, 'src', 'learn', 'selectors.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const HEX = 'ce7e74d32326c2bb443bdf2b46e03971';

/* 在 vm 沙箱里执行真实的 PAGE_PROBE_SRC，返回 window（含 window.__cx）。 */
function loadRealProbe(documentObj) {
  const sandbox = {};
  sandbox.window = sandbox;                 // window 自引用
  sandbox.document = documentObj;
  sandbox.console = console;
  sandbox.__CX_SEL = sel.SELECTORS;          // PAGE_PROBE_SRC 读 window.__CX_SEL
  sandbox.__CX_KWS = [];
  sandbox.__CX_PATTERN = 'passport2\\.chaoxing\\.com';
  vm.createContext(sandbox);
  vm.runInContext(sel.PAGE_PROBE_SRC, sandbox, { filename: 'PAGE_PROBE_SRC.js' });
  return sandbox;
}

function fakeVideo(over) {
  return Object.assign({
    getBoundingClientRect() { return { width: 800, height: 450, left: 0, top: 0 }; },
    duration: 2040.4,
    currentTime: 12.5,
    paused: true,
    ended: false,
    readyState: 4,
    networkState: 1,
    buffered: { length: 0 },
    error: null,
    muted: false,
    currentSrc: 'https://s2.cldisk.com/sv-w9/video/58/d8/5a/' + HEX + '/sd.mp4?at_=1&ak_=2',
    src: '',
  }, over || {});
}

(async () => {
  /* ---------- 1. 契约：真实 videoState() 必须带 objectid ---------- */
  console.log('== 1. 真实 videoState() 返回 objectid（真探针契约）==');
  {
    const video = fakeVideo();
    const doc = { querySelectorAll(s) { return s === 'video' ? [video] : []; } };
    const win = loadRealProbe(doc);
    let vs = null;
    try { vs = win.__cx.videoState(); } catch (e) { vs = { __err: String(e && e.message || e) }; }
    ok(!!vs && vs.found === true, '★ videoState() 能识别到视频（实际 ' + JSON.stringify(vs && vs.found) + '）');
    ok(!!vs && typeof vs.objectid === 'string', '★ videoState() 返回 objectid 字段（实际 type=' + (vs && typeof vs.objectid) + '）');
    ok(!!vs && String(vs.objectid).toLowerCase() === HEX, '★ objectid 值等于 src 里的 32-hex（实际 ' + (vs && vs.objectid) + '）');
  }

  /* ---------- 2. 契约：真实 gatherState() 必须填充 st.videos ---------- */
  console.log('== 2. 真实 gatherState() 填充 st.videos（数组、含每个视频帧）==');
  {
    const cfg = E2.mergeConfig(E2.CONFIG, {
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    });
    E2.humanize.configure(cfg.humanize);

    const OID1 = '1857487a82a1e07f1a2d072765de7542';
    const OID2 = HEX;
    const CARDS = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=643076150&num=0';
    const VURL = 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=1';

    const baseProbe = { url: '', video: { found: false }, dialogs: [], quiz: { present: false }, videoQuiz: null, quizTab: { present: false }, human: { detected: false }, login: {}, tasks: [], videos: [] };
    const adapter = {
      engine: 'fake',
      async getFrameDocuments() {
        return [
          { frameId: 'top', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150', isTop: true, depth: 0 },
          { frameId: 'cards', url: CARDS, isTop: false, depth: 1 },
          { frameId: 'vf1', url: VURL, isTop: false, depth: 2 },
          { frameId: 'vf2', url: VURL, isTop: false, depth: 2 },
        ];
      },
      async evalInFrame(frameId, expr) {
        const e = String(expr);
        if (/probeAll\(\)/.test(e)) {
          if (frameId === 'cards') {
            return Object.assign({}, baseProbe, {
              url: CARDS,
              toc: { found: true, layer: 2, items: [{ title: '2.2 流体的状态方程', chapterId: '643076150', current: true, done: false, unfinish: 2 }] },
              tasks: [
                { kind: 'video', finished: true, objectid: OID1, iframeSrc: VURL },
                { kind: 'video', finished: false, objectid: OID2, iframeSrc: VURL },
              ],
              videos: [],
            });
          }
          if (frameId === 'vf1') return Object.assign({}, baseProbe, { url: VURL, video: { found: true, objectid: OID1, paused: true, ended: true, duration: 834, currentTime: 834, progress: 100, readyState: 4, currentSrc: 'https://x/' + OID1 + '/sd.mp4', src: 'https://x/' + OID1 + '/sd.mp4' }, videos: [{ objectid: OID1, duration: 834, currentTime: 834, paused: true, ended: true, readyState: 4, src: 'https://x/' + OID1 + '/sd.mp4' }] });
          if (frameId === 'vf2') return Object.assign({}, baseProbe, { url: VURL, video: { found: true, objectid: OID2, paused: true, ended: false, duration: 0, currentTime: 0, progress: 0, readyState: 0, currentSrc: 'https://x/' + OID2 + '/sd.mp4', src: 'https://x/' + OID2 + '/sd.mp4' }, videos: [{ objectid: OID2, duration: 0, currentTime: 0, paused: true, ended: false, readyState: 0, src: 'https://x/' + OID2 + '/sd.mp4' }] });
          if (frameId === 'top') return Object.assign({}, baseProbe, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=643076150' });
        }
        return 'installed';
      },
      async click() { return { mode: 'noop' }; },
      async jsClick() { return { ok: false }; },
      getTargetId() { return 'top'; },
      shutdown() {},
    };

    const m = new E2.LearnMachine(adapter, cfg);
    const st = await m.gatherState();
    ok(Array.isArray(st.videos), '★ st.videos 是数组（实际 ' + (Array.isArray(st.videos) ? 'array' : typeof st.videos) + '）');
    ok(Array.isArray(st.videos) && st.videos.length === 2, '★ st.videos 含 2 个视频（实际 ' + (Array.isArray(st.videos) ? st.videos.length : 'n/a') + '）');
    ok(Array.isArray(m._lastVideos) && m._lastVideos.length === 2, '  _lastVideos 也含 2 个（实际 ' + (m._lastVideos || []).length + '）');
    /* st.video（当前视频）应挑到「未完成」的 vf2，而不是已播完的 vf1（取决于 videoState 是否带 objectid） */
    ok(!!st.video && String(st.video.objectid || '') === OID2, '★ st.video 指向未播完的 vf2（实际 ' + (st.video && (st.video.objectid || 'no-oid')) + '）');
  }

  /* ---------- 3. 契约：起播验证必须核对 objectid（播错要响，不能静默通过） ---------- */
  console.log('== 3. _verifyVideoStarted 核对 objectid（播错视频 → 判失败）==');
  {
    const cfg = E2.mergeConfig(E2.CONFIG, {
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    });
    E2.humanize.configure(cfg.humanize);
    const OID_TARGET = 'ce7e74d32326c2bb443bdf2b46e03971';
    const OID_OTHER = '1857487a82a1e07f1a2d072765de7542';

    // 假 frame：视频在动，但 objectid 是「另一个」——旧逻辑会误判成功
    const mkAdapter = (oidInFrame) => ({
      engine: 'fake',
      async evalInFrame() {
        return JSON.stringify({ t: 30, dur: 100, paused: false, rs: 4, oid: oidInFrame });
      },
      async gatherState() { return { videos: [], video: null }; }, // 全局兜底也给空，确保只走 frame 分支
      async getFrameDocuments() { return []; },
      getTargetId() { return 'top'; },
      shutdown() {},
    });

    // 3a：frame 里播的是「别的视频」→ 必须判失败
    const mBad = new E2.LearnMachine(mkAdapter(OID_OTHER), cfg);
    const rBad = await mBad._verifyVideoStarted(OID_TARGET, 0, 1500, 'vf2');
    ok(rBad.ok === false, '★ 播错视频判失败（实际 ' + JSON.stringify(rBad) + '）');
    ok(/wrong-video/.test(String(rBad.note || '')), '★ 失败原因标 wrong-video（实际 ' + rBad.note + '）');

    // 3b：frame 里就是目标视频 → 判成功
    const mGood = new E2.LearnMachine(mkAdapter(OID_TARGET), cfg);
    const rGood = await mGood._verifyVideoStarted(OID_TARGET, 0, 1500, 'vf2');
    ok(rGood.ok === true, '★ 目标视频在动 → 成功（实际 ' + JSON.stringify(rGood) + '）');
  }

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项（这些就是当前模式发现不了的契约缺陷）==');
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
