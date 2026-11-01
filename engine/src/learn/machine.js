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
const { parseAnswerLetter } = require('../core/config.js');
const { humanize, logger } = require('../core/logging.js');
const { emitQuestionEvent } = require('../core/questions.js');
const { installProbeExpression } = require('./selectors.js');
const { decideTaskPoint, kindOf, TASK_KIND } = require('./taskpoints.js');
const { isVideoTaskDone, pickNextSection, pickStart } = require('./judge.js');

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
    this.counters = { sectionsCompleted: 0, sectionsSkipped: 0, quizzesAnswered: 0, dialogsDismissed: 0 };
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
      for (const f of probes) {
        const ts = f.probe && f.probe.tasks;
        if (Array.isArray(ts)) {
          for (const t of ts) allTasks.push(Object.assign({ frameUrl: String(f.url || '') }, t));
        }
      }
      this._lastInventory = { tasks: allTasks, at: Date.now() };
    }
    for (const f of probes) {
      const v = f.probe.video;
      if (v && v.found && (!st.video || (v.progress || 0) > (st.video.progress || 0))) {
        st.video = Object.assign({}, v, { frameId: f.frameId });
        st.videoFrameId = f.frameId;
      }
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
    let found;
    try {
      found = await this.adapter.evalInFrame(frameId, '__cx.find(' + JSON.stringify(kind) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')');
    } catch (e) {
      return { ok: false, reason: 'find-eval-error: ' + String((e && e.message) || e).slice(0, 80) };
    }
    if (!found || !found.ok) {
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
      const doneNow = this._currentSectionDone(st)
        ? { ok: true, by: 'toc-section-done' }
        : this._videoTaskDone(st);
      if (doneNow.ok) {
        logger.info('ADVANCE', '本节视频任务已完成（测验按策略跳过），直接切下一节', {
          title: this._currentTitle,
          progress: (st.video && st.video.progress) || 0,
          by: doneNow.by,
          unfinish: doneNow.unfinish,
          total: doneNow.total,
        });
        this.counters.sectionsSkipped += 1;
        this.failures = 0;
        return this.advanceSection(st);
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
        this.counters.sectionsCompleted += 1;
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
        // 本章若有「章节测验」标签，先切过去把题答完，再进入下一节
        const quizDone = await this.maybeHandleChapterQuiz(st);
        if (quizDone === 'handled') return { progress: true, outcome: 'CHAPTER_QUIZ_HANDLED' };
        if (quizDone === 'pending') return { progress: true, outcome: 'CHAPTER_QUIZ_PENDING' };
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
        logger.warn('PLAYING_CHECK', '恢复播放失败（未找到播放控件）', { layer: r.layer || 0 });
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
      if (decision.action === 'wait') {
        /* handler 认为还要等（异步加载的文档常见） */
        await humanize.pollDelay();
        return { progress: true, outcome: 'TASKPOINT_WAIT' };
      }
      this.counters.sectionsSkipped += 1;
      this._videoSeenThisSection = true; // 防重复跳过
      this.failures = 0;                 // 跳过是有效进展
      return this.advanceSection(st);
    }

    /* —— 视频曾经出现又消失：视为异常 —— */
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
  async askAI(question, options, imageB64) {
    const askUrl = process.env.CX_LLM_ASK_URL || '';
    const base = process.env.CX_LLM_BASE || '';
    const key = process.env.CX_LLM_KEY || '';
    const model = process.env.CX_LLM_MODEL || '';
    if (!options || !options.length) return -1;
    if (!askUrl && !(base && key && model)) return -1;
    const labels = options.map(function (o, i) {
      return (o.letter || String.fromCharCode(65 + i)) + '. ' + (o.label || '');
    }).join('\n');
    const prompt = imageB64
      ? '这是考试题目的截图（超星用加密字体渲染，截图里才是明文）。\n' +
        '请读出题干和全部选项，判断正确答案是哪一个。\n' +
        '只输出正确选项的字母（A/B/C/D），不要任何解释。'
      : '题目：' + (question || '') + '\n选项：\n' + labels +
        '\n\n只输出正确选项的字母（A/B/C/D…），不要任何解释。';

    let text = '';
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      text = '';
      if (askUrl) {
        // 通路 1：回调宿主，由宿主用 ctx.llm 调用户配置的模型
        const payload = {
          provider: process.env.CX_LLM_PROVIDER || '',
          model: model,
          prompt: prompt,
        };
        if (imageB64) payload.image = 'data:image/png;base64,' + imageB64;
        const res = await fetch(askUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cx-token': process.env.CX_LLM_ASK_TOKEN || '',
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
        const j = await res.json();
        if (!j || j.ok !== true) throw new Error(String((j && j.error) || '宿主答题回调失败'));
        text = String(j.text || '');
      } else {
        // 通路 2：直连 OpenAI 兼容接口
        const url = base.replace(/\/+$/, '') + '/chat/completions';
        const msgContent = imageB64
          ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } }]
          : prompt;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: msgContent }],
            temperature: 0,
            max_tokens: 16,
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
        const j = await res.json();
        text = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
      }
      if (text.trim()) break;
      // 上游偶尔「成功返回但正文为空」，重试一次再判定不可用
      if (attempt < attempts) {
        logger.warn('QUIZ', '模型返回空内容，重试中 ' + attempt + '/' + (attempts - 1), { model: model });
        await new Promise(function (r) { setTimeout(r, 800 * attempt); });
      }
    }

    return parseAnswerLetter(text, options.length);
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

  async maybeHandleChapterQuiz(st) {
    /* ★★★ 2026-10-31 修：开关只认配置，不再读环境变量 ★★★
       原实现是：
           if (String(process.env.CX_QUIZ_MODE || '') === 'skip') return 'none';
       宿主 index.js 每次 spawn 都设 CX_QUIZ_MODE=skip，所以**插件跑时**安全；
       但直接 `node engine/chaoxing-autolearn.js --mode=...`（README 教的用法）
       这个变量是空的 → 条件不成立 → 继续往下 → **点开章节测验标签**。
       同一个引擎两种入口两种行为，这是最容易出事的那种不一致。

       现在只认配置 safety.skipChapterQuiz（默认 true），与入口无关。 */
    if (this.cfg.safety.skipChapterQuiz !== false) {
      return 'none';
    }
    /* 兼容：显式要求跳过时也不点（防止旧配置/旧调用方传 env 才有预期） */
    if (String(process.env.CX_QUIZ_MODE || '') === 'skip') {
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

      for (let i = 0; i < optCount; i++) {
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
          this._videoQuizTried = null; this._videoQuizKey = null;
          return { progress: true, outcome: 'VIDEO_QUIZ_PASSED' };
        }
        if (fb.correct || fb.continueVisible) {
          logger.info('QUIZ', '随堂题答对了，点「继续」恢复播放', { option: i });
          await this.clickFound(frameId, 'videoQuizContinue');
          this.counters.quizzesAnswered += 1;   // 随堂题已答（计入统计）
          this._videoQuizTried = null; this._videoQuizKey = null;
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
      const quizMode = String(process.env.CX_QUIZ_MODE || 'skip');
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
        if (isChapterWork && this.cfg.safety.skipChapterQuiz !== false) {
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
      const targets = isWorkPage ? blocks : [{ i: 0, question: q.question, options: q.options, kind: 'single' }];

      /* —— 逐题作答 —— */
      let answered = 0;
      for (const blk of targets) {
        await humanize.quizThink(); // 2–5s 思考延迟，不秒选
        let pickIdx = 0;
        let pickBy = 'first';
        let imgB64 = '';

        if (useAi) {
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
            const ai = await this.askAI(blk.question, blk.options, imgB64);
            if (ai >= 0) { pickIdx = ai; pickBy = imgB64 ? 'ai-vision' : 'ai'; }
            logger.info('QUIZ', 'AI 作答结果', { block: blk.i, idx: pickIdx, by: pickBy, model: process.env.CX_LLM_MODEL, hasImage: !!imgB64 });
          } catch (e) {
            logger.warn('QUIZ', 'AI 答题失败，回退首选项', { block: blk.i, err: String((e && e.message) || e) });
          }
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

      /* —— 提交 —— */
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
      tasks: (inv && Array.isArray(inv.tasks)) ? inv.tasks : [],
      currentChapterId: cur && cur.chapterId ? String(cur.chapterId) : '',
      tocItem: cur,
    });
    if (!r.done) return { ok: false, by: r.by };
    return { ok: true, by: r.by, count: r.count, unfinish: r.unfinish, total: cur ? cur.taskTotal : undefined };
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
