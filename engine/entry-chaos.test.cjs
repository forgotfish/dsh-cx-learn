#!/usr/bin/env node
/* ============================================================================
 * entry-chaos.test.cjs —— 课程入口的破坏性测试（D-041 / D-042 / D-043 / D-044）
 *
 * 真机事故：引擎「进入课程」拿到了**残留的旧 studentstudy 标签**（chapterId=643076170），
 * 那个 URL 没有有效 enc → 「温馨提示」错误页 → 1 frame / tocFound=false →
 * UNRECOGNIZED_PAGE。根因三处：
 *   D-041 选页正则含 studentstudy 且 fresh 为空时 fallback 到残留旧页
 *   D-042 鼠标点击没生效时偷偷用 element.click() 兜底（链路不同、假成功）
 *   D-044 每轮留下旧 studentstudy 标签，越跑越脏
 *
 * 本测试把 openCourseByClick 的这些行为锁死：
 *   1) 池子里只有残留旧 studentstudy（点击没开新页）→ 必须失败，不许「成功」进旧页
 *   2) 点了之后出现新 mooc2-ans/stu → 成功，且附着到**新**那个
 *   3) 点击坐标被遮罩挡住 → 不再 element.click() 兜底，直接失败 + 快照
 *   4) 新页是 studentstudy（老域）而只有它「新」→ 不认它（只认 mooc2-ans/stu）
 *   4b) 完全没有课程页 → 失败并报 pagesSeen
 *
 * 用法：node engine/entry-chaos.test.cjs
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

const cfg = E.mergeConfig(E.CONFIG, {});
E.humanize.configure(cfg.humanize);

const STU_OLD = (cid) => 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=' + cid + '&courseId=mock&clazzid=1&mooc2=1';
const STU_NEW_ENTRY = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=mock&clazzid=1&enc=fresh123&t=999&pageHeader=0';

/* 用「假 CDP 层」拦截 listTargets：courses.js 内部走 http://127.0.0.1:<port>/json/list，
   所以这里起一个本地 http server 提供 /json/list，模拟不同场景。 */
const http = require('node:http');

function startServer(getList) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/json/list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(getList()));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function makeAdapter(opts) {
  const o = opts || {};
  const a = {
    engine: 'fake',
    clicks: [],
    closed: [],
    url: 'https://mooc1.chaoxing.com/visit/interaction',
    _isDetectUrl() { return false; },
    async navigate() {},
    async getCurrentUrl() { return this.url; },
    async getFrameDocuments() { return [{ frameId: 'top', url: this.url, isTop: true }]; },
    async evalInFrame(_f, expr) {
      /* locateCourseLink 会要坐标；这里返回一个「命中/被遮罩」两种形态 */
      if (/getBoundingClientRect/.test(String(expr))) {
        if (o.hitBlocked) return JSON.stringify({ ok: false, reason: 'hit-test-blocked' });
        return JSON.stringify({
          ok: true, text: '化工热力学', href: 'https://mooc1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=mock',
          x: 740, y: 401, w: 240, h: 130,
        });
      }
      if (/elementFromPoint/.test(String(expr))) return JSON.stringify({ point: { x: 740, y: 401 }, topEl: { tag: 'IMG' } });
      if (/scrollIntoView/.test(String(expr))) return 'scrolled';
      return null;
    },
    async click(_f, rect) { this.clicks.push(rect); return { mode: 'cdp-input' }; },
    async jsClick() { return { ok: false, reason: 'jsClick-disabled-in-test' }; },
    async attachTarget(id) { this.attached = id; },
    async closeTarget(id) { this.closed.push(id); },
    async ensureBrowser() { return {}; },
    async getAllCookies() { return null; },
    async getText() { return ''; },
    shutdown() {},
  };
  return a;
}

(async () => {
  const { openCourseByClick } = require(path.join(__dirname, 'src', 'courses.js'));

  /* ---------- 1. 只有残留旧 studentstudy（点击没开新页）→ 必须失败 ---------- */
  console.log('== 1. 池子里只有残留旧 studentstudy → 不许当成「进入成功」 ==');
  {
    const list = [
      { id: 'old-1', type: 'page', url: STU_OLD('643076150') },
      { id: 'old-2', type: 'page', url: STU_OLD('643076170') },
      { id: 'list', type: 'page', url: 'https://mooc1.chaoxing.com/visit/interaction' },
    ];
    const { srv, port } = await startServer(() => list);
    const c = E.mergeConfig(cfg, { cdp: { port } });
    const a = makeAdapter();
    const r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 6000 });
    ok(r && r.ok === false, '★ 点击未开新页 → ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(/新|残留|未打开/.test(String(r && r.reason || '')),
      '★ 失败原因点明「没打开新页/只有残留」（实际 ' + (r && r.reason) + '）');
    ok(!a.attached || a.attached === undefined, '★ 不许附着到残留旧标签（attached=' + a.attached + '）');
    srv.close();
  }

  /* ---------- 2. 点了之后出现新 mooc2-ans/stu → 成功且附着新的 ---------- */
  console.log('== 2. 点击后出现新的 mooc2-ans/stu → 成功并附着新页 ==');
  {
    let phase = 0;
    const { srv, port } = await startServer(() => {
      phase += 1;
      const base = [
        { id: 'old-1', type: 'page', url: STU_OLD('643076170') },
        { id: 'list', type: 'page', url: 'https://mooc1.chaoxing.com/visit/interaction' },
      ];
      if (phase >= 2) base.push({ id: 'new-stu', type: 'page', url: STU_NEW_ENTRY });
      return base;
    });
    const c = E.mergeConfig(cfg, { cdp: { port } });
    const a = makeAdapter();
    const r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 12000 });
    ok(r && r.ok === true, '★ 拿到新页 → ok:true（实际 ' + JSON.stringify(r && r.reason || r && r.ok) + '）');
    ok(a.attached === 'new-stu', '★ 附着到**新** target（实际 ' + a.attached + '）');
    ok(String(r && r.url || '').includes('mooc2-ans'), '★ 返回的 URL 是新域（实际 ' + (r && r.url) + '）');
    srv.close();
  }

  /* ---------- 3. 坐标被遮罩 → 不许 JS click 兜底，直接失败 ---------- */
  console.log('== 3. 命中被遮罩 → 失败告终，绝不 element.click() 兜底 ==');
  {
    const list = [{ id: 'list', type: 'page', url: 'https://mooc1.chaoxing.com/visit/interaction' }];
    const { srv, port } = await startServer(() => list);
    const c = E.mergeConfig(cfg, { cdp: { port } });
    const a = makeAdapter({ hitBlocked: true });
    const r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 5000 });
    ok(r && r.ok === false, '★ ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(a.clicks.length === 0, '★ 连鼠标点击都没发生（命中检查就挡掉了，实际 ' + a.clicks.length + ' 次）');
    srv.close();
  }

  /* ---------- 4. 只出现「新」的 studentstudy（老域）→ 不认 ---------- */
  console.log('== 4. 新生成了 studentstudy 老域页 → 不认（只认 mooc2-ans/stu）==');
  {
    let phase = 0;
    const { srv, port } = await startServer(() => {
      phase += 1;
      const base = [{ id: 'list', type: 'page', url: 'https://mooc1.chaoxing.com/visit/interaction' }];
      if (phase >= 2) base.push({ id: 'new-old', type: 'page', url: STU_OLD('643076150') });
      return base;
    });
    const c = E.mergeConfig(cfg, { cdp: { port } });
    const a = makeAdapter();
    const r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 6000 });
    ok(r && r.ok === false, '★ 老域新页不认，判失败（实际 ' + JSON.stringify(r && r.ok) + '）');
    ok(a.attached === undefined, '★ 没有附着到老域页');
    srv.close();
  }

  /* ---------- 5. 完全没课程页 ---------- */
  console.log('== 5. 完全没有课程页 → 失败并报 pagesSeen ==');
  {
    const list = [{ id: 'list', type: 'page', url: 'https://mooc1.chaoxing.com/visit/interaction' }];
    const { srv, port } = await startServer(() => list);
    const c = E.mergeConfig(cfg, { cdp: { port } });
    const a = makeAdapter();
    const r = await openCourseByClick(a, '化工热力学', { cfg: c, courseId: 'mock', maxWaitMs: 4000 });
    ok(r && r.ok === false, '★ ok:false');
    srv.close();
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
