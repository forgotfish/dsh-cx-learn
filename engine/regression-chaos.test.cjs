#!/usr/bin/env node
/* ============================================================================
 * regression-chaos.test.cjs —— 0.2.3 补盲：之前没被单独锁死的几处边角
 *
 * 这里补的是「上一轮破坏性测试没覆盖、但一旦回退就会复发」的回归点：
 *   1) D-039 本节多视频账本（_attemptedVideoIds/_startedVideoIds/
 *      _unstartableVideoIds）在**换节时必须清零**
 *        —— 源码断言 + 行为断言（只有源码断言会被「挪走/复制一份」骗过）
 *   2) _verifyVideoStarted(不存在的 objectid) → ok:false 且不抛
 *   3) _pickUnplayedVideo 的三种「挑不出来」：objectid 为空 / videos 缺该播放器 /
 *      全部 unstartable>=3 —— 都必须返回 null 且不抛（绝不猜、绝不拿别的冒充）
 *   4) D-042 openCourseByClick：/json/list 返回空数组 → ok:false 不抛
 *   5) D-043 run.js 的 enc 分级：带 enc 的学习页**不被剥离**（源码断言）
 *        —— 必须存在 isEntryPageUrl；不再存在 isBareStudentStudy 那条剥离逻辑
 *
 * 用法：node engine/regression-chaos.test.cjs
 * 只读产品代码，不改任何 engine/src/**。
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
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

const MACHINE_SRC = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
const RUN_SRC = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'run.js'), 'utf8');

const OID_A = 'a'.repeat(32);
const OID_B = 'b'.repeat(32);
const OID_C = 'c'.repeat(32);
const FRAME_URL = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=111';

function fakeAdapter() {
  return {
    engine: 'fake',
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
    async attachTarget() {},
    async closeTarget() {},
    async shutdown() {},
    async typeInto() { return { ok: true }; },
    getTargetId() { return 'top'; },
  };
}

function makeMachine() {
  const a = fakeAdapter();
  const m = new E.LearnMachine(a, cfg);
  m.clickFound = async () => ({ ok: true, note: 'fake' });
  m.muteIfPossible = async () => {};
  m.waitLoad = async () => true;
  m.stop = (reason) => { m.stopped = reason; };
  return { m, a };
}

const V = (oid) => ({ frameId: 'vf' + oid.slice(0, 4), frameUrl: FRAME_URL, src: 'https://cdn/' + oid + '.mp4', objectid: oid, duration: 100, currentTime: 0, paused: true, ended: false, readyState: 4 });

(async () => {
  /* ================================================================
   * 1. 换节清零：源码断言
   * ==============================================================*/
  console.log('== 1a. 源码断言：advanceSection 里三本账必须清零 ==');
  {
    const at = MACHINE_SRC.indexOf('async advanceSection(');
    ok(at > 0, '★ 能定位到 advanceSection（offset=' + at + '）');
    const body = at > 0 ? MACHINE_SRC.slice(at, at + 6000) : '';
    ok(/this\._attemptedVideoIds\s*=\s*new\s+Set\(\)/.test(body),
      '★ advanceSection 内 _attemptedVideoIds = new Set()');
    ok(/this\._startedVideoIds\s*=\s*new\s+Set\(\)/.test(body),
      '★ advanceSection 内 _startedVideoIds = new Set()');
    ok(/this\._unstartableVideoIds\s*=\s*new\s+Map\(\)/.test(body),
      '★ advanceSection 内 _unstartableVideoIds = new Map()');
    /* 三处必须在同一个「换节账本重置」块里，且都出现在 clickFound 成功之后，
       否则就是「点了不过去也把账本清了」→ 本节剩余候选被当成看过。 */
    const iClick = body.indexOf("this.clickFound(");
    const iAtt = body.indexOf('this._attemptedVideoIds = new Set()');
    ok(iClick > 0 && iAtt > iClick, '★ 清零发生在目录点击成功之后（click@' + iClick + ' < reset@' + iAtt + '）');
  }

  /* ================================================================
   * 1. 换节清零：行为断言
   * ==============================================================*/
  console.log('== 1b. 行为断言：advanceSection 真跑一遍，账本确被清空 ==');
  {
    const { m } = makeMachine();
    m._attemptedVideoIds.add(OID_A);
    m._attemptedVideoIds.add(OID_B);
    m._startedVideoIds.add(OID_A);
    m._unstartableVideoIds.set(OID_C, 2);
    m._lastCurIdx = 0;
    m._currentTitle = '本节';
    ok(m._attemptedVideoIds.size === 2 && m._startedVideoIds.size === 1 && m._unstartableVideoIds.size === 1,
      '前置：三本账都非空（' + m._attemptedVideoIds.size + '/' + m._startedVideoIds.size + '/' + m._unstartableVideoIds.size + '）');
    const st = {
      toc: {
        found: true, layer: 2, sel: '.posCatalog_select', frameId: 'top',
        items: [
          { title: '本节', id: 'cur1', chapterId: '111', current: true, done: false, i: 0, unfinish: 2 },
          { title: '下一节', id: 'cur2', chapterId: '222', current: false, done: false, i: 1, unfinish: 1 },
        ],
      },
    };
    let r = null, threw = false;
    try { r = await m.advanceSection(st); } catch (e) { threw = true; console.log('     throw: ' + (e && e.message)); }
    ok(!threw, 'advanceSection 不抛错');
    ok(r && r.outcome === 'SECTION_ADVANCED', '切节成功（实际 ' + JSON.stringify(r) + '）');
    ok(m._attemptedVideoIds.size === 0, '★ 换节后 _attemptedVideoIds 清空（实际 size=' + m._attemptedVideoIds.size + '）');
    ok(m._startedVideoIds.size === 0, '★ 换节后 _startedVideoIds 清空（实际 size=' + m._startedVideoIds.size + '）');
    ok(m._unstartableVideoIds.size === 0, '★ 换节后 _unstartableVideoIds 清空（实际 size=' + m._unstartableVideoIds.size + '）');
    ok(m._currentTitle === '下一节' && String(m._currentChapterIdValue) === '222',
      '切节后的定位已更新（title=' + m._currentTitle + ', chapterId=' + m._currentChapterIdValue + '）');
  }

  /* ================================================================
   * 2. _verifyVideoStarted：不存在的 objectid
   * ==============================================================*/
  console.log('== 2. _verifyVideoStarted(不存在的 objectid) → ok:false 且不抛 ==');
  {
    const { m } = makeMachine();
    m.gatherState = async () => ({ videos: [V(OID_A), V(OID_B)] });
    let r = null, threw = false;
    try { r = await m._verifyVideoStarted(OID_C, 0, 800); } catch (e) { threw = true; console.log('     throw: ' + (e && e.message)); }
    ok(!threw, '★ 不抛错');
    ok(r && r.ok === false, '★ ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(r && r.note === 'video-not-found', '★ note 明确指出找不到该播放器（实际 ' + (r && r.note) + '）');
  }

  /* ================================================================
   * 3. _pickUnplayedVideo：三种挑不出来
   * ==============================================================*/
  console.log('== 3. _pickUnplayedVideo 三种「挑不出来」→ null 且不抛 ==');
  {
    const { m } = makeMachine();

    /* 3a. pending 里 objectid 为空 */
    m._lastVideos = [V(OID_A)];
    let threw = false, r = null;
    try {
      r = m._pickUnplayedVideo({}, { ok: true, pending: [{ objectid: '', frameUrl: FRAME_URL }, { frameUrl: FRAME_URL }], total: 2, finished: 0 });
    } catch (e) { threw = true; }
    ok(!threw, '3a 不抛错');
    ok(r === null, '★ 3a objectid 为空 → null（实际 ' + JSON.stringify(r) + '）');

    /* 3b. pending 有 objectid，但 videos 里没有对应播放器 */
    m._lastVideos = [V(OID_A)];
    threw = false; r = undefined;
    try { r = m._pickUnplayedVideo({}, { ok: true, pending: [{ objectid: OID_B, frameUrl: FRAME_URL }], total: 1, finished: 0 }); }
    catch (e) { threw = true; }
    ok(!threw, '3b 不抛错');
    ok(r === null, '★ 3b videos 缺对应项 → null（实际 ' + JSON.stringify(r) + '）');

    /* 3c. 全部 unstartable >= 3 */
    m._lastVideos = [V(OID_A), V(OID_B)];
    m._unstartableVideoIds.set(OID_A, 3);
    m._unstartableVideoIds.set(OID_B, 5);
    threw = false; r = undefined;
    try {
      r = m._pickUnplayedVideo({}, {
        ok: true,
        pending: [{ objectid: OID_A, frameUrl: FRAME_URL }, { objectid: OID_B, frameUrl: FRAME_URL }],
        total: 2, finished: 0,
      });
    } catch (e) { threw = true; }
    ok(!threw, '3c 不抛错');
    ok(r === null, '★ 3c 全部 unstartable>=3 → null（实际 ' + JSON.stringify(r) + '）');

    /* 3d. 正对照：把账本清干净后必须能挑出来（证明上面不是因为函数永远返回 null） */
    m._unstartableVideoIds.clear();
    m._startedVideoIds.clear();
    m._attemptedVideoIds.clear();
    let pick = null;
    try { pick = m._pickUnplayedVideo({}, { ok: true, pending: [{ objectid: OID_B, frameUrl: FRAME_URL }], total: 2, finished: 1 }); }
    catch (e) { pick = null; }
    ok(pick && String(pick.objectid) === OID_B, '★ 3d 正对照：账本干净时能挑出 OID_B（实际 ' + JSON.stringify(pick && pick.objectid) + '）');

    /* 3e. 非 ok / pending 为空 → null */
    ok(m._pickUnplayedVideo({}, { ok: false, pending: [{ objectid: OID_B }] }) === null, '★ 3e pv.ok=false → null');
    ok(m._pickUnplayedVideo({}, { ok: true, pending: [], total: 0, finished: 0 }) === null, '★ 3e pending 为空 → null');
    ok(m._pickUnplayedVideo({}, null) === null, '★ 3e pv=null → null（不抛）');
  }

  /* ================================================================
   * 4. openCourseByClick：/json/list 返回空数组
   * ==============================================================*/
  console.log('== 4. openCourseByClick：/json/list 空数组 → ok:false 不抛 ==');
  {
    const http = require('node:http');
    const { openCourseByClick } = require(path.join(__dirname, 'src', 'courses.js'));

    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');                      /* 空数组：一个 target 都没有 */
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    const a = fakeAdapter();
    a.evalInFrame = async (_f, expr) => {
      if (/getBoundingClientRect/.test(String(expr))) {
        return JSON.stringify({
          ok: true, text: '化工热力学', href: 'https://mooc1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=mock',
          x: 740, y: 401, w: 240, h: 130,
        });
      }
      if (/elementFromPoint/.test(String(expr))) return JSON.stringify({ point: { x: 740, y: 401 }, topEl: { tag: 'IMG' } });
      if (/scrollIntoView/.test(String(expr))) return 'scrolled';
      return null;
    };

    const c = E.mergeConfig(cfg, { cdp: { port } });
    let r = null, threw = false;
    try { r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 4000 }); }
    catch (e) { threw = true; console.log('     throw: ' + (e && e.message)); }
    try { srv.close(); } catch { /* ignore */ }
    ok(!threw, '★ 不抛错（空 target 列表不是异常）');
    ok(r && r.ok === false, '★ ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(r && /未打开课程页|未找到/.test(String(r.reason || '')), '★ reason 说明没打开课程页（实际 ' + (r && r.reason) + '）');
  }

  /* ================================================================
   * 5. run.js 的 enc 分级（源码断言）
   * ==============================================================*/
  console.log('== 5. run.js enc 分级：带 enc 不被剥离 ==');
  {
    ok(/const isEntryPageUrl\s*=/.test(RUN_SRC), '★ 存在 isEntryPageUrl 判定');
    ok(/stucoursemiddle|ismooc2=1/i.test(RUN_SRC), '★ 入口页判据来自 URL 形态（stucoursemiddle / ismooc2=1）');
    ok(!/isBareStudentStudy/.test(RUN_SRC), '★ 不再存在 isBareStudentStudy 那条剥离逻辑');

    /* 入口页判定里绝不能含 studentstudy —— 否则「带 enc 的 studentstudy 学习页」
       会被当成入口页去 drill-down，等于把有效 enc 丢弃。 */
    const line = (RUN_SRC.split('\n').find((l) => /const isEntryPageUrl\s*=/.test(l)) || '');
    ok(line.length > 0 && !/studentstudy/i.test(line), '★ isEntryPageUrl 判据不含 studentstudy（实际：' + line.trim() + '）');
    ok(/needDrillDown\s*=\s*isEntryPageUrl\(/.test(RUN_SRC), '★ needDrillDown 只由 isEntryPageUrl 决定（不再由 enc 剥离决定）');

    /* 全文没有任何「删除/剥离 enc」的动作 */
    ok(!/(delete|strip|remove)[^\n]{0,30}\benc\b/i.test(RUN_SRC), '★ 全文没有剥离 enc 的动作');
    ok(!/enc=[^\n]{0,40}\.replace\(/.test(RUN_SRC), '★ 没有对 enc= 参数做 replace 清空');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
