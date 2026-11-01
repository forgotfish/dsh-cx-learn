/* ============================================================================
 * chaoxing-autolearn.js — 引擎入口（薄壳）
 * ----------------------------------------------------------------------------
 * 2026-10-30 重写：原来 8133 行的单文件按职责拆到 engine/src/ 下，本文件只负责
 *   1) 组装模块并导出对外的稳定 API（宿主 index.js 用 spawn 调用本文件，路径不变）
 *   2) CLI 分发（--login / --self-test / --check-login / --probe / --course-report /
 *      --section-report / --scan-all / --list-courses / --serve-mcp / 默认看课）
 *
 * 模块地图（详见各文件顶部注释）：
 *   core/base.js        内置依赖、分层中间件加载、FatalStop、sleep、VERSION
 *   core/config.js      CONFIG 默认值、mergeConfig、validateConfig
 *   core/logging.js     humanize（拟人化延迟）、logger（结构化日志）
 *   core/questions.js   题目事件 JSONL（识别 → 人工审阅，不含答案）
 *   browser/args.js     内核启动参数、调试端口发现、启动失败归因（纯函数）
 *   browser/cdp.js      CDP 适配器（浏览器层）
 *   browser/exit-guard.js 进程退出守卫
 *   learn/selectors.js  SELECTORS + 页面探针脚本 + 注入表达式
 *   learn/machine.js    LearnMachine 业务状态机
 *   learn/run.js        run() 主循环
 *   login/index.js      扫码登录 / 一次性 profile / 登录态预检
 *   courses.js          课程列表、只读结构扫描、课程报告
 *   mcp.js              MCP stdio server + CLI 参数解析
 *   selftest.js         自测 + Mock 适配器
 *
 * 安全边界（不变）：只看视频、随堂题盲试、章节测验绝不触碰、遇人工验证立即停。
 * ==========================================================================*/
'use strict';

/* ★★★ 测试隔离必须在这里设，不能等到 selfTest() 里面 ★★★
 * state-bus.js 在**模块加载时**就算好了状态根目录（`const abs = ...`），
 * 之后改 process.env.CX_STATE_DIR 对它无效。实测过：把设置写在
 * selfTest() 函数体里，跑完自测生产 learn.json 的 mtime 照样被改写。
 *
 * 所以：只要是自测/只读诊断这类**不该碰生产状态**的入口，
 * 就在 require 任何业务模块之前把状态目录切到临时目录。 */
{
  const a = process.argv.slice(2);
  const isReadOnly = a.includes('--self-test');
  if (isReadOnly && !process.env.CX_STATE_DIR) {
    const path = require('node:path');
    const os = require('node:os');
    process.env.CX_STATE_DIR = path.join(os.tmpdir(), 'cx-selftest-' + process.pid);
  }
}

const { fs, sleep, VERSION } = require('./src/core/base.js');
const { CONFIG, mergeConfig } = require('./src/core/config.js');
const { humanize, logger } = require('./src/core/logging.js');
const { installExitGuard } = require('./src/browser/exit-guard.js');
const {
  buildChromiumArgs, mergeChromiumArgs, readDevToolsActivePort, isHeadlessShellKernel,
  resolveCdpPort, describeLaunchExit, inspectProfileLock, isProfileWritable,
  CHROMIUM_EXIT_CODES, isBareCommandName
} = require('./src/browser/args.js');
const { createCdpAdapter } = require('./src/browser/cdp.js');
const { SELECTORS, PAGE_PROBE_SRC, installProbeExpression } = require('./src/learn/selectors.js');
const { LearnMachine } = require('./src/learn/machine.js');
const { run } = require('./src/learn/run.js');
const {
  runLogin, checkLoginState, EPHEMERAL_DIR, ensureEphemeralProfile, cleanupEphemeralProfile,
  shutdownBrowser
} = require('./src/login/index.js');
const {
  openChapterTab, waitForChapterFrame, probePageStructure, openCourseByClick,
  openChapterAndWait, openSectionByClick, scanTaskPoints, scanAllCourses,
  buildCourseReport, runListCourses, listTargets
} = require('./src/courses.js');
const { serveMcp, parseArgs } = require('./src/mcp.js');
const { selfTest, createMockAdapter } = require('./src/selftest.js');

/* 退出守卫要在模块加载时就装上：之后任何退出路径（正常/异常/SIGTERM）都会收掉浏览器，
   否则 headless Chrome 会一直占着调试端口和 profile 目录。 */
installExitGuard();

module.exports = {
  /* 业务入口 */
  run, runLogin, checkLoginState, LearnMachine, selfTest, createMockAdapter,
  /* 配置与页面 */
  CONFIG, mergeConfig, SELECTORS, PAGE_PROBE_SRC, installProbeExpression,
  humanize, logger, VERSION,
  /* 浏览器层：适配器 + 启动参数（纯函数，便于独立测试） */
  createCdpAdapter, buildChromiumArgs, mergeChromiumArgs, readDevToolsActivePort,
  isHeadlessShellKernel, resolveCdpPort, describeLaunchExit, inspectProfileLock,
  isProfileWritable, CHROMIUM_EXIT_CODES, isBareCommandName,
  /* 课程扫描 / 报告 */
  runListCourses, scanAllCourses, buildCourseReport, scanTaskPoints, probePageStructure,
  openCourseByClick, openChapterTab, openChapterAndWait, openSectionByClick,
  waitForChapterFrame, listTargets,
  /* 登录与 profile */
  EPHEMERAL_DIR, ensureEphemeralProfile, cleanupEphemeralProfile, shutdownBrowser,
  /* 其它 */
  serveMcp, parseArgs
};

/* ── CLI 入口 ───────────────────────────────────────────────────────────────*/
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    selfTest().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error('自测异常:', e && e.stack || e); process.exit(1); });
  } else if (args['check-login']) {
    /* 登录态预检：只访问个人空间判断是否已登录，不开二维码。宿主 start 前调用。 */
    checkLoginState()
      .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok && r.loggedIn ? 0 : 3); })
      .catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
  } else if (args['probe']) {
    /* ★ 只读结构识别：扫描课程页结构（含跨域 iframe 穿透），
       不播放、不点击、不答题、不提交。主人 2026-10-27 要求先定框架再试播放。 */
    (async () => {
      const cfg = mergeConfig(CONFIG, {});
      const adapter = createCdpAdapter(cfg);
      try {
        await adapter.ensureBrowser();
        const target = args['course-url'] ? String(args['course-url']) : '';
        if (target) {
          console.log('[probe] navigate -> ' + target.slice(0, 140));
          await adapter.navigate(target);
          await sleep(5000);
        }
        // 新版课程主页：先点开「章节」tab，否则章节树不会加载
        const firstPass = await probePageStructure(adapter, { maxDepth: 2, maxFrames: 6 });
        if (firstPass.summary && firstPass.summary.pageKind === 'mooc2-home') {
          console.log('[probe] 检测到新版课程主页，点开「章节」tab');
          const r = await openChapterTab(adapter);
          if (r.ok) await sleep(4000);
          else console.log('[probe] 未能点开章节: ' + (r.reason || ''));
        }
        const report = await probePageStructure(adapter, {
          maxDepth: Number(args['max-depth'] || 4),
          maxFrames: Number(args['max-frames'] || 20),
        });
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
      } catch (e) {
        console.error('FATAL: ' + String((e && e.stack) || e).slice(0, 800));
        process.exit(1);
      }
    })();
  } else if (args['course-report']) {
    /* ★ 完整课程识别报告：章节树 + 每节状态 + 任务点（只读，不播放不答题）
       ★ 风控要求：进课程必须模拟点击，不能直接 navigate。 */
    (async () => {
      const cfg = mergeConfig(CONFIG, {});
      const adapter = createCdpAdapter(cfg);
      try {
        await adapter.ensureBrowser();
        // 唯一允许的 navigate：打开学习通首页/课程列表（之后全部走点击）
        const landing = args['course-url'] ? String(args['course-url']) : 'https://mooc1.chaoxing.com/visit/interaction';
        console.log('[report] navigate(landing) -> ' + landing.slice(0, 140));
        await adapter.navigate(landing);
        await sleep(7000);

        // 若当前还不在课程页，按课程名模拟点击进入
        let cur = '';
        try { cur = await adapter.getCurrentUrl(); } catch (_) { cur = ''; }
        const onCourse = /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/i.test(cur);
        if (!onCourse) {
          const kw = args.course ? String(args.course) : '';
          const r = await openCourseByClick(adapter, kw, { maxWaitMs: 30000, cfg });
          if (!r.ok) {
            console.log(JSON.stringify({ reason: '进入课程失败: ' + r.reason, step: 'openCourseByClick' }, null, 2));
            process.exit(2);
          }
        }
        const rep = await buildCourseReport(adapter, {});
        console.log(JSON.stringify(rep, null, 2));
        process.exit(0);
      } catch (e) {
        console.error('FATAL: ' + String((e && e.stack) || e).slice(0, 800));
        process.exit(1);
      }
    })();
  } else if (args['scan-all']) {
    /* ★ 批量扫描全部课程（只读）：不播放、不答题，只出识别报告 */
    (async () => {
      const cfg = mergeConfig(CONFIG, {});
      const adapter = createCdpAdapter(cfg);
      try {
        await adapter.ensureBrowser();
        const rep = await scanAllCourses(adapter, {
          cfg,
          limit: Number(args.limit || 0) || 5,
          gapMinMs: Number(args['gap-min'] || 0) || 25000,
          gapMaxMs: Number(args['gap-max'] || 0) || 45000,
          batchSize: Number(args['batch-size'] || 0) || 5,
          batchRestMinMs: Number(args['batch-rest-min'] || 0) || 60000,
          batchRestMaxMs: Number(args['batch-rest-max'] || 0) || 120000,
        });
        console.log(JSON.stringify(rep, null, 2));
        process.exit(0);
      } catch (e) {
        console.error('FATAL: ' + String((e && e.stack) || e).slice(0, 900));
        process.exit(1);
      }
    })();
  } else if (args['section-report']) {
    /* ★ 识别指定小节的任务点（只读：点章节 tab + 点小节，不播放不答题） */
    (async () => {
      const cfg = mergeConfig(CONFIG, {});
      const adapter = createCdpAdapter(cfg);
      try {
        await adapter.ensureBrowser();
        const landing = 'https://mooc1.chaoxing.com/visit/interaction';
        console.log('[section] navigate(landing) -> ' + landing);
        await adapter.navigate(landing);
        await sleep(7000);

        // 1) 模拟点击进入课程
        const kw = args.course ? String(args.course) : '';
        const r = await openCourseByClick(adapter, kw, { maxWaitMs: 30000, cfg });
        if (!r.ok) {
          console.log(JSON.stringify({ reason: '进入课程失败: ' + r.reason }, null, 2));
          process.exit(2);
        }

        // 2) 点「章节」tab
        const ch = await openChapterTab(adapter);
        if (!ch.ok) {
          console.log(JSON.stringify({ reason: '点章节失败: ' + ch.reason }, null, 2));
          process.exit(2);
        }
        const ready = await waitForChapterFrame(adapter, 25000);
        if (!ready) {
          console.log(JSON.stringify({ reason: '章节 iframe 未就绪' }, null, 2));
          process.exit(2);
        }

        // 3) 点开指定小节
        const sec = args.section ? String(args.section) : '';
        const so = await openSectionByClick(adapter, sec);
        if (!so.ok) {
          console.log(JSON.stringify({ reason: '点小节失败: ' + so.reason }, null, 2));
          process.exit(2);
        }
        console.log('[section] 已打开: ' + so.text);

        // 4) 等加载后扫描任务点
        await sleep(6000);
        const scan = await scanTaskPoints(adapter);
        console.log(JSON.stringify(scan, null, 2));
        process.exit(0);
      } catch (e) {
        console.error('FATAL: ' + String((e && e.stack) || e).slice(0, 800));
        process.exit(1);
      }
    })();
  } else if (args['serve-mcp']) {
    serveMcp();
  } else if (args['list-courses']) {
    runListCourses()
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 2); })
      .catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
  } else if (args.login) {
    /* 一次性扫码登录：node chaoxing-autolearn.js --login
       截图实时写入 CONFIG.login.shotDir/latest.png，手机学习通 App 扫码即可 */
    runLogin()
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 2); })
      .catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
  } else {
    const overrides = {};
    if (args.mode) overrides.mode = String(args.mode);
    if (args['max-sections']) overrides.maxSections = Number(args['max-sections']);
    if (args['course-url']) overrides.course = { url: String(args['course-url']) };
    if (args['cdp-port']) overrides.cdp = { port: Number(args['cdp-port']) };
    if (args.chromium) overrides.chromium = { executablePath: String(args.chromium) };
    run(overrides)
      .then((r) => {
        console.log('\n=== RESULT ===');
        console.log(JSON.stringify(Object.assign({}, r, { logs: r.logs.slice(-12) }), null, 2));
        process.exit(r.ok ? 0 : 2);
      })
      .catch((e) => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
  }
}
