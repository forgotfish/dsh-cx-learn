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

  console.log('');
  if (fails.length) {
    console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('== 全部通过（' + pass + ' 项）==');
  process.exit(0);
})();
