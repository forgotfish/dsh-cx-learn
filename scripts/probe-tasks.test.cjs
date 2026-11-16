#!/usr/bin/env node
/* ============================================================================
 * probe-tasks.test.cjs — 探针任务点清单（tasks）+ 视频清单（videos）回归
 * ============================================================================
 * 事故（Issue #1）：一节课 12 个任务点，引擎只播完第 1 个视频就切下一节。
 * 根因：探针每个任务点只采 {kind, finished, label}，**没有 objectid / iframe src**，
 *       执行层无法知道「该播哪个播放器」；而且 querySelectorAll('video') 只取第一个，
 *       同一 frame 里可能有 7 个 <video> 也只看到一个。
 *
 * 本测试用「假 DOM」把 PAGE_PROBE_SRC 真跑一遍（vm 注入），验证：
 *   · tasks 每项带出 objectid / iframeSrc / module（原有 kind/finished/label 语义不变）
 *   · data 属性是非法 JSON 时不抛错、objectid 给 ''
 *   · videos 全量列出（7 个就 7 个，不能只取第一个）
 *   · src 优先 currentSrc，回退 getAttribute('src')；objectid 从 32 位十六进制串抽取
 *
 * 用法：node scripts/probe-tasks.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const vm = require('node:vm');

const E = require(path.join(__dirname, '..', 'engine', 'chaoxing-autolearn.js'));
const S = E.SELECTORS;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* 32 位十六进制 objectid（与超星一致：无分隔的 32 位 hex） */
const HEX1 = 'a627ac35abc12345de67890123456789';
const HEX2 = 'b718bd46bcd23456ef78901234567890';

/* ── 假元素构造器 ──────────────────────────────────────────────────────── */

/* 任务点容器：按选择器返回 iframe / icon，classList 判完成 */
function makeTaskEl(opts) {
  const o = opts || {};
  const iframe = o.iframe || null;      /* { data, src, module } 或 null */
  const icon = o.icon || null;          /* { ariaLabel } 或 null */
  const el = {
    className: o.finished ? (S.jobFinishedClass + ' ans-attach-ct') : 'ans-attach-ct',
    classList: {
      contains(name) { return !!(o.finished && name === S.jobFinishedClass); }
    },
    querySelector(sel) {
      if (sel === 'iframe') return iframe ? iframeEl : null;
      if (sel === S.jobIconSel) return icon ? iconEl : null;
      if (sel === 'video,audio') return null;
      return null;
    }
  };
  const iframeEl = {
    getAttribute(name) {
      if (!iframe) return null;
      if (name === 'data') return iframe.data === undefined ? null : iframe.data;
      if (name === 'src') return iframe.src === undefined ? null : iframe.src;
      if (name === 'module') return iframe.module === undefined ? null : iframe.module;
      return null;
    }
  };
  const iconEl = {
    getAttribute(name) { return name === 'aria-label' ? (icon.ariaLabel || '') : null; }
  };
  return el;
}

/* 视频节点：同时被 tasks 的 el.querySelector('video,audio')（返回 null）和
   videos 全量清单、videoState()（需要 rect/duration 等）使用 */
function makeVideoEl(opts) {
  const o = opts || {};
  return {
    currentSrc: o.currentSrc || '',
    duration: o.duration === undefined ? 100 : o.duration,
    currentTime: o.currentTime === undefined ? 0 : o.currentTime,
    paused: !!o.paused,
    ended: !!o.ended,
    readyState: o.readyState === undefined ? 4 : o.readyState,
    muted: !!o.muted,
    networkState: 1,
    buffered: { length: 0 },
    error: null,
    getAttribute(name) { return name === 'src' ? (o.src || null) : null; },
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }; }
  };
}

/* ── 用 vm 真跑 PAGE_PROBE_SRC ──────────────────────────────────────────── */
function runProbe(taskEls, videoEls) {
  const document = {
    querySelectorAll(sel) {
      if (sel === S.jobAttachSel) return taskEls || [];
      if (sel === 'video') return videoEls || [];
      return [];
    },
    querySelector() { return null; },
    body: { innerText: '' }
  };
  const location = { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1', host: 'mooc1.chaoxing.com' };
  const sandbox = {
    document,
    location,
    JSON,
    Number,
    String,
    Array,
    Math,
    Object,
    parseInt,
    isNaN,
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
    __CX_SEL: S,
    __CX_KWS: ['人脸识别', '验证码'],
    __CX_PATTERN: 'passport2\\.chaoxing\\.com'
  };
  sandbox.window = sandbox;            /* 探针里 window === 全局 */
  sandbox.top = sandbox;
  sandbox.frameElement = null;
  sandbox.innerHeight = 800;
  sandbox.innerWidth = 1200;
  sandbox.console = console;
  vm.createContext(sandbox);
  const installed = vm.runInContext(E.PAGE_PROBE_SRC, sandbox, { filename: 'probe.js' });
  if (installed !== 'installed') throw new Error('探针未正确安装：' + installed);
  return sandbox.window.__cx.probeAll();
}

/* ========================================================================== */

console.log('== 1. 任务点带出 objectid / iframeSrc / module（kind/finished/label 不变）==');
{
  const tasks = [
    /* 1) 视频任务点：合法 data JSON + insertvideo */
    makeTaskEl({
      finished: true,
      iframe: { data: JSON.stringify({ objectid: HEX1, name: 'P39.mp4' }), src: '/ananas/modules/video/index.html', module: 'insertvideo' },
      icon: { ariaLabel: '任务点已完成' }
    }),
    /* 2) 音频任务点：无 data，insertaudio */
    makeTaskEl({
      iframe: { src: '/ananas/modules/audio/index.html', module: 'insertaudio' },
      icon: { ariaLabel: '' }
    }),
    /* 3) 无 iframe 的任务点 */
    makeTaskEl({}),
    /* 4) data 是非法 JSON：不得抛错，objectid 给 '' */
    makeTaskEl({ iframe: { data: 'not-json', src: '/ananas/modules/video/index.html', module: 'insertvideo' } })
  ];
  const state = runProbe(tasks, []);
  ok(Array.isArray(state.tasks) && state.tasks.length === 4, 'tasks 全量 4 个', String(state.tasks && state.tasks.length));

  const t0 = state.tasks[0];
  ok(t0.objectid === HEX1, '★ 任务点0 objectid 从 data JSON 解析正确', t0.objectid);
  ok(t0.iframeSrc === '/ananas/modules/video/index.html', '★ 任务点0 iframeSrc 正确', t0.iframeSrc);
  ok(t0.module === 'insertvideo', '★ 任务点0 module=insertvideo', t0.module);
  ok(t0.kind === 'video', '任务点0 kind=video（语义未变）', t0.kind);
  ok(t0.finished === true, '任务点0 finished=true（语义未变）', String(t0.finished));
  ok(t0.label === '任务点已完成', '任务点0 label 保持（语义未变）', t0.label);

  const t1 = state.tasks[1];
  ok(t1.objectid === '', '任务点1 无 data → objectid ""', t1.objectid);
  ok(t1.iframeSrc === '/ananas/modules/audio/index.html', '任务点1 iframeSrc 正确', t1.iframeSrc);
  ok(t1.module === 'insertaudio', '任务点1 module=insertaudio', t1.module);
  ok(t1.kind === 'audio', '任务点1 kind=audio（语义未变）', t1.kind);

  const t2 = state.tasks[2];
  ok(t2.objectid === '' && t2.iframeSrc === '' && t2.module === '', '任务点2 无 iframe → 三个新字段全空', JSON.stringify([t2.objectid, t2.iframeSrc, t2.module]));

  const t3 = state.tasks[3];
  ok(t3.objectid === '', '★ 非法 JSON → objectid ""（不抛错）', t3.objectid);
  ok(t3.kind === 'video', '任务点3 kind 仍按 src 判定为 video', t3.kind);
}

console.log('== 2. iframeSrc 截断 200 字符 ==');
{
  const longSrc = '/ananas/modules/video/index.html?' + 'x'.repeat(400);
  const tasks = [makeTaskEl({ iframe: { src: longSrc, module: 'insertvideo' } })];
  const state = runProbe(tasks, []);
  ok(state.tasks[0].iframeSrc.length === 200, '★ iframeSrc 截断到 200', String(state.tasks[0].iframeSrc.length));
}

console.log('== 3. videos 全量列出（7 个不能只取第一个）==');
{
  const videos = [];
  for (let i = 0; i < 7; i++) {
    videos.push(makeVideoEl({ src: '/ananas/modules/video/part' + i + '.mp4', currentSrc: '' }));
  }
  const state = runProbe([], videos);
  ok(Array.isArray(state.videos), 'videos 是数组');
  ok(state.videos.length === 7, '★ videos 全量 7 个（不是只取第一个）', String(state.videos && state.videos.length));
}

console.log('== 4. video.src 优先 currentSrc、回退 getAttribute；objectid 抽 32 位 hex ==');
{
  const videos = [
    /* currentSrc 有值且带 objectid → 用它 */
    makeVideoEl({ currentSrc: 'https://cdn/' + HEX1 + '.mp4', src: 'https://cdn/' + HEX2 + '.mp4', duration: 300, currentTime: 12.5, paused: false, ended: false, readyState: 4 }),
    /* 无 currentSrc → 回退 getAttribute('src') */
    makeVideoEl({ currentSrc: '', src: 'https://cdn/' + HEX2 + '.mp4', duration: 0, paused: true, ended: false, readyState: 0 }),
    /* src 里没有 32 位 hex → objectid '' */
    makeVideoEl({ currentSrc: 'https://cdn/plain.mp4', src: '' })
  ];
  const state = runProbe([], videos);
  ok(state.videos.length === 3, 'videos 3 个', String(state.videos.length));

  ok(state.videos[0].src === 'https://cdn/' + HEX1 + '.mp4', '★ 有 currentSrc 时优先用它', state.videos[0].src);
  ok(state.videos[0].objectid === HEX1, '★ objectid 从 currentSrc 抽出（不是 src）', state.videos[0].objectid);
  ok(state.videos[0].duration === 300 && state.videos[0].currentTime === 12.5, 'duration/currentTime 透传', JSON.stringify([state.videos[0].duration, state.videos[0].currentTime]));
  ok(state.videos[0].paused === false && state.videos[0].ended === false, 'paused/ended 透传', JSON.stringify([state.videos[0].paused, state.videos[0].ended]));
  ok(state.videos[0].readyState === 4, 'readyState 透传', String(state.videos[0].readyState));

  ok(state.videos[1].src === 'https://cdn/' + HEX2 + '.mp4', '★ 无 currentSrc 时回退 getAttribute(src)', state.videos[1].src);
  ok(state.videos[1].objectid === HEX2, '回退路径的 objectid 正确', state.videos[1].objectid);

  ok(state.videos[2].objectid === '', '★ src 无 hex → objectid ""', state.videos[2].objectid);
}

console.log('== 5. 空页面不抛错，videos/tasks 为空数组 ==');
{
  const state = runProbe([], []);
  ok(Array.isArray(state.tasks) && state.tasks.length === 0, 'tasks 空数组');
  ok(Array.isArray(state.videos) && state.videos.length === 0, 'videos 空数组');
}

console.log('== 6. 直播任务点分类（D-026） ==');
{
  /* 真实直播模块 iframe：src 形如 /ananas/modules/live/index.html，
     data 是 JSON 且**没有 objectid**，只有 liveId/_jobid/jobid/vdoid。 */
  const liveData = JSON.stringify({ liveId: '99887766', _jobid: 'live-99887766', jobid: 'abc', vdoid: '' });
  const t1 = runProbe([makeTaskEl({
    iframe: { src: 'https://mooc1.chaoxing.com/ananas/modules/live/index.html?v=2026-0708-1127', data: liveData, module: '' }
  })], []);
  ok(t1.tasks.length === 1, 'tasks 1 个', String(t1.tasks.length));
  ok(t1.tasks[0].kind === 'live', '★ 直播 iframe → kind=live', t1.tasks[0].kind);
  ok(t1.tasks[0].liveId === '99887766', '★ liveId 从 data JSON 取到', t1.tasks[0].liveId);
  ok(t1.tasks[0].objectid === '', '直播没有 objectid（保持空，不误借）', JSON.stringify(t1.tasks[0].objectid));

  /* 没有 liveId 时回退 vdoid / jobid / _jobid */
  const t2 = runProbe([makeTaskEl({
    iframe: { src: '/ananas/modules/live/index.html', data: JSON.stringify({ vdoid: 'v-123' }) }
  })], []);
  ok(t2.tasks[0].kind === 'live' && t2.tasks[0].liveId === 'v-123', 'liveId 回退 vdoid', t2.tasks[0].liveId);

  /* module=insertlive 也能识别（src 不含 /modules/live/ 时） */
  const t3 = runProbe([makeTaskEl({ iframe: { src: '', data: '{}', module: 'insertlive' } })], []);
  ok(t3.tasks[0].kind === 'live', '★ module=insertlive → kind=live', t3.tasks[0].kind);

  /* ★ 反例：视频 iframe 必须仍是 video，不能被 live 分支误判 */
  const t4 = runProbe([makeTaskEl({
    iframe: { src: '/ananas/modules/video/index.html', data: JSON.stringify({ objectid: HEX1 }) }
  })], []);
  ok(t4.tasks[0].kind === 'video', '★ 视频 src 仍判 video（不误判 live）', t4.tasks[0].kind);
  ok(t4.tasks[0].objectid === HEX1, '视频 objectid 不受影响', t4.tasks[0].objectid);

  /* 反例：音频仍 audio */
  const t5 = runProbe([makeTaskEl({ iframe: { src: '/ananas/modules/audio/index.html', data: '{}' } })], []);
  ok(t5.tasks[0].kind === 'audio', '音频仍判 audio', t5.tasks[0].kind);
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
