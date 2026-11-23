#!/usr/bin/env node
/* ============================================================================
 * playback-fallback.test.cjs —— D-066：真鼠标点不动时的「页内 JS play()」兜底 + 倍速
 *
 * 背景：点播放按钮要过「坐标/滚动/命中」三道关（D-048~D-063 那一串）。
 * 而 play() 是方法调用，完全不吃坐标。所以设计成 **B 档**：
 *   真鼠标优先 → 失败才用 JS 兜底 → **起播仍由 _verifyVideoStarted 判定**
 *   （调用成功 ≠ 真播了，失败不被掩盖）
 *
 * 覆盖：
 *   A. 探针层 __cx.playByObjectId()
 *      A1 按 objectid 精确命中；A2 找不到 → no-such-video；A3 没有 video → no-video-element
 *      A4 rate=1 → 不写 playbackRate（默认不改页面）；A5 rate=1.5 → 写入且回读
 *      A6 play() 同步抛 → ok:false 带 play-threw；A7 play() 返回 rejected Promise → 不向上抛
 *      A8 非法倍速（99）被 try/catch 吞掉，不影响起播
 *   B. 机器层 playSectionVideo
 *      B1 点击成功 → 不走兜底（日志/结果无 degraded 路径），且 rate=1 时不设倍速
 *      B2 点击失败 + 兜底成功 → 起播验证通过则 ok:true
 *      B3 点击失败 + 兜底也失败 → ok:false 且 reason 含 js-fallback-failed
 *      B4 点击失败 + 兜底成功但**没真播** → ok:false（验证层不放过）
 *      B5 倍速配置 1.5 → 点击成功后调用一次带 rate=1.5 的 playByObjectId
 *      B6 破坏：兜底返回非对象 → 不崩
 *
 * 用法：node engine/playback-fallback.test.cjs
 * ==========================================================================*/
'use strict';
const path = require('node:path');
const vm = require('node:vm');
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));
const sel = require(path.join(__dirname, 'src', 'learn', 'selectors.js'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

/* ---------------- A. 探针层 ---------------- */
const OID = 'ce7e74d32326c2bb443bdf2b46e03971';
const OID2 = '1857487a82a1e07f1a2d072765de7542';

function mkVideo(o) {
  const v = {
    _src: o.src === undefined ? ('https://x/' + OID + '/sd.mp4') : o.src,
    muted: false,
    playbackRate: 1,
    paused: true,
    readyState: 4,
    playCalls: 0,
    get currentSrc() { return this._src; },
    getAttribute() { return null; },
    play() {
      this.playCalls += 1;
      if (o.playThrows) throw Object.assign(new Error('nope'), { name: o.playThrows });
      if (o.playRejects) return Promise.reject(Object.assign(new Error('not allowed'), { name: o.playRejects }));
      this.paused = false;
      return Promise.resolve();
    },
  };
  return v;
}

function loadProbe(videos) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.document = { querySelectorAll(s) { return s === 'video' ? videos : []; } };
  sandbox.console = console;
  sandbox.__CX_SEL = sel.SELECTORS;
  sandbox.__CX_KWS = [];
  sandbox.__CX_PATTERN = 'x';
  sandbox.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  vm.createContext(sandbox);
  vm.runInContext(sel.PAGE_PROBE_SRC, sandbox, { filename: 'PAGE_PROBE_SRC.js' });
  return sandbox;
}

(async () => {
  console.log('== A1. 按 objectid 精确命中 + 起播 ==');
  {
    const v1 = mkVideo({ src: 'https://x/' + OID2 + '/sd.mp4' });
    const v2 = mkVideo({ src: 'https://x/' + OID + '/sd.mp4' });
    const win = loadProbe([v1, v2]);
    const r = win.__cx.playByObjectId(OID, 1);
    ok(r.ok === true, '★ ok:true（实际 ' + JSON.stringify(r) + '）');
    ok(v2.playCalls === 1 && v1.playCalls === 0, '★ 只播了命中的那一个（v1=' + v1.playCalls + ' v2=' + v2.playCalls + '）');
    ok(v2.muted === true, '★ 顺手静音（与 muteIfPossible 同语义）');
  }

  console.log('== A2/A3. 找不到目标 / 没有 video ==');
  {
    /* ★ D-067 语义变更：单播放器时按 all[0] 兜底（未加载的视频 currentSrc 为空，无法按 oid 匹配）。
       所以「无匹配 → no-such-video」只在**多播放器且都匹配不上**时成立。 */
    const win = loadProbe([
      mkVideo({ src: 'https://x/' + OID2 + '/sd.mp4' }),
      mkVideo({ src: 'https://x/00000000000000000000000000000000/sd.mp4' }),
    ]);
    const r = win.__cx.playByObjectId(OID, 1);
    ok(r.ok === false && r.reason === 'no-such-video', '★ 多播放器且无匹配 → no-such-video（实际 ' + r.reason + '）');
    /* 单播放器时允许兜底命中（这才是 D-067 修的真洞） */
    const win1 = loadProbe([mkVideo({ src: 'https://x/' + OID2 + '/sd.mp4' })]);
    const r1 = win1.__cx.playByObjectId(OID, 1);
    ok(r1.ok === true, '★ 单播放器时按兜底命中（D-067 语义，实际 ' + JSON.stringify(r1.ok) + '）');
    const win2 = loadProbe([]);
    const r2 = win2.__cx.playByObjectId(OID, 1);
    ok(r2.ok === false && r2.reason === 'no-video-element', '★ 无 video → no-video-element（实际 ' + r2.reason + '）');
  }

  console.log('== A4/A5. 倍速：默认 1 不写；1.5 写入并回读 ==');
  {
    const v = mkVideo({});
    const win = loadProbe([v]);
    win.__cx.playByObjectId(OID, 1);
    ok(v.playbackRate === 1, '★ rate=1 时不改 playbackRate（实际 ' + v.playbackRate + '）');
    const v2 = mkVideo({});
    const win2 = loadProbe([v2]);
    const r2 = win2.__cx.playByObjectId(OID, 1.5);
    ok(v2.playbackRate === 1.5, '★ rate=1.5 已写入（实际 ' + v2.playbackRate + '）');
    ok(r2.rateApplied === 1.5, '★ 结果回传 rateApplied（实际 ' + r2.rateApplied + '）');
  }

  console.log('== A6. play() 同步抛 → ok:false 带 play-threw ==');
  {
    const v = mkVideo({ playThrows: 'NotAllowedError' });
    const win = loadProbe([v]);
    const r = win.__cx.playByObjectId(OID, 1);
    ok(r.ok === false && /play-threw:NotAllowedError/.test(String(r.reason)), '★ 同步抛被捕获（实际 ' + r.reason + '）');
  }

  console.log('== A7. play() 返回 rejected Promise → 不向上抛 ==');
  {
    const v = mkVideo({ playRejects: 'NotAllowedError' });
    const win = loadProbe([v]);
    let threw = false;
    let r = null;
    try { r = win.__cx.playByObjectId(OID, 1); } catch (_) { threw = true; }
    ok(!threw, '★ 探针本身不抛（由 verify 判定）');
    ok(r && r.ok === true, '★ 调用成功即 ok:true（真正是否起播交给验证层）');
    await new Promise((res) => setTimeout(res, 10)); /* 让 promise 的 catch 执行完，确认不会冒出未捕获异常 */
    ok(true, '★ 10ms 后仍无未捕获拒绝');
  }

  console.log('== A8. 非法倍速被吞掉，不影响起播 ==');
  {
    const v = mkVideo({});
    /* 让设置 playbackRate 抛错，模拟浏览器不支持该倍速 */
    Object.defineProperty(v, 'playbackRate', {
      get() { return this._rate || 1; },
      set(x) { if (x > 16) throw Object.assign(new Error('bad rate'), { name: 'NotSupportedError' }); this._rate = x; },
    });
    const win = loadProbe([v]);
    const r = win.__cx.playByObjectId(OID, 99);
    ok(r.ok === true, '★ 倍速非法但起播仍成功（实际 ' + JSON.stringify(r) + '）');
    ok(r.rateApplied === null, '★ rateApplied=null（实际 ' + r.rateApplied + '）');
  }

  /* ---------------- B. 机器层 ---------------- */
  const cfgBase = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
  });

  function mkMachine(opts) {
    const o = opts || {};
    E.humanize.configure(cfgBase.humanize);   /* 否则 beforeClick 读不到 clickDelayMs */
    const calls = { find: 0, play: [], rate: [] };
    const a = {
      engine: 'fake',
      async evalInFrame(fid, expr) {
        const e = String(expr);
        if (e.indexOf('__cx.find(') >= 0) {
          calls.find += 1;
          return o.clickOk ? { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'vjs-big-play-button' } : { ok: false, reason: 'still-outside-viewport', rect: { x: 0, y: 1401, w: 60, h: 60 } };
        }
        if (e.indexOf('__cx.setRate(') >= 0) {          /* D-068：倍速走 setRate，不 play */
          const m = /setRate\("([^"]*)",\s*([0-9.]+)\)/.exec(e);
          calls.rate.push(m ? Number(m[2]) : NaN);
          return { ok: true, rate: m ? Number(m[2]) : NaN };
        }
        if (e.indexOf('playByObjectId') >= 0) {
          const m = /playByObjectId\("([^"]*)",\s*([0-9.]+)\)/.exec(e);
          const rate = m ? Number(m[2]) : NaN;
          calls.play.push(rate);
          if (o.probeReturnsNonObject) return 42;
          return o.fallbackOk === false ? { ok: false, reason: 'play-threw:NotAllowedError' } : { ok: true, rate: rate, readyState: 4 };
        }
        if (e.indexOf('v.muted = true') >= 0) return true;
        if (e.indexOf('currentTime') >= 0) return String(o.playing ? 5 : 0);
        return null;
      },
      async click() { return { mode: 'cdp-input' }; },
      async jsClick() { return { ok: false }; },
      getTargetId() { return 'top'; },
      shutdown() { },
    };
    const cfg = E.mergeConfig(cfgBase, o.videoCfg ? { video: o.videoCfg } : {});
    const m = new E.LearnMachine(a, cfg);
    /* 起播验证：直接打桩，便于聚焦「兜底逻辑」本身 */
    m._verifyVideoStarted = async () => (o.verified === false ? { ok: false, note: 'stuck paused=true t=0' } : { ok: true, note: 'playing(frame)' });
    return { m, calls };
  }

  const VID = { frameId: 'vf1', objectid: OID };

  console.log('== B1. 点击成功 → 不走兜底；rate=1 不设倍速 ==');
  {
    const { m, calls } = mkMachine({ clickOk: true });
    const r = await m.playSectionVideo({}, VID);
    ok(r.ok === true, '★ ok:true');
    ok(calls.rate.length === 0, '★ 未调用 playByObjectId（rate=1 且点击成功，实际 ' + calls.rate.length + ' 次）');
  }

  console.log('== B2. 点击失败 + 兜底成功 + 验证通过 → ok:true ==');
  {
    const { m, calls } = mkMachine({ clickOk: false });
    const r = await m.playSectionVideo({}, VID);
    ok(r.ok === true, '★ ok:true（实际 ' + JSON.stringify(r) + '）');
    ok(calls.play.length === 1, '★ 调用了 1 次兜底（实际 ' + calls.play.length + '）');
    ok(m._startedVideoIds.has(OID), '★ 记入 started（验证通过才记）');
  }

  console.log('== B3. 点击失败 + 兜底也失败 → ok:false 且带 js-fallback-failed ==');
  {
    const { m } = mkMachine({ clickOk: false, fallbackOk: false });
    const r = await m.playSectionVideo({}, VID);
    ok(r.ok === false, '★ ok:false');
    ok(/js-fallback-failed/.test(String(r.reason)), '★ reason 标明兜底失败（实际 ' + r.reason + '）');
    ok(!m._startedVideoIds.has(OID), '★ 不记 started');
    ok((m._unstartableVideoIds.get(OID) || 0) === 1, '★ 记 1 次 unstartable');
  }

  console.log('== B4. 兜底调用成功但没真播 → 验证层不放过 ==');
  {
    const { m } = mkMachine({ clickOk: false, verified: false });
    const r = await m.playSectionVideo({}, VID);
    ok(r.ok === false && r.reason === 'not-started', '★ 判 not-started（实际 ' + JSON.stringify(r) + '）');
    ok(!m._startedVideoIds.has(OID), '★ 不进 started —— 调用成功 ≠ 真播');
  }

  console.log('== B5. 配置 rate=1.5 → 点击成功后应调用一次带 1.5 的兜底探针 ==');
  {
    const { m, calls } = mkMachine({ clickOk: true, videoCfg: { playbackRate: 1.5 } });
    const r = await m.playSectionVideo({}, VID);
    ok(r.ok === true, '★ ok:true');
    ok(calls.rate.length === 1 && calls.rate[0] === 1.5, '★ 以 rate=1.5 调用（实际 ' + JSON.stringify(calls.rate) + '）');
  }

  console.log('== B6. 破坏：兜底返回非对象 → 不崩 ==');
  {
    const { m } = mkMachine({ clickOk: false, probeReturnsNonObject: true });
    let threw = false;
    let r = null;
    try { r = await m.playSectionVideo({}, VID); } catch (_) { threw = true; }
    ok(!threw, '★ 不抛错');
    ok(r && r.ok === false, '★ 判失败（实际 ' + JSON.stringify(r) + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });



