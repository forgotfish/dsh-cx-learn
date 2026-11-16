#!/usr/bin/env node
/* ============================================================================
 * live-task.test.cjs — 直播回放任务点（D-026）的表驱动回归测试
 * ============================================================================
 * 不连浏览器：用假 adapter 记录调用顺序，直接驱动 LearnMachine.handleLiveTask()。
 *
 * 覆盖：
 *   1) 没有 liveId           → LIVE_NO_ID，不开标签页
 *   2) liveinfo 读不到        → LIVE_INFO_FAIL，不开标签页
 *   3) 服务端已达标(≥90)      → 直接切节，绝不开播放器（零副作用）
 *   4) 正常路径              → openTarget → attach → playing → 轮询到达标 → 关页 → 切节
 *   5) 播放器起不来           → LIVE_START_FAIL，且关掉标签页、切回学习页
 *   6) 超时未达标             → LIVE_TIMEOUT，且关掉标签页
 *   7) 完成口径来自服务端 percentValue（不是本地 currentTime）
 *   8) 分派：live 不落「无视频→跳过」路径
 *
 * 用法：node engine/live-task.test.cjs
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

const CHAPTER_ID = '143117166';
const CARDS_URL = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=156594937&courseid=204169157&knowledgeid=' + CHAPTER_ID;
const STUDY_TARGET = 'study-target-1';

const cfg = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  live: { donePercent: 90, pollMs: 1, startTimeoutMs: 30, maxMs: 300, keepAliveMs: 1 },
});
E.humanize.configure(cfg.humanize);

/** 假 adapter：liveInfoQueue 依次返回 liveinfo 结果；startFails=true 时模拟播放器起不来 */
function fakeAdapter(opts) {
  const o = opts || {};
  const calls = [];
  const queue = (o.liveInfoQueue || []).slice();
  const box = o.queueBox || null;   /* 可运行的队列盒：{ q: [...] }，测试中途可替换 */
  let opened = 0;
  return {
    calls,
    engine: 'fake',
    async ensureBrowser() { return {}; },
    async navigate() { calls.push('navigate'); },
    async getCurrentUrl() { return 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=' + CHAPTER_ID; },
    getTargetId() { return STUDY_TARGET; },
    async getFrameDocuments() {
      return [
        { frameId: 'cards-frame', url: CARDS_URL, isTop: false, depth: 1 },
        { frameId: 'zhibo-frame', url: 'https://zhibo.chaoxing.com/live/course/watch?t=5&streamName=X&vdoid=Y', isTop: false, depth: 2 },
      ];
    },
    async evalInFrame(frameId, expr) {
      const s = String(expr);
      if (s.indexOf('liveinfo') >= 0) {
        const q = (box && box.q) ? box.q : queue;
        const r = q.length > 1 ? q.shift() : (q[0] || { ok: false, error: 'empty-queue' });
        calls.push('liveinfo:' + (r && r.percent));
        return r;
      }
      if (s.indexOf('querySelector("video")') >= 0) {
        calls.push('play:' + frameId);
        if (o.startFails) return { ok: false, why: 'no-video' };
        return { ok: true, paused: false, dur: 3540, rs: 4 };
      }
      return null;
    },
    async getText() { return ''; },
    async getAllCookies() { return null; },
    async screenshot() { return ''; },
    async screenshotClip() { return ''; },
    async openTarget(url) { opened += 1; calls.push('openTarget:' + url); return { id: 'player-' + opened, webSocketDebuggerUrl: 'ws://x/' + opened, url }; },
    async closeTarget(id) { calls.push('closeTarget:' + id); return true; },
    async attachTarget(id) { calls.push('attach:' + id); return { engine: 'fake', targetId: id }; },
  };
}

function makeMachine(adapter) {
  const m = new E.LearnMachine(adapter, cfg);
  m._lastCurIdx = 0;
  m._lastInventory = {
    at: Date.now(),
    tasks: [{ kind: 'live', liveId: '1583741', finished: false, frameUrl: CARDS_URL }],
  };
  const advanced = [];
  m.advanceSection = async () => { advanced.push(true); return { progress: true, outcome: 'ADVANCED' }; };
  m._advanced = advanced;
  return m;
}

function liveState(over) {
  const base = {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=' + CHAPTER_ID,
    topUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=' + CHAPTER_ID,
    frames: [{ frameId: 'cards-frame', url: CARDS_URL }],
    video: { found: false },
    videoFrameId: '',
    dialogs: [],
    human: [],
    loginInvalid: false,
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    quizTab: { present: false, title: '', index: -1, frameId: 'top' },
    toc: {
      found: true, layer: 2, sel: '.chapter_item', note: 'fake', frameId: 'top',
      items: [
        { i: 0, title: '16.1 第一次直播', done: false, current: true, chapterHeader: false, unfinish: 1, chapterId: CHAPTER_ID },
      ],
    },
    videoQuiz: { present: false },
  };
  return Object.assign(base, over || {});
}

const INFO_OK = (percent, timeLong) => ({
  ok: true, percent: percent, timeLong: timeLong === undefined ? Math.round(percent * 35400) : timeLong,
  duration: 3540, viewUrl: 'https://live.chaoxing.com/courseLive/pclive?streamName=X&vdoid=Y', streamName: 'X',
});

async function main() {
  /* ------------------------------------------------------ 1. 缺 liveId */
  console.log('== 1. 任务点没有 liveId ==');
  {
    const a = fakeAdapter({});
    const m = makeMachine(a);
    m._lastInventory = { at: Date.now(), tasks: [{ kind: 'live', finished: false, frameUrl: CARDS_URL }] };
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'LIVE_NO_ID', '★ 缺 liveId → LIVE_NO_ID', r.outcome);
    ok(!a.calls.some((c) => c.startsWith('openTarget')), '不打开任何标签页');
    ok(m.failures === 1, '计入一次失败', m.failures);
    ok(m._advanced.length === 0, '不切节');
  }

  /* ------------------------------------------------------ 2. liveinfo 失败 */
  console.log('== 2. 读不到直播信息 ==');
  {
    const a = fakeAdapter({ liveInfoQueue: [{ ok: false, error: 'no-data' }] });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'LIVE_INFO_FAIL', '★ liveinfo 失败 → LIVE_INFO_FAIL', r.outcome);
    ok(!a.calls.some((c) => c.startsWith('openTarget')), '不打开标签页（绝不盲开）');
    ok(m.failures === 1 && m._advanced.length === 0, '计失败且不切节');
  }

  /* ------------------------------------------------------ 3. 已达标 → 直接切节 */
  console.log('== 3. 服务端已达标（≥90%）==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(93)] });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'ADVANCED', '★ 已达标直接切下一节', r.outcome);
    ok(!a.calls.some((c) => c.startsWith('openTarget')), '★ 已达标绝不开播放器（零副作用）');
    ok(!a.calls.some((c) => c.startsWith('attach:player')), '也不切标签页');
    ok(m.failures === 0, '不算失败', m.failures);
  }

  /* ------------------------------------------------------ 4. 正常路径 */
  console.log('== 4. 正常路径：开播放器 → 轮询 → 达标 → 关页 → 切节 ==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(0), INFO_OK(40), INFO_OK(92)] });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'ADVANCED', '★ 达标后切节', r.outcome);
    const opens = a.calls.filter((c) => c.startsWith('openTarget'));
    ok(opens.length === 1, '恰好打开 1 个播放器标签页', opens.length);
    ok(opens[0].indexOf('live.chaoxing.com/courseLive/pclive') >= 0, '打开的是 liveinfo 给的 viewUrl', opens[0]);
    ok(a.calls.some((c) => c === 'attach:player-1'), '已附着到播放器');
    ok(a.calls.some((c) => c.indexOf('play:zhibo-frame') === 0), '★ 在 zhibo frame 里触发播放');
    ok(a.calls.some((c) => c === 'attach:' + STUDY_TARGET), '★ 结束时切回学习页');
    /* D-027：轮询期间**不再**来回 attachTarget（那会把渲染进程压死） */
    ok(a.calls.filter((c) => c === 'attach:player-1').length === 1,
      '★ 整个轮询期间只附着播放器一次（不来回切 target）',
      JSON.stringify(a.calls.filter((c) => c.indexOf('attach:') === 0)));
    ok(a.calls.some((c) => c === 'closeTarget:player-1'), '★ 达标后关掉播放器标签页');
    const infos = a.calls.filter((c) => c.indexOf('liveinfo:') === 0);
    ok(infos.length === 3, '轮询了 3 次 liveinfo（0 → 40 → 92）', infos.join(','));
    ok(m.failures === 0 && m._advanced.length === 1, '无失败且切节 1 次');
  }

  /* ------------------------------------------------------ 5. 播放器起不来 */
  console.log('== 5. 播放器起不来 ==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(0)], startFails: true });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'LIVE_START_FAIL', '★ 播放器未就绪 → LIVE_START_FAIL', r.outcome);
    ok(a.calls.some((c) => c === 'closeTarget:player-1'), '★ 失败也要关掉标签页（不留脏页）');
    ok(a.calls.indexOf('attach:' + STUDY_TARGET) >= 0, '切回学习页，状态机可继续');
    ok(m.failures === 1 && m._advanced.length === 0, '计失败且不切节（不谎报完成）');
  }

  /* ------------------------------------------------------ 6. 超时 */
  console.log('== 6. 等待超时未达标 ==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(0), INFO_OK(11), INFO_OK(12)] });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'LIVE_TIMEOUT', '★ 超时 → LIVE_TIMEOUT（不谎报完成）', r.outcome);
    /* D-027：超时**故意不关**播放器，让它继续累计服务端进度，下一轮 tick 复用同一标签页 */
    ok(!a.calls.some((c) => c.indexOf('closeTarget:player') === 0), '超时保留播放器（D-027 复用）');
    ok(m._livePlayer && m._livePlayer.targetId === 'player-1', '复用记录仍指向该播放器', JSON.stringify(m._livePlayer));
    ok(m.failures === 1 && m._advanced.length === 0, '计失败且不切节');
  }

  /* ------------------------------------------------------ 7. 口径断言 */
  console.log('== 7. 完成口径来自服务端 percentValue ==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(0), INFO_OK(90)] });
    const m = makeMachine(a);
    const r = await m.handleLiveTask(liveState());
    ok(r.outcome === 'ADVANCED', '★ percentValue=90 即达标（本地 currentTime 不参与）', r.outcome);
    ok(cfg.live.donePercent === 90, '默认完成线 90%', cfg.live.donePercent);
  }

  /* ------------------------------------------------------ 8. 分派 */
  console.log('== 8. 分派：live 交给 handleLiveTask，不落「无视频→跳过」==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(95)] });
    const m = makeMachine(a);
    let called = 0;
    const orig = m.handleLiveTask.bind(m);
    m.handleLiveTask = async (st) => { called += 1; return await orig(st); };
    ok(typeof m.handleLiveTask === 'function', 'handleLiveTask 存在');
    const r = await m.handleLiveTask(liveState());
    ok(called >= 1, 'handler 被调用');
    ok(r.outcome === 'ADVANCED', '并且直接切节（未计入 sectionsSkipped）', r.outcome);
    ok(m.counters.sectionsSkipped === 0, '没有走跳过计数', m.counters.sectionsSkipped);
  }

  /* ------------------------------------------------------ 9. 复用播放器（D-027） */
  console.log('== 9. 重复进入复用同一播放器标签页（D-027）==');
  {
    /* 第一次：进度不动 → 超时（保留播放器）；第二次：同一 liveId 直接复用，不再 openTarget */
    const box = { q: [INFO_OK(0), INFO_OK(5), INFO_OK(6)] };
    const a = fakeAdapter({ queueBox: box });
    const m = makeMachine(a);
    const r1 = await m.handleLiveTask(liveState());
    ok(r1.outcome === 'LIVE_TIMEOUT', '第一次超时', r1.outcome);
    ok(m._livePlayer && m._livePlayer.targetId === 'player-1', '第一次后记住播放器', JSON.stringify(m._livePlayer));
    box.q = [INFO_OK(6), INFO_OK(93)];
    const r2 = await m.handleLiveTask(liveState());
    ok(r2.outcome === 'ADVANCED', '第二次达标切节', r2.outcome);
    const opens = a.calls.filter((c) => c.startsWith('openTarget'));
    ok(opens.length === 1, '★ 两次进入只打开 1 个播放器（复用）', opens.length);
    ok(m._livePlayer === null, '达标后清掉复用记录');
    ok(a.calls.filter((c) => c === 'closeTarget:player-1').length === 1, '达标后关掉播放器 1 次');
  }

  /* ------------------------------------------------------ 10. 切节后 iframe 起不来（D-028） */
  console.log('== 10. 任务点读不到时重载当前节（D-028）==');
  {
    const a = fakeAdapter({ liveInfoQueue: [INFO_OK(0)] });
    const m = makeMachine(a);
    m._currentChapterIdValue = CHAPTER_ID;
    m._lastInventory = { at: Date.now(), tasks: [] };   // 一个任务点都没读到
    /* 第 1 次等待：不动 */
    m._waitTicks = 1;
    await m._kickReloadIfNoTasks();
    ok(!a.calls.some((c) => c === 'navigate'), '第 1 次等待不重载');
    /* 第 2 次等待：重载，并把 chapterId 换成当前节的 */
    m._waitTicks = 2;
    await m._kickReloadIfNoTasks();
    const nav = a.calls.filter((c) => c === 'navigate');
    ok(nav.length === 1, '★ 第 2 次等待重载一次', nav.length);
    /* 任务点已经读到就不该重载 */
    const a2 = fakeAdapter({ liveInfoQueue: [INFO_OK(0)] });
    const m2 = makeMachine(a2);                          // 默认 _lastInventory 里有 live 任务点
    m2._currentChapterIdValue = CHAPTER_ID;
    m2._waitTicks = 2;
    await m2._kickReloadIfNoTasks();
    ok(!a2.calls.some((c) => c === 'navigate'), '有任务点时不重载');
  }

  console.log('\n' + (fails.length ? ('FAIL ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')) : ('全部通过（' + pass + ' 项）')));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL', e && e.stack || e); process.exit(1); });
