/* ============================================================================
 * engine/src/learn/run.js — run() 主循环：前置检查、自动点进课程、带停止条件的循环
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { createCdpAdapter } = require('../browser/cdp.js');
const { CONTRACT, FatalStop, busEmit, fs, sleep } = require('../core/base.js');
const { CONFIG, mergeConfig, validateConfig } = require('../core/config.js');
const { humanize, logBanner, logger } = require('../core/logging.js');
const { openChapterAndWait, openCourseByClick, openSectionByClick } = require('../courses.js');
const { LearnMachine } = require('./machine.js');
const { EPHEMERAL_DIR, cleanupEphemeralProfile, ensureEphemeralProfile, shutdownBrowser } = require('../login/index.js');
const { pickStart } = require('./judge.js');

/* ============================================================================
 * 第 7 节 · 主循环 run() —— 前置检查 + 带停止条件与异常捕获的 async 循环
 * ==========================================================================*/
let activeMachine = null;
try {
  process.on('SIGINT', () => { if (activeMachine) activeMachine.stop('user_abort'); });
} catch (_) { /* 非 Node 环境忽略 */ }

/**
 * 入口函数（后台任务 / 模块调用 / MCP 工具共用）。
 * @param {object} [overrides]  覆盖 CONFIG 的部分字段（深合并），如
 *                              { mode, maxSections, course:{url}, humanize:{...} }
 * @param {object} [options]    { adapter } — 注入自定义适配器（自测用 Mock）。
 * @returns {object} 结构化结果：{ ok, stopReason, sectionsCompleted, sectionsSkipped,
 *                              quizzesAnswered, dialogsDismissed, elapsedMs, logs }
 */
async function run(overrides, options) {
  const started = Date.now();
  const cfg = mergeConfig(CONFIG, overrides);
  validateConfig(cfg);
  logger.configure(cfg.log);
  logBanner(cfg);
  humanize.configure(cfg.humanize);

  const result = {
    ok: false, stopReason: null,
    sectionsCompleted: 0, sectionsSkipped: 0, quizzesAnswered: 0, dialogsDismissed: 0,
    elapsedMs: 0, logs: []
  };
  let machine = null;
  let adapterRef = null;
  /* ★ B-精简：登录态是否在本次运行中失效。
     失效时**必须**销毁内核 —— 一个没有登录态的浏览器留着毫无意义，
     而且会一直占内存（历史上泄漏过 13 个进程 / 1335MB）。
     所以会话模式（CX_KEEP_BROWSER=1）也要给它开个例外。 */
  let LOGIN_LOST = false;
  /* 一次性登录：看课任务复用扫码登录时建好的临时 profile，跑完即删。
     若临时 profile 不存在（没先扫码），这里会新建一个空 profile —— 会因未登录而
     在预检阶段 LOGIN_REQUIRED，提示用户先扫码，符合预期。 */
  if (cfg.login && cfg.login.ephemeral && !(options && options.adapter)) {
    cfg.chromium.profileDir = fs.existsSync(EPHEMERAL_DIR) ? EPHEMERAL_DIR : ensureEphemeralProfile();
  }
  try {
    const adapter = (options && options.adapter) || createCdpAdapter(cfg);
    adapterRef = adapter
    /* ★ 分层自检：契约不完整立刻暴露（注入的 Mock adapter 也一并检查） */
    try { if (CONTRACT && CONTRACT.assertAdapter) CONTRACT.assertAdapter(adapter, 'run'); } catch (_) {}
    busEmit('learn', 'run-start', { mode: cfg.mode, maxSections: cfg.maxSections });

    /* —— 前置检查 —— */
    await adapter.ensureBrowser();
    if (cfg.course.url) {
      logger.info('PRECHECK', '导航到课程页', { url: String(cfg.course.url).slice(0, 120) });
      await adapter.navigate(cfg.course.url);
    } else {
      const currentUrl = await adapter.getCurrentUrl();
      if (!currentUrl || /^about:blank/.test(currentUrl)) {
        throw new FatalStop('NO_COURSE_URL', '请在 CONFIG.course.url（或 CX_COURSE_URL / --course-url / MCP courseUrl）提供课程学习页地址，或让浏览器停留在该页面。');
      }
      logger.info('PRECHECK', '未提供 course.url，沿用浏览器当前页面', { url: currentUrl.slice(0, 120) });
    }

    /* ★★★ 2026-10-29：自动「点进去」（替代人工提供带 enc 的 URL）★★★
       背景：主人配的 courseUrl 往往是「课程入口页」
         https://mooc1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=xxx
       这种页面 pageHeader=-1、没有 iframe、没有视频，引擎会判「无视频」→ 连续失败 → FATAL。
       而真正能看课的是 studentstudy 页，它必须带 chapterId + enc + openc，
       这三个参数**只有点进去才有**（拼 URL 必然「enc校验失败」）。

       所以这里在导航后自动判断：如果落地页不是可用学习页，就模拟点击
         「进课程」→「章节 tab」→「第一/指定小节」
       拿到真正的学习页 URL，再继续。

       识别「需要点进去」的信号（任一命中）：
         · URL 含 ismooc2=1 / stucoursemiddle（课程入口页）
         · 落地页 pageHeader=-1
         · gatherState 后 hasVideo=false 且 tocFound=false

       安全：全部是导航类点击（进课程/切 tab/点小节），不触碰任何学习元素。 */
    const isEntryPageUrl = (u) => /stucoursemiddle|ismooc2=1/i.test(String(u || ''));
    let needDrillDown = isEntryPageUrl(cfg.course.url);

    if (needDrillDown) {
      logger.info('PRECHECK', '检测到课程入口页，自动点进去（规避 enc 参数缺失）', {
        url: String(cfg.course.url).slice(0, 120),
      });
    }

    machine = new LearnMachine(adapter, cfg);
    activeMachine = machine;
    let st0 = await machine.gatherState();
    if (!st0.frames.length) throw new FatalStop('PAGE_UNREACHABLE', '课程页面不可达（frame 树为空）。请检查 URL 与登录态。');
    if (st0.loginInvalid) throw new FatalStop('LOGIN_REQUIRED', '登录态无效（' + st0.loginEvidence.join('; ') + '）。请人工在浏览器 profile 中重新登录（脚本不会、也不应自动登录），完成后重跑。');
    if (st0.human.length) throw new FatalStop('HUMAN_VERIFICATION', 'FATAL: 需要人工介入 — 启动预检即检测到人工验证特征: ' + st0.human.map((h) => h.evidence).join(', '));

    /* 落地页不可用（没有视频 + 没有目录）→ 自动点进去 */
    if (!needDrillDown && !(st0.video && st0.video.found) && !(st0.toc && st0.toc.found)) {
      const curUrlNow = await adapter.getCurrentUrl().catch(() => '');
      if (/pageHeader=-1/i.test(curUrlNow) || /mooc2-ans.*mycourse\/stu/i.test(curUrlNow)) {
        logger.info('PRECHECK', '落地页无视频无目录，尝试自动点进去', { url: String(curUrlNow).slice(0, 120) });
        needDrillDown = true;
      }
    }

    if (needDrillDown) {
      /* 从 courseUrl 里取 courseid 用于精确匹配课程卡片 */
      let wantCourseId = '';
      try {
        const m0 = String(cfg.course.url || '').match(/courseid=(\d+)/i);
        if (m0) wantCourseId = m0[1];
      } catch (_) { /* ignore */ }

      /* 1) 回课程列表并点进课程 */
      const LANDING = 'https://mooc1.chaoxing.com/visit/interaction';
      logger.info('PRECHECK', '自动点进去：回到课程列表', { landing: LANDING });
      try { await adapter.navigate(LANDING); } catch (_) { /* 已在列表页也无妨 */ }
      await sleep(7000);

      const opened = await openCourseByClick(adapter, '', { maxWaitMs: 30000, cfg, courseId: wantCourseId });
      if (!opened.ok) {
        throw new FatalStop('ENTRY_CLICK_FAILED',
          '自动进入课程失败（' + (opened.reason || '未知') + '）。'
          + ' 请在浏览器里手动点进目标课程的小节，然后把地址栏带 chapterId & enc 的完整 URL 填进「课程地址」。');
      }
      logger.info('PRECHECK', '自动点进去：已进入课程页', { url: String(opened.url || '').slice(0, 120) });
      await sleep(5000);

      /* 2) 点「章节」tab 并等章节树 */
      const prefix = String((cfg.course && cfg.course.sectionPrefix) || '');
      const chOk = await openChapterAndWait(adapter, cfg, { maxRound: 2 });
      if (!chOk || !chOk.ok) {
        throw new FatalStop('ENTRY_CHAPTER_FAILED',
          '进入课程后点「章节」失败。请在浏览器里手动点进目标小节，把带 chapterId & enc 的完整 URL 填进「课程地址」。');
      }
      logger.info('PRECHECK', '自动点进去：章节树已就绪');

      /* 3) 点第一个（或指定）小节，落地到真正的学习页 */
      const sec = await openSectionByClick(adapter, prefix);
      if (!sec.ok) {
        throw new FatalStop('ENTRY_SECTION_FAILED',
          '章节树已就绪但点小节失败（' + (sec.reason || '未知') + '）。');
      }
      logger.info('PRECHECK', '自动点进去：已打开小节', { section: String(sec.text || '').slice(0, 60) });
      await sleep(8000);

      const landedUrl = await adapter.getCurrentUrl().catch(() => '');
      logger.info('PRECHECK', '自动点进去：落地页', { url: String(landedUrl).slice(0, 140) });
      if (!/[?&]chapterId=\d+/i.test(landedUrl)) {
        logger.warn('PRECHECK', '落地 URL 未含 chapterId，继续尝试（可能仍在章节树页）', {
          url: String(landedUrl).slice(0, 140),
        });
      }

      /* 4) 重建 machine 并重新取状态（页面已变） */
      machine = new LearnMachine(adapter, cfg);
      activeMachine = machine;
      st0 = await machine.gatherState();
      if (!st0.frames.length) throw new FatalStop('PAGE_UNREACHABLE', '自动点进去后页面仍不可达。');
      if (st0.loginInvalid) throw new FatalStop('LOGIN_REQUIRED', '自动点进去后登录态失效，请重新扫码登录。');
    }
    const cur0 = st0.toc && st0.toc.items ? st0.toc.items.find((x) => x.current) : null;
    machine._currentTitle = (cur0 && cur0.title) || '当前节';
    machine._videoSeenThisSection = !!(st0.video && st0.video.found);
    /* ★★ 2026-10-30 修：起点不再依赖「学习通上次打开的节」。
       实测症状：昨天播到 3.3 的 98%，今天每次启动都从 1.1 重来。
       原因：current 标记（posCatalog_active）表示「上次打开的节」，登录后重新
       进课程页时它会被重置到第一节 —— 引擎照着它走就等于每次从头开始。

       规则（三条，按优先级）：
         1. 当前打开的那节如果**未完成** → 就在它上面干活（不切节）。
            这是最常见的正常路径：用户/引擎刚才就停在这里。
         2. 当前节已完成、后面还有未完成的 → 定位到第一个未完成节，从它开始。
         3. 全部完成 → 走 ALL_DONE。

       注意 _lastCurIdx 的语义是「引擎当前停在哪」，advanceSection 用
       _lastCurIdx + 1 作为搜索起点，所以「想让某节成为目标」要把索引减 1。 */
    machine._lastCurIdx = null;
    try {
      const items0 = (st0.toc && st0.toc.items) || [];
      /* ★ 2026-10-31（L4）：起跑点规则搬到纯函数 pickStart()，这里只做
         「_lastCurIdx 的偏移换算 + 日志」。判据不再散落在 run() 里。
         注意偏移：advanceSection 以 _lastCurIdx + 1 为搜索起点，
         所以「想让某节成为目标」要把索引减 1。 */
      const start0 = pickStart(items0);
      if (start0.mode === 'stay') {
        machine._lastCurIdx = start0.idx;
        logger.info('PRECHECK', '当前节未完成，原地继续', {
          section: String((items0[start0.idx] && items0[start0.idx].title) || '').slice(0, 60),
          index: start0.idx,
          doneCount: items0.filter((x) => x.done).length,
          totalItems: items0.length,
        });
      } else if (start0.mode === 'jump') {
        machine._lastCurIdx = start0.idx - 1;
        const t0 = items0[start0.idx];
        logger.info('PRECHECK', '当前节已完成，定位到第一个未完成的节', {
          section: String((t0 && t0.title) || '').slice(0, 60),
          index: start0.idx,
          totalItems: items0.length,
          doneCount: items0.filter((x) => x.done).length,
        });
      } else if (items0.length) {
        machine._lastCurIdx = start0.idx;
        logger.info('PRECHECK', '目录内所有节都已完成', { totalItems: items0.length });
      }
    } catch (_) {
      /* 定位失败退回原逻辑（current 标记），不让启动失败 */
      machine._lastCurIdx = st0.toc && st0.toc.items ? st0.toc.items.findIndex((x) => x.current) : -1;
      if (machine._lastCurIdx < 0) machine._lastCurIdx = null;
    }
    // 记住当前节的 chapterId（重载页面时要用；课程 URL 里的是固定的第一节）
    if (cur0 && cur0.chapterId) machine._currentChapterIdValue = cur0.chapterId;
    else {
      try {
        const mu = String(cfg.course.url || '').match(/[?&]chapterId=(\d+)/);
        if (mu) machine._currentChapterIdValue = mu[1];
      } catch (_) { /* ignore */ }
    }
    logger.info('PRECHECK', '前置检查通过', {
      url: st0.topUrl, frames: st0.frames.length,
      hasVideo: !!(st0.video && st0.video.found),
      tocFound: !!(st0.toc && st0.toc.found), tocLayer: st0.toc ? st0.toc.layer : 0,
      section: machine._currentTitle
    });

    /* —— 主循环 —— */
    let consecutiveNonProgress = 0;
    while (!machine.stopReason) {
      if (Date.now() - started > cfg.safety.maxRuntimeMs) { machine.stop('max_runtime_exceeded'); break; }
      await humanize.maybeLongPause();
      let step;
      try {
        step = await machine.tick();
      } catch (e) {
        machine.failures += 1;
        logger.error('LOOP', 'tick 异常，计入连续失败 ' + machine.failures + '/' + cfg.safety.maxConsecutiveFailures, { err: String((e && e.message) || e).slice(0, 200) });
        step = { progress: false, outcome: 'TICK_EXCEPTION' };
      }
      if (machine.stopReason) break;
      if (step.progress) {
        machine.failures = 0;
        consecutiveNonProgress = 0;
      } else {
        consecutiveNonProgress += 1;
        if (machine.failures >= cfg.safety.maxConsecutiveFailures) {
          machine.fatalStop('UNRECOGNIZED_PAGE', '连续 ' + machine.failures + ' 次关键操作失败/页面无法识别，停止并输出诊断');
          break;
        }
        if (consecutiveNonProgress >= cfg.safety.maxConsecutiveFailures * 3) {
          machine.fatalStop('UNRECOGNIZED_PAGE', '连续 ' + consecutiveNonProgress + ' 轮无进展，防呆停止');
          break;
        }
        await humanize.pollDelay();
      }
    }
    if (machine.stopReason && !result.stopReason) result.stopReason = machine.stopReason;
  } catch (e) {
    if (e instanceof FatalStop) {
      result.stopReason = e.code;
      /* ★ B-精简：登录态失效必须走销毁路径。
         会话模式的前提是「登录态还有效」，一旦确认失效，留着一个没登录的
         内核只会占内存（历史上泄漏过 13 个进程 / 1335MB），也让下一次
         「开始看课」误以为会话还可用。 */
      if (e.code === 'LOGIN_REQUIRED') LOGIN_LOST = true;
      logger.error('FATAL', 'FATAL: ' + e.code + ' — ' + e.message);
    } else {
      result.stopReason = 'UNEXPECTED_ERROR';
      logger.error('FATAL', 'FATAL: ' + String((e && e.stack) || e).slice(0, 800));
    }
  } finally {
    activeMachine = null;
    /* ★★★ 2026-10-31（B-精简）：销毁时机从「任务结束」改成「会话结束」 ★★★
       原实现无条件做两件事：关内核 + 删 profile。于是跑完一门课想接着刷第二门，
       或者中途碰壁停下，都必须重新扫码 —— 用户诉求是「整个刷课过程里不死，
       刷完再死」。
       现在由宿主通过 CX_KEEP_BROWSER=1 声明「会话还开着」：
         · 设置了 → 只断开自己的 CDP 连接，内核与 profile 都留着
         · 没设置 → 保持原行为（关内核 + 删 profile），向后兼容
       注意：即使是会话模式，**登录失败**这类异常路径也不允许留内核，
       见下方 keepBrowser 的取反条件。 */
    const keepBrowser = String(process.env.CX_KEEP_BROWSER || '') === '1'
      && !LOGIN_LOST
      /* tick() 里的 fatalStop('LOGIN_REQUIRED') 不经过 throw，要单独判断 */
      && result.stopReason !== 'LOGIN_REQUIRED'
      && !(machine && machine.stopReason === 'LOGIN_REQUIRED');
    if (keepBrowser) {
      try {
        /* 只断连接：shutdown 内部已按 _spawnedByUs 区分 owner/附着方，
           附着方本来就不会关内核；owner 场景下这里也不该关，所以用
           adapter.detach()（若实现）或直接跳过。 */
        if (adapterRef && typeof adapterRef.detach === 'function') {
          await adapterRef.detach();
        } else if (adapterRef && typeof adapterRef.shutdown === 'function') {
          /* 回退路径：老适配器没有 detach 就只有 shutdown。
             我们会把 adapter 标记成「附着模式」再调，避免它误关内核。 */
          if (typeof adapterRef.markAsAttached === 'function') adapterRef.markAsAttached();
          await adapterRef.shutdown();
        }
      } catch (_) { /* ignore */ }
      logger.info('LOOP', '会话未结束：保留内核与登录态，供下一门课复用', {
        stopReason: result.stopReason,
      });
    } else {
      try { await shutdownBrowser(adapterRef); } catch (_) { /* ignore */ }
      /* ★ 只有「自己管理 profile」时才允许删它。
         注入 adapter（自测 / 外部调用）意味着调用方不拥有真实 profile，
         这时候删掉 $TMPDIR/cx-learn-ephemeral/session 会把**正在使用的
         在线登录态**一起删掉 —— 实测风险：跑一次 --self-test 就能把
         用户刚扫的码作废。
         判据与开头创建 profile 的条件严格对称（见 run() 开头的
         `!(options && options.adapter)`）。 */
      const ownsProfile = !(options && options.adapter);
      if (ownsProfile) {
        try { cleanupEphemeralProfile(); } catch (_) { /* ignore */ }
      }
    }
  }

  if (machine) {
    result.stopReason = result.stopReason || machine.stopReason || 'unknown';
    result.ok = machine.stoppedNormally;
    result.sectionsCompleted = machine.counters.sectionsCompleted;
    result.sectionsSkipped = machine.counters.sectionsSkipped;
    result.quizzesAnswered = machine.counters.quizzesAnswered;
    result.dialogsDismissed = machine.counters.dialogsDismissed;
  }
  result.elapsedMs = Date.now() - started;
  result.logs = logger.tail(40);
  logger.log('SUMMARY', result.ok ? 'INFO' : 'ERROR', '运行结束', {
    ok: result.ok, stopReason: result.stopReason,
    sectionsCompleted: result.sectionsCompleted, sectionsSkipped: result.sectionsSkipped,
    quizzesAnswered: result.quizzesAnswered, dialogsDismissed: result.dialogsDismissed,
    elapsedMs: result.elapsedMs
  });
  return result;
}

module.exports = {
  activeMachine,
  run
};
