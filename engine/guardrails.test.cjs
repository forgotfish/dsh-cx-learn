#!/usr/bin/env node
/* ============================================================================
 * guardrails.test.cjs — 三条「保护性」行为的状态机测试（不连浏览器）
 * ============================================================================
 * 这三条是最贵的三条红线：风控、人工验证、视频卡死。
 * 用假适配器直接驱动 tick()，几毫秒内跑完，不依赖真实站点、不用等 30 秒。
 *
 *   1. 命中风控 → 等待 → 刷新 → 解除则继续；重试用尽才 fatalStop
 *   2. 检测到人脸/验证码 → 立即 fatalStop（绝不尝试绕过）
 *   3. 视频 readyState=0（CDN 签名过期）→ 点播放推动加载
 *
 * 用法：node engine/guardrails.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
/* 状态隔离：问题快照会写 diagnostics/，测试必须落在临时目录，不能污染 engine/.state */
process.env.CX_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-guard-'));
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const cfg = E.mergeConfig(E.CONFIG, {
  humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  /* 把 30 秒的风控等待压到 20ms，只为让测试快；判据与真实一致 */
  detect: { retryWaitMs: 20, retryJitterMs: 1, maxRetries: 2 },
  safety: { maxLoadRetries: 3 }
});
E.humanize.configure(cfg.humanize);

const DETECT_URL = 'https://detect.chaoxing.com/api/monitor_temp?mes=%E5%A4%9A%E7%BB%88%E7%AB%AF%E7%99%BB%E5%BD%95';

function fakeAdapter(over) {
  const a = {
    engine: 'fake',
    navigations: [],
    clicks: [],
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    _isDetectUrl(u) { return /detect\.chaoxing\.com|\/api\/monitor_temp|[?&]mes=/.test(String(u || '')); },
    async _readDetectMessage() { return '多终端登录'; },
    async navigate(u) { this.navigations.push(u); this.url = u; },
    async getCurrentUrl() { return this.url; },
    async getFrameDocuments() { return [{ frameId: 'top', url: this.url, isTop: true }]; },
    async evalInFrame() { return null; },
    async click(_f, rect) { this.clicks.push(rect && rect.__kind); return { mode: 'fake' }; },
    async jsClick() { return { ok: false }; },
    async getText() { return ''; },
    async ensureBrowser() { return {}; },
    async getAllCookies() { return null; },
    async screenshot() { return ''; },
    async screenshotClip() { return ''; }
  };
  return Object.assign(a, over || {});
}

function state(over) {
  return Object.assign({
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    topUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
    frames: [], dialogs: [], human: [], loginInvalid: false,
    video: { found: false }, videoFrameId: null, videoQuiz: null,
    quiz: { present: false }, quizTab: { present: false },
    toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: [] }
  }, over || {});
}

(async () => {
  /* ---------------- 1. 风控：等到解除 → 继续 ---------------- */
  console.log('== 1. 命中风控 → 等待 → 刷新 → 解除则继续 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m.gatherState = async () => state({ topUrl: DETECT_URL });
    /* 刷新后落到安全页（模拟手机端已退出登录、风控解除） */
    const origNavigate = a.navigate.bind(a);
    a.navigate = async (u) => { await origNavigate(u); a.url = 'https://i.chaoxing.com/base'; };
    const r = await m.tick();
    ok(r.outcome === 'RISK_CONTROL_RECOVERED', '风控解除后继续（实际 ' + r.outcome + '）');
    ok(a.navigations.some((u) => /i\.chaoxing\.com\/base/.test(u)), '刷新到了 i.chaoxing.com/base');
    ok(m.stopReason === null, '没有停机', String(m.stopReason));
  }

  /* ---------------- 2. 风控：重试用尽 → 停止并写明原因 ---------------- */
  console.log('== 2. 风控未解除 → 重试 2 次后停止并写明原因 ==');
  {
    const a = fakeAdapter();
    a.navigate = async (u) => { a.navigations.push(u); /* 刷新后仍是风控页 */ };
    const m = new E.LearnMachine(a, cfg);
    m.gatherState = async () => state({ topUrl: DETECT_URL });
    let last = null;
    for (let i = 0; i < 4; i++) {
      last = await m.tick();
      if (m.stopReason) break;
    }
    ok(m.stopReason === 'RISK_CONTROL_DETECTED', '停止原因是 RISK_CONTROL_DETECTED（实际 ' + m.stopReason + '）');
    ok(/多终端登录|已重试/.test(JSON.stringify(E.logger.tail(60))), '日志写明了原因');
    void last;
  }

  /* ---------------- 3. 人工验证：立即停，绝不绕过 ---------------- */
  console.log('== 3. 人脸/验证码 → 立即 FATAL，不做任何尝试 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m.gatherState = async () => state({ human: [{ evidence: '人脸识别', frameId: 'top' }] });
    const r = await m.tick();
    ok(m.stopReason === 'HUMAN_VERIFICATION', '停止原因 HUMAN_VERIFICATION（实际 ' + m.stopReason + '）');
    ok(a.clicks.length === 0, '★ 一次点击都没发（不尝试绕过）', JSON.stringify(a.clicks));
    ok(r.outcome === 'FATAL_STOP', 'outcome=FATAL_STOP');
  }

  /* ---------------- 4. 登录态失效：停，且不自动登录 ---------------- */
  console.log('== 4. 登录态失效 → 停，不自动登录 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m.gatherState = async () => state({ loginInvalid: true, loginEvidence: ['top:passport2 pwField=true'] });
    await m.tick();
    ok(m.stopReason === 'LOGIN_REQUIRED', '停止原因 LOGIN_REQUIRED（实际 ' + m.stopReason + '）');
    ok(a.navigations.length === 0, '★ 没有自动跳登录页/自动填表', JSON.stringify(a.navigations));
  }

  /* ---------------- 5. 视频卡死（readyState=0）→ 点播放推动加载 ---------------- */
  console.log('== 5. 视频元数据未加载 → 点一次播放推动加载 ==');
  {
    const a = fakeAdapter();
    /* find 返回一个可点的播放控件坐标 */
    a.evalInFrame = async (_f, expr) => {
      if (typeof expr === 'string' && expr.indexOf('__cx.find') >= 0) {
        return { ok: true, text: '播放', layer: 1, note: 'vjs-big-play-button', rect: { x: 10, y: 20, w: 30, h: 30, __kind: 'videoToggle' } };
      }
      return null;
    };
    const m = new E.LearnMachine(a, cfg);
    m._currentTitle = '1.4 测试节';
    m.gatherState = async () => state({
      video: { found: true, paused: true, duration: 0, currentTime: 0, progress: 0, readyState: 0, networkState: 1, buffered: [] },
      videoFrameId: 'video'
    });
    await m.waitLoad();
    ok(a.clicks.filter((k) => k === 'videoToggle').length >= 1, '★ readyState=0 时点过播放（推动加载）', JSON.stringify(a.clicks));
  }

  /* ---------------- 6. 安全闸门：漏掉必杀词的页面不能当成正常 == */
  console.log('== 6. 风控页/登录页不在 toc 里被当成「没有目录」而乱点 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m.gatherState = async () => state({ toc: { found: false, items: [], layer: 0, sel: '', note: '' } });
    const r = await m.advanceSection(state({ toc: { found: false, items: [], layer: 0, sel: '', note: '' } }));
    ok(r.outcome === 'TOC_MISSING', '目录缺失时明确报 TOC_MISSING（实际 ' + r.outcome + '）');
    ok(a.clicks.length === 0, '★ 没有盲目点击', JSON.stringify(a.clicks));
  }

  /* ---------------- 7. 播完但超星未确认：连续 N 次必须停 ---------------- */
  /* 2026-10-31 真机：3.4 播到 97.8% 就 ended，任务点始终 not-done，
     目录 current 被页面拉回 3.3 → 引擎跟随 → 点回 3.4 → 再播完，约 27s 一轮。
     这里模拟同一节连续「播完未确认」，要求第 3 次停下来，而不是无限重进。 */
  console.log('== 7. 播完未确认：连续 3 次后停止 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    const tocItems = [
      { title: '3.3 上一节', id: 'cur1', chapterId: '1', current: true, done: true, unfinish: 1 },
      { title: '3.4 当前节', id: 'cur2', chapterId: '2', current: false, done: false, unfinish: 2 },
    ];
    m.gatherState = async () => state({
      video: {
        found: true, frameId: 'vf', ended: true, paused: false,
        currentTime: 755.4, duration: 772.2, progress: 97.8, readyState: 4, buffered: [[0, 755]],
      },
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
    m._isVideoStartedHere = () => true;
    m._currentSectionDone = () => false;
    m._videoTaskDone = () => ({ ok: false, by: 'not-done' });
    m.confirmVideoWatched = async () => 2;
    m.maybeHandleChapterQuiz = async () => 'none';
    let advances = 0;
    m.advanceSection = async () => { advances += 1; return { progress: true, outcome: 'ADVANCED' }; };
    for (let i = 0; i < 3 && !m.stopReason; i++) await m.tick();
    ok(m.stopReason === 'video_not_confirmed', '★ 第 3 次未确认后停止（实际 ' + m.stopReason + '）');
    ok(advances <= 2, '前两次允许重试，不会一开始就停（advance=' + advances + '）');
    ok(m.counters.videoNotConfirmed === 3, '未确认计数到 3（实际 ' + m.counters.videoNotConfirmed + '）');
  }

  /* ---------------- 8. 播放器串到上一节：不得当作已就绪 ---------------- */
  /* 2026-10-31 真机：点 3.4，但 knowledge/cards 还是 3.3 的播放器（772.2s），
     引擎只判「有视频 + duration>0」就当成就绪 → 把 3.3 当 3.4 看，3.4 永不记账。 */
  console.log('== 8. 播放器仍是上一节 → 不判就绪 ==');
  {
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);
    m._waitTarget = { tocFrameId: 'top', index: 3, chapterId: '111', title: '3.4 测试节' };
    m._currentTitle = '3.4 测试节';
    m.gatherState = async () => state({
      frames: [{ frameId: 'vf', url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=222' }],
      video: { found: true, frameId: 'vf', duration: 772.2, readyState: 4, progress: 0 },
      videoFrameId: 'vf',
    });
    const loaded = await m.waitLoad();
    ok(loaded === false, '★ 播放器属于别的节（knowledgeid=222 ≠ 111）→ 不返回就绪');
    ok(m.stopReason === 'section_unreachable', '★ 切换一直失败 → 以 section_unreachable 停机，不假装在学新节（实际 ' + m.stopReason + '）');

    const m2 = new E.LearnMachine(fakeAdapter(), cfg);
    m2._waitTarget = { tocFrameId: 'top', index: 3, chapterId: '111', title: '3.4 测试节' };
    m2._currentTitle = '3.4 测试节';
    m2.gatherState = async () => state({
      frames: [{ frameId: 'vf', url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111' }],
      video: { found: true, frameId: 'vf', duration: 578.2, readyState: 4, progress: 0 },
      videoFrameId: 'vf',
    });
    ok((await m2.waitLoad()) === true, 'knowledgeid 对得上 → 正常就绪');
  }

  /* 【20】2026-11-01：课程正文/字幕提到「人脸识别」不等于验证弹窗，必须带验证语境才停机 */
  {
    const kw = E.CONFIG.safety.fatalKeywords;
    ok(!kw.includes('人脸'), '★ 不再用裸「人脸」当停机关键词');
    ok(!kw.includes('活体'), '★ 不再用裸「活体」当停机关键词');
    const sel = require('./src/learn/selectors.js');
    ok(/var strong/.test(sel.PAGE_PROBE_SRC), '★ 探针里有验证语境判定（strong）');
    ok(!sel.PAGE_PROBE_SRC.includes('[^。；' + String.fromCharCode(92) + 'n]'), '★ 正则里没有会被模板吃掉的换行转义');
  }

  /* 【24】2026-11-15：skipChapterQuiz=true 时章节测验通路绝不触达 ai 模块（用 spy 计数） */
  {
    const aiCore = require('./src/core/ai.js');
    let aiCalls = 0;
    const origDecide = aiCore.decide;
    aiCore.decide = function () { aiCalls += 1; return origDecide.apply(this, arguments); };
    try {
      const a = fakeAdapter();
      /* ★ 2026-11-15 策略改了：默认不再跳过，而是「作答 + 只保存」。
         本条用例专门验证「显式 skip」这条旧路径仍然可用，所以配置里手动打开。 */
      const cfgSkip = E.mergeConfig(cfg, { safety: { skipChapterQuiz: true } });
      const m = new E.LearnMachine(a, cfgSkip);
      m.gatherState = async () => state({});
      let advanced = 0;
      m.advanceSection = async () => { advanced += 1; return { progress: true, outcome: 'ADVANCED' }; };
      const chapterState = state({
        quiz: {
          present: true, kind: 'chapter_work', parseable: true,
          options: [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }],
          blocks: [{ i: 0, question: '题干', options: [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }] }],
        },
      });
      const r = await m.handleQuiz(chapterState);
      ok(aiCalls === 0, '★ 章节测验绝不触达 ai 模块（decide 调用 0 次，实际 ' + aiCalls + '）');
      ok(r && r.outcome === 'ADVANCED', '★ skip 策略下章节测验跳过并切下一节（实际 ' + (r && r.outcome) + '）');
      ok(advanced === 1, '跳过时只推进一次（advanced=' + advanced + '）');
    } finally {
      aiCore.decide = origDecide;
    }
  }

  /* 【24b】2026-11-15 主人指令：默认 = 作答后只点「保存」，绝不点「提交」
     ★ D-038：必须给一个 AI 通道，否则「没配 AI = 直接不答」，测不到保存逻辑。 */
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    const a = fakeAdapter();
    const m = new E.LearnMachine(a, cfg);   // 默认配置：answerChapterQuiz=true, submitMode='save'
    m.gatherState = async () => state({});
    const kinds = [];
    m.clickFound = async (_f, kind) => { kinds.push(kind); return { ok: true, text: kind === 'quizBlockSave' ? '保存' : 'A', note: kind }; };
    m.askAI = async () => 1;
    let advanced = 0;
    m.advanceSection = async () => { advanced += 1; return { progress: true, outcome: 'ADVANCED' }; };
    const r = await m.handleQuiz(state({
      quiz: {
        present: true, kind: 'chapter_work', parseable: true, frameId: 'top',
        options: [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }],
        blocks: [{ i: 0, question: '题干', options: [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }] }],
      },
    }));
    ok(kinds.indexOf('quizBlockOption') >= 0, '选了选项（实际 ' + JSON.stringify(kinds) + '）');
    ok(kinds.indexOf('quizBlockSave') >= 0, '★ 点了「保存」（实际 ' + JSON.stringify(kinds) + '）');
    ok(kinds.indexOf('quizBlockSubmit') < 0, '★ 绝不点「提交」（实际 ' + JSON.stringify(kinds) + '）');
    ok(m.counters.quizzesSaved === 1, '保存计数 +1（实际 ' + m.counters.quizzesSaved + '）');
    ok(r && r.outcome === 'ADVANCED', '保存后切下一节（实际 ' + (r && r.outcome) + '）');
    ok(advanced === 1, '只推进一次（advanced=' + advanced + '）');
  }

  /* 【24c】submitMode='none' → 只填选项，不点任何按钮（★ D-038：需要 AI 通道） */
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    const a = fakeAdapter();
    const cfgNone = E.mergeConfig(cfg, { safety: { chapterQuizSubmitMode: 'none' } });
    const m = new E.LearnMachine(a, cfgNone);
    const kinds = [];
    m.clickFound = async (_f, kind) => { kinds.push(kind); return { ok: true, note: kind }; };
    m.askAI = async () => 0;
    m.advanceSection = async () => ({ progress: true, outcome: 'ADVANCED' });
    const r = await m.handleQuiz(state({
      quiz: {
        present: true, kind: 'chapter_work', parseable: true, frameId: 'top',
        options: [{ i: 0, letter: 'A', label: '甲' }],
        blocks: [{ i: 0, question: '题干', options: [{ i: 0, letter: 'A', label: '甲' }] }],
      },
    }));
    ok(kinds.indexOf('quizBlockSave') < 0 && kinds.indexOf('quizBlockSubmit') < 0,
      '★ none 模式不点保存也不点提交（实际 ' + JSON.stringify(kinds) + '）');
    ok(r && r.outcome === 'QUIZ_FILLED_ONLY', 'outcome=QUIZ_FILLED_ONLY（实际 ' + (r && r.outcome) + '）');
  }

  /* 【24d】submitMode='submit' → 才允许真交卷（必须显式开启；★ D-038：需要 AI 通道） */
  {
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:1/x';
    const a = fakeAdapter();
    const cfgSub = E.mergeConfig(cfg, { safety: { chapterQuizSubmitMode: 'submit' } });
    const m = new E.LearnMachine(a, cfgSub);
    const kinds = [];
    m.clickFound = async (_f, kind) => { kinds.push(kind); return { ok: true, note: kind }; };
    m.askAI = async () => 0;
    m.confirmWorkSubmit = async () => ({ confirmed: true, submitted: true });
    const r = await m.handleQuiz(state({
      quiz: {
        present: true, kind: 'chapter_work', parseable: true, frameId: 'top',
        options: [{ i: 0, letter: 'A', label: '甲' }],
        blocks: [{ i: 0, question: '题干', options: [{ i: 0, letter: 'A', label: '甲' }] }],
      },
    }));
    ok(kinds.indexOf('quizBlockSubmit') >= 0, 'submit 模式点了提交（实际 ' + JSON.stringify(kinds) + '）');
    ok(r && r.outcome === 'QUIZ_ANSWERED', 'outcome=QUIZ_ANSWERED（实际 ' + (r && r.outcome) + '）');
  }

  /* 【31】v2 批量答题：batchSize>1 时只发一次批量请求，逐题 askAI 一次都不调，
     按 answers[].index 点选（1/0/2），收尾仍是「只保存、不提交」 */
  {
    const a = fakeAdapter();
    const cfgb = E.mergeConfig(cfg, { ai: { enabled: true, batchSize: 10 } });
    const m = new E.LearnMachine(a, cfgb);
    m.gatherState = async () => state({});
    const prevAskUrl = process.env.CX_LLM_ASK_URL;
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:9/x';   // useAi=true（不会真发请求，下面全 stub）
    try {
      const clicks = [];
      const kinds = [];
      m.clickFound = async (_f, kind, arg) => {
        kinds.push(kind);
        if (kind === 'quizBlockOption') clicks.push({ b: arg && arg.b, o: arg && arg.o });
        return { ok: true, text: kind === 'quizBlockSave' ? '保存' : 'A', note: kind };
      };
      let aiCalls = 0;
      let batchCalls = 0;
      m.askAI = async () => { aiCalls += 1; return 0; };
      m.askAIBatch = async () => {
        batchCalls += 1;
        return { ok: true, answers: [{ id: 'q1', index: 1 }, { id: 'q2', index: 0 }, { id: 'q3', index: 2 }], unresolved: [], dropped: [] };
      };
      let advanced = 0;
      m.advanceSection = async () => { advanced += 1; return { progress: true, outcome: 'ADVANCED' }; };
      const two = [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }];
      const r = await m.handleQuiz(state({
        quiz: {
          present: true, kind: 'chapter_work', parseable: true, frameId: 'top',
          options: two,
          blocks: [
            { i: 0, question: '第一题', kind: 'single', options: two },
            { i: 1, question: '第二题', kind: 'single', options: two },
            { i: 2, question: '第三题', kind: 'single', options: two },
          ],
        },
      }));
      ok(batchCalls === 1, '★ 只发了一次批量请求（实际 ' + batchCalls + '）');
      ok(aiCalls === 0, '★ 批量命中时逐题 askAI 一次都不调（实际 ' + aiCalls + '）');
      ok(clicks.length === 3, '点了 3 个题块的选项（实际 ' + JSON.stringify(clicks) + '）');
      ok(clicks.map((c) => c.o).join(',') === '1,0,2', '★ 按批量答案下标点选 1/0/2（实际 ' + JSON.stringify(clicks) + '）');
      ok(m.counters.quizzesSaved === 1, '★ 保存计数 +1（实际 ' + m.counters.quizzesSaved + '）');
      ok(kinds.indexOf('quizBlockSubmit') < 0, '★ 绝不点「提交」（实际 ' + JSON.stringify(kinds) + '）');
      ok(r && r.outcome === 'ADVANCED', '保存后切下一节（实际 ' + (r && r.outcome) + '）');
      ok(advanced === 1, '只推进一次（advanced=' + advanced + '）');
    } finally {
      if (prevAskUrl === undefined) delete process.env.CX_LLM_ASK_URL; else process.env.CX_LLM_ASK_URL = prevAskUrl;
    }
  }

  /* 【32】v2 批量失败（AI_BAD_JSON）→ 整卷回退逐题 askAI，不中断，仍能保存 */
  {
    const a = fakeAdapter();
    const cfgb = E.mergeConfig(cfg, { ai: { enabled: true, batchSize: 10 } });
    const m = new E.LearnMachine(a, cfgb);
    m.gatherState = async () => state({});
    const prevAskUrl = process.env.CX_LLM_ASK_URL;
    process.env.CX_LLM_ASK_URL = 'http://127.0.0.1:9/x';
    try {
      const clicks = [];
      const kinds = [];
      m.clickFound = async (_f, kind, arg) => {
        kinds.push(kind);
        if (kind === 'quizBlockOption') clicks.push({ b: arg && arg.b, o: arg && arg.o });
        return { ok: true, text: kind === 'quizBlockSave' ? '保存' : 'A', note: kind };
      };
      let aiCalls = 0;
      m.askAI = async () => { aiCalls += 1; return 0; };
      m.askAIBatch = async () => ({ ok: false, code: 'AI_BAD_JSON', answers: [] });
      let advanced = 0;
      m.advanceSection = async () => { advanced += 1; return { progress: true, outcome: 'ADVANCED' }; };
      const two = [{ i: 0, letter: 'A', label: '甲' }, { i: 1, letter: 'B', label: '乙' }];
      const r = await m.handleQuiz(state({
        quiz: {
          present: true, kind: 'chapter_work', parseable: true, frameId: 'top',
          options: two,
          blocks: [
            { i: 0, question: '第一题', kind: 'single', options: two },
            { i: 1, question: '第二题', kind: 'single', options: two },
            { i: 2, question: '第三题', kind: 'single', options: two },
          ],
        },
      }));
      ok(aiCalls === 3, '★ 批量失败 → 3 道题全部回退逐题 askAI（实际 ' + aiCalls + '）');
      ok(clicks.length === 3, '3 道题仍然都点了选项（实际 ' + JSON.stringify(clicks) + '）');
      ok(m.counters.quizzesSaved === 1, '★ 回退后仍能保存（quizzesSaved 实际 ' + m.counters.quizzesSaved + '）');
      ok(kinds.indexOf('quizBlockSubmit') < 0, '★ 绝不点「提交」（实际 ' + JSON.stringify(kinds) + '）');
      ok(r && r.outcome === 'ADVANCED', '回退流程不中断，保存后切下一节（实际 ' + (r && r.outcome) + '）');
    } finally {
      if (prevAskUrl === undefined) delete process.env.CX_LLM_ASK_URL; else process.env.CX_LLM_ASK_URL = prevAskUrl;
    }
  }

  /* ==========================================================================
   * GitHub Issue #1 回归（2026-11-15）：一节多个视频任务点时，
   * 只播完第一个不能就切节，必须继续播下一个；只有本节所有 media 任务点
   * 都播过，才允许 advanceSection。
   * 下面用假 adapter 直接驱动 tick()，把 _lastInventory / _lastVideos 当作
   * gatherState 的产物手动喂进去（探针在真实浏览器里的产物形状）。
   * ======================================================================*/

  /* 【27】一节 3 个 video 任务点（1 完成 2 未完成）→ 不切节，改播下一个 */
  console.log('== 27. 一节 3 个视频任务点，仅 1 个完成 → 不切节，继续播下一个 ==');
  {
    const a = fakeAdapter();
    /* clickFound 走 __cx.find('videoToggle')，返回一个可点坐标 → 记一次 videoToggle */
    a.evalInFrame = async (_f, expr) => {
      if (typeof expr === 'string' && expr.indexOf('__cx.find') >= 0) {
        return { ok: true, text: '播放', layer: 1, note: 'videoToggle', rect: { x: 1, y: 1, w: 2, h: 2, __kind: 'videoToggle' } };
      }
      return null;
    };
    const oidA = 'a'.repeat(32), oidB = 'b'.repeat(32), oidC = 'c'.repeat(32);
    const frameUrl = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111';
    const tasks = [
      { kind: 'video', finished: true, objectid: oidA, frameUrl },
      { kind: 'video', finished: false, objectid: oidB, frameUrl },
      { kind: 'video', finished: false, objectid: oidC, frameUrl },
    ];
    /* 未完成的两个 task 各有对应播放器，均未启动过 */
    const videos = [
      { frameId: 'vfB', frameUrl, src: 'https://cdn.example/' + oidB + '.mp4', objectid: oidB, duration: 100, currentTime: 0, paused: true, ended: false, readyState: 4 },
      { frameId: 'vfC', frameUrl, src: 'https://cdn.example/' + oidC + '.mp4', objectid: oidC, duration: 100, currentTime: 0, paused: true, ended: false, readyState: 4 },
    ];
    const tocItems = [{ title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, unfinish: 2 }];
    const stPlayed = state({
      video: { found: true, frameId: 'vfA', src: 'https://cdn.example/' + oidA + '.mp4', objectid: oidA, ended: true, paused: false, progress: 99, currentTime: 100, duration: 100, readyState: 4 },
      videoFrameId: 'vfA',
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
    const m = new E.LearnMachine(a, cfg);
    m._currentTitle = '本节';
    m._markVideoStarted({ src: 'https://cdn.example/' + oidA + '.mp4' }); // 第一个视频已播完（本次启动过）
    m.gatherState = async () => {
      m._lastInventory = { tasks, at: Date.now() };
      m._lastVideos = videos;
      return stPlayed;
    };
    let advances = 0;
    m.advanceSection = async () => { advances += 1; return { progress: true, outcome: 'ADVANCED' }; };
    m.confirmVideoWatched = async () => 1;
    m.maybeHandleChapterQuiz = async () => 'none';
    const r = await m.tick();
    ok(advances === 0, '★ 不得切节（advanceSection 调用 0 次，实际 ' + advances + '）');
    ok(a.clicks.filter((k) => k === 'videoToggle').length >= 1, '★ 调用了播放下一个视频（videoToggle 点击 ≥1，实际 ' + JSON.stringify(a.clicks) + '）');
    ok(r.outcome === 'NEXT_VIDEO', '本拍产出 NEXT_VIDEO（不推进）（实际 ' + r.outcome + '）');
    ok(m.counters.sectionsCompleted === 0, '未切节时 sectionsCompleted 不增加（实际 ' + m.counters.sectionsCompleted + '）');
  }

  /* 【28】本节 media 任务点全部 finished → 允许 advanceSection，sectionsCompleted 只 +1 */
  console.log('== 28. 本节 media 任务点全部 finished → 允许切节，且计数只 +1 ==');
  {
    const a = fakeAdapter();
    const oids = ['1', '2', '3'].map((c) => c.repeat(32));
    const frameUrl = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111';
    const tasks = oids.map((o) => ({ kind: 'video', finished: true, objectid: o, frameUrl }));
    const videos = oids.map((o, i) => ({ frameId: 'vf' + i, frameUrl, src: 'https://cdn.example/' + o + '.mp4', objectid: o, duration: 100, currentTime: 100, paused: false, ended: true, readyState: 4 }));
    const tocItems = [{ title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, unfinish: 1 }];
    const stPlayed = state({
      video: { found: true, frameId: 'vf0', src: 'https://cdn.example/' + oids[0] + '.mp4', objectid: oids[0], ended: true, paused: false, progress: 99, currentTime: 100, duration: 100, readyState: 4 },
      videoFrameId: 'vf0',
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
    const m = new E.LearnMachine(a, cfg);
    m._currentTitle = '本节';
    m._markVideoStarted({ src: 'https://cdn.example/' + oids[0] + '.mp4' });
    /* 绕开 tick 开头的「整节完成 → 直接跳过」短路，专门验证「播完计数 + 切节」这条路：
       media 全部 finished 时最早那条闸门会以 sectionsSkipped 直接切节（不计数），
       这里把它短路掉，专注校验 Issue #1 里挪动后的 sectionsCompleted 计数只加一次。 */
    m._currentSectionDone = () => false;
    m._videoTaskDone = () => ({ ok: false, by: 'not-done' });
    m.gatherState = async () => {
      m._lastInventory = { tasks, at: Date.now() };
      m._lastVideos = videos;
      return stPlayed;
    };
    let advances = 0;
    m.advanceSection = async () => { advances += 1; return { progress: true, outcome: 'ADVANCED' }; };
    m.confirmVideoWatched = async () => 1;   // 平台已确认（待办降到 1）
    m.maybeHandleChapterQuiz = async () => 'none';
    const r = await m.tick();
    ok(advances === 1, '★ 全部完成 → 允许切节一次（advanceSection 调用 1 次，实际 ' + advances + '）');
    ok(m.counters.sectionsCompleted === 1, '★ sectionsCompleted 只 +1（实际 ' + m.counters.sectionsCompleted + '）');
    ok(r.outcome === 'ADVANCED', '本拍 outcome=ADVANCED（实际 ' + r.outcome + '）');
  }

  /* 【29】任务点全部来自别的 knowledgeid（stale）→ 不得据此判完成，也不得切节 */
  console.log('== 29. 任务点全来自别的 knowledgeid（stale）→ 不判完成、不切节 ==');
  {
    const a = fakeAdapter();
    const oidA = 'd'.repeat(32);
    /* 任务点全部属于 knowledgeid=999（上一节残留），当前节是 111 */
    const frameUrlOther = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=999';
    const tasks = [
      { kind: 'video', finished: true, objectid: oidA, frameUrl: frameUrlOther },
      { kind: 'video', finished: false, objectid: 'e'.repeat(32), frameUrl: frameUrlOther },
    ];
    const tocItems = [{ title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, unfinish: 2 }];
    const stPlayed = state({
      video: { found: true, frameId: 'vfA', src: 'https://cdn.example/' + oidA + '.mp4', objectid: oidA, ended: true, paused: false, progress: 99, currentTime: 100, duration: 100, readyState: 4 },
      videoFrameId: 'vfA',
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
    /* 纯函数口径：stale ⇒ ok:false，且 sectionVideosDone 不得为 true */
    const J = require('./src/learn/judge.js');
    const pvUnit = J.pendingSectionVideos(tasks, '111');
    ok(pvUnit.ok === false && pvUnit.stale === true, '★ pendingSectionVideos 对 stale 数据返回 ok:false/stale:true（实际 ' + JSON.stringify(pvUnit) + '）');
    ok(J.sectionVideosDone(tasks, '111') === false, '★ sectionVideosDone 对 stale 数据返回 false');

    const cfg29 = JSON.parse(JSON.stringify(cfg));
    cfg29.safety.videoNotConfirmedMax = 1;   // 一拍未确认即停，避免空转
    const m = new E.LearnMachine(a, cfg29);
    m._currentTitle = '本节';
    m._markVideoStarted({ src: 'https://cdn.example/' + oidA + '.mp4' });
    m.gatherState = async () => {
      m._lastInventory = { tasks, at: Date.now() };
      m._lastVideos = [];
      return stPlayed;
    };
    m.captureProblemSnapshot = async () => {};
    let advances = 0;
    m.advanceSection = async () => { advances += 1; return { progress: true, outcome: 'ADVANCED' }; };
    m.confirmVideoWatched = async () => 'unknown';   // 坏数据下拿不到可信待办数
    m.maybeHandleChapterQuiz = async () => 'none';
    const r = await m.tick();
    ok(r.outcome !== 'ADVANCED', '★ stale 一拍不产出 ADVANCED（实际 ' + r.outcome + '）');
    ok(advances === 0, '★ stale 不得切节（advanceSection 调用 0 次，实际 ' + advances + '）');
    ok(m.counters.sectionsCompleted === 0, '★ stale 不得计入完成（sectionsCompleted 实际 ' + m.counters.sectionsCompleted + '）');
    ok(m._videoTaskDone(stPlayed).ok === false, '★ stale 下 _videoTaskDone 判为未完成');
  }

  /* 【30】剩余任务点都已播过一轮 → _pickUnplayedVideo 返回 null，tick 不前进 */
  console.log('== 30. 剩余任务点都已播过一轮 → 不重复播、也不切节（WAIT_VIDEO_CONFIRM）==');
  {
    const a = fakeAdapter();
    const oidA = 'f'.repeat(32), oidB = '1'.repeat(32), oidC = '2'.repeat(32);
    const frameUrl = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111';
    const tasks = [
      { kind: 'video', finished: false, objectid: oidB, frameUrl },
      { kind: 'video', finished: false, objectid: oidC, frameUrl },
    ];
    const videos = [
      { frameId: 'vfB', frameUrl, src: 'https://cdn.example/' + oidB + '.mp4', objectid: oidB, duration: 100, currentTime: 100, paused: false, ended: true, readyState: 4 },
      { frameId: 'vfC', frameUrl, src: 'https://cdn.example/' + oidC + '.mp4', objectid: oidC, duration: 100, currentTime: 100, paused: false, ended: true, readyState: 4 },
    ];
    const tocItems = [{ title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, unfinish: 2 }];
    const stPlayed = state({
      video: { found: true, frameId: 'vfA', src: 'https://cdn.example/' + oidA + '.mp4', objectid: oidA, ended: true, paused: false, progress: 99, currentTime: 100, duration: 100, readyState: 4 },
      videoFrameId: 'vfA',
      toc: { found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top', items: tocItems },
    });
    const m = new E.LearnMachine(a, cfg);
    m._currentTitle = '本节';
    /* 播放器都已在本次运行播过一轮（含当前正在播的这个 A，否则 playedEnough 不成立） */
    ['f', '1', '2'].forEach((c) => m._markVideoStarted({ src: 'https://cdn.example/' + c.repeat(32) + '.mp4' }));
    m._lastInventory = { tasks, at: Date.now() };
    m._lastVideos = videos;
    m.gatherState = async () => {
      m._lastInventory = { tasks, at: Date.now() };
      m._lastVideos = videos;
      return stPlayed;
    };
    let advances = 0;
    m.advanceSection = async () => { advances += 1; return { progress: true, outcome: 'ADVANCED' }; };
    m.confirmVideoWatched = async () => 1;
    m.maybeHandleChapterQuiz = async () => 'none';

    const pv = m._sectionPendingVideos(stPlayed);
    ok(pv.ok === true && pv.pending.length === 2, '本节还剩 2 个未完成媒体任务点（实际 ' + JSON.stringify({ ok: pv.ok, pending: pv.pending.length }) + '）');
    ok(m._pickUnplayedVideo(stPlayed, pv) === null, '★ 剩余任务点都播过一轮 → _pickUnplayedVideo 返回 null');

    const r = await m.tick();
    ok(r.outcome !== 'ADVANCED', '★ 不切节（outcome 非 ADVANCED，实际 ' + r.outcome + '）');
    ok(r.outcome === 'WAIT_VIDEO_CONFIRM', '本拍 outcome=WAIT_VIDEO_CONFIRM（实际 ' + r.outcome + '）');
    ok(advances === 0, 'advanceSection 未被调用（实际 ' + advances + '）');
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
