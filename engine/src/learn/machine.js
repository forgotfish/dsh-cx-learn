/* ============================================================================
 * engine/src/learn/machine.js — LearnMachine 业务状态机（P0–P4：播放/切节/弹题/跳过/上限）
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BUS, busEmit, sleep } = require('../core/base.js');
const aiCore = require('../core/ai.js');
const aiProviders = require('../core/ai-providers.js');
const { humanize, logger } = require('../core/logging.js');
const { emitQuestionEvent } = require('../core/questions.js');
const { installProbeExpression } = require('./selectors.js');
const { decideTaskPoint, kindOf, TASK_KIND } = require('./taskpoints.js');
const { isVideoTaskDone, pendingSectionVideos, pickNextSection, pickStart } = require('./judge.js');

/* ============================================================================
 * 第 6 节 · 业务状态机
 *   PLAYING_CHECK → QUIZ_INTERRUPT → SECTION_ADVANCE → WAIT_LOAD → IDLE(轮询)
 *   任意状态 → FATAL_STOP（人工验证 / 登录失效 / 连续失败 / 防呆）
 * ==========================================================================*/
const NORMAL_STOP = ['all_done_or_no_target', 'max_sections_reached', 'chapter_boundary', 'max_runtime_exceeded', 'user_abort'];

class LearnMachine {
  constructor(adapter, cfg) {
    this.adapter = adapter;
    this.cfg = cfg;
    this.counters = { sectionsCompleted: 0, sectionsSkipped: 0, quizzesAnswered: 0, quizzesSaved: 0, dialogsDismissed: 0 };
    this.failures = 0;
    this.stopReason = null;
    this.stoppedNormally = false;
    this._lastState = null;
    this._lastCurIdx = null;
    this._currentTitle = '当前节';
    this._videoSeenThisSection = false;
    this._waitTicks = 0;
    this._mutedTried = false;
    /* ★ 2026-10-29：本次运行「真正启动过」的视频 src 指纹集合。
       参考 xuexitong-ai-assistant 的 startedVideos（WeakSet<HTMLVideoElement>）：
       只有本次运行亲自推动播放过的视频，才允许用 ended/进度 判定「播完」；
       历史残留的播放器（duration=0、ended 默认 true、或上次留下的旧 currentTime）
       一律不能作为完成证据 —— 这正是 3.3↔3.4 空转的根因。
       CDP 侧拿不到元素引用，改用 currentSrc 指纹代替。 */
    this._startedVideoSrcs = new Set();
    /* ★ 2026-11-18（D-039）：按 **objectid** 记账的本节视频账本。
       为什么不用 src：src 是播放器实现细节，MSE/blob 时为空 → 全塌缩成一个键；
       而 objectid 是任务点身份，判定层本来就有，必须贯穿到动作/记账/验证三层。
         · _attemptedVideoIds ：已「尝试起播」过的（在点击**之前**写入，与成功解耦）
         · _startedVideoIds   ：已确认**真的起播**的（currentTime 前进 / paused=false）
         · _unstartableVideoIds：试过 N 次仍起不来的（Map<objectid, 次数>） */
    this._attemptedVideoIds = new Set();
    this._startedVideoIds = new Set();
    this._unstartableVideoIds = new Map();
    /* ★ 2026-11-15（GitHub Issue #1）：本节「各 frame 里的 <video> 清单」，
       由 gatherState 每次扫描填充（带 frameId / frameUrl / objectid）。
       一节课可能有多个视频任务点、每个任务点一个独立播放器 iframe，
       只有这份清单才能把「未完成的任务点」映射到「该播哪个播放器」。 */
    this._lastVideos = [];
    /* ★ 2026-11-16（D-027）：直播回放状态。
       _livePlayer = { targetId, liveId } —— 复用同一个播放器标签页，杜绝越堆越多；
       _liveCtx = { key, userid, clazzid, courseid } —— liveinfo 需要的上下文，抓一次缓存。 */
    this._livePlayer = null;
    this._liveCtx = null;
    // 视频播放停滞检测（CDN 签名过期 → 源 403 → 进度卡住）
    this._stallTicks = 0;
    this._lastProgressTime = undefined;
    this._resumeAttempts = 0;
    this._lastVideoFrameId = null;
    this._lastVideoCurrentTime = undefined;
    this._lastVideoDuration = undefined;
    this._lastVideoSrc = '';
    this._videoProgressTicks = 0;
    // 当前节的 chapterId（重载页面时要用，课程 URL 里的是固定的第一节）
    this._currentChapterIdValue = '';
    // 章内「章节测验」状态
    this._quizTabOpened = false;
    this._quizTabWaitTicks = 0;
    this._quizTabDoneFor = null;
    this._quizTabChapter = null;
    // 随堂题：记住「这道题已经问过 AI 了」，避免同一题反复问模型（D-019）
    this._videoQuizAiForKey = null;
  }

  /**
   * 出问题时**暂停并拍快照**（2026-10-31 主人要求）。
   * 落盘内容：播放器真实字段（含 seekable/buffered/ended）+ 当前任务点
   * + 目录待办 + 整页截图。任何一步失败都吞掉，不影响主流程。
   * @returns {Promise<string>} json 路径；失败返回空串
   */
  async captureProblemSnapshot(st, reason) {
    try {
      const base = process.env.CX_STATE_DIR || path.join(__dirname, '..', '..', '.state');
      const dir = path.join(base, 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const v = (st && st.video) || {};
      let videoLive = null;
      try {
        if (v.frameId) {
          videoLive = await this.adapter.evalInFrame(v.frameId,
            '(function(){try{var v=document.querySelector("video");if(!v)return null;v.pause();return {currentTime:v.currentTime,duration:v.duration,ended:v.ended,paused:v.paused,muted:v.muted,readyState:v.readyState,seekable:v.seekable.length?[v.seekable.start(0),v.seekable.end(v.seekable.length-1)]:null,buffered:v.buffered.length?[v.buffered.start(0),v.buffered.end(v.buffered.length-1)]:null,src:(v.currentSrc||"").slice(0,200)}}catch(e){return {err:String(e&&e.message||e)}}})()');
        }
      } catch (e) { videoLive = { err: String((e && e.message) || e) }; }
      let targetProbe = null;
      try {
        const wt = this._waitTarget;
        if (wt && wt.tocFrameId && wt.chapterId) {
          targetProbe = await this.adapter.evalInFrame(wt.tocFrameId,
            '(function(){try{var e=document.getElementById("cur" + ' + JSON.stringify(String(wt.chapterId)) + ');if(!e)return {found:false};var r=e.getBoundingClientRect();var p=e.parentElement;return {found:true,rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},visible:!!(e.offsetWidth||e.offsetHeight),display:getComputedStyle(e).display,parentDisplay:p?getComputedStyle(p).display:null,cls:String(e.className||""),text:(e.innerText||"").slice(0,60)}}catch(err){return {err:String(err&&err.message||err)}}})()');
        }
      } catch (_) { targetProbe = null; }
      const cur = this._currentTocItem(st);
      const payload = {
        at: new Date().toISOString(),
        reason: reason,
        section: this._currentTitle,
        video: {
          progress: v.progress, currentTime: v.currentTime, duration: v.duration,
          ended: v.ended, paused: v.paused, muted: v.muted, readyState: v.readyState,
        },
        videoLive: videoLive,
        pending: this._currentPending(st),
        tocItem: cur ? { title: cur.title, done: cur.done, unfinish: cur.unfinish, chapterId: cur.chapterId } : null,
        targetProbe: targetProbe,
        tasks: (this._lastInventory && this._lastInventory.tasks) || [],
        counters: this.counters,
      };
      const jsonPath = path.join(dir, stamp + '-' + reason + '.json');
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
      let pngPath = '';
      try {
        pngPath = path.join(dir, stamp + '-' + reason + '.png');
        const b64 = await this.adapter.screenshot(pngPath);
        if (!b64) pngPath = '';
      } catch (_) { pngPath = ''; }
      logger.warn('DIAG', '已暂停播放并保存问题快照', { json: jsonPath, png: pngPath, reason: reason });
      return jsonPath;
    } catch (e) {
      logger.warn('DIAG', '问题快照保存失败（不影响主流程）', { error: String((e && e.message) || e) });
      return '';
    }
  }

  stop(reason) {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.stoppedNormally = NORMAL_STOP.indexOf(reason) >= 0;
    logger.info('LOOP', '达到停止条件', { reason, counters: this.counters });
    /* ★ 分层：把停止事实写进中间文件，插件/另一层不必解析日志 */
    try {
      if (BUS && BUS.reportLearn) {
        BUS.reportLearn({
          phase: 'stopped',
          stopReason: reason,
          section: this._currentTitle,
          counters: this.counters,
        });
      }
      busEmit('learn', 'stop', { reason, section: this._currentTitle });
    } catch (_) { /* ignore */ }
  }

  fatalStop(code, msg, meta) {
    if (this.stopReason) return;
    this.stopReason = code;
    this.stoppedNormally = false;
    logger.error('FATAL', code === 'HUMAN_VERIFICATION' ? msg : 'FATAL: ' + code + ' — ' + msg, meta);
    if (code === 'HUMAN_VERIFICATION') logger.error('FATAL', '按安全策略立即停止，不做任何绕过尝试');
    if (code === 'UNRECOGNIZED_PAGE') logger.error('FATAL', '诊断信息: ' + JSON.stringify(this.lastDiagnostics()).slice(0, 1200));
    try {
      if (BUS && BUS.reportLearn) {
        BUS.reportLearn({
          phase: 'fatal',
          stopReason: code,
          message: String(msg || '').slice(0, 300),
          section: this._currentTitle,
          counters: this.counters,
        });
      }
      busEmit('learn', 'fatal', { code, section: this._currentTitle });
    } catch (_) { /* ignore */ }
  }

  lastDiagnostics() {
    const st = this._lastState || {};
    return {
      topUrl: st.topUrl || '',
      frames: (st.frames || []).map((f) => ({
        frameId: f.frameId, url: f.url, error: f.error || null,
        hasVideo: !!(f.probe && f.probe.video && f.probe.video.found),
        tocFound: !!(f.probe && f.probe.toc && f.probe.toc.found)
      })),
      counters: this.counters,
      failures: this.failures
    };
  }

  /** 逐帧注入探测代码并合并全量状态（iframe 递归遍历发生在 adapter.getFrameDocuments） */
  async gatherState() {
    const frames = await this.adapter.getFrameDocuments();
    const inst = installProbeExpression(this.cfg);
    const st = { frames: [], topUrl: '', video: null, videoFrameId: null, dialogs: [], human: [], quiz: null, quizFrameId: null, videoQuiz: null, quizTab: null, toc: null, loginInvalid: false, loginEvidence: [] };
    for (const f of frames) {
      const rec = { frameId: f.frameId, url: f.url, isTop: !!f.isTop };
      try {
        await this.adapter.evalInFrame(f.frameId, inst);
        rec.probe = await this.adapter.evalInFrame(f.frameId, '__cx.probeAll()');
      } catch (e) {
        rec.error = String((e && e.message) || e).slice(0, 120);
      }
      st.frames.push(rec);
    }
    const probes = st.frames.filter((f) => f.probe);
    const top = probes.find((f) => f.isTop) || probes[0];
    st.topUrl = (top && top.probe.url) || (frames[0] && frames[0].url) || '';
    /* ★ 2026-10-29：缓存本次扫描到的任务点清单，供 _videoTaskDone 判定「视频任务已完成」。
       probeAll 现在会返回 tasks[]（kind + finished），逐个 .ans-attach-ct 分类。
       参考 xuexitong-ai-assistant 的 pageInventory.markers 设计。

       ★ 2026-10-30 补：每条任务点带上「它来自哪个 frame 的 URL」。
       切节瞬间，knowledge/cards iframe 可能还挂着**上一节**的内容，
       只按 ans-job-finished 判会拿上一节的「已完成」去跳过这一节 —— 那是误跳。 */
    {
      const allTasks = [];
      const allVideos = [];
      for (const f of probes) {
        const ts = f.probe && f.probe.tasks;
        if (Array.isArray(ts)) {
          for (const t of ts) allTasks.push(Object.assign({ frameUrl: String(f.url || '') }, t));
        }
        /* ★ 2026-11-15（Issue #1）：同时汇总每个 frame 的 <video> 清单。
           任务点带 objectid、video 也从 src 里抽了 objectid，两者能对上，
           才能回答「本节还剩哪几个视频没播」以及「该播哪个播放器」。 */
        const vs = f.probe && f.probe.videos;
        if (Array.isArray(vs)) {
          for (const v of vs) {
            allVideos.push(Object.assign({ frameId: f.frameId, frameUrl: String(f.url || '') }, v));
          }
        }
      }
      this._lastInventory = { tasks: allTasks, at: Date.now() };
      this._lastVideos = allVideos;
      /* ★ 2026-11-21（真探针契约）：把汇总结果也挂到 state 上。
         过去只赋 _lastVideos，从没赋 st.videos —— 而验证兜底 / 诊断快照都在读
         st.videos / st2.videos，于是永远读到 undefined（诊断里 videos 恒为 []）。 */
      st.videos = allVideos;
    }
    for (const f of probes) {
      for (const d of f.probe.dialogs || []) {
        st.dialogs.push(Object.assign({}, d, { frameId: f.frameId }));
        if (d.kind === 'human') st.human.push({ evidence: d.evidence, frameId: f.frameId });
      }
      if (f.probe.human && f.probe.human.detected) st.human.push({ evidence: f.probe.human.evidence, frameId: f.frameId });
      const q = f.probe.quiz;
      if (q && q.present && (!st.quiz || (!st.quiz.parseable && q.parseable))) {
        st.quiz = Object.assign({}, q, { frameId: f.frameId });
        st.quizFrameId = f.frameId;
      }
      /* 随堂弹题（视频内嵌答题）：优先级最高，一出现就处理（它会把视频强制暂停） */
      const vq = f.probe.videoQuiz;
      if (vq && vq.present && !st.videoQuiz) st.videoQuiz = Object.assign({}, vq, { frameId: f.frameId });
      const qt = f.probe.quizTab;
      if (qt && qt.present && !st.quizTab) st.quizTab = Object.assign({}, qt, { frameId: f.frameId });
      const t = f.probe.toc;
      if (t && t.found && !st.toc) st.toc = Object.assign({}, t, { frameId: f.frameId });
    }
    /* ★★ 2026-11-15（Issue #1）：视频选择放在这里（不能再放上面那个循环里）——
       必须等 st.toc 收集完，才能算出「本节还剩哪几个视频任务点」，
       进而优先挑「未完成任务点」对应的播放器。
       旧逻辑按 progress 最大挑 ⇒ 一节多视频时永远挑回刚播完那个（progress≈98%），
       于是每轮都判「本节已播完」→ 提前切节，剩下 9 个视频一次没播。 */
    const pendingVids = this._sectionPendingVideos(st);
    for (const f of probes) {
      const v = f.probe.video;
      if (!v || !v.found) continue;
      const cand = Object.assign({}, v, { frameId: f.frameId });
      if (!st.video) {
        st.video = cand;
        st.videoFrameId = f.frameId;
        continue;
      }
      const candPending = this._videoMatchesPending(cand, pendingVids);
      const curPending = this._videoMatchesPending(st.video, pendingVids);
      if (candPending && !curPending) {
        st.video = cand;
        st.videoFrameId = f.frameId;
      } else if (candPending === curPending && (v.progress || 0) > (st.video.progress || 0)) {
        st.video = cand;
        st.videoFrameId = f.frameId;
      }
    }
    if (top) {
      const lg = top.probe.login || {};
      if (lg.hostHit && (lg.hasPwField || /passport|login/i.test(lg.href || ''))) {
        st.loginInvalid = true;
        st.loginEvidence.push('top:' + lg.host + ' pwField=' + lg.hasPwField);
      }
    }
    for (const f of probes) {
      const lg = f.probe.login || {};
      if (lg.hostHit && lg.hasPwField) { st.loginInvalid = true; st.loginEvidence.push('frame:' + lg.host); }
    }
    this._lastState = st;
    return st;
  }

  /** 点击前实时解析元素 + 拟人化延迟 + 真实输入事件；失败降级 JS click（WARN） */
  async clickFound(frameId, kind, arg) {
    const evalFind = () => this.adapter.evalInFrame(
      frameId, '__cx.find(' + JSON.stringify(kind) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')'
    );
    let found;
    try {
      found = await evalFind();
    } catch (e) {
      return { ok: false, reason: 'find-eval-error: ' + String((e && e.message) || e).slice(0, 80) };
    }
    /* ★ 2026-11-22（D-048 教训复用）：滚动是**异步**的。页面探针里滚完只能立刻量一次，
       真实的滚动落位（尤其 smooth / 布局重排）常常晚一拍。这里在页面侧滚过之后，
       等 450ms 再查一次；仍失败才判失败/降级。只重查一次，不循环。 */
    if (found && !found.ok && /^(hit-test-blocked|still-outside-viewport)$/.test(String(found.reason || ''))) {
      await sleep(450);
      try {
        const again = await evalFind();
        if (again && again.ok) {
          logger.info('CLICK', '滚动后重查命中（异步滚动已落位）', {
            kind, firstReason: found.reason, note: again.note || null,
          });
          found = again;
        } else if (again) {
          found = again;
        }
      } catch (_) { /* 重查失败保持原结果 */ }
    }
    if (!found || !found.ok) {
      /* ★ D-055：videoToggle 绝不降级 el.click()。
         红线：所有点击一律真鼠标，点不中就快照+报错。且对 <video> 来说
         el.click() 根本不会触发起播（vjs 播放要真实指针事件），降级=掩盖失败。
         多视频第 2 个视频起不来那次真机事故就是这里偷偷降级造成的。 */
      if (kind === 'videoToggle') {
        return {
          ok: false,
          reason: (found && found.reason) || 'find-null',
          note: (found && found.note) || null,
          rect: (found && found.rect) || null,
        };
      }
      if (found && found.jsFallback) {
        logger.warn('CLICK', 'WARN 跨域 frame 无法计算全局坐标，降级为页内 JS click', { kind, layer: 3 });
        return this.jsClickFound(frameId, kind, arg);
      }
      /* ★ 2026-10-31：坐标命不中（被遮罩挡住 / 滚完仍在视口外）→ 降级页内 JS click，
         不再直接判失败。 */
      if (found && /^(hit-test-blocked|still-outside-viewport)$/.test(String(found.reason || ''))) {
        logger.warn('CLICK', '坐标不可用（命中检查/视口失败），降级为页内 JS click', { kind, reason: found.reason });
        return this.jsClickFound(frameId, kind, arg);
      }
      return { ok: false, reason: found ? found.reason : 'find-null' };
    }
    await humanize.beforeClick(); // 拟人化：点击前随机延迟 300–1200ms
    if (found.scrolled) logger.info('CLICK', '目标在视口外，已滚动至可视区后点击', { kind, layer: found.layer });
    try {
      const r = await this.adapter.click(frameId, found.rect);
      logger.log('CLICK', 'INFO', '点击完成（真实输入事件）', { kind, layer: found.layer, note: found.note, text: found.text, mode: r.mode });
      return { ok: true, layer: found.layer, note: found.note, text: found.text };
    } catch (e) {
      if (kind === 'videoToggle') {
        return { ok: false, reason: 'click-error: ' + String((e && e.message) || e).slice(0, 80) };
      }
      logger.warn('CLICK', 'WARN 输入事件点击失败，降级为页内 JS click', { kind, err: String((e && e.message) || e).slice(0, 80) });
      return this.jsClickFound(frameId, kind, arg);
    }
  }

  async jsClickFound(frameId, kind, arg) {
    try {
      const r = await this.adapter.jsClick(frameId, kind, arg);
      if (r && r.ok) {
        logger.log('CLICK', 'WARN', '已用降级 JS click 完成点击', { kind, layer: r.layer || 3, note: r.note || '' });
        return { ok: true, layer: r.layer || 3, degraded: true };
      }
      return { ok: false, reason: r && r.reason };
    } catch (e) {
      this.failures += 1;
      return { ok: false, reason: 'jsClick-error: ' + String((e && e.message) || e).slice(0, 80) };
    }
  }

  async muteIfPossible(frameId) {
    if (this._mutedTried || !this.cfg.video.mute) return;
    this._mutedTried = true;
    try {
      await this.adapter.evalInFrame(frameId, 'Array.prototype.forEach.call(document.querySelectorAll("video"), function (v) { v.muted = true; }); true');
      logger.info('PLAYING_CHECK', '已将视频静音（等价用户点静音；NAS 环境防外放）');
    } catch (_) { /* 静音失败不阻塞 */ }
  }

  /**
   * D-066：按 objectid 在该 frame 内**直接起播**（真鼠标点不动时的兜底）。
   * 这是属性/方法调用，不是合成点击；与 muteIfPossible 同性质。
   * ok=true 只代表 play() 调用成功，**是否真起播仍由 _verifyVideoStarted 判定**。
   */
  async _playByObjectId(frameId, oid) {
    try {
      const r = await this.adapter.evalInFrame(
        frameId,
        '__cx && __cx.playByObjectId ? __cx.playByObjectId(' + JSON.stringify(String(oid || '')) + ', 1) : {ok:false,reason:"probe-missing"}'
      );
      return (r && typeof r === 'object') ? r : { ok: false, reason: 'bad-probe-result' };
    } catch (e) {
      return { ok: false, reason: 'eval-error: ' + String((e && e.message) || e).slice(0, 60) };
    }
  }

  /**
   * D-066：应用播放倍速。**默认 1 → 直接跳过**（不改页面状态）。
   */
  async _applyPlaybackRate(frameId, oid) {
    const rate = Number((this.cfg && this.cfg.video && this.cfg.video.playbackRate) || 1);
    if (!(rate > 0) || rate === 1) return;
    try {
      /* ★ D-068：只设倍速（__cx.setRate），**不再复用 playByObjectId** ——
         后者会顺带再 play() 一次，且多视频帧里 oid 匹配不上时静默不设倍速。 */
      const r = await this.adapter.evalInFrame(
        frameId,
        '__cx && __cx.setRate ? __cx.setRate(' + JSON.stringify(String(oid || '')) + ', ' + JSON.stringify(rate) + ') : null'
      );
      if (r && r.ok) logger.info('PLAYING', '已应用播放倍速', { rate: r.rate });
      else if (r) logger.warn('PLAYING', '倍速未能应用（不阻塞播放）', { reason: r.reason, videoCount: r.videoCount });
    } catch (_) { /* 倍速失败不影响播放 */ }
  }

  /** 单步状态机。返回 { progress, outcome }；progress=true 时主循环重置失败计数。 */
  async tick() {
    const st = await this.gatherState();

    /* ★ 2026-10-28：运行时风控检查（不只是 navigate 时）。
       实测：播放过程中超星也可能把当前页跳转到 detect.chaoxing.com，
       此时 gatherState 拿到的 frames 会异常，最终表现为 UNRECOGNIZED_PAGE。
       这里先直接看顶层 URL，命中就走「等 30 秒 → 刷新 → 重试，最多 2 次」的恢复流程。 */
    const topUrlNow = String((st && st.topUrl) || '');
    if (this.adapter && typeof this.adapter._isDetectUrl === 'function' && this.adapter._isDetectUrl(topUrlNow)) {
      const maxRetries = Number(this.cfg.detect && this.cfg.detect.maxRetries) || 2;
      this._detectRetry = (this._detectRetry || 0) + 1;
      const baseWait = Number(this.cfg.detect && this.cfg.detect.retryWaitMs) || 30000;
      const jitter = Number(this.cfg.detect && this.cfg.detect.retryJitterMs) || 5000;
      let msg = '';
      try { msg = await this.adapter._readDetectMessage(); } catch (_) { /* ignore */ }

      if (this._detectRetry <= maxRetries) {
        const waitMs = baseWait + Math.floor(Math.random() * jitter);
        logger.warn('RISK_CONTROL', '播放中命中风控页，等待后刷新重试', {
          attempt: this._detectRetry, maxRetries,
          waitSeconds: Math.round(waitMs / 1000),
          url: topUrlNow.slice(0, 160),
          message: String(msg || '').slice(0, 160),
          hint: '建议退出手机端超星 App 会话',
        });
        await sleep(waitMs);
        try {
          await this.adapter.navigate('https://i.chaoxing.com/base');
          const after = await this.adapter.getCurrentUrl().catch(() => '');
          if (!this.adapter._isDetectUrl(after)) {
            logger.info('RISK_CONTROL', '播放中风控已解除，继续', {
              attempt: this._detectRetry, url: String(after).slice(0, 140),
            });
            this.failures = 0;
            return { progress: true, outcome: 'RISK_CONTROL_RECOVERED' };
          }
        } catch (e) {
          logger.warn('RISK_CONTROL', '播放中风控刷新出错', {
            attempt: this._detectRetry, err: String((e && e.message) || e).slice(0, 120),
          });
        }
        return { progress: false, outcome: 'RISK_CONTROL_WAIT' };
      }

      logger.error('RISK_CONTROL', '播放中风控重试已达上限，停止运行', {
        attempts: this._detectRetry, maxRetries,
        url: topUrlNow.slice(0, 200),
        message: String(msg || '').slice(0, 200),
        reason: '超星判定「多终端登录 / 异常学习」。已按策略等待 30 秒并刷新重试 '
          + maxRetries + ' 次仍未解除。处理：① 手机端学习通 App 完全退出登录；'
          + '② 确认无其他终端同时登录；③ 等待 10-30 分钟后重试。',
      });
      this.fatalStop('RISK_CONTROL_DETECTED',
        '超星风控未解除（已重试 ' + maxRetries + ' 次）：多终端登录/异常学习判定。'
        + (msg ? ' 平台提示：' + String(msg).slice(0, 120) : '')
        + ' 请退出手机端学习通 App 后等待 10-30 分钟再试。');
      return { progress: false, outcome: 'FATAL_STOP' };
    }
    this._detectRetry = 0;

    if (st.video && st.video.found) {
      const frameChanged = this._lastVideoFrameId !== st.video.frameId;
      const current = Number(st.video.currentTime) || 0;
      const duration = Number(st.video.duration) || 0;
      const src = String(st.video.src || '');
      const mediaChanged = !frameChanged && (
        (this._lastVideoDuration > 0 && duration > 0 && Math.abs(duration - this._lastVideoDuration) > 1)
        || (this._lastVideoSrc && src && src !== this._lastVideoSrc)
      );
      if (frameChanged || mediaChanged) {
        this._lastVideoFrameId = st.video.frameId;
        this._lastVideoCurrentTime = current;
        this._lastVideoDuration = duration;
        this._lastVideoSrc = src;
        this._videoProgressTicks = 0;
      } else if (this._lastVideoCurrentTime !== undefined && current - this._lastVideoCurrentTime >= 0.5) {
        this._videoProgressTicks += 1;
        this._lastVideoCurrentTime = current;
      } else if (this._lastVideoCurrentTime === undefined) {
        this._lastVideoCurrentTime = current;
      }
    }

    /* —— 安全闸门（最高优先级，立即 FATAL）—— */
    if (st.human.length) {
      this.fatalStop('HUMAN_VERIFICATION', 'FATAL: 需要人工介入 — 检测到人脸识别/活体/验证码特征: ' + st.human.map((h) => h.evidence).join(', '), { frames: st.human.map((h) => h.frameId) });
      return { progress: false, outcome: 'FATAL_STOP' };
    }
    if (st.loginInvalid) {
      this.fatalStop('LOGIN_REQUIRED', '登录态失效（' + st.loginEvidence.join('; ') + '）。请在浏览器 profile 中人工重新登录后重跑；脚本不会自动登录。');
      return { progress: false, outcome: 'FATAL_STOP' };
    }

    /* —— P0：防挂机弹窗。非普通确认弹窗不自动处理，避免误点题目按钮 —— */
    const dlg = st.dialogs.find((d) => d.kind === 'anti-idle');
    if (dlg) {
      const r = await this.clickFound(dlg.frameId, 'dialogPrimary');
      if (r.ok) {
        this.counters.dialogsDismissed += 1;
        logger.info('DIALOG', 'P0 防挂机弹窗已关闭并尝试恢复播放', { kind: dlg.kind, text: dlg.text.slice(0, 60), layer: dlg.layer, note: dlg.note });
        return { progress: true, outcome: 'DIALOG_DISMISSED' };
      }
      logger.warn('DIALOG', 'P0 防挂机弹窗主按钮点击失败', { kind: dlg.kind });
      this.failures += 1;
      return { progress: false, outcome: 'DIALOG_CLICK_FAIL' };
    }

    /* ★★★ 2026-10-30 修正顺序：先判「本节视频任务已完成」，再谈题目 ★★★
       实测（FNOS run.log 11:59:17→11:59:28，章节 1.3 工程形态）：
         · 目录里 jobUnfinishCount=1（视频已完成，只剩章节测验）
         · 页面 knowledge/cards 里 <div class="ans-attach-ct videoContainer ans-job-finished">
           aria-label="任务点已完成" —— 视频任务点早就完成了
         · 但播放器把上次的 254 秒位置恢复出来，随堂题面板也跟着弹出来
       原顺序是「先处理弹题」→ 因为本轮还没产生播放进度（progressedTicks=0）
       判「证据不足」→ quiz_unclassified_needs_human 整体停机。
       一节已经看完的视频，不该因为一个遗留弹题把整轮跑废。

       安全性：_videoTaskDone 只看 video/audio 任务点，绝不看章节测验，
       也绝不点任何选项。整节完成（含测验）走 _currentSectionDone 那条。 */
    if (!this._quizTabOpened) {
      /* ★ D-064：先确保本节所有知识卡片都被扫描过（必要时切卡）。
         切了卡 → 本拍直接返回 progress（新卡片的任务点/播放器要等下一拍重新 gatherState）。 */
      try {
        const cardStep = await this._ensureCardsScanned(st);
        if (cardStep) return cardStep;
      } catch (e) {
        logger.warn('ADVANCE', '知识卡片扫描异常（不影响主流程）', { err: String((e && e.message) || e).slice(0, 120) });
      }
      const doneNow = this._currentSectionDone(st)
        ? { ok: true, by: 'toc-section-done' }
        : this._videoTaskDone(st);
      /* ★ D-069（复测报告第 (5) 条，真机实证）：超星大约在 86% 就把任务点标绿。
         原实现 doneNow.ok 就直接 sectionsSkipped+1 并 advanceSection，
         于是「连播 → 记账确认 → 并集闸门 → 计数」整段被跳过：
           · 每个视频的后 10~14% 从未播放
           · sectionsCompleted 恒为 0（走了 sectionsSkipped），maxSections 彻底失效
           · 多卡片节的并集闸门也轮不到执行 → 后卡漏刷
         修法：区分「本次起播后被动标绿」与「进来时本来就已经绿」：
           · 前者 → 当「还没播完」，不切节，落下去继续播到判定线
           · 后者 → 上次已看完，该跳就跳（保持旧行为，不额外耗时） */
      const greenEarly = (() => {
        if (!doneNow.ok) return false;
        const v = st && st.video;
        if (!v || !v.found) return false;
        if (!this._isVideoStartedHere(v)) return false;               /* 进来时就是绿的 → 不算提前 */
        if (v.ended) return false;                                    /* 真播完了 */
        /* ★ D-073（复测报告 A 类）：**进节时平台就已经标绿** → 「上次已看完」，
           不是「本次起播后被推动」，绝不能再推着播（1.3 卡 0 从 85.9% 白播到 98.4%）。
           注意判据是「进节时平台已绿」，不是「进节进度 >= 98.5%」——
           复测案例进节 85.9% 就已经绿了。 */
        if (this._doneAtEntry(v)) return false;
        return (v.progress || 0) < this.cfg.video.progressDoneRatio;   /* 未到判定线 */
      })();
      if (greenEarly) {
        logger.info('ADVANCE', '平台已标绿但视频尚未播到判定线，继续播放（不切节）', {
          title: this._currentTitle,
          progress: (st.video && st.video.progress) || 0,
          doneAt: this.cfg.video.progressDoneRatio,
          by: doneNow.by,
        });
      }
      if (doneNow.ok && !greenEarly) {
        /* ★ D-064：本节可能是「多个知识卡片」。当前挂载那张卡片的 media 全绿
           **不等于**本节读完 —— 其余卡片还没扫/还没播。这里用「卡片并集」拦截：
             · 返回 false → 明确还有卡没播完：不许切节，继续走后面的卡片扫描/播放
             · 返回 null  → 无法判定（老页面/单卡）→ 按旧逻辑切节 */
        let unionDone = null;
        try { unionDone = this._cardsUnionDone(st); } catch (_) { unionDone = null; }
        if (unionDone === false) {
          logger.info('ADVANCE', '当前卡片已播完，但本节还有其他知识卡片未完成，先不切节', {
            title: this._currentTitle, cards: this._cardScan ? this._cardScan.size : 0,
          });
        } else {
          logger.info('ADVANCE', '本节视频任务已完成（测验按策略跳过），直接切下一节', {
            title: this._currentTitle,
            progress: (st.video && st.video.progress) || 0,
            by: doneNow.by,
            unfinish: doneNow.unfinish,
            total: doneNow.total,
          });
          this._countSectionOutcome();  /* D-073 唯一出口（原 sectionsSkipped += 1） */
          this.failures = 0;
          return this.advanceSection(st);
        }
      }
    }

    /* —— P2.5：视频内随堂题优先分类；不让泛化 radio 探针抢先命中 —— */
    if (st.videoQuiz && st.videoQuiz.present) {
      const r = await this.handleVideoQuiz(st);
      return r;
    }

    /* —— P2：章节作业/泛化题目只停止；绝不答题或自动切回视频 —— */
    if (st.quiz && st.quiz.present) {
      const r = await this.handleQuiz(st);
      return r;
    }

    /* —— 已切到「章节测验」标签：等题目加载 ——
       点开测验标签后视频区会被替换，st.video 消失；必须先把题目答完，
       否则会走「无视频→跳过」分支把这一节误判为非视频任务点。 */
    if (this._quizTabOpened) {
      const r = await this.continueChapterQuiz();
      if (r === 'pending') return { progress: true, outcome: 'CHAPTER_QUIZ_PENDING' };
      return { progress: true, outcome: 'CHAPTER_QUIZ_HANDLED' };
    }

    /* —— 视频状态（P0 / P1）—— */
    if (st.video && st.video.found) {
      this._videoSeenThisSection = true;
      /* ★ D-073：记录本节首次看到该视频时「平台是否已绿」，用于区分「早已看完」与「本次推动」 */
      this._noteVideoEntry(st.video, st);
      /* 「本节已完成 ⇒ 不重播」的判定已经在上面的统一闸门里做过（见 tick 开头），
         那里同时覆盖了「整节完成」与「视频任务点完成」两种情形，
         并且不会被遗留弹题抢先。这里不再重复。 */
      /* ★★ 2026-10-29 关键修复：只有「本次运行真正启动过」的视频，
         才允许用 ended / 进度 判定播完。
         参考 xuexitong-ai-assistant 的 startedVideos 语义：
           只有 startedVideos.has(video) 时才 return video.ended || ...，
           否则只认平台任务点（P.complete）。
         我们之前没做这个区分 ⇒ 刚点进新节、元数据还没加载时
           duration=0、ended 默认 true ⇒ 直接判成「播完」⇒ 反复空转。 */
      const startedHere = this._isVideoStartedHere(st.video);
      const playedEnough = startedHere &&
        (st.video.ended || (st.video.progress || 0) >= this.cfg.video.progressDoneRatio);
      if (!startedHere && (st.video.progress || 0) > 0.5) {
        /* 视频在走但还没登记为「本次启动」→ 补登记（正常播放中首次进入即命中） */
        this._markVideoStarted(st.video);
      }
      if (playedEnough) {
        /* ★★ 2026-11-15（GitHub Issue #1）P0：判定与动作解耦。
           播完「一个视频」≠「本节看完」。本节还有没播过的视频任务点时，
           必须接着播下一个，**绝不** advanceSection()。
           旧逻辑只要 playedEnough 就往切节走 —— 一节 12 个任务点（10 个视频）
           只播第 1 个就切走，剩下 9 个一次没播，这就是 Issue #1。 */
        const pv = this._sectionPendingVideos(st);
        /* ★ 只有「本节确实有多个 media 任务点」才启用连播逻辑；
           单视频节保持原行为（老页面/拿不到 objectid 时不至于误判）。 */
        const multiVideo = !!(pv.ok && pv.total > 1);
        const blockAdvance = multiVideo && pv.pending.length > 0;
        if (blockAdvance) {
          /* ★★ 2026-11-20（D-054，真机实证）：**多视频节的每个视频在独立子 iframe 里**。
             实测 2.2（2 个视频）frame 树：
                studentstudy → knowledge/cards → ananas/modules/video/index.html × 2
             而 cards frame 里 `document.querySelectorAll('video')` = 0 ——
             video 在下钻一层的 video 子 iframe 里。所以汇总出的 videos 为空，
             `_pickUnplayedVideo` 挑不出候选 → 直接收口 video_task_unreachable。
             修法：按 pending 的 objectid **反查 video 子 iframe** 补齐候选。 */
          await this._enrichVideosFromFrames(pv);
          const nextVid = this._pickUnplayedVideo(st, pv);
          if (nextVid) {
            logger.info('ADVANCE', '本节还有未播的视频任务点，继续播下一个（不切节）', {
              title: this._currentTitle,
              pendingVideos: pv.pending.length,
              totalVideos: pv.total,
              finishedVideos: pv.finished,
              nextObjectId: String(nextVid.objectid || '').slice(0, 32),
              nextFrame: nextVid.frameId,
            });
            const r = await this.playSectionVideo(st, nextVid);
            if (r.ok) return { progress: true, outcome: 'NEXT_VIDEO' };
            /* ★ D-039：起播失败**不再是致命错误**，也不再静默回循环头：
               本次已把该候选写进 attempted，下一拍会自动换下一个候选；
               只有「所有候选都试过/都起不来」时才收口（下面是那个分支）。 */
            logger.warn('ADVANCE', '该候选视频起播失败，下一拍换下一个候选', {
              title: this._currentTitle, reason: r.reason,
              objectid: String((nextVid && nextVid.objectid) || '').slice(0, 12),
              pendingVideos: pv.pending.length,
            });
            return { progress: false, outcome: 'NEXT_VIDEO_UNSTARTABLE' };
          }
          /* 没有可挑的候选了。要区分两种截然不同的情形：
             (a) 候选都**起播失败**过（unstartable>0）→ 独立终态：报错+快照+停机；
             (b) 候选都只是**试过并在播**、等平台记账 → 和旧语义一致，继续等，不停机。 */
          const stuck = [];
          for (const t of pv.pending) {
            const oid = String((t && t.objectid) || '');
            if (!oid) continue;
            const n = this._unstartableVideoIds.get(oid) || 0;
            if (n > 0) stuck.push({ objectid: oid, attempts: n });
          }
          if (stuck.length) {
            logger.warn('ADVANCE', '本节剩余视频任务点均无法起播，停止本轮（附快照）', {
              title: this._currentTitle,
              pendingVideos: pv.pending.length,
              attempted: this._attemptedVideoIds.size,
              unstartable: stuck,
            });
            try { this._dumpStuckVideos(st, pv, stuck); } catch (_) { /* ignore */ }
            this.stop('video_task_unreachable');
            return { progress: false, outcome: 'STOPPED' };
          }
          logger.warn('ADVANCE', '本节剩余视频任务点均已尝试过，等待平台记账，本轮不切节', {
            title: this._currentTitle, pendingVideos: pv.pending.length, totalVideos: pv.total,
          });
        }
        /* ★ 播放器走到 98.5% 不等于超星记了完成。目录里的待办数才是硬证据。
           播完后重新读一次目录：待办从 2 变 1 ⇒ 视频已被服务端记为看完。 */
        const pendingNow = await this.confirmVideoWatched(6000);
        /* ★ 判据放宽：不再要求 pending 必须降到 1。
           我们的策略是跳过章节测验，所以 pending 常常停在 1（视频完成 + 测验未做），
           3.4 这种首进拿不到时长的更会停在 2。
           只要「视频任务点已完成」（目录待办下降 或 页面 video 任务点全绿）就算数。 */
        const videoTask = this._videoTaskDone(st);
        const watched = (pendingNow === 1 || pendingNow === 0) || videoTask.ok;
        logger.info('ADVANCE', watched ? '当前节已看完（超星已确认）' : '当前节播放结束，但超星未确认视频完成', {
          title: this._currentTitle,
          completed: this.counters.sectionsCompleted,
          pending: pendingNow,
          startedHere,
          videoTask: videoTask.ok ? videoTask.by : 'not-done',
          note: watched
            ? (pendingNow === 0 ? '待办 0（整节完成）'
              : pendingNow === 1 ? '待办 1（视频已完成，剩章节测验）'
              : '按任务点判定视频已完成（待办 ' + pendingNow + '，剩章节测验）')
            : '★ 待办仍为 ' + pendingNow + '，超星未记录视频完成（进度可能未上报）',
        });
        if (!watched) {
          // 服务端没记 → 进度没上报，这一节等于白看。必须让主人知道。
          this.counters.videoNotConfirmed = (this.counters.videoNotConfirmed || 0) + 1;
          /* ★ 2026-10-31 主人要求：出问题的时候**暂停 + 拍快照**。
             先把视频按停，把播放器状态、任务点 DOM、目录待办、整页截图一起落盘，
             再决定要不要重试 —— 这样现场不会被下一步导航冲掉。 */
          if (this.cfg.safety.snapshotOnProblem !== false) {
            await this.captureProblemSnapshot(st, 'video_not_confirmed');
          }
          if (this.cfg.safety.stopOnSnapshot === true) {
            this.stop('video_not_confirmed_snapshot');
            return { progress: false, outcome: 'STOPPED' };
          }
          /* ★ 2026-10-31 真机：3.4 播完（ended，755.4/772.2s=97.8%）但任务点 not-done，
             目录 current 被页面自己拉回上一节 → 跟随 → 再点回来 → 再播完，
             约 27 秒一轮无限重载。连续多次未确认就停，别空转、也别把账号刷成异常画像。
             ★ 只对「同一节」累计：换节就归零，否则正常的多节连播也会被误停。 */
          const titleKey = String(this._currentTitle || '')
          if (this._unconfirmedTitle !== titleKey) {
            this._unconfirmedTitle = titleKey
            this._unconfirmedStreak = 0
          }
          this._unconfirmedStreak = (this._unconfirmedStreak || 0) + 1;
          const maxU = Number(this.cfg.safety.videoNotConfirmedMax) || 0;
          if (maxU > 0 && this._unconfirmedStreak >= maxU) {
            logger.warn('ADVANCE', '连续多次「播放结束但超星未确认」，停止本轮（不再空转）', {
              streak: this._unconfirmedStreak,
              title: this._currentTitle,
              pending: pendingNow,
              sectionCompleted: this.counters.sectionsCompleted,
            });
            this.stop('video_not_confirmed');
            return { progress: false, outcome: 'STOPPED' };
          }
        } else {
          this._unconfirmedStreak = 0;
          this._unconfirmedTitle = '';
        }
        /* ★ 2026-11-15（Issue #1）：本节还有未完成的视频任务点 → 不管本节「当前视频」
           判成什么，都**不允许**切节、也不许 +1 计数。绝不提前跳节。 */
        if (blockAdvance) {
          return { progress: false, outcome: 'WAIT_VIDEO_CONFIRM' };
        }
        // 本章若有「章节测验」标签，先切过去把题答完，再进入下一节
        const quizDone = await this.maybeHandleChapterQuiz(st);
        if (quizDone === 'handled') return { progress: true, outcome: 'CHAPTER_QUIZ_HANDLED' };
        if (quizDone === 'pending') return { progress: true, outcome: 'CHAPTER_QUIZ_PENDING' };
        /* ★ 2026-11-15（Issue #1）：本节所有视频任务点都播过了，才真正算「完成一节」。
           计数挪到真切节之前（以前写在播完那一刻，任务点没播也 +1，上报虚高）。 */
        /* ★ D-064：当前挂载卡片的视频播完 ≠ 本节读完。多卡片节用「并集」再拦一道：
           还有卡片没播完 → 不切节，按「等平台记账」处理（run.js 已豁免，不会误判无进展）。 */
        let unionDone2 = null;
        try { unionDone2 = this._cardsUnionDone(st); } catch (_) { unionDone2 = null; }
        if (unionDone2 === false) {
          logger.info('ADVANCE', '本节仍有其他知识卡片未完成，暂不切节', {
            title: this._currentTitle, cards: this._cardScan ? this._cardScan.size : 0,
          });
          return { progress: false, outcome: 'WAIT_VIDEO_CONFIRM' };
        }
        this._countSectionOutcome();  /* D-073 唯一出口（原 sectionsCompleted += 1） */
        return this.advanceSection(st);
      }
      if (st.video.paused) {
        /* ★ 顺序很重要：先点播放，再判断是不是真卡死。
           视频刚切过去、还没点播放时 readyState 本来就是 0（HAVE_NOTHING，
           元数据未加载），这是**正常状态**不是故障。
           早前把卡死判定放在点播放之前，结果每次切节都误判成「源 403」，
           反而从没点过播放按钮。
           实测：点播放后 readyState 0→4、buffered 出现、进度正常前进。 */
        const r = await this.clickFound(st.video.frameId, 'videoToggle');
        if (r.ok) {
          await this.muteIfPossible(st.video.frameId);
          // 点完等一轮，让播放器去拉流（要拿到元数据才会 readyState 上升）
          await sleep(4000);
          let after = null;
          try {
            const st2 = await this.gatherState();
            after = st2.video;
          } catch (_) { /* ignore */ }
          const nowPlaying = after && after.found &&
            !this._isVideoStalled(after) &&
            (after.readyState >= 2 || (Array.isArray(after.buffered) && after.buffered.length > 0));
          if (nowPlaying) {
            this._resumeAttempts = 0;
            this._stallTicks = 0;
            this._lastProgressTime = undefined;
            logger.info('PLAYING_CHECK', 'P0 视频处于暂停，已恢复播放', {
              layer: r.layer, progress: after.progress, currentTime: after.currentTime,
              readyState: after.readyState, buffered: (after.buffered || []).length,
            });
            return { progress: true, outcome: 'RESUMED' };
          }
          /* 点完还是不动：可能是 CDN 源失效（403）⇒ 重新加载页面取新签名 */
          this._resumeAttempts = (this._resumeAttempts || 0) + 1;
          logger.warn('PLAYING_CHECK', '点了播放但播放器没起来', {
            section: this._currentTitle,
            attempts: this._resumeAttempts,
            readyState: after ? after.readyState : 'unknown',
            buffered: after ? after.buffered : null,
            error: after ? after.error : null,
          });
          if (this._resumeAttempts >= 2) {
            const fixed = await this.reloadForFreshVideo();
            this._resumeAttempts = 0;
            if (fixed) return { progress: true, outcome: 'VIDEO_RELOADED' };
            this.failures += 1;
            logger.warn('PLAYING_CHECK', '视频无法恢复播放，计入失败', {
              section: this._currentTitle, failures: this.failures,
            });
            return { progress: false, outcome: 'VIDEO_STALLED' };
          }
          return { progress: true, outcome: 'RESUME_PENDING' };
        }
        /* ★ 2026-11-22：失败分支原来只打 {layer: r.layer || 0}，把真正的 reason 吞了
           （失败时 r 没有 layer 字段，恒定输出 0），外部无法定位是命中失败/视口外/跨域。
           这里把 reason / note / rect 一并打出来。 */
        logger.warn('PLAYING_CHECK', '恢复播放失败（未找到播放控件）', {
          layer: r && r.layer != null ? r.layer : null,
          reason: (r && r.reason) || null,
          note: (r && r.note) || null,
          rect: (r && r.rect) || null,
        });
        this.failures += 1;
        return { progress: false, outcome: 'RESUME_FAIL' };
      }
      /* ★ 2026-10-29：视频确实在走 ⇒ 登记为「本次运行启动过」。
         之前只在上面的补登记分支加了，这里再兜一层：
         只要 currentTime > 0 就说明播放真实发生，可以放心用 ended 判完成。 */
      if ((st.video.currentTime || 0) > 0) this._markVideoStarted(st.video);
      logger.info('PLAYING', '视频播放中', {
        progress: st.video.progress,
        currentTime: st.video.currentTime,
        duration: st.video.duration,
        section: this._currentTitle,
        /* ★ 播放器进度不等于超星认不认。目录里的 jobUnfinishCount 才是硬证据：
             每节待办 = 视频 + 章节测验 ⇒ 2 → 1 表示「视频已被超星记为看完」。
           把这个数一起打出来，主人随时能看到服务端到底认不认。 */
        pending: this._currentPending(st),
      });
      /* ★ 进度停滞检测：paused=false 但 currentTime 长时间不动 = 缓冲耗尽/源失效。
         这时超星不会自己换签名，必须重新加载页面。 */
      if (this._progressStalled(st.video)) {
        const fixed = await this.reloadForFreshVideo();
        if (fixed) return { progress: true, outcome: 'VIDEO_RELOADED' };
        this.failures += 1;
        logger.warn('PLAYING_CHECK', '进度停滞且重载后仍未恢复，计入失败', {
          section: this._currentTitle, failures: this.failures,
        });
        return { progress: false, outcome: 'VIDEO_STALLED' };
      }
      await humanize.pollDelay(); // 轮询节流：播放期间按 CONFIG 节奏休眠，避免热循环
      return { progress: true, outcome: 'PLAYING' };
    }

    /* —— 无视频：先等待加载，超过阈值按非视频任务点跳过（P3 变体）—— */
    if (!this._videoSeenThisSection && this._waitTicks < this.cfg.safety.maxNoVideoWaitTicks) {
      this._waitTicks += 1;
      logger.info('WAIT_LOAD', '当前节尚未出现视频，等待加载', { tick: this._waitTicks, max: this.cfg.safety.maxNoVideoWaitTicks });
      /* ★ 2026-11-17（D-028）：真机 16.2 实测——点完目录切节后，knowledge/cards iframe
         一直没起来（诊断里 10 个 frame 有 9 个是 about:blank），任务点一个都读不到，
         纯等下去只会撞「连续 9 轮无进展」的防呆。等一半时主动重载当前节页面，等同人工刷新。 */
      await this._kickReloadIfNoTasks();
      await humanize.pollDelay();
      return { progress: false, outcome: 'WAIT_LOAD' };
    }
    if (!this._videoSeenThisSection) {
      /* ★ 2026-10-31：从「硬编码跳过」改成「查任务点注册表」（扩展点 E1）。
         行为完全不变 —— 除 video 外目前没有注册任何 handler，所以一律 skip。
         但未来拿到文档/阅读类的真实样本后，只需 registerHandler('document', fn)，
         不用改这里的主循环。
         见 engine/src/learn/taskpoints.js 顶部「怎么升级」。 */
      const kind = this._currentTaskKind(st);
      const decision = await decideTaskPoint(kind, {
        section: this._currentTitle,
        task: this._currentTask(st),
      });
      logger.warn('ADVANCE', 'WARN 当前任务点无视频（' + kind + '），按注册表决策处理', {
        section: this._currentTitle,
        kind,
        action: decision.action,
        reason: decision.reason,
        layer: st.toc ? st.toc.layer : 0,
      });
      /* ★ 2026-11-16（D-026）：直播回放任务点。
         它没有 <video>、没有 objectid，播放器在独立的 zhibo 标签页里，
         所以绝不复用下面的「无视频 → 跳过/切节」路径，也不复用 play（视频路径
         强依赖同 frame 的 <video> 与 objectid 对齐）。走专用 handler。 */
      if (kind === TASK_KIND.LIVE || decision.action === 'open_live') {
        return await this.handleLiveTask(st);
      }
      if (decision.action === 'wait') {
        /* handler 认为还要等（异步加载的文档常见） */
        await humanize.pollDelay();
        return { progress: true, outcome: 'TASKPOINT_WAIT' };
      }
      this._countSectionOutcome();  /* D-073 唯一出口（原 sectionsSkipped += 1） */
      this._videoSeenThisSection = true; // 防重复跳过
      this.failures = 0;                 // 跳过是有效进展
      return this.advanceSection(st);
    }

    /* —— 视频曾经出现又消失：★ D-073 要区分三种情形，不能一律当异常 —— */
    /* (a) 刚切过知识卡片：旧卡的 DOM/frame 被换掉，视频元素必然「消失」，这是预期的 */
    if (this._recentlySwitchedCard()) {
      logger.info('PLAYING_CHECK', '刚切过知识卡片，视频消失属预期（豁免失败计数）', {
        msSinceSwitch: this._cardSwitchAt ? (Date.now() - this._cardSwitchAt) : null,
      });
      return { progress: true, outcome: 'CARD_SWITCH_SETTLE' };
    }
    /* (b) 当前卡本来就没有目标视频（如「教学课件」卡）：不是异常，交回卡片驱动 */
    if (this._currentCardHasNoTargetVideo(st)) {
      logger.info('ADVANCE', '当前知识卡片没有目标视频任务点，交回卡片驱动（不判本节）', {
        title: this._currentTitle,
      });
      return { progress: true, outcome: 'CARD_NO_TARGET_VIDEO' };
    }
    /* (c) 真的异常 */
    this.failures += 1;
    logger.warn('PLAYING_CHECK', '视频元素消失', { failures: this.failures });
    return { progress: false, outcome: 'VIDEO_GONE' };
  }

  /**
   * AI 作答：题干 + 选项交给模型，返回选项索引；失败或未配置返回 -1。
   *
   * 两条通路：
   *   1) CX_LLM_ASK_URL —— 回调宿主（DSH 插件）端点，用 DSH 已配置的模型
   *      （含 our-free-model 的免费模型）。这是主通路。
   *   2) CX_LLM_BASE/CX_LLM_KEY —— 直连 OpenAI 兼容接口（插件内置智谱模型）。
   */
  /**
   * 向模型问一道题。
   *
   * @param {string} question 题干文本（超星是密文，仅作兜底）
   * @param {Array} options   选项 [{i, letter, label}]
   * @param {string} imageB64  该题的截图 base64（PNG）。超星题干是加密字体，
   *                          DOM 读出来是密文，只有截图才是明文——有图就以图为准。
   */
  async askAI(question, options, imageB64, kind) {
    const askUrl = process.env.CX_LLM_ASK_URL || '';
    const base = process.env.CX_LLM_BASE || '';
    const key = process.env.CX_LLM_KEY || '';
    const envModel = process.env.CX_LLM_MODEL || '';
    if (!options || !options.length) return -1;
    if (!askUrl && !(base && key && envModel)) return -1;

    /* 决策层已抽到 engine/src/core/ai.js：这里只提供可插拔 transport，
       范围锁 / prompt 构造 / 严格解析 / 审计 全部交给 ai.decide()。
       ai 模块只返回选项下标，永不碰页面；点选与提交仍在本状态机原逻辑。 */
    const cfgAi = (this.cfg && this.cfg.ai) || {};
    const timeoutMs = Number(cfgAi.timeoutMs) > 0 ? Number(cfgAi.timeoutMs) : 20000;

    /* transport 抽到 _aiTransport()，与 askAIBatch 共用同一套通路 */
    const transport = this._aiTransport(timeoutMs);

    const r = await aiCore.decide({
      kind: kind || '',
      question,
      options,
      image: imageB64 || '',
      cfg: { ai: cfgAi },
      transport,
    });
    if (r && !r.ok && r.code) {
      logger.warn('QUIZ', 'AI 未给出可用答案，回退原逻辑', { code: r.code, model: r.model, ms: r.ms });
    }
    return r && r.ok && r.index >= 0 ? r.index : -1;
  }

  /**
   * 构造「模型传输层」——`askAI`（逐题）与 `askAIBatch`（批量）共用同一套通路。
   *
   * 两条通路（与旧 askAI 内联实现完全一致，行为不变）：
   *   1) CX_LLM_ASK_URL —— 回调宿主（DSH 插件）端点，用 DSH 已配置的模型
   *   2) CX_LLM_BASE/CX_LLM_KEY —— 直连 OpenAI 兼容接口
   *
   * transport 只负责「把 prompt 送出去、把文本拿回来」，返回值固定为
   * `{ok:true, text, model}`；失败抛错，由 ai.js 的 decide/decideBatch 统一重试/判错。
   * **不做任何题目推理**（决策层在 engine/src/core/ai.js）。
   *
   * @param {number} timeoutMs 单次请求超时
   * @param {number} [maxTokens] 直连通路的 max_tokens；缺省 16（逐题只回一个字母）
   */
  _aiTransport(timeoutMs, maxTokens) {
    /* ★ D-065：传输层改为「provider 注册表 + 回退链」（engine/src/core/ai-providers.js）。
       原来这里是写死的两个 if 分支（宿主回调 / 直连），加供应商要改本函数本体；
       现在只按配置挑通道，新增供应商用 aiProviders.registerProvider() 注册即可。
       契约不变：({prompt,image}) → {ok,text,model,by}；全部通道失败才抛错。 */
    const cfgAi = (this.cfg && this.cfg.ai) || {};
    return aiProviders.createTransport({
      env: process.env,
      cfgAi,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined,
      maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : undefined,
    });
  }
  /**
   * 批量作答：一次把一批题投给模型，拿回「每题选哪个下标」。
   *
   * 边界（与 askAI 同宗）：
   *   - 本方法**只做传输**，prompt 拼装 / 严格解析 / 范围校验 全在
   *     `engine/src/core/ai.js` 的 `decideBatch()`，本层绝不推理「题目 → 字母」。
   *   - **不碰页面**：点选与保存/提交仍由 handleQuiz 原逻辑执行。
   *
   * @param {Array<{id,type,question,options}>} items 一批题
   * @returns {Promise<null|{ok:true,answers,unresolved,dropped,model,ms}>}
   *   未配置模型环境 或 异常 → null（调用方据此回退逐题）
   */
  async askAIBatch(items) {
    const askUrl = process.env.CX_LLM_ASK_URL || '';
    const base = process.env.CX_LLM_BASE || '';
    const key = process.env.CX_LLM_KEY || '';
    const envModel = process.env.CX_LLM_MODEL || '';
    /* 环境判据与 askAI 完全一致：两条通路二者其一即可，都没有就只能逐题 */
    if (!Array.isArray(items) || !items.length) return null;
    if (!askUrl && !(base && key && envModel)) return null;

    const cfgAi = (this.cfg && this.cfg.ai) || {};
    const timeoutMs = Number(cfgAi.timeoutMs) > 0 ? Number(cfgAi.timeoutMs) : 20000;
    try {
      /* 批量一次要回多条 JSON，max_tokens 不能按逐题的 16 卡死 */
      const transport = this._aiTransport(timeoutMs, 1024);
      const r = await aiCore.decideBatch({ items, cfg: { ai: cfgAi }, transport });
      return r;
    } catch (e) {
      logger.warn('AI', '批量答题失败', { err: String((e && e.message) || e).slice(0, 120) });
      return null;
    }
  }

  /**
   * 章内「章节测验」处理。
   *
   * 学习通每看完一节视频，本章往往还有一个「章节测验」子任务（在 .prev_ul 里，
   * 标题含「章节测验」）。题目并不在顶层页面，而是按需加载进 popFrameId iframe
   * （平时是 about:blank 空页），所以必须先点开标签页、等题目加载，再交给
   * handleQuiz 作答。
   *
   * @returns {'handled'|'none'|'pending'|'skipped'}
   *   handled = 已作答（含人工模式暂停）；none = 本章无测验；pending = 正在等题目加载
   */
  /**
   * 取当前节所属的章标题（目录里最后一个 chapterHeader 且位于当前项之前）。
   * 章节测验是「章级」子任务，同一章的多节共用同一个测验入口，
   * 所以去重必须按章而不是按节。
   */
  currentChapterTitle(st) {
    const toc = st && st.toc;
    const items = (toc && toc.items) || [];
    if (!items.length) return this._currentTitle;
    let curIdx = items.findIndex((x) => x.current);
    if (curIdx < 0 && this._lastCurIdx != null && this._lastCurIdx >= 0) curIdx = this._lastCurIdx;
    if (curIdx < 0) curIdx = 0;
    let chapter = '';
    for (let i = 0; i <= curIdx && i < items.length; i++) {
      if (items[i].chapterHeader) chapter = items[i].title;
    }
    return chapter || ('§' + curIdx);
  }

  /**
   * 章节测验处理策略（唯一判定入口）。
   *   'skip'   完全不碰
   *   'save'   作答后只点「保存」存草稿，绝不交卷（默认）
   *   'submit' 作答后真交卷（必须主人明确打开）
   *   'none'   只填选项，不点任何按钮
   *
   * 优先级：CX_QUIZ_MODE（宿主/CLI 显式下传，宿主配置 chapterQuiz 的镜像）
   *        → 配置文件 safety.answerChapterQuiz / chapterQuizSubmitMode
   *        → 'save'
   * 说明：引擎与宿主不是同一个进程，引擎读不到宿主的 state/config.json，
   *       所以宿主必须用环境变量把策略传下来；直接跑引擎时才用配置默认值。
   * @returns {'skip'|'save'|'submit'|'none'}
   */
  _chapterQuizMode() {
    const env = String(process.env.CX_QUIZ_MODE || '').toLowerCase();
    if (env === 'skip' || env === 'save' || env === 'submit' || env === 'none') return env;
    const s = (this.cfg && this.cfg.safety) || {};
    if (s.skipChapterQuiz === true) return 'skip';
    if (s.answerChapterQuiz === true) {
      const m = String(s.chapterQuizSubmitMode || 'save').toLowerCase();
      if (m === 'submit' || m === 'save' || m === 'none') return m;
      return 'save';
    }
    return 'save';
  }

  async maybeHandleChapterQuiz(st) {
    /* ★★★ 2026-10-31 修：开关只认配置，不再读环境变量 ★★★
       原实现是：
           if (String(process.env.CX_QUIZ_MODE || '') === 'skip') return 'none';
       宿主 index.js 每次 spawn 都设 CX_QUIZ_MODE=skip，所以**插件跑时**安全；
       但直接 `node engine/chaoxing-autolearn.js --mode=...`（README 教的用法）
       这个变量是空的 → 条件不成立 → 继续往下 → **点开章节测验标签**。
       同一个引擎两种入口两种行为，这是最容易出事的那种不一致。

       现在只认配置 safety.skipChapterQuiz（默认 true），与入口无关。 */
    if (this._chapterQuizMode() === 'skip') {
      return 'none';
    }
    // 本章已处理过测验 → 不重复（测验是章级任务，同章多节共用）
    const chapter = this.currentChapterTitle(st);
    if (this._quizTabDoneFor === chapter) return 'none';
    const tab = st.quizTab;
    if (!tab || !tab.present) return 'none';

    // 还没点开过测验标签 → 点它
    const r = await this.clickFound(tab.frameId, 'quizTab');
    if (!r.ok) {
      logger.warn('QUIZTAB', '章节测验标签点击失败，跳过本章测验', { reason: r.reason, title: tab.title, chapter });
      this._quizTabDoneFor = chapter;
      return 'none';
    }
    this._quizTabOpened = true;
    this._quizTabWaitTicks = 0;
    this._quizTabChapter = chapter;
    logger.info('QUIZTAB', '已切换到章节测验，等待题目加载', { title: tab.title, chapter, layer: r.layer });
    return 'pending';
  }

  /**
   * 已切到章节测验标签后的续作：等题目加载出来。
   * 作答由主 tick 的 P2 分支完成（题目出现时会被 st.quiz 捕获）。
   * @returns {'handled'|'pending'}
   */
  async continueChapterQuiz() {
    if (this._quizTabWaitTicks < this.cfg.safety.maxLoadRetries) {
      this._quizTabWaitTicks += 1;
      await humanize.pollDelay();
      /* 已提交过的章节测验：作业页会跳到「批阅页」selectWorkQuestionYiPiYue，
         页面里没有题目可答。这种情况不是「加载失败」，而是「本测验已完成」，
         必须识别出来，否则会一直等到超时，再因为切不回视频标签而误判成页面异常。 */
      if (await this.quizAlreadySubmitted()) {
        logger.info('QUIZTAB', '检测到该章节测验此前已提交（批阅页），跳过作答', { chapter: this._quizTabChapter || this._currentTitle });
        this._quizTabDoneFor = this._quizTabChapter || this._currentTitle;
        this._quizTabOpened = false;
        this._quizTabWaitTicks = 0;
        await this.switchBackToVideoTabAnyFrame(this._lastState);
        return 'handled';
      }
      const q = await this.findQuizInFrames();
      if (!q) {
        logger.info('QUIZTAB', '章节测验题目尚未加载，继续等待', { tick: this._quizTabWaitTicks, max: this.cfg.safety.maxLoadRetries });
        return 'pending';
      }
      logger.info('QUIZTAB', '章节测验题目已就绪', { options: (q.options || []).length });
      return 'handled';
    }
    logger.warn('QUIZTAB', '章节测验题目加载超时，跳过', { chapter: this._quizTabChapter || this._currentTitle });
    this._quizTabDoneFor = this._quizTabChapter || this._currentTitle;
    this._quizTabOpened = false;
    /* ★ 必须切回视频标签：停留在测验标签上视频区已被替换，
       主循环下一轮会看到「视频元素消失」，连续 3 次就误判成页面异常而 FATAL。 */
    await this.switchBackToVideoTabAnyFrame(this._lastState);
    return 'handled';
  }

  /**
   * 判断当前章节测验是否「此前已提交」。
   *
   * 超星作业已提交后，作业 frame 会跳到批阅页：
   *   /mooc-ans/work/selectWorkQuestionYiPiYue?...
   * 该页没有 .TiMu.newTiMu 题块，所以「找不到题目」不等于「加载失败」。
   */
  async quizAlreadySubmitted() {
    const adapter = this.adapter;
    let frames = [];
    try { frames = await adapter.getFrameDocuments(); } catch (_) { return false; }
    for (const f of frames) {
      const u = String(f.url || '');
      if (/selectWorkQuestion|workAnswerDetail/i.test(u)) return true;
    }
    return false;
  }

  /**
   * 答完章节测验后切回「视频」标签。
   * 学习通同一章内，「1视频 / 2章节测验」是并列标签；停留在测验标签上，
   * 视频元素不存在 → 主循环会把本节误判成「非视频任务点」直接跳过。
   */
  async switchBackToVideoTab(st) {
    try {
      const tab = st && st.quizTab;
      const frameId = (tab && tab.frameId) || (st && st.frames && st.frames[0] && st.frames[0].frameId);
      if (!frameId) return false;
      const r = await this.clickFound(frameId, 'videoTab');
      if (r.ok) {
        logger.info('QUIZTAB', '已切回视频标签', { layer: r.layer });
        await humanize.sectionCooldown();
        this._videoSeenThisSection = false;
        this._waitTicks = 0;
        return true;
      }
      logger.warn('QUIZTAB', '切回视频标签失败', { reason: r.reason });
    } catch (e) {
      logger.warn('QUIZTAB', '切回视频标签异常', { err: String((e && e.message) || e).slice(0, 120) });
    }
    return false;
  }

  /**
   * 在所有 frame 里找「视频」标签并点回。
   *
   * 「1视频 / 2章节测验」这组标签在 .prev_ul 里，属于章内子任务列表 ——
   * 实测它既可能出现在顶层 frame，也可能出现在内容 frame，
   * 所以不能只盯着 st.quizTab.frameId 一个 frame 找。
   */
  async switchBackToVideoTabAnyFrame(st) {
    const adapter = this.adapter;
    let frames = [];
    try { frames = await adapter.getFrameDocuments(); } catch (_) { frames = []; }
    const inst = installProbeExpression(this.cfg);
    const order = [];
    const tb = st && st.quizTab && st.quizTab.frameId;
    if (tb) order.push(frames.find((f) => f.frameId === tb));
    for (const f of frames) if (!order.includes(f)) order.push(f);
    for (const f of order) {
      if (!f) continue;
      if (f.url && /^about:blank/.test(f.url)) continue;
      try {
        await adapter.evalInFrame(f.frameId, inst);
        const hit = await adapter.evalInFrame(f.frameId, '__cx.find("videoTab",null)');
        if (!hit || !hit.ok) continue;
        const r = await this.clickFound(f.frameId, 'videoTab');
        if (r.ok) {
          logger.info('QUIZTAB', '已切回视频标签', { layer: r.layer, frameId: f.frameId.slice(0, 10), note: r.note });
          await humanize.sectionCooldown();
          this._videoSeenThisSection = false;
          this._waitTicks = 0;
          return true;
        }
      } catch (_) { /* 该 frame 不可达就跳过 */ }
    }
    logger.warn('QUIZTAB', '未能在任何 frame 找到「视频」标签');
    return false;
  }

  /** 在所有 frame 里找可解析的题目（测验页加载后题目在 popFrameId 内） */
  async findQuizInFrames() {
    const frames = await this.adapter.getFrameDocuments();
    const inst = installProbeExpression(this.cfg);
    for (const f of frames) {
      if (f.url && /^about:blank/.test(f.url)) continue;
      try {
        await this.adapter.evalInFrame(f.frameId, inst);
        const probe = await this.adapter.evalInFrame(f.frameId, '__cx.probeAll()');
        const q = probe && probe.quiz;
        if (q && q.present && q.parseable && (q.options || []).length) {
          return Object.assign({}, q, { frameId: f.frameId });
        }
      } catch (_) { /* 该 frame 不可达就跳过 */ }
    }
    return null;
  }

  /** 只读输出题目事件；此方法不截图、不调用模型、不点击页面。 */
  emitDetectedQuestions(q, meta) {
    if (!q || !q.present) return [];
    const blocks = q.blocks && q.blocks.length ? q.blocks : [{ question: q.question, options: q.options, kind: q.kind }];
    const out = [];
    for (const block of blocks) {
      const options = (block.options || []).map((o) => ({
        i: Number(o.i) || 0,
        letter: String(o.letter || ''),
        label: String(o.label || '').slice(0, 240),
      }));
      const event = {
        kind: String(meta && meta.kind || q.kind || 'unknown'),
        source: String(meta && meta.source || 'page'),
        question: String(block.question || q.question || '').slice(0, 1000),
        options,
        frameId: String(q.frameId || ''),
        chapterTitle: String(this._currentTitle || '').slice(0, 160),
        videoTime: meta && Number.isFinite(meta.videoTime) ? meta.videoTime : null,
        duration: meta && Number.isFinite(meta.duration) ? meta.duration : null,
        pageUrl: String(this._lastState && this._lastState.topUrl || '').slice(0, 300),
      };
      const id = emitQuestionEvent(event);
      if (id) out.push(id);
    }
    return out;
  }

  /**
   * P2.5：随堂弹题（视频内嵌 ans-videoquiz）。
   *
   * 超星视频播到某个时间点会弹出一道题并强制暂停。DOM（实测）：
   *   .ans-videoquiz → .tkItem_title（题干）+ li.ans-videoquiz-opt（选项，radio value 空串，答案在文本）
   *   + #videoquiz-submit（提交）+ #videoquiz-continue（答对后点它视频才继续）
   *   + #spanHas（回答正确）/ #spanNot（回答错误）
   *
   * 流程：答对 → 点「继续」→ 视频恢复；答错 → 超星会回看（可能要求重看一段）。
   * 这道题的题干是**明文**（不是章节测验的加密字体），所以可以直接读文本作答。
   */
  handleVideoQuiz(st) {
    return Promise.resolve().then(async () => {
      const vq = st.videoQuiz;
      if (!vq || !vq.present) return { progress: false, outcome: 'VIDEO_QUIZ_NONE' };
      const frameId = vq.frameId;
      const duration = Number(st.video && st.video.duration) || 0;
      const currentTime = Number(st.video && st.video.currentTime) || 0;
      const durationKnown = duration > 0;
      /* ★★ 2026-10-30 放宽「播放上下文」判据 ★★
         原判据要求 _videoProgressTicks > 0（本轮亲眼看到进度推进）。
         实测（FNOS run.log 11:59:26→11:59:28）：从目录点进 1.3 后，播放器把
         **上次的 254 秒位置**恢复出来，随堂题同时在 254 秒处弹出 ——
         本轮一帧都还没推进，progressedTicks 恒为 0，于是被判「证据不足」→
         整轮以 quiz_unclassified_needs_human 停机。视频时间轴停在半途
         （0 < currentTime < duration）本身就是「这段视频真的播放过」的铁证，
         再加上「弹题与播放器在同一个 frame」和「时长已知」，足以确认是视频内随堂题。

         仍然拒绝的场景（保持原来的安全边界）：
           · 没有播放器 / 播放器在别的 frame（章节测验在独立作业页）
           · 拿不到 duration（页面还没加载完）
           · currentTime 与进度都没动过（可能是别的弹层被误判）*/
      const sameFramePlayer = !!(st.video && st.video.found && durationKnown && st.videoFrameId === frameId);
      const resumedMidVideo = currentTime > 0.5;
      const hasPlaybackContext = sameFramePlayer && (this._videoProgressTicks > 0 || resumedMidVideo);

      /* ★★★ 2026-10-30 主人指令：删掉「识别不出来就停」的兜底 ★★★
         这里原来会 this.stop('quiz_unclassified_needs_human') 把整轮运行停掉。
         实测代价太大：1.3 播放器续播到 254 秒时，随堂题面板一挂上，
         本轮 progressedTicks 还是 0，就被判「证据不足」整体停机 ——
         一节视频没看完，整门课都不跑了，比「点错一个不计分的随堂题」严重得多。

         现在改成：证据不足只记一条 WARN，**照常走随堂题盲试**。
         安全性由三件事保证，停机不再是必需：
           · 只处理 .ans-videoquiz（视频内嵌题），绝不碰 .TiMu（章节测验，计成绩）；
           · 「答错且要求回看」（#spanNotBack / 面板文本含回看）→ 仍然立即停；
           · 面板「剩余 N 次」耗尽 → 仍然立即停。 */
      if (!hasPlaybackContext) {
        logger.warn('QUIZ', '视频题证据不足，仍按随堂题处理（不再整体停机）', {
          frameId, videoFrameId: st.videoFrameId, duration, currentTime, sameFramePlayer,
          progressedTicks: this._videoProgressTicks,
        });
      } else {
        this._videoQuizObserveTicks = 0;
      }

      const eventIds = this.emitDetectedQuestions({
        ...vq,
        question: vq.title,
        frameId,
      }, {
        kind: 'video_embedded_quiz',
        source: 'video',
        videoTime: currentTime,
        duration,
      });
      logger.warn('QUIZ', '已根据播放器上下文识别为视频内随堂题', {
        title: (vq.title || '').slice(0, 50), duration, currentTime, eventIds,
        options: (vq.options || []).map((o) => o.label).join(' | '),
        remaining: vq.remaining, wrongBack: vq.wrongBack, correct: vq.correct,
      });

      /* ★★★ 盲试作答（2026-10-27 主人要求）★★★
         原话：「判断题你能不能在不用 ai 的情况下完成，他不会影响我的成绩，
                打错了，换个答案，一直到答对就可以看了」

         依据（实测 + 参考项目 xuexitong-ai-assistant 的 video-quiz.js）：
           1. 随堂题不计入课程成绩，答错只影响本次播放；
           2. #spanNotBack「回答错误，回看 N 分钟」出现时会被要求回看 → 必须立即停；
           3. 面板有「剩余 N 次」→ 次数耗尽前可以换答案重试。

         策略：按选项顺序逐个试 → 提交 → 读反馈
           答对(#spanHas)/继续可见 → 点「继续」恢复播放
           答错且无回看惩罚        → 换下一个选项重试
           答错且要求回看          → 停止（不硬试）
           剩余次数为 0            → 停止

         ★ 安全边界：只处理 .ans-videoquiz（视频内随堂题）。
           绝不触碰 .TiMu（章节测验/作业，计入成绩）。 */
      const optCount = Array.isArray(vq.options) ? vq.options.length : 0;
      if (!optCount) {
        logger.warn('QUIZ', '随堂题没有可读选项，停止', { title: (vq.title || '').slice(0, 40) });
        this.stop('video_quiz_no_options');
        return { progress: false, outcome: 'VIDEO_QUIZ_NO_OPTIONS' };
      }
      if (vq.wrongBack) {
        logger.warn('QUIZ', '随堂题答错且要求回看，停止盲试（避免回看惩罚）', {
          panelText: String(vq.panelText || '').slice(0, 100),
        });
        this.stop('video_quiz_review_required');
        return { progress: false, outcome: 'VIDEO_QUIZ_REVIEW_REQUIRED' };
      }
      if (typeof vq.remaining === 'number' && vq.remaining <= 0) {
        logger.warn('QUIZ', '随堂题剩余次数已用尽，停止', { remaining: vq.remaining });
        this.stop('video_quiz_no_attempts_left');
        return { progress: false, outcome: 'VIDEO_QUIZ_NO_ATTEMPTS' };
      }

      // 已答对：直接点「继续」
      if (vq.correct || vq.continueVisible) {
        logger.info('QUIZ', '随堂题已答对，点「继续」恢复播放', { eventIds });
        await this.clickFound(frameId, 'videoQuizContinue');
        this._videoProgressTicks = 0;
        return { progress: true, outcome: 'VIDEO_QUIZ_CONTINUED' };
      }

      /* 盲试：按顺序尝试没试过的选项。每轮都重新读真实反馈。 */
      const qkey = String(vq.title || '').slice(0, 60);
      if (this._videoQuizKey !== qkey) { this._videoQuizKey = qkey; this._videoQuizTried = new Set(); }
      const tried = this._videoQuizTried;

      /* ★ 视频随堂题**永不**用 AI（主人 2026-11-15 定）：
         随堂题不计入课程成绩，用模型判断纯属浪费资源，还会拖慢播放。
         这里固定「按 A→B→C 顺序盲试直到答对」，不再读 cfg.ai / CX_LLM_*。
         AI 只服务章节测验（见 handleQuiz / AI_SCOPE.chapterQuiz）。 */
      const order = [];
      for (let i = 0; i < optCount; i++) order.push(i);

      for (const i of order) {
        if (tried.has(i)) continue;
        tried.add(i);
        logger.info('QUIZ', '随堂题盲试选项 ' + (i + 1) + '/' + optCount, {
          title: qkey.slice(0, 40), option: (vq.options[i] || {}).label,
        });
        // 1) 点选项（find() 期望 arg 是数字下标，不是对象）
        const picked = await this.clickFound(frameId, 'videoQuizOption', i);
        if (!picked || !picked.ok) { logger.warn('QUIZ', '选项点击失败', { i, reason: picked && picked.reason }); continue; }
        await humanize.pollDelay();
        // 2) 提交
        const sub = await this.clickFound(frameId, 'videoQuizSubmit');
        if (!sub || !sub.ok) { logger.warn('QUIZ', '提交点击失败', { i, reason: sub && sub.reason }); continue; }
        // 3) 等反馈（最多约 10 秒）
        let fb = null;
        for (let w = 0; w < 10; w++) {
          await humanize.pollDelay();
          const sc = await this.gatherState();
          fb = sc && sc.videoQuiz;
          if (!fb || !fb.present) break;
          if (fb.correct || fb.continueVisible || fb.wrong || fb.wrongBack) break;
        }
        if (!fb || !fb.present) {
          logger.info('QUIZ', '提交后弹题消失，视为已通过');
          this.counters.quizzesAnswered += 1;   // 随堂题已答（计入统计）
          this._videoQuizTried = null; this._videoQuizKey = null; this._videoQuizAiForKey = null;
          return { progress: true, outcome: 'VIDEO_QUIZ_PASSED' };
        }
        if (fb.correct || fb.continueVisible) {
          logger.info('QUIZ', '随堂题答对了，点「继续」恢复播放', { option: i });
          await this.clickFound(frameId, 'videoQuizContinue');
          this.counters.quizzesAnswered += 1;   // 随堂题已答（计入统计）
          this._videoQuizTried = null; this._videoQuizKey = null; this._videoQuizAiForKey = null;
          this._videoProgressTicks = 0;
          return { progress: true, outcome: 'VIDEO_QUIZ_CORRECT' };
        }
        if (fb.wrongBack) {
          logger.warn('QUIZ', '答错且要求回看，停止盲试', { option: i, panelText: String(fb.panelText || '').slice(0, 80) });
          this.stop('video_quiz_review_required');
          return { progress: false, outcome: 'VIDEO_QUIZ_REVIEW_REQUIRED' };
        }
        if (typeof fb.remaining === 'number' && fb.remaining <= 0) {
          logger.warn('QUIZ', '剩余次数用尽，停止盲试', { option: i });
          this.stop('video_quiz_no_attempts_left');
          return { progress: false, outcome: 'VIDEO_QUIZ_NO_ATTEMPTS' };
        }
        logger.info('QUIZ', '答错了，换下一个选项继续试', { option: i, remaining: fb.remaining });
      }

      logger.warn('QUIZ', '所有选项都试过仍未答对，转人工', { title: qkey.slice(0, 40) });
      this.stop('video_quiz_exhausted');
      return { progress: false, outcome: 'VIDEO_QUIZ_EXHAUSTED' };

    });
  }

  /**
   * P2：弹题/章节测验作答。
   *
   * 学习通「章节测验」是一整个作业页（.TiMu.newTiMu × N），不是一题一弹窗。
   * 早期版本只处理第一题就提交 → 提交必然失败 → 作业永不完成 →
   * 目录里的 jobUnfinishCount 恒 >0 → 每轮都从第一章重新开始（主人报的核心症状）。
   *
   * 现在：遍历全部题块 → 每题截图（题干是加密字体，只有图才是明文）→ 逐题作答 →
   * 全部答完再点提交。
   */
  handleQuiz(st) {
    return Promise.resolve().then(async () => {
      const q = st && st.quiz;
      if (!q || !q.present) return { progress: false, outcome: 'QUIZ_NONE' };
      const blocks = q.blocks || [];
      const isWorkPage = q.kind === 'chapter_work' || blocks.length > 0;
      /* 本章测验本轮已作答/已保存过 → 不再答第二遍（只针对作业页，随堂弹题不走这条）。
         没有这个闸门，保存后页面停在原处，每轮都会重新点一遍选项。 */
      if (isWorkPage) {
        const chapterKey = this.currentChapterTitle(st);
        if (this._quizFilledFor && this._quizFilledFor === chapterKey) {
          this._quizTabDoneFor = chapterKey;
          return { progress: true, outcome: 'QUIZ_ALREADY_HANDLED' };
        }
      }
      /* 作业页（章节测验）走配置策略：save / submit / none / skip。
         非作业页（页面里的泛化弹层）**没有「保存」可点**，只能沿用旧语义：
         CX_QUIZ_MODE=ai 时才作答并提交，否则一律忽略（不点任何东西）。 */
      const legacyAi = String(process.env.CX_QUIZ_MODE || '') === 'ai';
      let quizMode = isWorkPage ? this._chapterQuizMode() : (legacyAi ? 'submit' : 'skip');
      /* ★★★ 2026-11-18 主人指令（D-038）：**没有 AI 通道 = 直接不答**。
         主人原话：「没配 AI 通道时，就是 ai 按钮是关的，直接不答，同理 ai 失效时
         就是 == 没开 ai」。所以「没配 AI」与「AI 挂了」走同一条路：不点任何选项，
         按 skip 语义记录题目并继续下一节，把题留给人工。
         （以前没配 AI 会按首个选项填草稿 —— 那也是猜，记分的题上等于扣分。） */
      const aiAvail = !!(process.env.CX_LLM_ASK_URL || process.env.CX_LLM_MODEL);
      if (isWorkPage && quizMode !== 'skip' && !aiAvail) {
        logger.warn('QUIZ', '没有 AI 通道，章节测验直接不答（按 skip 处理，留空给人工）', {
          quizMode, note: '启用 AI（ai.enabled=true）后才会自动作答',
        });
        quizMode = 'skip';
      }
      if (quizMode === 'skip' || quizMode === 'manual') {
        const eventIds = this.emitDetectedQuestions(q, {
          kind: q.kind || 'popup_quiz',
          source: q.kind === 'chapter_work' ? 'chapter_work' : 'popup',
        });
        /* ★★★ 2026-10-28 主人需求：遇到章节测验 → 不答题，**跳过并进入下一节继续看视频** ★★★
           原行为：stop('quiz_needs_human') 整个流程停下来等人。
           新行为：记录题目事件后，把当前节标记为「已完成（视频部分）」，
                   直接 advanceSection 切到下一节继续播放。

           为什么可以这样做：
             · 章节测验（.TiMu / chapter_work）计入成绩，绝不能自动作答；
             · 但视频任务点此时已完成（超星已确认 completed），
               留着不动只会让整个流程卡死在这一节；
             · 跳过测验不答 = 该节得分不变差，只是不拿这部分的分数，
               与主人「课后题一定不要做」的要求一致。

           安全：只跳过，不点任何题目的选项/提交按钮。 */
        const isChapterWork = q.kind === 'chapter_work' || blocks.length > 0;
        /* 走到这里说明 quizMode 已被判成 'skip'（要么配置显式 skip，要么不是作业页）。
           作业页 = 章节测验，按策略跳过并切下一节；非作业页走下面的「忽略继续」。 */
        if (isChapterWork) {
          logger.warn('QUIZ', '章节测验：按安全策略跳过（不答题），继续下一节看视频', {
            kind: q.kind || 'unknown',
            question: (q.question || '').slice(0, 60),
            blockCount: blocks.length,
            eventIds,
          });
          this.counters.quizzesSkipped = (this.counters.quizzesSkipped || 0) + 1;
          // 标记本节已处理，避免 advanceSection 之后又被拉回来
          this._videoSeenThisSection = true;
          this.failures = 0;   // 跳过是有效进展
          return this.advanceSection(st);
        }
        /* ★★★ 2026-10-30 主人指令：不再因为「识别不出来」就停整轮 ★★★
           只看视频模式下遇到的是泛化弹层（不是 .TiMu 章节测验）时，
           原来 stop('quiz_needs_human') 直接停机。改成：忽略它、继续跑。
           防止无限空转：连续忽略 _quizIgnoreMax 次后，当作本节没东西可看，切下一节。 */
        this._quizIgnoreTicks = (this._quizIgnoreTicks || 0) + 1;
        logger.warn('QUIZ', '只看视频模式：已记录题目，忽略该弹层继续（不再停机）', {
          kind: q.kind || 'unknown', question: (q.question || '').slice(0, 80),
          blockCount: blocks.length, eventIds, ignored: this._quizIgnoreTicks,
        });
        if (this._quizIgnoreTicks >= (this.cfg.safety.quizIgnoreMax || 12)) {
          this._quizIgnoreTicks = 0;
          logger.warn('QUIZ', '同一弹层连续忽略次数过多，按「本节无视频可看」处理，切下一节', {
            section: this._currentTitle,
          });
          this._videoSeenThisSection = true;
          this.failures = 0;
          return this.advanceSection(st);
        }
        await humanize.pollDelay();
        return { progress: true, outcome: 'QUIZ_IGNORED' };
      }

      if (!q.parseable || !(q.options || []).length) {
        /* 同上：结构解析不出来也不能停整轮。忽略 + 连续太多次才切下一节。 */
        this._quizIgnoreTicks = (this._quizIgnoreTicks || 0) + 1;
        logger.warn('QUIZ', '题目结构无法识别，忽略并不做任何点击（不再停机）', {
          kind: q.kind || 'unknown', frameId: q.frameId, layer: q.layer,
          question: (q.question || '').slice(0, 60), ignored: this._quizIgnoreTicks,
        });
        if (this._quizIgnoreTicks >= (this.cfg.safety.quizIgnoreMax || 12)) {
          this._quizIgnoreTicks = 0;
          this._videoSeenThisSection = true;
          this.failures = 0;
          return this.advanceSection(st);
        }
        await humanize.pollDelay();
        return { progress: true, outcome: 'QUIZ_UNCLASSIFIED_IGNORED' };
      }
      this._quizIgnoreTicks = 0;
      const useAi = !!(process.env.CX_LLM_ASK_URL || process.env.CX_LLM_MODEL);

      /* —— 批量作答（v2，见 docs/AI-ANSWER-FRAMEWORK.md §14）——
         只在「作业页 + 有多题 + batchSize>1」时开启；任何一片失败/缺答案
         都退回下面的逐题 askAI，绝不因此中断整卷。
         batchSize 未配置时 batchOn=false，行为与旧版逐题完全一致。 */
      const aiCfg = (this.cfg && this.cfg.ai) || {};
      const batchSize = Math.max(1, Number(aiCfg.batchSize) || 1);
      const batchOn = useAi && isWorkPage && blocks.length > 1 && batchSize > 1;
      const batchIdx = {};   // blockIndex -> 0基选项下标
      if (batchOn) {
        const picks = [];
        for (let bi = 0; bi < blocks.length; bi++) {
          const b = blocks[bi] || {};
          const opts = Array.isArray(b.options) ? b.options : [];
          if (!opts.length) continue;
          const kindTxt = String(b.kind || '').toLowerCase();
          picks.push({
            blockIndex: bi,
            item: {
              id: 'q' + (bi + 1),
              kind: 'chapter_work',
              type: kindTxt.indexOf('multi') >= 0 ? 'multi' : (/true\s*or\s*false|判断/i.test(String(b.question || '')) ? 'judge' : 'single'),
              question: String(b.question || '').slice(0, 500),
              options: opts.map(function (o, k) { return { letter: (o && o.letter) || String.fromCharCode(65 + k), label: String((o && o.label) || '').slice(0, 300) }; }),
            },
          });
        }
        for (let s = 0; s < picks.length; s += batchSize) {
          const slice = picks.slice(s, s + batchSize);
          const r = await this.askAIBatch(slice.map(function (p) { return p.item; }));
          if (!r || r.ok !== true) { logger.warn('AI', '批量作答不可用，回退逐题', { code: (r && r.code) || 'AI_BATCH_NULL', n: slice.length }); break; }
          const byId = {};
          (r.answers || []).forEach(function (a) { byId[a.id] = a; });
          slice.forEach(function (p) {
            /* 多选题本期不点选：只点一个选项必然是错的（连草稿都不该这么存）。
               decideBatch 会把它记为 indexList，这里主动忽略，交给下面的逐题/首个逻辑。 */
            if (p.item.type === 'multi') return;
            const a = byId[p.item.id];
            if (a && a.index >= 0) batchIdx[p.blockIndex] = a.index;
          });
          if ((r.unresolved || []).length) logger.info('AI', '批量里有未确定题（将回退逐题）', { ids: r.unresolved });
        }
      }

      const targets = isWorkPage ? blocks : [{ i: 0, question: q.question, options: q.options, kind: 'single' }];

      /* —— 逐题作答 —— */
      /* ★★★ 2026-11-18 主人指令（D-037）：**记分的题绝不许猜**。
         以前 AI 失败会「回退首选项」盲点第一个 —— 这在章节测验/作业里会实打实
         扣分。新规则：拿不到 AI 答案就**不点任何选项、留空**，把题留给人工。
         （视频随堂题不受影响：它不记分，且不答会卡住播放，仍按 A→B→C 盲试，
           见上面 1308 附近的独立路径。） */
      let answered = 0;
      let skippedNoAi = 0;
      for (const blk of targets) {
        await humanize.quizThink(); // 2–5s 思考延迟，不秒选
        let pickIdx = -1;          /* -1 = 还没有可信答案，不许点 */
        let pickBy = '';
        let imgB64 = '';

        /* 批量答案优先。探针里 blocks 的 i 就是数组下标（`i: blocks.length`），
           万一遇到 i 与下标错位的页面，再按数组下标兜底查一次。 */
        const _ti = isWorkPage ? blocks.indexOf(blk) : -1;
        const _hasBatch = (idx) => isWorkPage && Object.prototype.hasOwnProperty.call(batchIdx, idx);
        const hasBatch = _hasBatch(blk.i) || (_ti >= 0 && _hasBatch(_ti));
        if (hasBatch) {
          pickIdx = _hasBatch(blk.i) ? batchIdx[blk.i] : batchIdx[_ti];
          pickBy = 'ai-batch';
        }

        if (useAi && !hasBatch) {
          /* 截图：超星题干用 font-cxsecret 加密字体渲染，DOM 里是密文，
             截图才是明文。有图走图，没图才退回文本（文本此时无意义）。 */
          if (isWorkPage) {
            try {
              imgB64 = await this.captureQuizBlock(q.frameId, blk.i);
              if (imgB64) logger.info('QUIZ', '已截取题目图片', { block: blk.i, bytes: imgB64.length });
              else logger.warn('QUIZ', '题目截图失败，退回文本作答', { block: blk.i });
            } catch (e) {
              logger.warn('QUIZ', '题目截图失败，退回文本作答', { block: blk.i, err: String((e && e.message) || e).slice(0, 100) });
            }
          }
          try {
            const ai = await this.askAI(blk.question, blk.options, imgB64, isWorkPage ? 'chapter_work' : 'popup_quiz');
            if (ai >= 0) { pickIdx = ai; pickBy = imgB64 ? 'ai-vision' : 'ai'; }
            logger.info('QUIZ', 'AI 作答结果', { block: blk.i, idx: pickIdx, by: pickBy, model: process.env.CX_LLM_MODEL, hasImage: !!imgB64 });
          } catch (e) {
            /* ★ D-037：不再「回退首选项」。拿不到答案就留空，下面统一跳过。 */
            logger.warn('QUIZ', 'AI 答题失败，本题留空不猜（避免扣分）', { block: blk.i, err: String((e && e.message) || e) });
          }
        }

        /* ★ D-037/D-038：没有可信答案 → **一个选项都不点**，留空给人工。
           · 作业页（isWorkPage：章节测验/作业，**记分**）→ 严格留空，绝不猜。
           · 非作业页的泛化弹层（不记分，且只在 CX_QUIZ_MODE=ai 时才走到这里）
             → 保持老语义（首个选项），否则弹层永远关不掉、流程卡死。 */
        if (pickIdx < 0) {
          if (isWorkPage) {
            skippedNoAi += 1;
            this.counters.quizzesSkippedAi = (this.counters.quizzesSkippedAi || 0) + 1;
            logger.warn('QUIZ', '本题无 AI 答案，按主人要求留空（不点任何选项）', {
              block: blk.i, hasBatch, options: (blk.options || []).map((o) => o.letter).join(''),
            });
            continue;
          }
          pickIdx = 0;
          pickBy = 'first';
          logger.warn('QUIZ', '弹层题无 AI 答案，按首个选项关闭弹层（不记分，旧语义）', { block: blk.i });
        }

        const pick = isWorkPage
          ? await this.clickFound(q.frameId, 'quizBlockOption', { b: blk.i, o: pickIdx })
          : await this.clickFound(q.frameId, 'quizOption', pickIdx);
        if (!pick.ok) {
          logger.warn('QUIZ', '选项点击失败，本轮跳过', { block: blk.i, reason: pick.reason, layer: 3 });
          this.failures += 1;
          return { progress: false, outcome: 'QUIZ_PICK_FAIL' };
        }
        answered += 1;
        logger.info('QUIZ', '已选择选项', { block: blk.i, by: pickBy, note: pick.note, options: (blk.options || []).map((o) => o.letter) });
      }

      /* ★ D-037：有题没答成时，绝不能「空着交卷」——那同样扣分。 */
      if (quizMode === 'submit' && skippedNoAi > 0) {
        logger.warn('QUIZ', '有题目没有可信答案，放弃本次交卷（宁可留空给人工）', {
          answered, skipped: skippedNoAi, blocks: blocks.length,
          note: '要强制交卷请把 chapterQuiz 设为 save（只存草稿）或人工处理',
        });
        this._quizFilledFor = this.currentChapterTitle(st);
        this.failures = 0;
        return { progress: true, outcome: 'QUIZ_SUBMIT_SKIPPED_INCOMPLETE' };
      }
      /* 一题都没答成 → 连「保存」也不点，避免无意义的页面操作，直接切下一节
         （与 skip 策略一致：不碰页面，把题留给人工） */
      if (answered === 0 && skippedNoAi > 0) {
        logger.warn('QUIZ', '本节测验无任何可信答案，整体留空并继续下一节（未点任何按钮）', {
          blocks: blocks.length, skipped: skippedNoAi,
        });
        this._videoSeenThisSection = true;
        this.failures = 0;
        return this.advanceSection(st);
      }

      /* —— 收尾：保存草稿 / 交卷 / 只填不点 —— */
      /* ★★★ 2026-11-15 主人指令：章节测验默认「答完只保存，不提交」★★★
         保存 = 把答案写进草稿，本人随时可以改、可以自己交；不产生成绩。
         交卷 = 真实成绩，且不可撤回。所以默认只点「保存」，交卷必须显式开启。 */
      if (quizMode === 'none') {
        logger.info('QUIZ', '章节测验已填好，按配置不点任何按钮（不保存也不提交）', {
          answered, blocks: blocks.length,
        });
        this._quizFilledFor = this.currentChapterTitle(st);
        return { progress: true, outcome: 'QUIZ_FILLED_ONLY' };
      }

      if (quizMode === 'save') {
        const sav = isWorkPage
          ? await this.clickFound(q.frameId, 'quizBlockSave')
          : { ok: false, reason: 'not-work-page' };
        if (!sav.ok) {
          /* 找不到保存按钮 → 绝不能退化成点提交。答案留在页面上，交给人处理。 */
          logger.warn('QUIZ', '未找到「保存」按钮，保留已填答案不提交（请人工确认）', {
            reason: sav.reason, answered, blocks: blocks.length,
          });
          this.counters.quizzesSaved = (this.counters.quizzesSaved || 0) + 1;
          this._quizFilledFor = this.currentChapterTitle(st);
          this.failures = 0;
          return { progress: true, outcome: 'QUIZ_SAVED_NO_BUTTON' };
        }
        /* 保存结果校验：超星可能弹一个小提示，也可能静默。这里只等页面稳定后复核，
           不把「没看到提示」当成失败。 */
        await sleep(1500);
        const after = await this.gatherState();
        const stillThere = !!(after && after.quiz && after.quiz.present);
        this.counters.quizzesSaved = (this.counters.quizzesSaved || 0) + 1;
        this._quizFilledFor = this.currentChapterTitle(st);
        this.failures = 0;
        logger.info('QUIZ', '章节测验已保存草稿（未交卷）', {
          answered, blocks: blocks.length, saveText: sav.text,
          stillOnPage: stillThere, note: '如需交卷请把 chapterQuizSubmitMode 设为 submit',
        });
        /* 保存不改任务点完成状态，本节仍算未完成；但继续停在测验页只会空转，
           所以按「已处理」切到下一节继续看视频（旧跳过逻辑同此处理）。 */
        return this.advanceSection(st);
      }

      /* —— 提交（quizMode === 'submit'，仅在明确开启时走这里）—— */
      const sub = isWorkPage
        ? await this.clickFound(q.frameId, 'quizBlockSubmit')
        : await this.clickFound(q.frameId, 'quizSubmit');
      if (sub.ok) {
        /* 超星的 .btnSubmit 只走到 workPop 确认框，真正提交还需要点 #popok。
           不点确认框 ⇒ 作业从未提交 ⇒ jobUnfinishCount 恒 >0 ⇒ 永远从第一章重来。 */
        if (isWorkPage) {
          const conf = await this.confirmWorkSubmit(q.frameId);
          if (!conf.confirmed) {
            logger.warn('QUIZ', '提交确认框未出现，无法确认作业已提交', { blocks: blocks.length });
          } else if (!conf.submitted) {
            logger.warn('QUIZ', '提交后未跳转到批阅页，作业可能仍未提交', { url: String(conf.url || '').slice(0, 120) });
          }
        }
        this.counters.quizzesAnswered += 1;
        logger.info('QUIZ', '已提交（若出现确认框，下一轮 P0 分支处理）', { submitText: sub.text, answered, blocks: blocks.length });
        return { progress: true, outcome: 'QUIZ_ANSWERED' };
      }
      logger.warn('QUIZ', '提交按钮点击失败', { reason: sub.reason, answered });
      this.failures += 1;
      return { progress: false, outcome: 'QUIZ_SUBMIT_FAIL' };
    });
  }

  /**
   * 截取作业页第 b 个题块的截图（base64 PNG）。
   *
   * 难点是坐标系（实测踩过的坑，务必照抄这套流程）：
   *   超星作业页在 4 层 iframe 里（studentstudy → knowledge/cards →
   *   ananas/modules/work → mooc-ans/work/doHomeWorkNew），
   *   而 Page.captureScreenshot 的 clip 用的是**顶层文档坐标**。
   *
   * 完整步骤：
   *   ① 在题目所在 frame 内把该题块滚到可视区（scrollIntoView）
   *   ② 取题块在本 frame 视口里的并集矩形（题块+题干+全部选项）
   *   ③ 沿 frame 链逐层累加偏移，换算成顶层文档坐标
   *      （每层 = 子 frame 的 frameElement 矩形 + 父 frame 的滚动量）
   *   ④ 把顶层页面滚到让裁剪区落进顶层视口
   *      —— 必须这一步！captureBeyondViewport=false 时裁剪区必须在视口内，
   *         否则 Chrome 截出来是空白或错位
   *   ⑤ 裁剪截图
   *
   * @returns {Promise<string>} base64 PNG；失败返回空串
   */
  async captureQuizBlock(frameId, blockIndex) {
    const adapter = this.adapter;
    if (!adapter || typeof adapter.getFrameChain !== 'function') return '';

    // ① frame 内滚动定位（不同 frame 的滚动互不影响）
    try {
      await adapter.evalInFrame(frameId, '__cx.find("quizBlockScroll",' + JSON.stringify({ b: blockIndex }) + ')');
    } catch (_) { /* 滚动失败也能试 */ }
    await sleep(500);

    // ② 本 frame 视口坐标的并集矩形
    const found = await adapter.evalInFrame(frameId, '__cx.find("quizBlockRect",' + JSON.stringify({ b: blockIndex }) + ')');
    if (!found || !found.ok || !found.rect) return '';
    const local = found.rect;

    // ③ frame 链 → 顶层文档坐标
    const chain = await adapter.getFrameChain(frameId);
    if (!chain || chain.length < 2) return '';
    const org = await adapter.frameOrigin(chain);
    const frameScroll = await adapter.evalInFrame(frameId, '({ x: window.scrollX || 0, y: window.scrollY || 0 })');
    const docX = org.ox + local.x + (frameScroll.x || 0);
    const docY = org.oy + local.y + (frameScroll.y || 0);

    // ④ 把顶层页面滚到让裁剪区进入顶层视口
    const vp = await adapter.rootViewport();
    const want = Math.max(0, Math.round(docY - Math.floor(vp.h / 3)));
    await adapter.scrollRootTo(want);
    await sleep(500);

    // ⑤ 滚动后 frame 链上的偏移会变（子 frame 相对顶层移动了），必须重算
    const org2 = await adapter.frameOrigin(chain);
    const frameScroll2 = await adapter.evalInFrame(frameId, '({ x: window.scrollX || 0, y: window.scrollY || 0 })');
    const clip = {
      x: Math.max(0, Math.round(org2.ox + local.x + (frameScroll2.x || 0))),
      y: Math.max(0, Math.round(org2.oy + local.y + (frameScroll2.y || 0))),
      w: Math.max(1, Math.round(local.w)),
      h: Math.max(1, Math.round(local.h)),
    };

    const rootNow = await adapter.rootViewport();
    const inView = clip.y >= rootNow.sy && (clip.y + clip.h) <= rootNow.sy + rootNow.h;
    if (!inView) {
      logger.warn('QUIZ', 'WARN 裁剪区不在顶层视口内，截图可能错位', {
        block: blockIndex, clip, rootScroll: rootNow.sy, vh: rootNow.h,
      });
    }
    logger.info('QUIZ', '题目坐标已换算到顶层文档', {
      block: blockIndex, chain: chain.length, origin: org.parts.join('|'),
      local: local.x + ',' + local.y + ',' + local.w + ',' + local.h,
      clip: clip.x + ',' + clip.y + ',' + clip.w + ',' + clip.h, inView: inView,
    });

    return await adapter.screenshotClip(clip);
  }

  /**
   * P2：处理作业提交后的确认框，并校验是否真的提交成功。
   *
   * 超星的提交链路（实测自 doHomeWorkNew 页）：
   *   .btnSubmit → onclick="btnBlueSubmit()"
   *     → validateTimeNew(classId, courseId, knowledgeId, cb)   // GET /mooc-ans/work/validate
   *         status==1 → 账号异常，直接 return
   *         status==2 → 弹验证码
   *         status==3 → cb('','')  ← 正常路径
   *     → toadd('','')
   *         → 收集各题答案 → workPop('Submit？', 'Submit', 'Cancel', cb)
   *     → 弹出 #workpop 确认框（★ 用 top.workPop 渲染 ⇒ 出现在**顶层 frame**）
   *     → 用户点 #popok → submitCheckTimes() → form1submit()  ← 真正提交
   *
   * 早期版本只点了 .btnSubmit 就当提交成功 ⇒ 确认框还挂着 ⇒ 作业从未提交
   * ⇒ 目录里 jobUnfinishCount 恒 >0 ⇒ 永远从第一章重新开始（主人报的核心症状）。
   *
   * @returns {Promise<{confirmed:boolean, frameId?:string, note?:string, submitted?:boolean, url?:string}>}
   */
  async confirmWorkSubmit(workFrameId) {
    const adapter = this.adapter;
    const deadline = Date.now() + 15000;
    let confirmed = false;
    let note = '';

    // 确认框可能在顶层 frame，也可能在作业 frame（不同版本超星实现不一致）→ 全部扫一遍
    while (Date.now() < deadline && !confirmed) {
      let frames = [];
      try {
        frames = await adapter.getFrameDocuments();
      } catch (_) { break; }
      for (const f of frames) {
        if (f.url && /^about:blank/.test(f.url)) continue;
        try {
          await adapter.evalInFrame(f.frameId, '__cx.find("workConfirm",null)');
        } catch (_) { continue; }
        const found = await adapter.evalInFrame(f.frameId, '__cx.find("workConfirm",null)');
        if (!found || !found.ok) continue;
        logger.info('QUIZ', '检测到作业提交确认框，点击确定', {
          frameId: f.frameId.slice(0, 10), note: found.note, text: found.text,
        });
        const r = await this.clickFound(f.frameId, 'workConfirm');
        if (r.ok) {
          confirmed = true;
          note = found.note || '';
          break;
        }
      }
      if (!confirmed) await sleep(600);
    }

    if (!confirmed) {
      logger.warn('QUIZ', '未出现提交确认框（可能该版本直接提交）', {});
      return { confirmed: false };
    }

    // 点完确认框后页面会跳到「批阅页」selectWorkQuestionYiPiYue → 视为提交成功
    await sleep(3000);
    let submitted = false;
    let url = '';
    try {
      url = String(await adapter.evalInFrame(workFrameId, 'location.href'));
    } catch (_) { /* frame 可能已销毁 */ }
    if (/selectWorkQuestionYiPiYue|selectWorkQuestion|workAnswerDetail|doHomeWorkNew/.test(url)) {
      // doHomeWorkNew 还在说明可能没跳走；再等一轮看有没有变化
      if (/selectWorkQuestionYiPiYue|selectWorkQuestion|workAnswerDetail/.test(url)) submitted = true;
    }
    if (!submitted) {
      await sleep(2500);
      try {
        url = String(await adapter.evalInFrame(workFrameId, 'location.href'));
      } catch (_) { /* ignore */ }
      submitted = /selectWorkQuestionYiPiYue|selectWorkQuestion|workAnswerDetail/.test(url);
    }
    logger.info('QUIZ', submitted ? '作业已真正提交' : '已点确认，但页面未跳转到批阅页（提交可能未生效）', {
      url: url.slice(0, 140), submitted,
    });
    return { confirmed: true, submitted, url, note };
  }

  /**
   * 判断视频是否「卡死」（而不是普通的暂停）。
   *
   * 实测超星视频卡住的特征：
   *   readyState = 0（HAVE_NOTHING，连元数据都没拿到）
   *   networkState = 1（NETWORK_IDLE）
   *   buffered = []（一个字节都没缓冲）
   *   进度长时间不动
   * 根因：超星的视频源是带**时效签名**的 CDN 链接
   *   https://s2.cldisk.com/.../sd.mp4?at_=<签发时间戳>&ak_=<key>&ad_=<...>
   * 签名过期后 CDN 直接返回 **HTTP 403**（实测确认），页面不会自己换新链接。
   * ⇒ 点播放按钮无效，必须重新加载页面拿新的签名 URL。
   *
   * @param {object} v videoState 的结果
   * @returns {boolean}
   */
  _isVideoStalled(v) {
    if (!v || !v.found) return false;
    // 有明确错误码（网络/解码错误）也算卡死
    if (v.error) return true;
    // readyState 0 = 没有任何数据到达 → 必然是源加载失败（签名过期 / 403）
    if (v.readyState === 0) return true;
    // 网络空闲但一字节都没缓冲
    if (v.networkState === 1 && Array.isArray(v.buffered) && !v.buffered.length) return true;
    return false;
  }

  /**
   * 判断视频进度是否停滞（paused=false 但时间不动）。
   *
   * 播放器仍报"播放中"，但 currentTime 连着几轮不变 —— 通常是缓冲耗尽
   * 或源已失效（CDN 签名过期后，浏览器可能仍保留旧连接）。
   * 判据：连续 N 轮 currentTime 完全不变（且不是 paused）。
   *
   * @param {object} v videoState 结果
   * @returns {boolean}
   */
  _progressStalled(v) {
    if (!v || !v.found) return false;
    if (v.paused || v.ended) return false;
    if (this._isVideoStalled(v)) return false;
    const t = v.currentTime || 0;
    const prev = this._lastProgressTime;
    // 只在已经播过一段之后才做停滞判定（避免刚加载完第一轮就误判）
    if (prev !== undefined && prev > 1 && Math.abs(t - prev) < 0.05) {
      this._stallTicks = (this._stallTicks || 0) + 1;
    } else {
      this._stallTicks = 0;
      this._lastProgressTime = t;
    }
    // 连续 4 轮（约 30 秒）不动 → 判为停滞
    if (this._stallTicks >= 4) {
      this._stallTicks = 0;
      this._lastProgressTime = undefined;
      return true;
    }
    return false;
  }

  /**
   * 重新加载课程页，拿到新的视频签名 URL 并恢复播放。
   *
   * ★ 关键：必须用**当前节的 chapterId** 重新加载。
   *   课程 URL 里的 chapterId 是固定的（第一节），直接重载会跳回第一节，
   *   那样既拿不到当前节的视频签名，也会把进度搞乱。
   *
   * @returns {Promise<boolean>} 是否成功重新加载并恢复播放
   */
  /**
   * 任务点一个都读不到时，重载当前节页面（D-028）。
   * 只在「等待加载」的中途调用一次，避免热循环里反复刷新。
   */
  async _kickReloadIfNoTasks() {
    try {
      const tasks = (this._lastInventory && this._lastInventory.tasks) || [];
      if (tasks.length) return;                       // 任务点已读到，不需要重载
      if (this._waitTicks !== 2) return;              // 只在第 2 次等待时踢一次
      const cid = this._currentChapterId();
      if (!cid) return;
      /* 优先用「当前页 URL」换 chapterId（cfg.course.url 是 stucoursemiddle 入口页，没有 chapterId） */
      let url = '';
      try { url = String(await this.adapter.getCurrentUrl() || ''); } catch (_) { url = ''; }
      if (/[?&]chapterId=\d+/.test(url)) {
        url = url.replace(/([?&]chapterId=)\d+/, '$1' + cid);
      } else {
        const base = String((this.cfg && this.cfg.course && this.cfg.course.url) || '');
        if (!/[?&]chapterId=\d+/.test(base)) return;   // 两个来源都拼不出目标地址就放弃
        url = base.replace(/([?&]chapterId=)\d+/, '$1' + cid);
      }
      logger.info('WAIT_LOAD', '任务点一直读不到，重载当前节页面', {
        chapterId: cid, url: url.slice(0, 120),
      });
      await this.adapter.navigate(url);
      await sleep(8000);
    } catch (e) {
      logger.warn('WAIT_LOAD', '重载当前节页面失败', { error: String((e && e.message) || e).slice(0, 140) });
    }
  }

  async reloadForFreshVideo() {
    const adapter = this.adapter;
    logger.warn('PLAYING_CHECK', '视频卡死（源加载失败，通常是 CDN 签名过期 403），重新加载页面取新签名', {
      section: this._currentTitle,
    });
    try {
      const base = this.cfg && this.cfg.course && this.cfg.course.url;
      if (!base) {
        logger.warn('PLAYING_CHECK', '无法重载：缺少课程地址');
        return false;
      }
      /* 拼当前节的 URL：把 chapterId 换成当前节的 */
      let url = base;
      const cid = this._currentChapterId();
      if (cid) {
        try {
          url = base.replace(/([?&]chapterId=)\d+/, '$1' + cid);
        } catch (e0) { /* 用原地址 */ }
      }
      logger.info('PLAYING_CHECK', '重新加载当前节页面', { chapterId: cid || '(沿用原值)', url: String(url).slice(0, 110) });
      await adapter.navigate(url);
      await sleep(8000);
      const st = await this.gatherState();
      if (st.video && st.video.found && !this._isVideoStalled(st.video)) {
        // 恢复播放
        if (st.video.paused) {
          const r = await this.clickFound(st.video.frameId, 'videoToggle');
          if (!r.ok) return false;
          await this.muteIfPossible(st.video.frameId);
        }
        logger.info('PLAYING_CHECK', '重新加载后视频已恢复', {
          section: this._currentTitle,
          progress: st.video.progress,
          currentTime: st.video.currentTime,
        });
        this._stallTicks = 0;
        this._lastProgressTime = undefined;
        this._resumeAttempts = 0;
        return true;
      }
      logger.warn('PLAYING_CHECK', '重新加载后视频仍未恢复', {
        readyState: st.video ? st.video.readyState : 'no-video',
        buffered: st.video ? st.video.buffered : null,
      });
      return false;
    } catch (e) {
      logger.warn('PLAYING_CHECK', '重新加载异常', { err: String((e && e.message) || e).slice(0, 120) });
      return false;
    }
  }

  /** 取当前节的 chapterId（目录项 id 去掉 cur 前缀）。 */
  _currentChapterId() {
    // 切节时记下的最可靠
    if (this._currentChapterIdValue) return this._currentChapterIdValue;
    const items = (this._lastState && this._lastState.toc && this._lastState.toc.items) || [];
    let idx = -1;
    if (this._lastCurIdx != null && this._lastCurIdx >= 0 && this._lastCurIdx < items.length) idx = this._lastCurIdx;
    else idx = items.findIndex((x) => x.current);
    if (idx < 0) return '';
    const it = items[idx];
    if (it && it.chapterId) return it.chapterId;
    // 兜底：按标题在目录里找同名项
    try {
      const title = this._currentTitle || '';
      const hit = items.find((x) => x.title === title && x.chapterId);
      if (hit) return hit.chapterId;
    } catch (_) { /* ignore */ }
    return '';
  }

  /**
   * 当前节在目录里的待办数（超星服务端认的完成度）。
   *
   * 每节的 jobUnfinishCount = 剩余未完成任务点（视频 1 + 章节测验 1 = 2）。
   * 所以：
   *   2 → 视频还没被超星记为看完
   *   1 → 视频已看完，只剩测验
   *   消失/done → 整节完成
   * 这是判断「视频到底看没看完」的唯一硬证据（播放器进度不作数）。
   *
   * @returns {number|string} 待办数；拿不到时返回 'unknown'
   */
  _currentPending(st) {
    const toc = st && st.toc;
    const items = (toc && toc.items) || [];
    if (!items.length) return 'unknown';
    let idx = -1;
    if (this._lastCurIdx != null && this._lastCurIdx >= 0 && this._lastCurIdx < items.length) idx = this._lastCurIdx;
    else idx = items.findIndex((x) => x.current);
    if (idx < 0) return 'unknown';
    const it = items[idx];
    if (!it) return 'unknown';
    if (it.done) return 0;
    return typeof it.unfinish === 'number' && it.unfinish >= 0 ? it.unfinish : 'unknown';
  }

  /**
   * 当前节在目录里是否已被标记为「完成」。
   *
   * 学习通的完成标记有两种互斥形态（实测）：
   *   A) 全部完成 → 有 <span class="icon_Completed">，**且没有** input.jobUnfinishCount
   *   B) 还有待办 → 有 input.jobUnfinishCount（value = 待办数，>0）
   * 所以「done && 无 jobUnfinishCount」才等价于「这节整节都做完了」。
   */
  _currentSectionDone(st) {
    const toc = st && st.toc;
    const items = (toc && toc.items) || [];
    if (!items.length) return false;
    let idx = -1;
    if (this._lastCurIdx != null && this._lastCurIdx >= 0 && this._lastCurIdx < items.length) idx = this._lastCurIdx;
    else idx = items.findIndex((x) => x.current);
    if (idx < 0) return false;
    const it = items[idx];
    if (!it || !it.done) return false;
    // done 但仍有待办数（>0）→ 只是部分完成，不能整节跳过
    if (typeof it.unfinish === 'number' && it.unfinish > 0) return false;
    return true;
  }

  /**
   * ★★★ 2026-10-29 新增：这一节的「视频任务」是否已完成 ★★★
   *
   * 为什么需要它（3.3 ↔ 3.4 空转 15 分钟的根因）：
   *   _currentSectionDone 要求「整节所有任务点都完成」（unfinish === 0）。
   *   但我们的策略是**跳过章节测验**，所以 unfinish 永远是 1 ——
   *   于是每节播完都不会被判定为完成，引擎反复切下一节又被弹回来。
   *   （实测 1.3~3.2 之所以正常，是因为它们播完时 pending 恰好降到了 1，
   *     走的是 confirmVideoWatched 那条路；3.4 因为首次进入拿不到 duration，
   *     pending 一直停在 2，就死循环了。）
   *
   * 参考 xuexitong-ai-assistant 的 pageInventory.markers（按 .ans-attach-ct 逐个分类）：
   *   它把每个任务点标成 video/audio/document/quiz/discussion 并单独记 finished，
   *   「视频这个任务点完成」就足以进入下一节，不需要整节归零。
   *
   * 判据（任一成立即可）：
   *   a) 目录 unfinish 已 < 本节任务点总数（说明至少完成了一个任务点）
   *   b) 页面扫描里所有 video 类任务点都是 finished（ans-job-finished 或 aria-label 含已完成）
   *   c) 视频确实播放到了进度阈值（由调用方结合 _startedVideoSrcs 保证是本次启动的）
   */
  _videoTaskDone(st) {
    /* ★ 2026-10-31（L4）：判定逻辑搬到纯函数 judge.isVideoTaskDone()。
       这里只做「取上下文 + 调用 + 映射返回形状」，不再自己写判据。
       好处：边界情况（任务点属于上一节、unfinish 恰好=1、duration=0）
       可以用表驱动测试穷举，不需要跑整条状态机。
       见 engine/src/learn/judge.js 与 engine/judge.test.cjs。 */
    const cur = this._currentTocItem(st);
    const inv = this._lastInventory;
    const r = isVideoTaskDone({
      targetKinds: this._targetKinds(),
      tasks: (inv && Array.isArray(inv.tasks)) ? inv.tasks : [],
      currentChapterId: cur && cur.chapterId ? String(cur.chapterId) : '',
      tocItem: cur,
    });
    if (!r.done) return { ok: false, by: r.by };
    return { ok: true, by: r.by, count: r.count, unfinish: r.unfinish, total: cur ? cur.taskTotal : undefined };
  }

  /**
   * 本节未完成的 media 任务点（judge.pendingSectionVideos 的薄封装）。
   * 拿不到/不可信时一律返回 ok:false —— 调用方据此退回「不猜」的保守路径。
   */
  /** 目标类任务点（D-070 可配置；默认 video+audio，保持历史行为）。 */
  _targetKinds() {
    const k = this.cfg && this.cfg.safety && this.cfg.safety.targetKinds;
    return Array.isArray(k) && k.length ? k : ['video', 'audio'];
  }

  _sectionPendingVideos(st) {
    const EMPTY = { ok: false, stale: false, pending: [], total: 0, finished: 0 };
    try {
      const cur = this._currentTocItem(st);
      const inv = this._lastInventory;
      const tasks = (inv && Array.isArray(inv.tasks)) ? inv.tasks : [];
      const r = pendingSectionVideos(tasks, cur && cur.chapterId ? String(cur.chapterId) : '', this._targetKinds());
      return (r && typeof r === 'object') ? r : EMPTY;
    } catch (_) { return EMPTY; }
  }

  /* ==========================================================================
   * D-064：一节多「知识卡片」（knowledge/cards?...&num=0/1/...）
   *
   * 真机事实（复测者实测，跨 6 节）：
   *   · 切换条在最外层 studentstudy 文档：ul.prev_ul > li[cardid][onclick=changeDisplayContent(seq,total,...)]
   *     —— 与「章内子任务」的 ul.prev_ul 同名不同实例，必须按 onclick+cardid 鉴别。
   *   · 单卡节是**常态**（6 节里 4 节只有 1 张卡）；单卡 ≠ 单任务点（有节单卡 4 个任务点）。
   *   · 切卡后 **cards frame id 不变**，只有它下面的**子 frame** 全死（一次 16 个 frameDetached）。
   *     → 不能缓存子 frameId；gatherState 每 tick 重新枚举 frame 树，天然刷新，别自己缓存。
   *   · 任务点可读时机：155ms 新 frame navigated、883ms 任务点可读（.ans-attach-ct 5→7）。
   *     → 轮询「cards frame 里 .ans-attach-ct > 0」，上限 5s，不用固定 sleep。
   * ========================================================================== */

  /** 外层（studentstudy）frame id —— 卡片切换条在这里。 */
  _topFrameId(st) {
    const fr = (st && Array.isArray(st.frames)) ? st.frames : [];
    const t = fr.find((f) => f && f.isTop) || fr[0];
    return t ? t.frameId : null;
  }

  /** knowledge/cards frame id + 当前 num（从 URL 取）。 */
  _cardsFrameInfo(st) {
    const fr = (st && Array.isArray(st.frames)) ? st.frames : [];
    for (const f of fr) {
      const u = String((f && f.url) || '');
      if (!/knowledge\/cards/i.test(u)) continue;
      const m = /[?&]num=(\d+)/i.exec(u);
      return { frameId: f.frameId, num: m ? Number(m[1]) : null, url: u };
    }
    return null;
  }

  /** 读卡片清单（外层文档）。 */
  async _readCardsInfo(st) {
    const fid = this._topFrameId(st);
    if (!fid) return { ok: false, total: 0, cards: [] };
    let r = null;
    try {
      /* ★ D-069：探针缺失时返回 noProbe 标记 —— 用来区分
         「老页面/旧探针（确认没有卡片条）」与「还没渲染（要等）」。 */
      r = await this.adapter.evalInFrame(fid, '__cx && __cx.cardsInfo ? __cx.cardsInfo() : {ok:false,noProbe:true}');
    } catch (_) { r = null; }
    if (!r) return { ok: false, total: 0, cards: [], noProbe: false, readFailed: true };
    if (r.noProbe) return { ok: false, total: 0, cards: [], noProbe: true };
    if (!r.ok || !Array.isArray(r.cards)) return { ok: false, total: 0, cards: [], noProbe: false };
    return r;
  }

  /** 轮询等「cards frame 里出现任务点」，返回是否就绪。 */
  async _waitCardsTasksReady(cardsFrameId, maxMs) {
    if (!cardsFrameId) return false;
    const deadline = Date.now() + (Number(maxMs) > 0 ? Number(maxMs) : 5000);
    while (Date.now() < deadline) {
      let n = 0;
      try {
        n = Number(await this.adapter.evalInFrame(
          cardsFrameId, 'document.querySelectorAll(".ans-attach-ct").length'
        )) || 0;
      } catch (_) { n = 0; }
      if (n > 0) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * 逐卡扫描 + 必要时切卡。返回非 null 时表示「本拍做了切卡动作」，调用方直接返回该 step。
   * 单卡节（total<=1）不切卡，只记录一次扫描结果后返回 null（优雅退化）。
   */
  async _ensureCardsScanned(st) {
    const cur = this._currentTocItem(st);
    const secKey = String((cur && cur.chapterId) || '');
    if (!secKey) return null;

    /* ★ D-069：本节状态表。切节即重建（杜绝沿用上一节账本）。 */
    if (!this._cardCollect || this._cardCollect.key !== secKey) {
      this._cardCollect = {
        key: secKey, state: 'pending', startedAt: Date.now(),
        total: 0, cards: [], title: this._currentTitle,
      };
      this._cardScan = new Map();        // cardid -> { media, finished, failed }
      this._cardAwait = null;            // 刚点过的卡，等它采集完
      this._cardSwitchCount = 0;
      this._cardClickTries = new Map();
    }
    const col = this._cardCollect;
    if (!(this._cardScan instanceof Map)) this._cardScan = new Map();
    if (!(this._cardClickTries instanceof Map)) this._cardClickTries = new Map();
    const timeoutMs = Number(this.cfg && this.cfg.safety && this.cfg.safety.cardDetectTimeoutMs) > 0
      ? Number(this.cfg.safety.cardDetectTimeoutMs) : 15000;

    /* ---------- 阶段一：采集本节卡片清单（每节只做一次）---------- */
    if (col.state === 'pending') {
      const info = await this._readCardsInfo(st);
      const cf = this._cardsFrameInfo(st);
      if (info.ok && info.cards.length > 1) {
        col.state = 'multi'; col.total = info.cards.length; col.cards = info.cards;
        logger.info('ADVANCE', '本节有多个知识卡片，开始逐卡采集', {
          title: col.title, cards: info.cards.length,
          list: info.cards.map((c) => String(c.title || '')).slice(0, 6),
        });
      } else if (info.ok && info.cards.length === 1) {
        col.state = 'single'; col.total = 1; col.cards = info.cards;
      } else if (!cf) {
        /* 连 knowledge/cards frame 都没有 → 老版页面，确认无卡片条（按单卡处理） */
        col.state = 'none';
      } else if (info.noProbe) {
        /* 探针缺失/旧探针 → 老页面，确认无卡片条（按单卡处理） */
        col.state = 'none';
      } else if (info.ok && info.cards.length === 0) {
        /* ★ 读到外层文档「成功但没有卡片 li」→ 这是**确认无**（老版/单卡页），
           不是「还没渲染」。若一直当 pending，会把「已看完的小节」拖到超时停机。
           区分依据：读失败（!info.ok）才说明可能还没就绪。 */
        col.state = 'none';
      } else {
        const waited = Date.now() - col.startedAt;
        if (waited > timeoutMs) {
          col.state = 'timeout';
          logger.error('ADVANCE', '卡片清单迟迟读不到（超时），停止本轮', {
            title: col.title, waitedMs: waited, timeoutMs,
            liCount: info && info.cards ? info.cards.length : 0,
            hasCardsFrame: !!cf,
          });
          this.stop('card_detect_timeout');
          return { progress: false, outcome: 'STOPPED' };
        }
        /* 未就绪：本拍不做任何结论（避免拿旧 inventory 下判定） */
        return null;
      }
    }
    if (col.state === 'timeout') return null;

    /* ---------- 阶段二：记录「当前挂载那张卡」的任务点统计 ---------- */
    this._recordCurrentCard(st, col);

    /* ---------- 阶段三：单卡 / 老页面 → 不介入 ---------- */
    if (col.state === 'none' || col.state === 'single') return null;

    /* ---------- 阶段四：多卡 —— 点过的卡先等它采集完成 ---------- */
    if (this._cardAwait) {
      const done = this._cardScan.has(String(this._cardAwait.cardid));
      if (done) { this._cardAwait = null; }
      else {
        const waited = Date.now() - this._cardAwait.since;
        if (waited > timeoutMs) {
          logger.error('ADVANCE', '切卡后任务点迟迟未就绪（超时），停止本轮', {
            title: col.title, cardid: String(this._cardAwait.cardid).slice(0, 16), waitedMs: waited, timeoutMs,
          });
          this.stop('card_detect_timeout');
          return { progress: false, outcome: 'STOPPED' };
        }
        return null;                      /* 等采集，不重复点击 */
      }
    }

    /* ---------- 阶段五：找一张「还没采集」的卡 ---------- */
    const next = col.cards.find((c) => !this._cardScan.has(String(c.cardid)));
    if (!next) return null;

    /* ★ D-073（复测报告 B3）：切卡守卫从「播放器没 ended」改成
         「当前卡的目标视频是否都已判定完成（平台绿 或 已记录）」。
         原实现要求 !paused && !ended —— 复测里 1.3 卡 0 进节就已 85.9% 且平台标绿，
         却因为「还没到 98.5%、播放器还在播」被一路推到 98.4%，白播 7 分 19 秒。
         现在：平台已绿/本卡无未完成目标 → 允许切（播放器还在播也切）。 */
    if (!this._currentCardTargetsSettled(st)) return null;

    const topId = this._topFrameId(st);
    if (!topId) return null;

    /* 同一张卡限次（防风控 + 防死循环） */
    const nextKey = String(next.cardid);
    const tries = (this._cardClickTries.get(nextKey) || 0) + 1;
    this._cardClickTries.set(nextKey, tries);
    if (tries > 3) {
      this._cardScan.set(nextKey, { media: 0, finished: 0, failed: true });
      logger.warn('ADVANCE', '这张卡片点了多次仍采集不到，标记 failed', { title: next.title, tries: tries - 1, cardid: nextKey.slice(0, 16) });
      return this._stopOnCardCollectFailed(col, next, 'retry-exhausted');
    }

    const r = await this.clickFound(topId, 'cardsTab', { index: next.i });
    if (!r || !r.ok) {
      this._cardScan.set(nextKey, { media: 0, finished: 0, failed: true });
      logger.warn('ADVANCE', '切换知识卡片失败，标记 failed', {
        title: next.title, cardid: nextKey.slice(0, 16), reason: (r && r.reason) || null,
      });
      return this._stopOnCardCollectFailed(col, next, (r && r.reason) || 'click-failed');
    }
    this._cardSwitchCount = (this._cardSwitchCount || 0) + 1;
      this._cardSwitchAt = Date.now();   /* ★ D-073：供 PLAYING_CHECK 换卡豁免窗口 */
    this._cardAwait = { cardid: nextKey, since: Date.now() };   /* ★ 关键：点过就等，不再重复点 */
    logger.info('ADVANCE', '已切换到知识卡片', {
      title: next.title, num: next.num, total: col.cards.length, cardid: nextKey.slice(0, 16),
    });
    const cf2 = this._cardsFrameInfo(st);
    await this._waitCardsTasksReady(cf2 && cf2.frameId, 5000);
    return { progress: true, outcome: 'CARD_SWITCHED' };
  }

  /**
   * 记录「当前挂载那张卡」的 media 任务点统计（按 cards frame 的 num 反查 cardid）。
   * 任务点按 knowledgeid 无法区分卡片，只能按当前挂载算 —— 所以必须逐卡切过去读。
   */
  _recordCurrentCard(st, col) {
    try {
      /* ★ D-070：防御性初始化。原实现直接 this._cardScan.get()，
         若谁先调本方法（测试/未来重构），会 TypeError 并被下面的 catch 静默吞掉 —— 
         表现为"什么都没发生"，极难排查。 */
      if (!(this._cardScan instanceof Map)) this._cardScan = new Map();
      const cf = this._cardsFrameInfo(st);
      const curNum = cf && cf.num != null ? cf.num : null;
      if (curNum == null) return;
      const curCard = (col.cards || []).find((c) => Number(c.num) === Number(curNum));
      if (!curCard) return;
      const pv = this._sectionPendingVideos(st);
      if (!pv || !pv.ok) return;
      const prev = this._cardScan.get(String(curCard.cardid)) || {};
      const rec = {
        media: Number(pv.total) || 0,
        finished: Number(pv.finished) || 0,
        failed: !!prev.failed,
      };
      this._cardScan.set(String(curCard.cardid), rec);
      this._persistSectionState(col);
    } catch (_) { /* 记录失败不阻塞 */ }
  }

  /**
   * ★ D-070：把本节卡片采集表落盘到 learn.json 的 sections[]（复测者建议）。
   * **跨运行只作提示** —— 切节判据仍以平台任务点为准（平台可能把进度退回）。
   * 失败不影响主流程（写盘异常只打 debug）。
   */
  _persistSectionState(col) {
    try {
      if (!col || !col.key) return;
      if (!BUS || typeof BUS.reportSection !== 'function') return;
      const cards = (col.cards || []).map((c) => {
        const r = this._cardScan.get(String(c.cardid)) || null;
        return {
          cardid: String(c.cardid),
          num: Number(c.num),
          title: String(c.title || ''),
          collected: !!r,
          media: r ? Number(r.media) || 0 : 0,
          finished: r ? Number(r.finished) || 0 : 0,
          failed: !!(r && r.failed),
        };
      });
      BUS.reportSection({
        chapterId: col.key,
        title: col.title || '',
        kind: col.state,
        total: Number(col.total) || 0,
        cards: cards,
      });
    } catch (_) { /* 落盘失败不影响主流程 */ }
  }

  /**
   * 本节「所有卡片的 media 任务点是否都完成」。
   * 返回 null = 无法判定（老页面/单卡/未扫完），调用方按旧逻辑处理；
   * 返回 false = 明确还有卡片没播完 → 不许切节。
   */
  _cardsUnionDone(st) {
    /* ★ D-069（复测报告第 (2) 条）：原实现不校验 chapterId，只遍历「扫到过的卡」——
       「没扫到的卡根本不在表里」，所以这个「并集」实际是「已扫卡的并集」，
       天然返回不了 false → 复测里 1.3 拿上一节的 7/7 判定 true 直接放行（静默漏刷）。
       新判据：三态 + 绑 chapterId + 未采集即 fail-closed。 */
    const cur = this._currentTocItem(st);
    const secKey = String((cur && cur.chapterId) || '');
    const col = this._cardCollect;

    /* 没有本节采集记录 / 记录属于别的节 → 明确不许切节（不许当成「无法判定」） */
    if (!secKey) return null;
    if (!col || col.key !== secKey) return false;

    /* 老页面 / 单卡：没有「别的卡」概念 → 交回旧逻辑（null） */
    if (col.state === 'none' || col.state === 'single') return null;

    /* 采集未完成 / 超时 → 不许切节 */
    if (col.state === 'pending' || col.state === 'timeout') return false;

    /* multi：每一张卡都必须「已采集 且 目标类任务点全部完成」 */
    const rec = this._cardScan;
    if (!(rec instanceof Map)) return false;
    for (const c of (col.cards || [])) {
      const r = rec.get(String(c.cardid));
      if (!r) return false;                       /* 有卡未采集 → 不许切节（fail-closed） */
      /* ★ D-073（复测报告 B8）：采集失败的卡**不得**参与「并集通过」。
           原实现 continue 跳过 → 并集可以虚 true → 既漏刷又虚增计数。
           现在：有失败卡 → 本节不许判完成（上层据此停机报 card_collect_failed）。 */
      if (r.failed) return false;
      if ((Number(r.media) || 0) > (Number(r.finished) || 0)) return false;
    }
    return true;
  }

  /** 这个播放器是否对应「某个未完成的 media 任务点」（按 objectid 对齐，对不上就 false） */
  _videoMatchesPending(video, pv) {
    try {
      if (!pv || !pv.ok || !Array.isArray(pv.pending) || !pv.pending.length) return false;
      const oid = String((video && video.objectid) || '');
      if (!oid) return false;
      return pv.pending.some((t) => String((t && t.objectid) || '') === oid);
    } catch (_) { return false; }
  }

  /**
   * 挑「本节未完成、且本次运行还没开始播过」的那个播放器。
   * 找不到（或任务点没有 objectid、无法定位）返回 null —— 绝不猜、绝不拿别的视频冒充。
   * 全部未完成任务点都已播过一次（平台还没记账）时也返回 null，
   * 交给后面的「未确认」逻辑（拍快照 / 累积 streak / 停止）。
   */
  /**
   * 按 objectid 反查 video 子 iframe，补齐 `_lastVideos`（D-054）。
   *
   * 为什么需要：超星「一节多视频」时，每个视频各自在一个
   * `ananas/modules/video/index.html` 子 iframe 里（frame 树形如
   * studentstudy → knowledge/cards → video/index.html × N）。
   * cards frame 自身没有 <video>，靠常规探针汇总会得到空列表，
   * 于是「还有没播的视频」却挑不出可点的播放器。
   *
   * 做法：只对「pending 里还没在 _lastVideos 出现过」的 objectid，
   * 逐个 video 子 iframe 读它的 <video>.currentSrc 抽 32-hex 比对。
   * 命中就补一条 { frameId, frameUrl, objectid, src, currentTime, paused }。
   */
  async _enrichVideosFromFrames(pv) {
    try {
      const pending = (pv && Array.isArray(pv.pending)) ? pv.pending : [];
      if (!pending.length) return;
      const known = new Set((Array.isArray(this._lastVideos) ? this._lastVideos : [])
        .map((v) => String((v && v.objectid) || '')).filter(Boolean));
      const missing = pending.map((t) => String((t && t.objectid) || '')).filter((o) => o && !known.has(o));
      if (!missing.length) return;

      const frames = await this.adapter.getFrameDocuments().catch(() => []);
      const vidFrames = (frames || []).filter((f) => /ananas\/modules\/video|modules\/video\/index\.html/i.test(f.url || ''));
      if (!vidFrames.length) return;

      const probeExpr = `(() => {
        const v = document.querySelector('video');
        if (!v) return '';
        const s = String(v.currentSrc || v.getAttribute('src') || '');
        const m = /[0-9a-fA-F]{32}/.exec(s);
        return m ? m[0] : '';
      })()`;

      const added = [];
      for (const f of vidFrames) {
        let oid = '';
        try { oid = String(await this.adapter.evalInFrame(f.frameId, probeExpr) || ''); } catch (_) { oid = ''; }
        if (!oid || !missing.includes(oid)) continue;
        if (known.has(oid)) continue;
        this._lastVideos = (Array.isArray(this._lastVideos) ? this._lastVideos : []).concat([{
          frameId: f.frameId,
          frameUrl: String(f.url || ''),
          objectid: oid,
          src: '',
          duration: null,
          currentTime: 0,
          paused: true,
        }]);
        known.add(oid);
        added.push({ objectid: oid.slice(0, 12), frameId: String(f.frameId).slice(0, 10) });
      }
      if (added.length) {
        logger.info('ADVANCE', '已从 video 子 iframe 补齐播放器候选', { added, totalVideos: this._lastVideos.length });
      }
    } catch (e) {
      logger.warn('ADVANCE', '反查 video 子 iframe 失败', { err: String((e && e.message) || e).slice(0, 100) });
    }
  }

  _pickUnplayedVideo(st, pv) {
    try {
      if (!pv || !pv.ok || !Array.isArray(pv.pending) || !pv.pending.length) return null;
      const vids = Array.isArray(this._lastVideos) ? this._lastVideos : [];
      const notStarted = [];
      for (const t of pv.pending) {
        const oid = String((t && t.objectid) || '');
        if (!oid) continue;
        /* ★ D-039：按 objectid 记账，且「尝试」与「成功」都排除；
           单个候选连续起播失败 ≥3 次也排除，避免死循环。 */
        if (this._startedVideoIds.has(oid)) continue;
        if (this._attemptedVideoIds.has(oid)) continue;
        if ((this._unstartableVideoIds.get(oid) || 0) >= 3) continue;
        for (const v of vids) {
          if (String(v.objectid || '') !== oid) continue;
          notStarted.push(v);
          break;
        }
      }
      return notStarted.length ? notStarted[0] : null;
    } catch (_) { return null; }
  }

  /**
   * 把「剩余任务点都起播失败」的现场落到诊断快照（D-039）。
   * 目的：失败必须**可见**，而不是像旧版那样静默空转 108 轮。
   */
  _dumpStuckVideos(st, pv, stuck) {
    try {
      const snap = {
        at: new Date().toISOString(),
        reason: 'video_task_unreachable',
        section: this._currentTitle || '',
        chapterId: String(this._currentChapterId() || ''),
        pendingCount: (pv && pv.pending) ? pv.pending.length : 0,
        totalVideos: pv ? pv.total : 0,
        finishedVideos: pv ? pv.finished : 0,
        stuck,
        attemptedIds: Array.from(this._attemptedVideoIds || []),
        startedIds: Array.from(this._startedVideoIds || []),
        pending: ((pv && pv.pending) || []).map((t) => ({
          objectid: String((t && t.objectid) || ''),
          frameUrl: String((t && t.frameUrl) || '').slice(0, 200),
        })),
        videos: (Array.isArray(st && st.videos) ? st.videos : []).map((v) => ({
          objectid: String(v.objectid || ''),
          src: String(v.src || '').slice(0, 160),
          duration: v.duration,
          currentTime: v.currentTime,
          paused: v.paused,
        })),
      };
      const path = require('node:path');
      const fs = require('node:fs');
      const dir = path.join((this.cfg && this.cfg.stateDir) || process.env.CX_STATE_DIR || '.', 'diagnostics');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
      const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-video_unstartable.json');
      fs.writeFileSync(file, JSON.stringify(snap, null, 2));
      logger.warn('ADVANCE', '已写入起播失败快照', { file: String(file).slice(-64) });
    } catch (e) {
      logger.warn('ADVANCE', '写起播失败快照失败', { err: String((e && e.message) || e).slice(0, 100) });
    }
  }

  /* ==========================================================================
   * 直播回放任务点（D-026）
   * --------------------------------------------------------------------------
   * 超星直播不是 <video>：
   *   卡片 iframe = mooc1 .../ananas/modules/live/index.html（只是入口，无 video）
   *   真播放器   = https://live.chaoxing.com/courseLive/pclive?streamName=..&vdoid=..
   *                └─ 内嵌 https://zhibo.chaoxing.com/live/course/watch?...（video.js + HLS）
   *
   * 进度口径（2026-11-16 实测，唯一可信来源）：
   *   播放器页每 30s 打一次 GET https://zhibo.chaoxing.com/saveTimePc?...&isStart=1，
   *   服务端按**墙钟**累计，每 5 分钟落一次 liveinfo 的 percentValue/timeLong。
   *   ⇒ 引擎只需「把播放器页开着并保持 playing 态」，再轮询 liveinfo 等 percentValue ≥ 90。
   *
   * 为什么不用本地 currentTime 判定：headless 里 HLS+MSE 的 currentTime 恒为 0
   * （webkitVideoDecodedByteCount 恒 0；同一浏览器播 mp4 正常解码 442 帧），
   * 但 paused=false 时心跳照发、percentValue 照涨（实测 241s → 6.83%）。
   * ========================================================================*/

  /** 读 liveinfo 的服务端进度。
   *
   * ★ 2026-11-16 真机教训（D-027）：原来只在 cards frame 里 `evalInFrame` 发请求，
   *   而轮询循环每分钟 `attachTarget(播放器)` ↔ `attachTarget(学习页)` 来回切。
   *   实测后果：多次 attach 后 `Runtime.evaluate` 集体超时（一次播放器标签页的
   *   渲染进程吃到 793MB），进度彻底读不到，播放器越堆越多。
   *
   *   现在优先走 **Node 侧 fetch**（adapter.getAllCookies() 拿真实 cookie 自己发请求），
   *   完全不依赖 CDP 附着，也不受页面卡顿影响；只有拿不到 cookie/上下文时才回退到
   *   页面内 fetch（_liveInfoFrame）。
   */
  async _liveInfo(knowledgeId, liveId, ctx) {
    if (ctx && typeof fetch === 'function') {
      const n = await this._liveInfoNode(knowledgeId, liveId, ctx).catch(() => null);
      if (n && n.ok) return n;
    }
    return this._liveInfoFrame(knowledgeId, liveId);
  }

  /** Node 侧带 cookie 直接请求 liveinfo（最快、最稳，不碰 CDP） */
  async _liveInfoNode(knowledgeId, liveId, ctx) {
    const getCk = this.adapter && this.adapter.getAllCookies;
    if (typeof getCk !== 'function') return { ok: false, error: 'no-cookie-api' };
    const all = await getCk.call(this.adapter);
    if (!Array.isArray(all) || !all.length) return { ok: false, error: 'no-cookies' };
    const jar = all
      .filter((c) => /chaoxing\.com$/i.test(String((c && c.domain) || '').replace(/^\./, ''))
        || /chaoxing\.com/i.test(String((c && c.domain) || '')))
      .map((c) => c.name + '=' + c.value).join('; ');
    if (!jar) return { ok: false, error: 'no-chaoxing-cookies' };
    const p = new URLSearchParams();
    p.set('liveid', String(liveId));
    p.set('userid', String((ctx && ctx.userid) || ''));
    p.set('clazzid', String((ctx && ctx.clazzid) || ''));
    p.set('knowledgeid', String(knowledgeId || ''));
    p.set('courseid', String((ctx && ctx.courseid) || ''));
    p.set('jobid', 'live-' + String(liveId));
    p.set('ut', 's');
    const res = await fetch('https://mooc1.chaoxing.com/ananas/live/liveinfo?' + p.toString(), {
      headers: {
        cookie: jar,
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: 'https://mooc1.chaoxing.com/mycourse/studentstudy',
      },
    });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) { return { ok: false, error: 'bad-json:' + txt.slice(0, 40) }; }
    const dd = j && j.temp && j.temp.data;
    if (!dd) return { ok: false, error: 'no-data' };
    return {
      ok: true,
      percent: Number(dd.percentValue) || 0,
      timeLong: Number(dd.timeLong) || 0,
      duration: Number(dd.duration) || 0,
      viewUrl: dd.viewUrl || '',
      streamName: dd.streamName || '',
    };
  }

  /** 页面内读（回退路径）：在 cards frame 里带 cookie 请求，同源 mooc1 */
  async _liveInfoFrame(knowledgeId, liveId) {
    try {
      const docs = await this.adapter.getFrameDocuments();
      const want = String(knowledgeId || '');
      const cards = (docs || []).filter((d) => /knowledge\/cards/i.test(String(d.url || '')));
      const f = cards.find((d) => want && String(d.url).indexOf('knowledgeid=' + want) >= 0) || cards[0];
      if (!f) return { ok: false, error: 'no-cards-frame' };
      const lid = JSON.stringify(String(liveId));
      const kid = JSON.stringify(want);
      const expr = '(async () => { try {' +
        ' var d = (window.AttachmentSetting && window.AttachmentSetting.defaults) || {};' +
        ' var p = new URLSearchParams();' +
        ' p.set("liveid", ' + lid + ');' +
        ' p.set("userid", d.userid || "");' +
        ' p.set("clazzid", d.clazzId || d.clazzid || "");' +
        ' p.set("knowledgeid", d.knowledgeid || ' + kid + ');' +
        ' p.set("courseid", d.courseid || d.courseId || "");' +
        ' p.set("jobid", "live-" + ' + lid + ');' +
        ' p.set("ut", "s");' +
        ' var r = await fetch("https://mooc1.chaoxing.com/ananas/live/liveinfo?" + p.toString(), { credentials: "include" });' +
        ' var j = await r.json();' +
        ' var dd = (j && j.temp && j.temp.data) || null;' +
        ' if (!dd) return { ok: false, error: "no-data" };' +
        ' return { ok: true, percent: Number(dd.percentValue) || 0, timeLong: Number(dd.timeLong) || 0,' +
        '   duration: Number(dd.duration) || 0, viewUrl: dd.viewUrl || "", streamName: dd.streamName || "" };' +
        ' } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()';
      const r = await this.adapter.evalInFrame(f.frameId, expr);
      if (r && typeof r === 'object') return r;
      return { ok: false, error: 'bad-result' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 150) };
    }
  }

  /** 抓一次 liveinfo 需要的学生上下文（userid/clazzid/courseid），成功即缓存 */
  async _liveCtxOf(knowledgeId) {
    const key = String(knowledgeId || '');
    if (this._liveCtx && this._liveCtx.key === key) return this._liveCtx;
    try {
      const docs = await this.adapter.getFrameDocuments();
      const cards = (docs || []).filter((d) => /knowledge\/cards/i.test(String(d.url || '')));
      const f = cards.find((d) => key && String(d.url).indexOf('knowledgeid=' + key) >= 0) || cards[0];
      if (!f) return null;
      const expr = '(() => { var d = (window.AttachmentSetting && window.AttachmentSetting.defaults) || {};'
        + ' return { userid: String(d.userid || ""), clazzid: String(d.clazzId || d.clazzid || ""),'
        + '   courseid: String(d.courseid || d.courseId || ""), knowledgeid: String(d.knowledgeid || "") }; })()';
      const r = await this.adapter.evalInFrame(f.frameId, expr);
      if (r && r.userid) {
        this._liveCtx = { key, userid: r.userid, clazzid: r.clazzid, courseid: r.courseid };
        return this._liveCtx;
      }
    } catch (_) { /* 拿不到就走回退路径 */ }
    return null;
  }

  /**
   * 让直播播放器进入 playing 态（muted + play）。
   * 只读 + 播放，不点任何「提交/报名/发送」类按钮。
   */
  async _liveEnsurePlaying(timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 10000);
    let lastErr = 'no-zhibo-frame';
    const expr = '(() => { var v = document.querySelector("video");' +
      ' if (!v) return { ok: false, why: "no-video" };' +
      ' try { v.muted = true; } catch (e) {}' +
      ' var p = null; try { p = v.play(); } catch (e) {}' +
      ' if (p && p.catch) p.catch(function () {});' +
      ' return { ok: true, paused: !!v.paused, dur: Number(v.duration) || 0, rs: v.readyState }; })()';
    while (Date.now() < deadline) {
      let docs = [];
      try { docs = await this.adapter.getFrameDocuments(); } catch (e) {
        lastErr = String((e && e.message) || e);
        await sleep(1500);
        continue;
      }
      const z = (docs || []).find((d) => /zhibo\.chaoxing\.com/i.test(String(d.url || '')));
      if (!z) { lastErr = 'zhibo-frame-missing'; await sleep(1500); continue; }
      let r = null;
      try { r = await this.adapter.evalInFrame(z.frameId, expr); } catch (e) {
        lastErr = String((e && e.message) || e);
        await sleep(1500);
        continue;
      }
      if (r && r.ok && r.dur > 0) {
        if (!r.paused) return { ok: true, dur: r.dur };
        /* autoplay 可能需要第二次触发 */
        await sleep(1200);
        let r2 = null;
        try { r2 = await this.adapter.evalInFrame(z.frameId, expr); } catch (_) { /* ignore */ }
        if (r2 && r2.ok) return { ok: true, dur: r2.dur, paused: !!r2.paused };
      }
      await sleep(1500);
    }
    return { ok: false, error: lastErr };
  }

  /**
   * 直播回放：开播放器标签页 → 保持 playing → 轮询 liveinfo percentValue → 达标切节。
   * 返回与其它 tick 分支相同的 { progress, outcome } 形状。
   */
  async handleLiveTask(st) {
    const task = this._currentTask(st);
    const cur = this._currentTocItem(st);
    const knowledgeId = String((cur && cur.chapterId) || '');
    const liveId = String((task && task.liveId) || '');
    const liveCfg = (this.cfg && this.cfg.live) || {};
    const donePercent = Number(liveCfg.donePercent) || 90;
    const pollMs = Number(liveCfg.pollMs) || 60000;
    const startTimeoutMs = Number(liveCfg.startTimeoutMs) || 60000;
    const maxMs = Number(liveCfg.maxMs) || 150 * 60 * 1000;

    if (!liveId) {
      this.failures += 1;
      logger.warn('LIVE', '直播任务点缺少 liveId，无法定位播放器', { section: this._currentTitle, kind: 'live' });
      return { progress: false, outcome: 'LIVE_NO_ID' };
    }

    /* 上下文只需抓一次（userid/clazzid/courseid），之后 Node 侧直接发请求 */
    const ctx = await this._liveCtxOf(knowledgeId);
    const info = await this._liveInfo(knowledgeId, liveId, ctx);
    if (!info || !info.ok) {
      this.failures += 1;
      logger.warn('LIVE', '读取直播信息失败', {
        section: this._currentTitle, liveId, error: (info && info.error) || 'unknown',
      });
      return { progress: false, outcome: 'LIVE_INFO_FAIL' };
    }

    if (info.percent >= donePercent) {
      logger.info('LIVE', '直播回放已达超星完成线，切下一节', {
        section: this._currentTitle, percent: info.percent, donePercent,
      });
      this._videoSeenThisSection = true;
      this.failures = 0;
      return this.advanceSection(st);
    }

    const studyTarget = (typeof this.adapter.getTargetId === 'function') ? this.adapter.getTargetId() : null;

    /* ── 播放器标签页：复用优先，绝不多开（D-027 真机教训） ──
     * 原来每进一次 handleLiveTask 就 openTarget 一个新播放器，且轮询里来回
     * attachTarget 切换，实测堆到 8+ 个 HLS 播放器标签页，单个渲染进程 793MB，
     * Runtime.evaluate 集体超时，进度彻底读不到。现在同 liveId 复用同一个。 */
    let playerId = null;
    if (this._livePlayer && this._livePlayer.liveId !== liveId) {
      /* 上一条直播遗留的播放器：关掉，避免标签页越堆越多 */
      try { await this.adapter.closeTarget(this._livePlayer.targetId); } catch (_) { /* ignore */ }
      logger.info('LIVE', '关闭上一条直播遗留的播放器标签页', {
        section: this._currentTitle, targetId: this._livePlayer.targetId,
      });
      this._livePlayer = null;
    }
    if (this._livePlayer && this._livePlayer.liveId === liveId) {
      try {
        await this.adapter.attachTarget(this._livePlayer.targetId);
        playerId = this._livePlayer.targetId;
        logger.info('LIVE', '复用已在播放的播放器标签页', { section: this._currentTitle, targetId: playerId });
      } catch (_) {
        this._livePlayer = null;
      }
    }
    if (!playerId) {
      try {
        const opened = await this.adapter.openTarget(info.viewUrl);
        playerId = opened && opened.id;
        if (!playerId) throw new Error('openTarget 未返回 targetId');
        await this.adapter.attachTarget(playerId);
        this._livePlayer = { targetId: playerId, liveId };
      } catch (e) {
        logger.warn('LIVE', '直播播放器打开失败', {
          section: this._currentTitle, error: String((e && e.message) || e).slice(0, 160),
        });
        try { if (playerId) await this.adapter.closeTarget(playerId); } catch (_) { /* ignore */ }
        this._livePlayer = null;
        if (studyTarget) { try { await this.adapter.attachTarget(studyTarget); } catch (_) { /* ignore */ } }
        this.failures += 1;
        return { progress: false, outcome: 'LIVE_START_FAIL' };
      }
    }

    /* 确保在播（此时已附着在播放器 target 上） */
    const started = await this._liveEnsurePlaying(startTimeoutMs);
    if (!started.ok) {
      logger.warn('LIVE', '直播播放器未能开始播放', {
        section: this._currentTitle, error: started.error || 'not-playing',
      });
      try { await this.adapter.closeTarget(playerId); } catch (_) { /* ignore */ }
      this._livePlayer = null;
      if (studyTarget) { try { await this.adapter.attachTarget(studyTarget); } catch (_) { /* ignore */ } }
      this.failures += 1;
      return { progress: false, outcome: 'LIVE_START_FAIL' };
    }
    logger.info('LIVE', '直播播放器正在播放（服务端进度按墙钟累计）', {
      section: this._currentTitle, percent: info.percent, durationSec: info.duration, targetId: playerId,
    });

    /* ── 轮询：进度走 Node 侧 fetch，循环内不再切 target ── */
    const deadline = Date.now() + maxMs;
    let last = info;
    let reviveAttempts = 0;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const now = await this._liveInfo(knowledgeId, liveId, ctx);
      if (now && now.ok) {
        last = now;
        logger.info('LIVE', '直播观看进度（服务端口径）', {
          section: this._currentTitle,
          percent: now.percent,
          watchedMin: +(now.timeLong / 60000).toFixed(1),
          durationMin: +(now.duration / 60).toFixed(1),
          donePercent,
        });
        if (now.percent >= donePercent) break;
      } else {
        logger.warn('LIVE', '本轮读进度失败', { error: (now && now.error) || 'unknown' });
      }
      /* 保活：我们从头到尾都附着在播放器上，直接确认它还在 playing（不切 target） */
      let alive = { ok: false };
      try {
        alive = await this._liveEnsurePlaying(8000);
      } catch (e) {
        alive = { ok: false, error: String((e && e.message) || e).slice(0, 120) };
        /* 连接可能掉了，重新附着一次播放器再试 */
        try { await this.adapter.attachTarget(playerId); } catch (_) { /* ignore */ }
      }
      if (!alive.ok) {
        reviveAttempts += 1;
        logger.warn('LIVE', '播放器掉线，尝试重新播放', { attempt: reviveAttempts, error: alive.error });
        if (reviveAttempts > 8) {
          logger.warn('LIVE', '播放器反复掉线，放弃本条直播', { attempts: reviveAttempts });
          break;
        }
      }
    }

    if (last.percent >= donePercent) {
      /* 达标才关播放器，并清掉复用记录 */
      try { await this.adapter.closeTarget(playerId); } catch (_) { /* ignore */ }
      this._livePlayer = null;
      if (studyTarget) { try { await this.adapter.attachTarget(studyTarget); } catch (_) { /* ignore */ } }
      logger.info('LIVE', '直播回放完成', {
        section: this._currentTitle, percent: last.percent, watchedMin: +(last.timeLong / 60000).toFixed(1),
      });
      this._videoSeenThisSection = true;
      this.failures = 0;
      return this.advanceSection(st);
    }

    /* 超时：**故意不关播放器**，让它继续累计，下一轮 tick 复用同一个标签页 */
    if (studyTarget) { try { await this.adapter.attachTarget(studyTarget); } catch (_) { /* ignore */ } }
    this.failures += 1;
    logger.warn('LIVE', '等待超时，直播未达完成线（播放器保留，稍后继续）', {
      section: this._currentTitle, percent: last.percent, donePercent,
    });
    return { progress: false, outcome: 'LIVE_TIMEOUT' };
  }

  /** 驱动指定的那个播放器开始播放（只点它自己的 frame，不碰其它播放器） */
  /**
   * 起播本节指定的那个视频（D-039 重写）。
   *
   * 旧实现三处致命缺陷（Issue #1 复测：108 次空转、第 2 个视频始终没起播）：
   *   1. 点击不带目标 → `videoToggle` 内部 querySelector('video') 永远点第一个；
   *   2. 记「已启动」时用的是**重新探到的 video**（还是第一个），不是候选；
   *   3. 点完 sleep 3s 直接 return {ok:true}，**从不校验 currentTime 是否前进**。
   *
   * 现在：目标带 objectid 下发 → 点击前先写 attempt → 点击后轮询验证是否真的起播。
   * 起播判据（任一成立即算成功）：paused === false，或 currentTime 比点击前前进 > 0.5s。
   */
  async playSectionVideo(st, video) {
    const frameId = video && video.frameId;
    if (!frameId) return { ok: false, reason: 'no-frame' };
    const oid = String((video && video.objectid) || '');
    /* ★ 尝试记录**在点击之前**写入 —— 与「成功」彻底解耦，
       否则失败不记账 → 同一个候选被无限重试（自证失败）。 */
    if (oid) this._attemptedVideoIds.add(oid);

    /* 记点击前的进度基线，用于「有没有真的动起来」的判定 */
    let beforeTime = -1;
    /* ★ D-054：优先在该候选自己的 frame 里读基线（多视频节 st.videos 可能是空的） */
    try {
      const raw = await this.adapter.evalInFrame(frameId, `(() => { const v = document.querySelector('video'); return v ? String(v.currentTime) : ''; })()`);
      const t = Number(raw);
      if (Number.isFinite(t)) beforeTime = t;
    } catch (_) { /* ignore */ }
    if (beforeTime < 0) {
      try {
        const base = Array.isArray(st && st.videos) ? st.videos : [];
        for (const v of base) {
          if (oid && String(v.objectid || '') === oid) { beforeTime = Number(v.currentTime || 0); break; }
        }
        if (beforeTime < 0 && st && st.video && typeof st.video.currentTime === 'number') {
          beforeTime = Number(st.video.currentTime || 0);
        }
      } catch (_) { /* ignore */ }
    }

    try {
      let degraded = false;
      const r = await this.clickFound(frameId, 'videoToggle', oid ? { objectid: oid } : undefined);
      if (!r || !r.ok) {
        /* ★ D-066（B 档）：真鼠标点不动时的**兜底** —— 在该 frame 内直接调用
           media.play()（属性/方法调用，不是合成点击；与 muteIfPossible 同性质）。
           点不动通常是视口外/命中失败/多层 iframe 偏移（D-048~D-063 那一串），
           而 play() 完全不吃坐标。
           注意：仍然「不回退去点别的播放器」——兜底只针对**同一个 objectid**。 */
        const fb = await this._playByObjectId(frameId, oid);
        if (!fb.ok) {
          logger.warn('CLICK', '真鼠标点不动，页内 JS play() 兜底也未成功', {
            objectid: oid.slice(0, 12), clickReason: (r && r.reason) || 'toggle-failed', fbReason: fb.reason,
          });
          this._bumpUnstartable(oid);
          return {
            ok: false,
            reason: ((r && r.reason) || 'toggle-failed') + '+js-fallback-failed(' + (fb.reason || '?') + ')',
            objectid: oid,
          };
        }
        degraded = true;
        logger.warn('CLICK', '真鼠标点不动 → 已用页内 JS play() 兜底（降级，但起播仍要过验证）', {
          objectid: oid.slice(0, 12), clickReason: (r && r.reason) || 'toggle-failed',
          readyState: fb.readyState, rate: fb.rate,
        });
      }
      await this.muteIfPossible(frameId);
      /* D-066：倍速（默认 1 → 不写）。两条路径都应用，放在 mute 之后。 */
      await this._applyPlaybackRate(frameId, oid);
      if (oid) {
        const verified = await this._verifyVideoStarted(oid, beforeTime, 6000, frameId);
        if (!verified.ok) {
          this._bumpUnstartable(oid);
          logger.warn('QUIZ', '点击后视频未起播（已记录失败，换下一个候选）', {
            objectid: oid.slice(0, 12), note: verified.note, attempts: this._unstartableVideoIds.get(oid) || 1,
          });
          return { ok: false, reason: 'not-started', objectid: oid, note: verified.note };
        }
        this._startedVideoIds.add(oid);
        this._unstartableVideoIds.delete(oid);
        this._playedThisSection = true;   /* D-073：本节确实推动过播放 */
        return { ok: true, objectid: oid, note: verified.note };
      }
      /* 没有 objectid 的老情形：保持旧语义（无法按身份验证） */
      await sleep(1500);
      this._markVideoStarted(video);
      this._stallTicks = 0;
      this._resumeAttempts = 0;
      this._playedThisSection = true;   /* D-073：本节确实推动过播放 */
      return { ok: true };
    } catch (e) {
      this._bumpUnstartable(oid);
      return { ok: false, reason: 'play-error: ' + String((e && e.message) || e).slice(0, 80), objectid: oid };
    }
  }

  /**
   * ★ D-073（复测报告 B8）：采集失败的卡**不许当通过**。
   * 默认停机（宁可停，不可漏刷后静默 +1）；可用 safety.stopOnCardCollectFailed=false 关掉，
   * 关掉时也不 +1（由 _cardsUnionDone 的 fail-closed 保证不判完成）。
   */
  _stopOnCardCollectFailed(col, card, reason) {
    const on = !(this.cfg && this.cfg.safety && this.cfg.safety.stopOnCardCollectFailed === false);
    logger.warn('ADVANCE', '知识卡片采集失败，本节无法判定完成', {
      title: col && col.title, card: card && card.title, reason,
      cardid: card ? String(card.cardid).slice(0, 16) : '',
      stop: on,
    });
    if (on) this.stop('card_collect_failed');
    return null;
  }

  /**
   * ★ D-073：记录「本视频在本节首次出现时的进度」。
   * 用来区分「进节时早已绿」与「本次起播后被推着走」——前者不许白播。
   */
  _noteVideoEntry(v, st) {
    try {
      if (!v) return;
      if (!(this._videoEntryDone instanceof Map)) this._videoEntryDone = new Map();
      const k = this._videoKey(v);
      if (!k || this._videoEntryDone.has(k)) return;
      /* ★ 关键：记录「进节时平台是否已经认为本节视频任务点完成」。
         复测案例：1.3 卡 0 进节进度 85.9%（< 98.5%）但平台已标绿 —— 这就是「早已看完」，
         不该再被 greenEarly 推着播到 98.4%（白播 7 分 19 秒）。 */
      const green = (() => { try { const r = this._videoTaskDone(st); return !!(r && r.ok); } catch (_) { return false; } })();
      this._videoEntryDone.set(k, green);
    } catch (_) { /* ignore */ }
  }

  /** 进节时该视频是否已被平台判为完成（= 上次已看完，本次不该再播） */
  _doneAtEntry(v) {
    try {
      const k = this._videoKey(v);
      const m = this._videoEntryDone;
      return !!(m instanceof Map && k && m.get(k) === true);
    } catch (_) { return false; }
  }

  _videoKey(v) {
    const oid = String((v && v.objectid) || '');
    if (oid) return oid;
    return String((v && v.src) || '').slice(0, 200);
  }

  /** 进节时该视频进度是否已达判定线（= 平台早已标绿的古老视频） */
  _greenAtEntry(v) {
    try {
      const k = this._videoKey(v);
      const m = this._videoEntryProgress;
      if (!(m instanceof Map) || !k || !m.has(k)) return false;
      return Number(m.get(k)) >= this.cfg.video.progressDoneRatio;
    } catch (_) { return false; }
  }

  /** 刚切过卡片的豁免窗口（默认 8s，可配 safety.cardSwitchSettleMs） */
  _recentlySwitchedCard() {
    const w = Number(this.cfg && this.cfg.safety && this.cfg.safety.cardSwitchSettleMs);
    const win = w > 0 ? w : 8000;
    const at = Number(this._cardSwitchAt || 0);
    return at > 0 && (Date.now() - at) < win;
  }

  /**
   * ★ D-073（B3）：当前挂载那张卡的**目标视频是否都已判定完成**。
   * 依据：本卡 pending 为空；或平台已把本节任务点标绿（≈86% 早绿）。
   * 不比 98.5/100，也不看播放器是否还在播。
   */
  _currentCardTargetsSettled(st) {
    try {
      /* 当前没有播放器元素 → 没有「正在播的视频」可打断，直接放行。
         （切卡本身会把旧卡的 DOM 换掉，不必等一个不存在的播放器） */
      if (!st || !st.video || !st.video.found) return true;
      const pv = this._sectionPendingVideos(st);
      if (!pv || !pv.ok) return true;                 /* 数据不可信 → 不阻塞 */
      if (!Array.isArray(pv.pending) || pv.pending.length === 0) return true;
      const green = this._videoTaskDone(st);
      return !!(green && green.ok);                   /* 平台标绿即放行（早绿也算完成） */
    } catch (_) { return true; }
  }

  /** ★ D-073（B4）：当前卡是否根本没有目标视频（如「教学课件」卡） */
  _currentCardHasNoTargetVideo(st) {
    try {
      const pv = this._sectionPendingVideos(st);
      if (pv && pv.ok) return (Number(pv.total) || 0) === 0;
      return false;
    } catch (_) { return false; }
  }

  /**
   * ★ D-073（复测报告 A4）：本节计数的**唯一出口**。
   *
   * 原实现把 sectionsCompleted += 1 只写在「视频播完」分支尾部，而「提前完成」分支
   * 排在它前面 —— 视频一到判定线 greenEarly 立刻变 false，控制流被提前分支接走记
   * sectionsSkipped，于是 sectionsCompleted 恒为 0，maxSections 的
   * completed >= maxSections 永不成立（复测 33 分钟走了 4 节，一次都没触发）。
   *
   * 判据：**本次是否真的推动过目标点**（_startedVideoSrcs 非空 = 本节起播过视频）。
   */
  _countSectionOutcome() {
    /* ★ 不能借 _startedVideoSrcs —— 那是「本次运行」级账本、跨节不清，
       会把上一节的「播过」带到本节（实测导致无视频节被误记 completed）。 */
    const played = this._playedThisSection === true;
    if (played) this.counters.sectionsCompleted += 1;
    else this.counters.sectionsSkipped += 1;
    return played;
  }

  _bumpUnstartable(oid) {
    if (!oid) return;
    const n = (this._unstartableVideoIds.get(oid) || 0) + 1;
    this._unstartableVideoIds.set(oid, n);
  }

  /**
   * 点完之后验证「真的起播了」—— 这是旧实现最缺的一环（失败不可见）。
   * 轮询最多 maxMs；命中 paused===false 或 currentTime 前进 > 0.5s 即成功。
   */
  async _verifyVideoStarted(oid, beforeTime, maxMs, frameId) {
    const deadline = Date.now() + (Number(maxMs) > 0 ? Number(maxMs) : 4000);
    let last = null;
    while (Date.now() < deadline) {
      await sleep(700);
      /* ★ D-054：多视频节的 video 在子 iframe 里，st2.videos 可能是空的。
         所以有 frameId 时**先在该 frame 内读**；读不到再回退全局汇总（两条路都试）。 */
      let frameHit = null;
      if (frameId) {
        try {
          const raw = await this.adapter.evalInFrame(frameId, `(() => {
            const v = document.querySelector('video');
            if (!v) return '';
            const s = String(v.currentSrc || v.src || '');
            const m = /[0-9a-fA-F]{32}/.exec(s);
            return JSON.stringify({ t: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState, oid: m ? m[0] : '' });
          })()`);
          try { frameHit = JSON.parse(raw); } catch (_) { frameHit = null; }
        } catch (_) { frameHit = null; }
      }
      if (frameHit) {
        last = frameHit;
        /* ★ 2026-11-21（堵「静默播错」盲区）：起播验证必须核对身份。
           旧逻辑只要「这个 frame 里有东西在动」就判成功 —— 点了相邻/错的 iframe
           也会「通过」。现在要求 frameHit 的 objectid 与目标一致（空 src 的视频除外）。 */
        const hitOid = String(frameHit.oid || '').toLowerCase();
        const wantOid = String(oid || '').toLowerCase();
        const oidOk = !hitOid || !wantOid || hitOid === wantOid;
        if (!oidOk) {
          last = { paused: frameHit.paused, currentTime: frameHit.t, wrongOid: hitOid.slice(0, 12) };
        } else {
          const cur = Number(frameHit.t || 0);
          if (frameHit.paused === false && (cur > 0 || (beforeTime >= 0 && cur - beforeTime > 0.5))) {
            return { ok: true, note: 'playing(frame)' };
          }
          if (beforeTime >= 0 && cur - beforeTime > 0.5) return { ok: true, note: 'time-advanced(frame)' };
        }
      }
      let st2 = null;
      try { st2 = await this.gatherState(); } catch (_) { st2 = null; }
      if (!st2) continue;
      const vids = Array.isArray(st2.videos) ? st2.videos : [];
      let hit = null;
      for (const v of vids) {
        if (String(v.objectid || '') === oid) { hit = v; break; }
      }
      if (!hit) continue;
      last = hit;
      const cur = Number(hit.currentTime || 0);
      if (hit.paused === false) {
        if (cur > 0 || (beforeTime >= 0 && cur - beforeTime > 0.5)) {
          return { ok: true, note: 'playing' };
        }
        /* 已 paused=false 但 currentTime 还 0（HLS 起步慢）→ 继续等 */
      }
      if (beforeTime >= 0 && cur - beforeTime > 0.5) return { ok: true, note: 'time-advanced' };
    }
    if (!last) return { ok: false, note: 'video-not-found' };
    if (last.wrongOid) return { ok: false, note: 'wrong-video oid=' + last.wrongOid };
    return { ok: false, note: 'stuck paused=' + last.paused + ' t=' + Number(last.currentTime || last.t || 0) };
  }

  /**
   * 当前节的任务点列表（按 knowledgeid 与当前节对齐，避免拿到上一节的残留）。
   * 扩展点 E1 的输入之一。
   */
  _currentTasks(st) {
    const cur = this._currentTocItem(st);
    const wantId = cur && cur.chapterId ? String(cur.chapterId) : '';
    const inv = this._lastInventory;
    const all = (inv && Array.isArray(inv.tasks)) ? inv.tasks : [];
    if (!wantId) return all;
    const matched = all.filter((t) => {
      const m = /[?&]knowledgeid=([0-9]+)/i.exec(String(t.frameUrl || ''));
      return !!(m && m[1] === wantId);
    });
    return matched.length ? matched : all;
  }

  /** 当前节第一个任务点的类型（没有任务点时为 unknown） */
  _currentTaskKind(st) {
    const tasks = this._currentTasks(st);
    if (!tasks.length) return TASK_KIND.UNKNOWN;
    return kindOf(tasks[0]);
  }

  /** 当前节第一个任务点对象（扩展点 E1 的输入） */
  _currentTask(st) {
    const tasks = this._currentTasks(st);
    return tasks.length ? tasks[0] : null;
  }

  /** 取目录里「当前节」那条 item（与 _currentSectionDone 同一套定位规则） */
  _currentTocItem(st) {
    const toc = st && st.toc;
    const items = (toc && toc.items) || [];
    if (!items.length) return null;
    let idx = -1;
    if (this._lastCurIdx != null && this._lastCurIdx >= 0 && this._lastCurIdx < items.length) idx = this._lastCurIdx;
    else idx = items.findIndex((x) => x.current);
    return idx >= 0 ? items[idx] : null;
  }

  /**
   * ★ 2026-10-29：标记「本次运行真的推动过播放」的视频。
   * 只有被标记过的 src，才允许用 ended/进度 来判定播完。
   * 参考 xuexitong-ai-assistant 的 startedVideos 语义。
   */
  _markVideoStarted(video) {
    /* ★ D-073：只要本节真的推动过播放（不论走 playSectionVideo 还是 P0 恢复播放），
       本节计数就该记 completed。放在这里是因为两条播放路径都会经过 _markVideoStarted。 */
    this._playedThisSection = true;
    try {
      const src = String((video && video.src) || '').slice(0, 400);
      if (src) this._startedVideoSrcs.add(src);
      else this._startedVideoSrcs.add('__nosrc__');   // 没 src 的播放器（Mock/内联 blob）统一登记
    } catch (_) { /* ignore */ }
  }

  /** 这个视频是否为本次运行启动过（决定能否用 ended 判完成） */
  _isVideoStartedHere(video) {
    try {
      const src = String((video && video.src) || '').slice(0, 400);
      if (!src) {
        /* 没有 src 的情况（Mock、内联 blob、或超星用 MSE 挂载）：
           只要登记过就认，否则永远判不出来。 */
        return this._startedVideoSrcs.has('__nosrc__');
      }
      return this._startedVideoSrcs.has(src);
    } catch (_) { return false; }
  }

  /**
   * 刷新目录读当前节的待办数，确认超星服务端是否真的记了「视频看完」。
   *
   * 超星的学习进度是**定时上报**的，不是播放器一结束就写库。
   * 所以播放条走完的那一刻，目录里的 jobUnfinishCount 可能仍是 2（视频还没被记）。
   * 这里主动重新读目录并短暂等待，把真实状态确认下来 ——
   * 否则「看完了」只是我们自己的错觉。
   *
   * @param {number} [waitMs] 首次等待时长
   * @returns {Promise<number|string>} 待办数；拿不到返回 'unknown'
   */
  async confirmVideoWatched(waitMs) {
    const wait = typeof waitMs === 'number' ? waitMs : 6000;
    await sleep(wait);
    let pending = 'unknown';
    try {
      const st = await this.gatherState();
      pending = this._currentPending(st);
    } catch (_) { /* ignore */ }
    if (pending === 2) {
      // 上报可能还没到账，再等一轮
      await sleep(6000);
      try {
        const st = await this.gatherState();
        pending = this._currentPending(st);
      } catch (_) { /* ignore */ }
    }
    return pending;
  }

  /** P1/P3/P4：定位目录下一节（跳过已完成），切换并等待加载。 */
  async advanceSection(st) {
    const toc = st.toc;
    if (!toc || !toc.found) {
      this.failures += 1;
      logger.warn('ADVANCE', 'WARN P1 目录未识别，无法定位下一节', { layer: 0 });
      return { progress: false, outcome: 'TOC_MISSING' };
    }
    const items = toc.items || [];
    /* ★ 当前节定位：以「引擎自己推进到的位置」为准，而不是目录里的 current class。
       实测坑：学习通 posCatalog_active 只标记「上一次打开的节」，切到下一节后
       它不会跟着更新 —— 引擎每次重读目录都会退回原来那一节 ⇒ 永远在 1.1 打转。
       规则：_lastCurIdx（引擎自己记的位置）优先；只有当目录里 current 指向的
       标题跟引擎记录的不一致时，才认为是外部（用户手动）切节并跟随它。 */
    const currentIdx = items.findIndex((x) => x.current);
    let curIdx = -1;
    if (this._lastCurIdx != null && this._lastCurIdx >= 0 && this._lastCurIdx < items.length) {
      curIdx = this._lastCurIdx;
      if (currentIdx >= 0 && currentIdx !== curIdx) {
        const curTitle = items[currentIdx].title || '';
        const lastTitle = items[curIdx].title || '';
        if (curTitle && lastTitle && curTitle !== lastTitle) {
          /* ★ 2026-10-31 真机：页面一刷新/抖动，目录 current 会自己跳回 1.1，
             引擎跟着走 → 整门课重走一遍（实测白走 24 分钟）。
             只允许「向前」跟随，且同一轮最多 3 次；回退一律忽略。 */
          const forward = currentIdx > curIdx;
          const MAX_FOLLOW = 3;
          if (forward && (this._followCount || 0) < MAX_FOLLOW) {
            this._followCount = (this._followCount || 0) + 1;
            logger.info('ADVANCE', '检测到目录当前节被外部改变（向前），跟随新位置', {
              from: lastTitle, to: curTitle, follow: this._followCount,
            });
            curIdx = currentIdx;
          } else {
            logger.warn('ADVANCE', forward ? '目录外部改变次数过多，忽略' : '目录 current 回退了，忽略（不从头重走）', {
              from: lastTitle, to: curTitle, follow: this._followCount || 0, forward: forward,
            });
          }
        }
      }
    } else if (currentIdx >= 0) {
      curIdx = currentIdx;
    }
    /* ★ 2026-10-31（L4）：选节判定搬到纯函数 pickNextSection()。
       这里只剩「按判定结果点击 + 日志 + 计数器」，判据不再内联。
       判据见 engine/src/learn/judge.js（含「跳过已完成」「节数上限」「跨章边界」）。 */
    const decision = pickNextSection({
      items,
      curIdx,
      mode: this.cfg.mode,
      maxSections: this.cfg.maxSections,
      completed: this.counters.sectionsCompleted,
    });
    const bypassedDone = decision.skipped;

    if (decision.action === 'stop') {
      if (decision.stopReason === 'chapter_boundary') {
        logger.info('ADVANCE', 'P4 当前章节已推进完毕（mode=current_chapter）', {
          skipped: bypassedDone, mode: this.cfg.mode,
        });
        this.stop('chapter_boundary');
        return { progress: false, outcome: 'CHAPTER_BOUNDARY' };
      }
      if (decision.stopReason === 'max_sections_reached') {
        this.stop('max_sections_reached');   // P4：最大节数上限
        return { progress: false, outcome: 'MAX_SECTIONS' };
      }
      this.stop(decision.stopReason || 'all_done_or_no_target');
      return { progress: false, outcome: 'ALL_DONE' };
    }

    const target = decision.target;

    /* ★ 2026-10-31：优先按 chapterId 点，避免目录重排/缓存导致 index 错位。 */
    const clickArg = target.chapterId ? String(target.chapterId) : target.i;
    const r = await this.clickFound(toc.frameId, 'tocItem', clickArg);
    if (!r.ok) {
      logger.warn('ADVANCE', '目录项点击失败', { title: target.title, reason: r.reason });
      this.failures += 1;
      return { progress: false, outcome: 'TOC_CLICK_FAIL' };
    }
    logger.info('ADVANCE', 'P1 已切换到下一节', { title: target.title, bypassedDone, layer: r.layer, note: r.note, mode: this.cfg.mode });
    /* ★ 分层：切节事实写进中间文件 */
    try {
      if (BUS && BUS.reportLearn) {
        BUS.reportLearn({
          phase: 'advanced',
          section: target.title,
          sectionIndex: target.i,
          chapterId: target.chapterId || '',
          counters: this.counters,
        });
      }
      busEmit('learn', 'section-advance', { title: target.title, index: target.i });
    } catch (_) { /* ignore */ }
    this.counters.sectionsSkipped += bypassedDone;
    this._lastCurIdx = target.i;
    this._currentTitle = target.title;
    // 记住本节的 chapterId：重载页面时要用它（课程 URL 里的 chapterId 固定指向第一节）
    this._currentChapterIdValue = target.chapterId || '';
    this._videoSeenThisSection = false;
    this._waitTicks = 0;
    /* ★ D-039：换节了，本节的多视频账本必须清零，否则上一节的 objectid 会
       让新节的候选被误判成「已经尝试过/已经播过」。 */
    this._attemptedVideoIds = new Set();
    this._startedVideoIds = new Set();
    this._unstartableVideoIds = new Map();
    this._videoEntryDone = new Map();       /* D-073：换节清「进节时平台是否已绿」快照 */
    this._cardSwitchAt = 0;                 /* D-073：换节清换卡豁免窗口 */
    this._playedThisSection = false;        /* D-073：本节是否真的起播过（计数唯一依据） */
    /* ★ 2026-10-31 真机（FNOS 3.4）：点了 3.4，但 knowledge/cards 播放器
       还是 3.3 那一份（772.2s），引擎只看到「有视频 + 有 duration」就当成就绪，
       于是把 3.3 当 3.4 看，最后 3.4 永远不记账，还来回重进。
       这里记下目标节，等加载时用 knowledgeid 校验播放器真的换了。 */
    this._waitTarget = { tocFrameId: toc.frameId, index: target.i, chapterId: target.chapterId || '', title: target.title };
    this._staleLoadRetries = 0;
    this._mutedTried = false;
    // 切到下一节 → 章节测验标签状态重置（下一节属于新的一章，测验入口会变）
    this._quizTabOpened = false;
    this._quizTabWaitTicks = 0;
    this._quizTabDoneFor = null;
    /* 忽略计数归零：否则上一节忽略到阈值边缘，下一节会被过早判成「切下一节」 */
    this._quizIgnoreTicks = 0;
    // 切节重置播放停滞/恢复计数（新节的视频是新会话）
    this._stallTicks = 0;
    this._lastProgressTime = undefined;
    this._resumeAttempts = 0;
    this._lastVideoFrameId = null;
    this._lastVideoCurrentTime = undefined;
    this._lastVideoDuration = undefined;
    this._lastVideoSrc = '';
    this._videoProgressTicks = 0;
    const loaded = await this.waitLoad(); // P1：切换后等待新页面加载完成
    return { progress: loaded, outcome: loaded ? 'SECTION_ADVANCED' : 'WAIT_LOAD_TIMEOUT' };
  }

  /**
   * 当前 knowledge/cards iframe 的 knowledgeid（= 正在显示哪一节的播放器）。
   * 没有这个 frame / 没有该参数 → 返回空串（调用方按「无法校验」处理）。
   */
  _loadedKnowledgeId(st) {
    const frames = (st && st.frames) || [];
    for (const f of frames) {
      const u = String(f.url || '');
      if (!/knowledge\/cards/.test(u)) continue;
      const m = /[?&]knowledgeid=([0-9]+)/.exec(u);
      if (m) return m[1];
    }
    return '';
  }

  /** P1：切换后的加载等待 = 拟人化冷却（8–15s）+ 轮询确认视频就绪。 */
  async waitLoad() {
    await humanize.sectionCooldown();
    for (let i = 0; i < this.cfg.safety.maxLoadRetries; i++) {
      const st = await this.gatherState();
      /* ★★★ 2026-10-29：就绪 = 元素存在 **且** 元数据已加载（duration > 0）★★★
         原来只判 st.video.found，元素一出现就当作就绪，但此时 duration 还是 0，
         上层会把「没开始播」误判成「已播完」（详见 videoState 里的注释），
         导致 3.3 ↔ 3.4 空转。

         再加一个兜底：如果元素在但一直拿不到 duration，主动点一次播放按钮
         （超星新节有时停在待播放状态，中间那个大播放图标），推动它加载。
         仍然拿不到就交回状态机，由 tick 的卡滞逻辑处理，不在这里死等。 */
      if (st.video && st.video.found) {
        this._videoSeenThisSection = true;
        /* ★ 2026-10-31：先确认播放器是不是**本节**的。
           学习通点小节后 knowledge/cards iframe 是异步换的；换之前
           video 元素还在，duration 也有值（上一节的）。只判 found+duration
           会把上一节的视频当成新节，整轮看的是旧视频，目标节永远不记账。 */
        const kb = this._loadedKnowledgeId(st);
        const want = String((this._waitTarget && this._waitTarget.chapterId) || '');
        if (kb && want && kb !== want) {
          this._staleLoadRetries = (this._staleLoadRetries || 0) + 1;
          logger.warn('WAIT_LOAD', '播放器仍是上一节，等待切换（不当作已就绪）', {
            title: this._currentTitle, retries: i, loadedKnowledgeId: kb, wantKnowledgeId: want,
            stale: this._staleLoadRetries,
          });
          /* ★ 2026-10-31：点击本质是按坐标发鼠标事件，视口/滚动一变就不可靠。
             第二次还没换过来时，直接改用「带 chapterId 的参数地址」导航 —— 不再依赖任何坐标。 */
          if (this._staleLoadRetries === 1 && want) {
            const base = String((st && st.topUrl) || '');
            if (base) {
              const u = /[?&]chapterId=\d+/.test(base)
                ? base.replace(/([?&])chapterId=\d+/, '$1chapterId=' + want)
                : base + (base.indexOf('?') >= 0 ? '&' : '?') + 'chapterId=' + want;
              logger.info('WAIT_LOAD', '点击切节失败，改用带 chapterId 的地址直接导航', { url: u.slice(0, 130) });
              try { await this.adapter.navigate(u); } catch (_) { /* ignore */ }
              await sleep(2500);
            }
          }
          /* 连续两次没换过来就再点一次小节（页面偶尔吃第一次点击） */
          if (this._staleLoadRetries % 2 === 0 && this._waitTarget) {
            try { await this.clickFound(this._waitTarget.tocFrameId, 'tocItem', this._waitTarget.index); } catch (_) { /* ignore */ }
            await sleep(1500);
          }
          await humanize.pollDelay();
          continue;
        }
        const dur = st.video.duration || 0;
        if (dur > 0) {
          logger.info('WAIT_LOAD', '新节视频已就绪', {
            title: this._currentTitle, retries: i, duration: dur,
          });
          return true;
        }
        /* 元素在但元数据未到 → 点播放推动加载。
           ★ 参考 xuexitong-ai-assistant L8884 的做法：
               if (video.readyState === 0 && playBtn) playBtn.click();
             readyState 0 = HAVE_NOTHING（元数据都没拿到），此时点播放能触发加载。
             readyState >= 1 说明元数据已在路上，再点反而可能暂停，所以只在 0 时点。
             每轮都要重试（不是只点一次）：切节后播放器可能重建，点一次不够。 */
        if (st.video.readyState === 0) {
          logger.info('WAIT_LOAD', '视频元数据未加载（readyState=0），点播放推动加载', {
            title: this._currentTitle, retries: i, networkState: st.video.networkState,
          });
          try { await this.clickFound(st.video.frameId || null, 'videoToggle'); } catch (_) { /* ignore */ }
          await sleep(1200);
          continue;
        }
        logger.info('WAIT_LOAD', '视频元素已在但时长仍未知，继续等待', {
          title: this._currentTitle, retries: i,
          readyState: st.video.readyState, networkState: st.video.networkState,
        });
      }
      if (st.human.length || st.loginInvalid) {
        logger.warn('WAIT_LOAD', '等待中检测到人工验证/登录态变化，交回主循环处理');
        return false;
      }
      await humanize.pollDelay();
    }
    /* ★ 2026-10-31 真机陷阱：点 3.4 后播放器始终停在 3.3（knowledgeid 不换）。
       以前超时后交回主循环，主循环就继续拿那个旧视频当本节播 —— 看的是上一节，
       目标节永远不记账。现在只要见过「播放器不换」，就明确停机并写清原因，
       不再假装在学新节。 */
    if (this._staleLoadRetries > 0) {
      try { await this.captureProblemSnapshot((this._lastState || {}), 'section_unreachable'); } catch (_) { /* ignore */ }
      logger.error('WAIT_LOAD', '小节切换失败：播放器一直停在上一节，停止本轮（避免看错节）', {
        title: this._currentTitle,
        wantKnowledgeId: (this._waitTarget && this._waitTarget.chapterId) || '',
        stale: this._staleLoadRetries,
      });
      this.stop('section_unreachable');
      return false;
    }
    logger.warn('WAIT_LOAD', '等待超时（新节未见可播放视频，交回状态机判定）', { retries: this.cfg.safety.maxLoadRetries });
    return false;
  }
}

module.exports = {
  NORMAL_STOP,
  LearnMachine
};








