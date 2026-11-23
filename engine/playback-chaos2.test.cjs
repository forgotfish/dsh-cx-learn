#!/usr/bin/env node
/* ============================================================================
 * playback-chaos2.test.cjs —— D-066 第二批破坏测试（专砸边缘条件）
 *
 * 前一批（playback-fallback.test.cjs）覆盖了主干；这一批专砸「我以为没事」的地方：
 *
 *   C1  未加载视频（currentSrc 为空）+ 给了 oid → 现在会 no-such-video（**真洞**）
 *   C2  同 frame 里只有一个 video 且无 src → 应当仍能播（单播放器安全）
 *   C3  多个 video，其中未加载的那个才是目标 → 不能误播已加载的别的
 *   C4  rs=0（元数据未就绪）→ play() 调用后需在验证窗口内真的推进，否则判 not-started
 *   C5  rate>1 但目标未加载（匹配不到）→ 倍速**不会**被应用（静默丢失，需可见）
 *   C6  _cardsUnionDone 在「只扫了一部分卡片」时的保守性（**真洞**：会过早放行切节）
 *   C7  切卡不应用来清掉本节账本（_startedVideoIds 不能被误清）
 *   C8  破坏：playByObjectId 收到 null/undefined oid → 不崩，按 all[0] 处理
 *   C9  破坏：document.querySelectorAll 抛错 → 不崩、返回 ok:false
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

const OID = 'ce7e74d32326c2bb443bdf2b46e03971';
const OID2 = '1857487a82a1e07f1a2d072765de7542';

function mkVideo(o) {
  const opt = o || {};
  const v = {
    _src: opt.src === undefined ? ('https://x/' + OID + '/sd.mp4') : opt.src,
    muted: false,
    playbackRate: 1,
    paused: true,
    readyState: opt.readyState === undefined ? 4 : opt.readyState,
    duration: opt.duration === undefined ? 100 : opt.duration,
    currentTime: 0,
    playCalls: 0,
    get currentSrc() { return this._src; },
    getAttribute() { return null; },
    play() {
      this.playCalls += 1;
      if (opt.playThrows) throw Object.assign(new Error('x'), { name: opt.playThrows });
      if (opt.playRejects) return Promise.reject(Object.assign(new Error('x'), { name: opt.playRejects }));
      this.paused = false;
      return Promise.resolve();
    },
  };
  return v;
}

function loadProbe(videos, opts) {
  const o = opts || {};
  const sandbox = {};
  sandbox.window = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox;
  sandbox.document = {
    querySelectorAll(s) {
      if (o.throwOnQuery && s === 'video') throw new Error('boom-query');
      return s === 'video' ? videos : [];
    },
  };
  sandbox.console = console;
  sandbox.__CX_SEL = sel.SELECTORS;
  sandbox.__CX_KWS = []; sandbox.__CX_PATTERN = 'x';
  sandbox.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  vm.createContext(sandbox);
  vm.runInContext(sel.PAGE_PROBE_SRC, sandbox, { filename: 'PAGE_PROBE_SRC.js' });
  return sandbox;
}

(async () => {
  console.log('== C1. 未加载视频（currentSrc 空）+ 给了 oid → 现状如何 ==');
  {
    const v = mkVideo({ src: '', readyState: 0 });           /* 未加载：无 currentSrc */
    const win = loadProbe([v]);
    const r = win.__cx.playByObjectId(OID, 1);
    console.log('    → ' + JSON.stringify(r));
    ok(r.ok === true, '★ 未加载的视频也应能被兜底起播（当前 ' + (r.ok ? 'ok' : r.reason) + '）');
  }

  console.log('== C2. 同 frame 只有一个 video 且无 src → 应仍可播 ==');
  {
    const v = mkVideo({ src: '', readyState: 0 });
    const win = loadProbe([v]);
    const r = win.__cx.playByObjectId(OID, 1);
    ok(r.ok === true && v.playCalls === 1, '★ 单播放器无 src 也要 play（实际 ' + JSON.stringify(r) + '）');
  }

  console.log('== C3. 两个 video，目标那个未加载 → 不能误播已加载的 ==');
  {
    const loaded = mkVideo({ src: 'https://x/' + OID2 + '/sd.mp4' });   /* 别的视频，已加载 */
    const target = mkVideo({ src: '', readyState: 0 });                 /* 目标，未加载 */
    const win = loadProbe([loaded, target]);
    const r = win.__cx.playByObjectId(OID, 1);
    ok(loaded.playCalls === 0, '★ 绝不误播别的播放器（实际 loaded.playCalls=' + loaded.playCalls + '）');
    /* ★ 安全取舍（不是 bug）：同 frame 有 2 个 video 且目标未加载（无 currentSrc）时，
       无法证明哪一个是目标 —— 宁可不播也不能误播别人的视频（误播=播错内容/污染别人的进度）。
       所以这里**要求明确失败**，并把 videoCount 带出来便于排障。 */
    ok(r.ok === false && r.reason === 'no-such-video' && r.videoCount === 2,
      '★ 多播放器且目标不可识别 → 明确失败（不猜），带 videoCount（实际 ' + JSON.stringify(r) + '）');
    ok(target.playCalls === 0, '★ 目标也没被瞎播（实际 ' + target.playCalls + '）');
  }

  console.log('== C4. rs=0 起播：验证窗口内推进才算成功 ==');
  {
    /* 直接测 machine 层：probe 说 ok，但视频 8 秒后才 paused=false → 6s 窗口内应判失败 */
    const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
    E.humanize.configure(cfg.humanize);
    let now = 0;
    const a = {
      engine: 'fake',
      async evalInFrame(fid, expr) {
        const e = String(expr);
        if (e.indexOf('currentTime') >= 0) return '0';
        if (e.indexOf('paused: v.paused') >= 0) {
          now += 1000;                                   /* 每次轮询推进 1s 虚拟时间 */
          const playing = now > 8000;                    /* 8s 后才真起播 */
          return JSON.stringify({ t: playing ? 3 : 0, dur: 100, paused: !playing, rs: playing ? 4 : 0, oid: OID });
        }
        return null;
      },
      async gatherState() { return { videos: [], video: null }; },
      async getFrameDocuments() { return []; },
      getTargetId() { return 'top'; }, shutdown() { },
    };
    const m = new E.LearnMachine(a, cfg);
    const r = await m._verifyVideoStarted(OID, 0, 2000, 'vf1');
    ok(r.ok === false, '★ 慢起播（8s）超出窗口 → 判失败（实际 ' + JSON.stringify(r) + '）');
  }

  console.log('== C5. rate>1 但目标未加载 → 倍速不能被静默丢掉 ==');
  {
    const v = mkVideo({ src: '', readyState: 0 });
    const win = loadProbe([v]);
    const r = win.__cx.playByObjectId(OID, 1.5);
    ok(r.ok === true && v.playbackRate === 1.5, '★ 未加载也应设上倍速（实际 ok=' + r.ok + ' rate=' + v.playbackRate + '）');
  }

  console.log('== C6. _cardsUnionDone：只扫了一部分卡片时不许放行切节 ==');
  {
    const cfg = E.mergeConfig(E.CONFIG, {});
    const m = new E.LearnMachine({ engine: 'fake', getTargetId() { return 'top'; }, shutdown() { } }, cfg);
    m._cardScanKey = 'K1';
    /* 场景：本节共 2 张卡，但只记录了 1 张（且它已全绿） */
    m._cardScan = new Map([['CARD_A', { media: 3, finished: 3 }]]);
    m._cardScanTotal = 2;
    const r = m._cardsUnionDone({});
    ok(r !== true, '★ 扫描未完成时不得返回 true（否则会跳过未扫的卡直接切节）—— 实际 ' + JSON.stringify(r));
  }

  console.log('== C7. 切卡不应清掉本节账本 ==');
  {
    const cfg = E.mergeConfig(E.CONFIG, { humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] } });
    E.humanize.configure(cfg.humanize);
    const TWO = { ok: true, total: 2, cards: [{ i: 0, seq: 1, num: 0, total: 2, cardid: 'CARD_A', title: 'a' }, { i: 1, seq: 2, num: 1, total: 2, cardid: 'CARD_B', title: 'b' }] };
    const a = {
      engine: 'fake',
      async evalInFrame(fid, expr) {
        const e = String(expr);
        if (e.indexOf('cardsInfo') >= 0) return TWO;
        if (e.indexOf('__cx.find(') >= 0) return { ok: true, rect: { x: 1, y: 2, w: 3, h: 4 }, layer: 1, note: 'cardsTab' };
        if (e.indexOf('ans-attach-ct') >= 0) return 3;
        return null;
      },
      async click() { return { mode: 'cdp-input' }; },
      async jsClick() { return { ok: false }; },
      getTargetId() { return 'top'; }, shutdown() { },
    };
    const m = new E.LearnMachine(a, cfg);
    m._startedVideoIds.add('VIDEO_OF_CARD_A');
    m._lastInventory = { tasks: [{ kind: 'video', finished: false, objectid: 'A', frameUrl: 'https://x/knowledge/cards?knowledgeid=K1' }] };
    const st = { frames: [{ frameId: 'top', url: 'https://mooc1/x/mycourse/studentstudy?chapterId=K1', isTop: true }, { frameId: 'cards', url: 'https://mooc1/x/knowledge/cards?knowledgeid=K1&num=0', isTop: false }], toc: { found: true, items: [{ chapterId: 'K1', current: true }] }, video: { found: false } };
    await m._ensureCardsScanned(st);
    ok(m._startedVideoIds.has('VIDEO_OF_CARD_A'), '★ 切卡后账本仍在（否则同一视频会被重复播）');
  }

  console.log('== C8/C9. 破坏：oid 为空 / querySelectorAll 抛错 ==');
  {
    const v = mkVideo({});
    const win = loadProbe([v]);
    const r1 = win.__cx.playByObjectId(null, 1);
    ok(r1.ok === true && v.playCalls === 1, '★ oid=null 时按 all[0] 播（实际 ' + JSON.stringify(r1) + '）');
    const win2 = loadProbe([], { throwOnQuery: true });
    let threw = false; let r2 = null;
    try { r2 = win2.__cx.playByObjectId(OID, 1); } catch (_) { threw = true; }
    ok(!threw && r2 && r2.ok === false, '★ querySelectorAll 抛错 → 不崩、ok:false（实际 ' + JSON.stringify(r2) + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项（这些是真洞）=='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });

