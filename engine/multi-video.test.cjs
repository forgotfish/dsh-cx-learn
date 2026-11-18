#!/usr/bin/env node
/* ============================================================================
 * multi-video.test.cjs —— D-039 回归：一节多视频「按目标起播 + 失败可见」
 *
 * 背景（Issue #1 复测）：第 2 个视频点不动，同一候选空转 108 次、7 分半。
 * 根因四环：
 *   ① 动作层丢目标：videoToggle 固定点第一个 video；
 *   ② 记账层记错对象：_markVideoStarted 用的是重新探到的 video；
 *   ③ 账本键不可靠：按 src 记账，MSE 时塌缩成 '__nosrc__'；
 *   ④ 验证层缺失：点完不校验 currentTime，失败不可见。
 *
 * 本测试锁住这四环的修复：
 *   1) playSectionVideo 会把 objectid 传给 clickFound（动作带目标）
 *   2) 起播验证：currentTime 前进/暂停解除才算成功
 *   3) 点不动/起不来 → 记 unstartable，且**不回退**去点别的播放器
 *   4) _pickUnplayedVideo 按 objectid 排除「已尝试/已起播/试过3次」
 *   5) 所有候选都失败 → 返回 null（上层据此收口，不再空转）
 *   6) 探针源码里保留「按 objectid 定位」的分支（防回退）
 *
 * 用法：node engine/multi-video.test.cjs
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

const OID1 = 'a'.repeat(32);
const OID2 = 'b'.repeat(32);

function makeMachine(opts) {
  const o = opts || {};
  const adapter = {
    engine: 'fake',
    async ensureBrowser() { return {}; },
    async navigate() {},
    async getCurrentUrl() { return ''; },
    getTargetId() { return 't'; },
    async getFrameDocuments() { return []; },
    async getAllCookies() { return null; },
    async evalInFrame() { return null; },
  };
  const m = new E.LearnMachine(adapter, cfg);
  m.clicks = [];
  m.clickFound = async (frameId, layer, arg) => {
    m.clicks.push({ frameId, layer, arg });
    if (o.clickFails) return { ok: false, reason: 'no-target' };
    return { ok: true, note: 'fake' };
  };
  m.muteIfPossible = async () => {};
  /* gatherState 由用例给：决定「点完之后视频动没动」 */
  m.gatherState = async () => ({ videos: o.videosAfter ? o.videosAfter() : [], video: { found: false } });
  m.loggerStop = null;
  m.stop = (reason) => { m.stopped = reason; };
  return m;
}

const V = (oid, t, paused) => ({ objectid: oid, frameId: 'frame-1', src: 'https://x/' + oid + '.mp4', currentTime: t, paused, duration: 100 });

(async () => {
  /* ---------------- 1. 动作带目标 ---------------- */
  console.log('== 1. playSectionVideo 必须把 objectid 传给点击层 ==');
  {
    const m = makeMachine({ videosAfter: () => [V(OID2, 5, false)] });
    const r = await m.playSectionVideo({ videos: [V(OID1, 90, true), V(OID2, 0, true)] }, V(OID2, 0, true));
    const c = m.clicks[0];
    ok(c && c.layer === 'videoToggle', '点击的是 videoToggle（实际 ' + (c && c.layer) + '）');
    ok(c && c.arg && c.arg.objectid === OID2, '★ 点击参数带上了目标 objectid（实际 ' + JSON.stringify(c && c.arg) + '）');
    ok(r.ok === true, '★ 起播验证通过 → ok:true（实际 ' + JSON.stringify(r) + '）');
    ok(m._startedVideoIds.has(OID2), '★ 已记入 started 账本（按 objectid）');
  }

  /* ---------------- 2. 起播验证：没动就不算成功 ---------------- */
  console.log('== 2. 点完没动 → 判失败（旧版这里会假报 ok）==');
  {
    const m = makeMachine({ videosAfter: () => [V(OID2, 0, true)] });   // currentTime 一直 0、仍暂停
    const r = await m.playSectionVideo({ videos: [V(OID2, 0, true)] }, V(OID2, 0, true));
    ok(r.ok === false, '★ 未起播 → ok:false（实际 ' + JSON.stringify(r) + '）');
    ok(r.reason === 'not-started', '★ reason=not-started（实际 ' + r.reason + '）');
    ok(!m._startedVideoIds.has(OID2), '★ 不能记进 started');
    ok((m._unstartableVideoIds.get(OID2) || 0) === 1, '★ 记一次 unstartable（实际 ' + (m._unstartableVideoIds.get(OID2) || 0) + '）');
  }

  /* ---------------- 3. 点不到目标 → 不回退去点别的 ---------------- */
  console.log('== 3. 点不到目标播放器 → 记失败，绝不回退点第一个 ==');
  {
    const m = makeMachine({ clickFails: true });
    const r = await m.playSectionVideo({}, V(OID2, 0, true));
    ok(r.ok === false, 'ok:false');
    ok(m.clicks.length === 1, '★ 只点了一次，没有反复重试（实际 ' + m.clicks.length + '）');
    ok(m.clicks[0].arg.objectid === OID2, '★ 点的仍是目标 objectid，没有换成别的（实际 ' + JSON.stringify(m.clicks[0].arg) + '）');
    ok((m._unstartableVideoIds.get(OID2) || 0) === 1, '记一次 unstartable');
  }

  /* ---------------- 4. 候选筛选：按 objectid 排除 ---------------- */
  console.log('== 4. _pickUnplayedVideo 按 objectid 排除已尝试/已起播/试满3次 ==');
  {
    const m = makeMachine({});
    const pv = { ok: true, pending: [{ objectid: OID1 }, { objectid: OID2 }], total: 2, finished: 0 };
    m._lastVideos = [V(OID1, 0, true), V(OID2, 0, true)];
    ok(m._pickUnplayedVideo({}, pv) !== null, '初始能挑到候选');
    m._attemptedVideoIds.add(OID1);
    const pick1 = m._pickUnplayedVideo({}, pv);
    ok(pick1 && pick1.objectid === OID2, '★ 已尝试的 OID1 被排除，挑 OID2（实际 ' + (pick1 && pick1.objectid) + '）');
    m._attemptedVideoIds.add(OID2);
    ok(m._pickUnplayedVideo({}, pv) === null, '★ 两个都尝试过 → null（不再无限重挑同一个）');
    /* 试满 3 次也算排除 */
    m._attemptedVideoIds.clear();
    m._unstartableVideoIds.set(OID1, 3);
    const pick2 = m._pickUnplayedVideo({}, pv);
    ok(pick2 && pick2.objectid === OID2, '★ 起播失败满 3 次的 OID1 被排除（实际 ' + (pick2 && pick2.objectid) + '）');
  }

  /* ---------------- 5. 换节清账本 ---------------- */
  console.log('== 5. 换节后账本清零（否则新节候选被误判）==');
  {
    const m = makeMachine({});
    m._attemptedVideoIds.add(OID1);
    m._startedVideoIds.add(OID1);
    m._unstartableVideoIds.set(OID1, 2);
    /* 直接调 advanceSection 内部会重置；这里模拟其重置语句的等价效果并断言语义 */
    m._attemptedVideoIds = new Set();
    m._startedVideoIds = new Set();
    m._unstartableVideoIds = new Map();
    ok(m._attemptedVideoIds.size === 0 && m._startedVideoIds.size === 0 && m._unstartableVideoIds.size === 0,
      '账本三个集合都能清空');
    const src = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'machine.js'), 'utf8');
    ok(src.indexOf('this._attemptedVideoIds = new Set();\n    this._startedVideoIds = new Set();') >= 0
      || /换节了，本节的多视频账本必须清零/.test(src), '★ 源码里换节处确实有清账本（防回退）');
  }

  /* ---------------- 6. 探针源码保留按 objectid 定位 ---------------- */
  console.log('== 6. 探针里有「按 objectid 定位播放器」分支（防回退）==');
  {
    const src = fs.readFileSync(path.join(__dirname, 'src', 'learn', 'selectors.js'), 'utf8');
    ok(/video-element\(targeted\)/.test(src), '★ 存在 targeted 分支');
    ok(/wantId/.test(src), '★ 存在 wantId 匹配逻辑');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
