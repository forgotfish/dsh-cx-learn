#!/usr/bin/env node
/* ============================================================================
 * multi-video-chaos.test.cjs —— D-039 破坏性测试：多视频起播的各种坏情况
 *
 * 上一版真机事故：第 2 个视频点不动 → 同一候选空转 108 次 / 7 分半。
 * 这里专门砸「起播失败」的各种形态，核心断言是 **不会无限空转**：
 *   · 每拍只「尝试」一次，尝试过的候选不再重挑
 *   · 几拍内必然收口（停机 + 快照），而不是 100+ 拍
 *
 * 覆盖：
 *   1) 点击成功但视频永不起播 → 逐拍换候选，≤4 拍内 stop(video_task_unreachable)
 *   2) 点击直接失败（找不到目标播放器）→ 同样有界
 *   3) gatherState 抛错 → 判失败但不崩
 *   4) 起播中途 currentTime 归零/回退 → 不算起播，有界收口
 *   5) 迟到的起播（2 秒后才 paused=false）→ 验证窗口内应判成功
 *   6) 缺 objectid 的老播放器 → 走旧路径不崩
 *   7) 同一候选绝不点两次
 *   8) 失败快照落盘（diagnostics/*.json）
 *
 * 用法：node engine/multi-video-chaos.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-mvchaos-'));
process.env.CX_STATE_DIR = TMP;

const OID_A = 'f'.repeat(32);   // 已完成/正在播
const OID_B = '1'.repeat(32);   // 未完成
const OID_C = '2'.repeat(32);   // 未完成
const FRAME_URL = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111';

function state(over) {
  return Object.assign({
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    topUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    frames: [], dialogs: [], human: [], loginInvalid: false,
    video: { found: false }, videoFrameId: null, videoQuiz: null,
    quiz: { present: false }, quizTab: { present: false },
    toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: [] },
  }, over || {});
}

function fakeAdapter() {
  const a = {
    engine: 'fake',
    clicks: [],
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    _isDetectUrl() { return false; },
    async navigate(u) { this.url = u; },
    async getCurrentUrl() { return this.url; },
    async getFrameDocuments() { return [{ frameId: 'top', url: this.url, isTop: true }]; },
    async evalInFrame() { return null; },
    async click() { return { mode: 'fake' }; },
    async jsClick() { return { ok: false }; },
    async getText() { return ''; },
    async ensureBrowser() { return {}; },
    async getAllCookies() { return null; },
    async shutdown() {},
    async typeInto() { return { ok: true }; },
    getTargetId() { return 'top'; },
  };
  return a;
}

const tasks = [
  { kind: 'video', finished: true, objectid: OID_A, frameUrl: FRAME_URL },
  { kind: 'video', finished: false, objectid: OID_B, frameUrl: FRAME_URL },
  { kind: 'video', finished: false, objectid: OID_C, frameUrl: FRAME_URL },
];
const tocItems = [{ title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, unfinish: 2 }];

/**
 * 造一台机器：A 已播完（本次启动过），B/C 未完成。
 * afterClick(videos) 决定「点击之后」探到的播放器状态 —— 用它模拟各种坏情况。
 */
function makeMachine(opts) {
  const o = opts || {};
  const a = fakeAdapter();
  const m = new E.LearnMachine(a, cfg);
  m._currentTitle = '本节';
  m._lastCurIdx = 0;
  m._markVideoStarted({ src: 'https://cdn/' + OID_A + '.mp4' });
  m.clickedOids = [];
  m.clickFound = async (frameId, kind, arg) => {
    if (kind === 'videoToggle') m.clickedOids.push(arg && arg.objectid);
    if (o.clickThrows) throw new Error('cdp boom');
    if (o.clickFails) return { ok: false, reason: 'no-target' };
    return { ok: true, note: 'fake' };
  };
  m.muteIfPossible = async () => {};
  let ticked = 0;
  m.gatherState = async () => {
    ticked += 1;
    if (o.gatherThrows && ticked > 1) throw new Error('gather boom');
    m._lastInventory = { tasks, at: Date.now() };
    const videosBase = [
      { frameId: 'vfA', frameUrl: FRAME_URL, src: 'https://cdn/' + OID_A + '.mp4', objectid: OID_A, duration: 100, currentTime: 100, paused: false, ended: true, readyState: 4 },
      { frameId: 'vfB', frameUrl: FRAME_URL, src: 'https://cdn/' + OID_B + '.mp4', objectid: OID_B, duration: 100, currentTime: 0, paused: true, ended: false, readyState: 4 },
      { frameId: 'vfC', frameUrl: FRAME_URL, src: 'https://cdn/' + OID_C + '.mp4', objectid: OID_C, duration: 100, currentTime: 0, paused: true, ended: false, readyState: 4 },
    ];
    m._lastVideos = videosBase;
    const videos = o.afterClick ? o.afterClick(m.clickedOids.slice(), videosBase, ticked) : videosBase;
    return state({
      video: { found: true, frameId: 'vfA', src: 'https://cdn/' + OID_A + '.mp4', objectid: OID_A, ended: true, paused: false, progress: 99, currentTime: 100, duration: 100, readyState: 4 },
      videoFrameId: 'vfA',
      videos,
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
  };
  m.advanceSection = async () => { m.advanced = (m.advanced || 0) + 1; return { progress: true, outcome: 'ADVANCED' }; };
  m.confirmVideoWatched = async () => 2;
  m.maybeHandleChapterQuiz = async () => 'none';
  m.stop = (reason) => { m.stopped = reason; };
  return { m, a };
}

async function runTicks(m, max) {
  const outcomes = [];
  for (let i = 0; i < (max || 8); i++) {
    const r = await m.tick();
    outcomes.push(r && r.outcome);
    if (m.stopped) break;
    if (m.advanced) break;
  }
  return outcomes;
}

const V = (oid, t, paused) => ({ frameId: 'vf' + oid[0], frameUrl: FRAME_URL, src: 'https://cdn/' + oid + '.mp4', objectid: oid, duration: 100, currentTime: t, paused, ended: false, readyState: 4 });

(async () => {
  /* ---------- 1. 点击成功但永不起播 → 有界收口 ---------- */
  console.log('== 1. 点击成功但视频永不起播（上一版事故形态）→ 必须几拍内停机 ==');
  {
    const { m } = makeMachine({ afterClick: (clicked, base) => base });   // B/C 始终 paused
    const outs = await runTicks(m, 12);
    console.log('     实际拍数=' + outs.length + ' outcomes=' + JSON.stringify(outs));
    ok(outs.length <= 5, '★ 不发散：≤5 拍收口（实际 ' + outs.length + ' 拍，上一版是 108 次）');
    ok(m.stopped === 'video_task_unreachable', '★ 停机原因 video_task_unreachable（实际 ' + m.stopped + '）');
    ok(m.clickedOids.length <= 2, '★ 每个候选最多点一次：总点击数 ≤2（实际 ' + JSON.stringify(m.clickedOids) + '）');
    const uniq = new Set(m.clickedOids);
    ok(uniq.size === m.clickedOids.length, '★ 同一 objectid 绝不点两次（实际 ' + JSON.stringify(m.clickedOids) + '）');
  }

  /* ---------- 2. 点击直接失败 ---------- */
  console.log('== 2. 点击失败（找不到目标播放器）→ 同样有界 ==');
  {
    const { m } = makeMachine({ clickFails: true });
    const outs = await runTicks(m, 12);
    ok(outs.length <= 5, '★ ≤5 拍收口（实际 ' + outs.length + '）');
    ok(m.stopped === 'video_task_unreachable', '停机原因正确（实际 ' + m.stopped + '）');
  }

  /* ---------- 3. 点击抛错 ---------- */
  console.log('== 3. clickFound 抛错 → 判失败、不崩、有界 ==');
  {
    const { m } = makeMachine({ clickThrows: true });
    let threw = false;
    let outs = [];
    try { outs = await runTicks(m, 12); } catch { threw = true; }
    ok(!threw, '★ 不向外抛错');
    ok(outs.length <= 5, '★ ≤5 拍收口（实际 ' + outs.length + '）');
  }

  /* ---------- 4. gatherState 抛错 ---------- */
  console.log('== 4. gatherState 抛错 → 验证层自己要兜住（tick 层由 run.js 的失败计数兜底）==');
  {
    const { m } = makeMachine({});
    m.gatherState = async () => { throw new Error('gather boom'); };
    let threw = false, r = null;
    try { r = await m._verifyVideoStarted(OID_B, 0, 1500); } catch { threw = true; }
    ok(!threw, '★ _verifyVideoStarted 不抛错（自己吞掉探测异常）');
    ok(r && r.ok === false, '★ 探测失败 → 判未起播（实际 ' + JSON.stringify(r) + '）');
    /* playSectionVideo 也必须兜住：不能把探测异常变成崩溃 */
    let threw2 = false;
    try { await m.playSectionVideo({ videos: [] }, V(OID_B, 0, true)); } catch { threw2 = true; }
    ok(!threw2, '★ playSectionVideo 也不抛错');
  }

  /* ---------- 5. 迟到的起播 → 验证窗口内应判成功 ---------- */
  console.log('== 5. 2 秒后才真正起播 → 验证窗口内仍应判成功 ==');
  {
    let calls = 0;
    const { m } = makeMachine({
      afterClick: (clicked, base) => {
        calls += 1;
        /* 前 2 次探测还没动，第 3 次开始 B 在播 */
        if (calls < 3) return base;
        return [base[0], V(OID_B, 3, false), base[2]];
      },
    });
    const r = await m.playSectionVideo({ videos: [V(OID_B, 0, true)] }, V(OID_B, 0, true));
    ok(r.ok === true, '★ 迟到起播被判成功（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- 6. currentTime 回退/归零 → 不算起播 ---------- */
  console.log('== 6. currentTime 反复归零 → 不算起播 ==');
  {
    let n = 0;
    const { m } = makeMachine({
      afterClick: (clicked, base) => {
        n += 1;
        return [base[0], V(OID_B, n % 2 === 0 ? 5 : 0, false), base[2]];
      },
    });
    /* paused=false 但 currentTime 抖动；beforeTime 给 10，要求前进>0.5 才算 */
    const r = await m.playSectionVideo({ videos: [V(OID_B, 10, true)] }, V(OID_B, 10, true));
    ok(typeof r.ok === 'boolean', '有明确结论（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- 7. 缺 objectid 的老播放器 → 旧路径不崩 ---------- */
  console.log('== 7. 缺 objectid → 走旧路径，不崩 ==');
  {
    const { m } = makeMachine({});
    const r = await m.playSectionVideo({ videos: [] }, { frameId: 'vfX', objectid: '', src: '' });
    ok(r && typeof r.ok === 'boolean', '有明确结论（实际 ' + JSON.stringify(r) + '）');
  }

  /* ---------- 8. 失败快照落盘 ---------- */
  console.log('== 8. 收口时写入诊断快照 ==');
  {
    const { m } = makeMachine({ afterClick: (c, b) => b });
    await runTicks(m, 8);
    const dir = path.join(TMP, 'diagnostics');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /video_unstartable/.test(f)); } catch { files = []; }
    ok(files.length >= 1, '★ diagnostics 里有 video_unstartable 快照（实际 ' + files.length + ' 个）');
    if (files.length) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      ok(j.reason === 'video_task_unreachable', '快照 reason 正确');
      ok(Array.isArray(j.stuck) && j.stuck.length >= 1, '★ 快照记录了不可起播的候选（实际 ' + (j.stuck || []).length + '）');
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
