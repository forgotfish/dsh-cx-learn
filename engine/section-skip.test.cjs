#!/usr/bin/env node
/* ============================================================================
 * section-skip.test.cjs — 「本节视频已完成就跳过」与「随堂题证据判据」的回归测试
 * ============================================================================
 * 两条断言直接来自 FNOS 真机实测（2026-10-30 20:2x，只读 CDP 探针，章节 1.3 工程形态）：
 *
 *   实测现场：
 *     · 目录项 id="cur143114597"、jobUnfinishCount=1（视频已完成，只剩章节测验）
 *     · knowledge/cards iframe：
 *         <div class="ans-attach-ct videoContainer ans-job-finished" id="ext-gen1050">
 *           <span class="ans-job-icon ans-job-video" aria-label="任务点已完成">
 *     · 播放器把上次位置恢复到 254 秒（duration=350），随堂题面板同时在 254 秒弹出
 *
 *   原来的两个缺陷：
 *     1) 「本节已完成就跳过」的判定排在弹题处理**之后** → 遗留弹题先把整轮停掉
 *        （quiz_unclassified_needs_human），明明该跳过。
 *     2) 弹题要求「本轮推进过播放」（_videoProgressTicks>0），但续播场景一帧都没推进
 *        → 真随堂题被判「证据不足」。
 *
 * 这个测试不连浏览器，用固定 state 直接驱动 LearnMachine 的两个判定。
 * 用法：node engine/section-skip.test.cjs
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

const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
/* humanize 是全局单例，不 configure 就直接调 pollDelay 会炸（_cfg 为 null）。
   run() 里会 configure，这里单独驱动状态机所以要自己配。 */
E.humanize.configure(cfg.humanize);

/** 造一个最小 adapter：只实现 tick 路径会用到的 find/click，用于断言「点了什么」 */
function fakeAdapter(clicks) {
  return {
    engine: 'fake',
    async ensureBrowser() { return {}; },
    async navigate() {},
    async getCurrentUrl() { return 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=143114597'; },
    async getFrameDocuments() { return []; },
    async evalInFrame() { return null; },
    async getText() { return ''; },
    async getAllCookies() { return null; },
    async screenshot() { return ''; },
    async screenshotClip() { return ''; }
  };
}

/** 实测现场：1.3 已看完（ans-job-finished），播放器续播到 254/350，随堂题还挂着 */
function liveState(over) {
  const base = {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=143114597&courseId=204169157',
    topUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=143114597&courseId=204169157',
    frames: [{ frameId: 'cards', url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=156594937&courseid=204169157&knowledgeid=143114597' }],
    video: { found: true, paused: true, ended: false, currentTime: 254, duration: 350, progress: 72.6, readyState: 4 },
    videoFrameId: 'video-frame',
    dialogs: [],
    human: [],
    loginInvalid: false,
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    quizTab: { present: true, title: '章节测验', index: 1, frameId: 'top' },
    toc: {
      found: true, layer: 2, sel: '.posCatalog_select', note: '旧版完整课程目录(.posCatalog_select)', frameId: 'top',
      items: [
        { i: 0, title: '第一章 新时代的工程', done: false, current: false, chapterHeader: true, unfinish: -1, chapterId: '' },
        { i: 1, title: '1.1 第四次工业革命', done: true, current: false, chapterHeader: false, unfinish: 0, chapterId: '143114595' },
        { i: 2, title: '1.2 中国与四次工业革命', done: true, current: false, chapterHeader: false, unfinish: 0, chapterId: '143114596' },
        { i: 3, title: '1.3 工程形态', done: false, current: true, chapterHeader: false, unfinish: 1, chapterId: '143114597' }
      ]
    },
    /* 随堂题：实测那一块 .ans-videoquiz 与播放器在同一个 frame */
    videoQuiz: {
      present: true, frameId: 'video-frame',
      title: '计算机和网络代表了电气时代的生活',
      options: [{ i: 0, letter: 'A', label: '对' }, { i: 1, letter: 'B', label: '错' }],
      submitVisible: true, continueVisible: false, correct: false, wrong: false,
      wrongBack: false, remaining: null, panelText: '判断题 提交'
    }
  };
  return Object.assign(base, over || {});
}

/* ------------------------------------------------------------------ 1. 完成判定 */
console.log('== 1. 本节「视频任务已完成」判定 ==');
{
  const m = new E.LearnMachine(fakeAdapter([]), cfg);
  m._lastCurIdx = 3;
  // 页面证据：cards iframe 里的视频任务点已是 ans-job-finished
  m._lastInventory = {
    at: Date.now(),
    tasks: [{ kind: 'video', finished: true, label: '任务点已完成', frameUrl: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=143114597' }]
  };
  const r = m._videoTaskDone(liveState());
  ok(r.ok === true, '★ 页面任务点 ans-job-finished → 判本节视频已完成', JSON.stringify(r));
  ok(r.by === 'page-video-task-finished', 'by 标明是页面任务点证据', String(r.by));
}

{
  const m = new E.LearnMachine(fakeAdapter([]), cfg);
  m._lastCurIdx = 3;
  /* 切节瞬间的残留：cards iframe 还是**上一节** 143114596 的内容，且显示已完成 */
  m._lastInventory = {
    at: Date.now(),
    tasks: [{ kind: 'video', finished: true, label: '任务点已完成', frameUrl: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=2&knowledgeid=143114596' }]
  };
  const r = m._videoTaskDone(liveState());
  ok(r.ok === false, '★ 任务点属于上一节（knowledgeid 不匹配）→ 不得据此跳过', JSON.stringify(r));
  ok(r.by === 'inventory-from-other-section', 'by 指出是别的节的任务点', String(r.by));
}

{
  const m = new E.LearnMachine(fakeAdapter([]), cfg);
  m._lastCurIdx = 3;
  m._lastInventory = {
    at: Date.now(),
    tasks: [{ kind: 'video', finished: false, label: '任务点未完成', frameUrl: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=2&knowledgeid=143114597' }]
  };
  const r = m._videoTaskDone(liveState());
  ok(r.ok === false, '视频任务点未完成 → 不跳过', JSON.stringify(r));
}

{
  const m = new E.LearnMachine(fakeAdapter([]), cfg);
  m._lastCurIdx = 3;
  m._lastInventory = { at: Date.now(), tasks: [] };
  /* 只有 1 个任务点的节（纯视频），未观看时 unfinish=1。
     旧的「unfinish < 假定总数 2」会把它判成已完成 —— 等于把没看的课当看完。 */
  const st = liveState({
    toc: {
      found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top',
      items: [
        { i: 0, title: '1.4 作为科学的工程', done: false, current: true, chapterHeader: false, unfinish: 1, chapterId: '143114598' }
      ]
    }
  });
  m._lastCurIdx = 0;
  const r = m._videoTaskDone(st);
  ok(r.ok === false, '★ 单任务点未看（unfinish=1）不得因「假定总数 2」被误跳', JSON.stringify(r));
}

{
  const m = new E.LearnMachine(fakeAdapter([]), cfg);
  m._lastCurIdx = 3;
  m._lastInventory = { at: Date.now(), tasks: [] };
  const st = liveState();
  st.toc.items[3].unfinish = 0;
  st.toc.items[3].done = true;
  const r = m._videoTaskDone(st);
  ok(r.ok === true && r.by === 'toc-unfinish-zero', '目录待办归零 → 兜底判完成', JSON.stringify(r));
}

/* ------------------------------------------------------- 2. 顺序：先判跳过再判弹题 */
console.log('== 2. 遗留弹题不得拦下「已完成」的小节 ==');
(async () => {
  {
    const clicks = [];
    const m = new E.LearnMachine(fakeAdapter(clicks), cfg);
    m._lastCurIdx = 3;
    m._lastInventory = {
      at: Date.now(),
      tasks: [{ kind: 'video', finished: true, label: '任务点已完成', frameUrl: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=2&knowledgeid=143114597' }]
    };
    let advanced = 0;
    m.advanceSection = async () => { advanced += 1; m.stop('all_done_or_no_target'); return { progress: true, outcome: 'ALL_DONE' }; };
    m.gatherState = async () => liveState();
    const r = await m.tick();
    ok(advanced === 1, '★ 进入已看完的小节 → 直接 advanceSection（不再处理遗留弹题）', 'advanced=' + advanced);
    ok(m.stopReason === 'all_done_or_no_target', '没有因 quiz_unclassified_needs_human 停机', String(m.stopReason));
    ok(m.counters.sectionsSkipped === 1, 'sectionsSkipped 记 1', String(m.counters.sectionsSkipped));
    void r; void clicks;
  }

  /* --------------------------------------------- 3. 续播场景的随堂题应能识别 */
  console.log('== 3. 续播到视频中途时弹题应判为视频随堂题 ==');
  {
    const m = new E.LearnMachine(fakeAdapter([]), cfg);
    m._videoProgressTicks = 0;          // 本轮一帧都没推进（续播场景）
    let stopped = null;
    m.stop = (r) => { stopped = r; };
    m.clickFound = async (_f, kind) => ({ ok: kind === 'videoQuizOption' || kind === 'videoQuizSubmit' || kind === 'videoQuizContinue', layer: 2, note: kind });
    m.gatherState = async () => liveState({
      videoQuiz: { present: false }   // 提交后弹题消失
    });
    const st = liveState();
    st.video = { found: true, paused: true, currentTime: 254, duration: 350, progress: 72.6, readyState: 4 };
    const r = await m.handleVideoQuiz(st);
    ok(r.outcome !== 'VIDEO_QUIZ_UNCLASSIFIED', '★ 有播放器+时长+续播位置 → 不再判「证据不足」', String(r.outcome));
    ok(stopped !== 'quiz_unclassified_needs_human', '没有因「视频题证据不足」停机', String(stopped));
  }

  {
    /* 安全边界不能丢：没有播放器（或播放器不在同一个 frame）时仍然必须停 */
    const m = new E.LearnMachine(fakeAdapter([]), cfg);
    m._videoProgressTicks = 0;
    let stopped = null;
    m.stop = (r) => { stopped = r; };
    const st = liveState();
    st.video = { found: true, paused: true, currentTime: 0, duration: 0, progress: 0, readyState: 0 };
    st.videoFrameId = 'other-frame';
    const r = await m.handleVideoQuiz(st);
    /* ★ 2026-10-30 主人指令：删掉「识别不出来就停」的兜底。
       证据不足时不再整体停机，而是照常走随堂题流程（只处理 .ans-videoquiz）。 */
    ok(r.outcome !== 'VIDEO_QUIZ_UNCLASSIFIED', '★ 证据不足不再判「无法识别」直接返回', String(r.outcome));
    ok(stopped !== 'quiz_unclassified_needs_human', '★ 不再以 quiz_unclassified_needs_human 停机', String(stopped));
  }

  {
    /* 安全边界仍然要在：章节测验（.TiMu）绝不能被这里当成随堂题去点。
       这条不依赖「证据不足」，它是 selector 层面的硬隔离 —— 见 handleQuiz 分支。 */
    const m = new E.LearnMachine(fakeAdapter([]), cfg);
    m.stop = () => {};
    const st = liveState({ videoQuiz: { present: false } });
    const r = await m.handleVideoQuiz(st);
    ok(r.outcome === 'VIDEO_QUIZ_NONE', '没有 .ans-videoquiz 时不做任何动作', String(r.outcome));
  }

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  process.exit(0);
})();
