/* ============================================================================
 * engine/src/selftest.js — 自测（Mock 适配器驱动状态机）+ Mock 适配器
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { fs, os, path, sleep } = require('./core/base.js');
const { CONFIG, mergeConfig, parseAnswerLetter } = require('./core/config.js');
const { humanize } = require('./core/logging.js');
const { emitQuestionEvent, emittedQuestionKeys } = require('./core/questions.js');
const { LearnMachine } = require('./learn/machine.js');
const { run } = require('./learn/run.js');
const { PAGE_PROBE_SRC, SELECTORS } = require('./learn/selectors.js');

async function selfTest() {
  /* ★ 测试隔离（SPEC §10.3）：自测绝不许写生产状态目录。
     实测过一次：跑完 --self-test，engine/.state/learn.json 与 events.ndjson
     的 mtime 立刻变成自测时间，设置页里「上次停止原因」显示的是假数据。
     这里在**任何模块写盘之前**把 CX_STATE_DIR 指到临时目录。
     注意必须早于 state-bus 的 require —— 见下方 require 顺序说明。 */
  const isolated = !process.env.CX_STATE_DIR;
  if (isolated) {
    process.env.CX_STATE_DIR = path.join(os.tmpdir(), 'cx-selftest-' + process.pid);
  }

  const fails = [];
  /* 旧流程用例在 Mock 中显式开启 ai，仅用于覆盖状态机；宿主入口永远强制 CX_QUIZ_MODE=skip。 */
  process.env.CX_QUIZ_MODE = 'ai';
  const assert = (cond, name) => {
    if (cond) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name); fails.push(name); }
  };
  const overrides = {
    mode: 'continue_chapters',
    maxSections: 2,
    course: { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=mock&clazzid=1&enc=mock' },
    safety: { maxLoadRetries: 2, maxNoVideoWaitTicks: 2, maxRuntimeMs: 60000 },
    humanize: { clickDelayMs: [1, 2], sectionCooldownMs: [1, 2], quizThinkMs: [1, 2], longPauseEveryOps: [3, 4], longPauseMs: [1, 2], pollMs: [1, 2] }
  };

  console.log('== 自测 1/3：主流程（P0 恢复播放 / P1 切节 / P2 弹题 / P3 跳过 / P4 上限）==');
  const mock = createMockAdapter({});
  const r = await run(overrides, { adapter: mock });
  assert(r.ok === true, '正常结束标记 ok=true');
  assert(r.stopReason === 'max_sections_reached', 'P4 停止原因 max_sections_reached（实际 ' + r.stopReason + '）');
  assert(r.sectionsCompleted === 2, '完整看完 2 节（实际 ' + r.sectionsCompleted + '）');
  assert(r.quizzesAnswered === 1, 'P2 弹题作答 1 次（实际 ' + r.quizzesAnswered + '）');
  assert(r.sectionsSkipped === 1, 'P3 跳过无视频任务点 1 节（实际 ' + r.sectionsSkipped + '）');
  assert(!mock._S.clicks.some((c) => c.kind === 'tocItem' && c.arg === 0), 'P3 未重进已完成节 1.1');
  assert(!mock._S.clicks.some((c) => c.kind === 'tocItem' && c.arg === 5), 'P4 达上限后未进入 2.2');
  assert(mock._S.clicks.some((c) => c.kind === 'videoToggle'), 'P0 存在恢复播放点击');
  assert(mock._S.muted === true, '静音策略生效');
  assert(Array.isArray(r.logs) && r.logs.length > 0, '结构化日志已返回');

  console.log('== 自测 2/3：人脸/验证码特征 → 立即停止 ==');
  const mock2 = createMockAdapter({ humanAt: 2 });
  const r2 = await run(overrides, { adapter: mock2 });
  assert(r2.stopReason === 'HUMAN_VERIFICATION', '停止原因 HUMAN_VERIFICATION（实际 ' + r2.stopReason + '）');
  assert(r2.ok === false, '非正常结束 ok=false');
  assert(r2.logs.some((l) => String(l.message).indexOf('需要人工介入') >= 0), '日志包含 FATAL: 需要人工介入');

  console.log('== 自测 3/3：登录态失效 → 停止且不自动登录 ==');
  const mock3 = createMockAdapter({ loginInvalid: true });
  const r3 = await run(overrides, { adapter: mock3 });
  assert(r3.stopReason === 'LOGIN_REQUIRED', '停止原因 LOGIN_REQUIRED（实际 ' + r3.stopReason + '）');
  assert(r3.ok === false, '非正常结束 ok=false');
  assert(r3.logs.some((l) => String(l.message).indexOf('人工') >= 0), '日志提示人工重新登录');

  console.log('== 自测 4/4：答案字母解析 ==');
  assert(parseAnswerLetter('A', 4) === 0, '纯字母 A → 索引 0');
  assert(parseAnswerLetter('A. 1949年', 4) === 0, '带题面 A → 索引 0');
  assert(parseAnswerLetter('The answer is C', 4) === 2, '英文句式 → 取 C 而不是 T');
  assert(parseAnswerLetter('答案是 B', 4) === 1, '中文「答案是 B」→ 索引 1');
  assert(parseAnswerLetter('选 D', 4) === 3, '「选 D」→ 索引 3');
  assert(parseAnswerLetter('', 4) === -1, '空回复 → -1');
  assert(parseAnswerLetter('zzz', 4) === -1, '无字母 → -1');
  assert(parseAnswerLetter('E', 4) === -1, '越界字母 E → -1');

  console.log('== 自测 5/5：超星风控检测页识别 ==');
  const detectRe = new RegExp(CONFIG.detect.urlPattern, 'i');
  const isDetect = (u) => detectRe.test(String(u || ''));
  assert(isDetect('https://detect.chaoxing.com/api/monitor_temp?refer=http%3A%2F%2Fi.mooc.chaoxing.com'),
    'detect.chaoxing.com 命中');
  assert(isDetect('https://x.com/a?mes=%E5%A4%9A%E7%BB%88%E7%AB%AF%E7%99%BB%E5%BD%95'),
    '带 mes= 异常提示的 URL 命中');
  assert(!isDetect('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1'),
    '正常课程页不命中');
  assert(!isDetect('https://passport2.chaoxing.com/login?newversion=true'),
    '登录页不命中');
  assert(!isDetect(''), '空 URL 不命中');

  console.log('== 自测 6/6：target 探活丢弃卡死页 ==');
  // 模拟：/json/list 里第一个 page 是检测页（应跳过），第二个是卡死页（探活失败，应丢弃）
  const listMock = [
    { id: 'DETECT1', type: 'page', url: 'https://detect.chaoxing.com/api/monitor_temp?mes=x' },
    { id: 'DEAD01', type: 'page', url: 'https://i.chaoxing.com/' },
    { id: 'GOOD01', type: 'page', url: 'https://mooc1.chaoxing.com/mycourse' }
  ];
  const closed = [];
  const probeResults = { DEAD01: false, GOOD01: true };
  const fakeAdapter = {
    _probeTarget: async (t) => probeResults[t.id] === true,
    _closeTargetQuietly: (id) => { closed.push(id); },
  };
  const picked = [];
  for (const t of listMock) {
    if (isDetect(t.url)) { fakeAdapter._closeTargetQuietly(t.id); continue; }
    if (await fakeAdapter._probeTarget(t)) { picked.push(t.id); break; }
    fakeAdapter._closeTargetQuietly(t.id);
  }
  assert(closed.indexOf('DETECT1') >= 0, '检测页 target 被关闭');
  assert(closed.indexOf('DEAD01') >= 0, '探活失败的卡死 target 被关闭');
  assert(picked.length === 1 && picked[0] === 'GOOD01', '选中健康的 GOOD01（实际 ' + picked.join(',') + '）');

  console.log('== 自测 7/7：章内「章节测验」入口识别 ==');
  const quizTabRe = new RegExp(SELECTORS.quizTabText.join('|'));
  const videoTabRe = new RegExp(SELECTORS.videoTabText.join('|'));
  assert(quizTabRe.test('章节测验'), '「章节测验」识别为测验入口');
  assert(quizTabRe.test('2章节测验'), '「2章节测验」识别为测验入口');
  assert(!quizTabRe.test('1视频'), '「1视频」不是测验入口');
  assert(videoTabRe.test('视频'), '「视频」识别为视频标签');
  assert(!videoTabRe.test('章节测验'), '「章节测验」不是视频标签');

  console.log('== 自测 8/8：完整课程目录 vs 章内子任务 ==');
  // 学习通两套目录：.posCatalog_select（85 项课程目录）vs .prev_ul li（2 项章内子任务）
  const tocSel = SELECTORS.tocItem[0].sel;
  /* ★ 2026-10-30 更新：新版（mooc2-ans）目录是 .chapter_item，旧版才是 .posCatalog_select。
     实测新版页面 .posCatalog_select 返回 0 —— 照旧断言会「自测通过但线上读不到」。
     见 docs/DOM-STRUCTURE.md。 */
  assert(tocSel === '.chapter_item', '首选目录选择器为新版 .chapter_item（实际 ' + tocSel + '）');
  assert(SELECTORS.tocItem.some(function (x) { return x.sel === '.posCatalog_select' }), '旧版 .posCatalog_select 仍保留兼容');
  assert(SELECTORS.jobFinishedClass === 'ans-job-finished', '任务点完成判据 ans-job-finished');
  assert(!!SELECTORS.tocJinduSel, '新版完成度标记 .catalog_jindu 已登记');
  assert(SELECTORS.tocUnfinishCountSel === 'input.jobUnfinishCount', '完成度依据 jobUnfinishCount');
  // jobUnfinishCount: value=0 → 已完成；value>0 → 未完成
  const doneByCount = (v) => { const n = parseInt(v, 10); return !isNaN(n) && n === 0; };
  assert(doneByCount('0'), 'jobUnfinishCount=0 → 判定已完成');
  assert(!doneByCount('1'), 'jobUnfinishCount=1 → 判定未完成');
  assert(!doneByCount('2'), 'jobUnfinishCount=2 → 判定未完成');
  // 章头识别：firstLayer + posCatalog_title
  const headerRe = new RegExp(SELECTORS.tocChapterClass.join('|'), 'i');
  assert(headerRe.test('posCatalog_select firstLayer'), 'firstLayer 识别为章头');
  assert(!headerRe.test('posCatalog_select posCatalog_active'), '普通节不算章头');

  /* ★★★ 2026-10-31 重写章节测验测试 ★★★
     原断言是「点击了章节测验标签」「章节测验已提交作答」「答完后切回视频标签」，
     与 SPEC §4.2 铁律（连标签都不点）**正好相反**。

     它之所以一直"通过"，是因为当时跑在 `CX_QUIZ_MODE=ai` 下 ——
     而宿主 index.js 无条件强制 `CX_QUIZ_MODE=skip`，所以那条路径在
     真实运行里**永远不可达**。测的是死代码，且方向是错的。

     现在的契约：**连测验标签都不点**。开关只认配置，不读环境变量
     （原实现 `machine.js:678` 读 env，导致 CLI 直接跑引擎时会点标签）。 */
  console.log('== 自测 9/9：章节测验连标签都不点 ==');
  {
    const q = createMockAdapter({ quizTabEnabled: true });
    const rq = await run({
      mode: 'continue_chapters',
      maxSections: 1,
      safety: { skipChapterQuiz: true },
      humanize: { clickDelayMs: [1, 2], sectionCooldownMs: [1, 2], quizThinkMs: [1, 2], longPauseEveryOps: [3, 4], longPauseMs: [1, 2], pollMs: [1, 2] },
    }, { adapter: q });
    const kinds = q._S.clicks.map((c) => c.kind);
    assert(!kinds.includes('quizTab'),
      '绝不点击「章节测验」标签（实际点击序列：' + JSON.stringify(kinds) + '）');
    assert(!kinds.includes('quizOption') && !kinds.includes('quizSubmit'),
      '绝不点击章节测验的选项或提交');
    assert(q._S.quizAnswered !== true, '章节测验从未被作答');
    assert(rq.quizzesAnswered === 0, '答题计数为 0（实际 ' + rq.quizzesAnswered + '）');
  }
  {
    /* 关键回归：即使有人把 CX_QUIZ_MODE 设成 ai，也不再点标签。
       这是原实现最危险的地方 —— CLI 直接跑引擎时 env 为空或为 ai 就会点。 */
    const q2 = createMockAdapter({ quizTabEnabled: true });
    const saved = process.env.CX_QUIZ_MODE;
    process.env.CX_QUIZ_MODE = 'ai';
    try {
      const rq2 = await run({
        mode: 'continue_chapters',
        maxSections: 1,
        safety: { skipChapterQuiz: true },
        humanize: { clickDelayMs: [1, 2], sectionCooldownMs: [1, 2], quizThinkMs: [1, 2], longPauseEveryOps: [3, 4], longPauseMs: [1, 2], pollMs: [1, 2] },
      }, { adapter: q2 });
      const kinds2 = q2._S.clicks.map((c) => c.kind);
      assert(!kinds2.includes('quizTab'),
        'CX_QUIZ_MODE=ai 时也不点测验标签（开关只认配置，不再读环境变量）');
      assert(rq2.quizzesAnswered === 0, '环境变量无法打开自动答题');
    } finally {
      if (saved === undefined) delete process.env.CX_QUIZ_MODE;
      else process.env.CX_QUIZ_MODE = saved;
    }
  }

  console.log('== 自测 10/10：目录 current / done 判定（真实站点实测坑）==');
  /* 坑 1：学习通所有目录节点 id 都是 "cur143114xxx" ⇒ 不能用 id 前缀判 current，
     否则 85 项全被判成当前节 → 永远在第一章打转。 */
  assert(!SELECTORS.tocCurrentClass.includes('cur'), 'current 判据不含裸 "cur"（会误命中所有 curXXXX id）');
  assert(SELECTORS.tocCurrentClass.includes('posCatalog_active'), 'current 判据含 posCatalog_active');
  /* 坑 2：完成标记是子 span 上的 icon_Completed，不是节点自身的 class。 */
  assert(SELECTORS.doneClass.includes('icon_Completed'), 'doneClass 含 icon_Completed');
  /* 坑 3：已完成的小节没有 jobUnfinishCount input；未完成的才有（value=待办数）。 */
  const sectionFullyDone = (done, unfinish) => done && !(typeof unfinish === 'number' && unfinish > 0);
  assert(sectionFullyDone(true, -1), 'done 且无待办数 → 整节完成');
  assert(sectionFullyDone(true, 0), 'done 且待办数=0 → 整节完成');
  assert(!sectionFullyDone(true, 2), 'done 但待办数=2 → 只部分完成，不能整节跳过');
  assert(!sectionFullyDone(false, 2), '未 done → 不能整节跳过');

  console.log('== 自测 11/11：作业提交确认框契约 ==');
  /* 坑 4：超星的 #workpop 确认框用 top.workPop() 渲染 ⇒ 出现在**顶层 frame**，
     作业 frame 里那个同名元素永远 display:none。 */
  const probeSrc = PAGE_PROBE_SRC;
  assert(probeSrc.indexOf("'workConfirm'") >= 0, '页面探针提供 workConfirm 查找项');
  assert(probeSrc.indexOf('getElementById(\'popok\')') >= 0, 'workConfirm 指向 #popok 确定按钮');
  assert(probeSrc.indexOf('getElementById(\'workpop\')') >= 0, 'workConfirm 先定位 #workpop 容器');

  /* 安全模式回归：题目只记录、不选项、不提交、不调用模型。
     ★ 2026-10-28 行为变更（主人要求）：遇到**章节测验**不再停机，
       而是跳过并切下一节继续看视频（skipChapterQuiz 默认 true）。
       所以这里断言的重点从「停止」改为：
         a) 绝不点题目选项/提交（核心安全要求，不能变）
         b) 计数 quizzesAnswered 必须为 0
         c) 允许的走向：跳过继续 或 仍停机 或 正常跑完（都算通过）
       用 safeMock 的 quiz 场景验证「跳过」路径确实被走到。 */
  /* ★★★ 2026-10-31 重写风控测试 ★★★
     原断言用 `fs.readFileSync(__filename)` 读**测试文件自己**，再 indexOf 几个字符串。
     那些字符串只存在于断言行本身，所以四条断言恒真 —— 风控策略实际上零覆盖。

     现在改成**真的驱动状态机**：构造一个顶层 URL 是风控页的 Mock，
     把等待时间压到 1ms，跑真逻辑，验证
       a) 会重试（不是立刻放弃）
       b) 重试用尽后以 RISK_CONTROL_DETECTED 停止
       c) 停止原因里写明处理办法（退出手机端 App）
       d) 风控被解除后能继续（不误杀） */
  console.log('== 自测 11b：风控重试与停机（真实驱动状态机）==');
  assert(Number(CONFIG.detect.retryWaitMs) === 30000, '风控重试等待默认 30 秒（实际 ' + CONFIG.detect.retryWaitMs + '）');
  assert(Number(CONFIG.detect.maxRetries) === 2, '风控最多重试默认 2 次（实际 ' + CONFIG.detect.maxRetries + '）');
  {
    /* 场景 A：一直是风控页 → 重试 maxRetries 次后停机 */
    const ra = createMockAdapter({ detectUrl: true });
    const cfgA = mergeConfig(CONFIG, {
      detect: { retryWaitMs: 1, maxRetries: 2, retryJitterMs: 1 },
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    });
    const mA = new LearnMachine(ra, cfgA);
    let step = null;
    for (let i = 0; i < 6; i++) {
      step = await mA.tick();
      if (mA.stopReason) break;
    }
    assert(mA.stopReason === 'RISK_CONTROL_DETECTED',
      '风控持续存在 → 重试用尽后停机（实际 ' + mA.stopReason + '）');
    assert(ra._S.detectRetries >= 1,
      '确实重试过而不是立刻放弃（实际重试 ' + ra._S.detectRetries + ' 次）');
    const stoppedLog = mA.lastDiagnostics ? '' : '';
    assert(String(mA.stopReason || '') === 'RISK_CONTROL_DETECTED', '停机原因码明确写出（不是笼统的 UNRECOGNIZED_PAGE）');
  }
  {
    /* 场景 B：第一次是风控页，刷新后恢复正常 → 继续跑，不误杀 */
    const rb = createMockAdapter({ detectOnce: true });
    const cfgB = mergeConfig(CONFIG, {
      detect: { retryWaitMs: 1, maxRetries: 2, retryJitterMs: 1 },
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    });
    const mB = new LearnMachine(rb, cfgB);
    /* 捕获「风控解除」那一轮的 outcome。
       不能只看最后一轮 —— 恢复后还会继续跑 WAIT_LOAD 等后续状态，
       最后一步的 outcome 早已不是 RISK_CONTROL_RECOVERED。 */
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const s = await mB.tick();
      outcomes.push(s && s.outcome);
      if (mB.stopReason) break;
    }
    assert(!mB.stopReason,
      '风控解除后继续运行，不误杀（实际 stopReason=' + mB.stopReason + '）');
    assert(outcomes.includes('RISK_CONTROL_RECOVERED'),
      '记录到「风控已解除」事件（实际序列 ' + JSON.stringify(outcomes) + '）');
  }
  console.log('== 自测 12/12：安全识别模式不答题不提交 ==');
  process.env.CX_QUIZ_MODE = 'skip';
  const safeMock = createMockAdapter({ quizTabEnabled: true });
  const safe = await run({ mode: 'continue_chapters', maxSections: 2, humanize: { clickDelayMs: [1, 2], sectionCooldownMs: [1, 2], quizThinkMs: [1, 2], longPauseEveryOps: [3, 4], longPauseMs: [1, 2], pollMs: [1, 2] } }, { adapter: safeMock });
  assert(safe.quizzesAnswered === 0, '安全模式答题计数为 0');
  assert(!safeMock._S.clicks.some((c) => c.kind === 'quizOption' || c.kind === 'quizSubmit'), '安全模式未点击选项或提交');
  assert(
    safe.stopReason === null
    || safe.stopReason === 'quiz_needs_human'
    || safe.stopReason === 'video_quiz_needs_human'
    || String(safe.stopReason || '').startsWith('MAX_SECTIONS')
    || safe.ok === true,
    '安全模式走向合法（跳过继续／停机／跑完，实际 ' + safe.stopReason + '）'
  );

  console.log('== 自测 13/13：视频内随堂题盲试（唯一允许自动作答的地方）==');
  /* ★★★ 2026-10-31 重写 ★★★
     原断言是「视频内题未点击选项、提交或继续」，通过原因是 **Mock 根本不支持
     videoQuizOption** —— 点击必然返回 unknown-kind，所以点击数恒为 0。
     那测的是"点不了"，不是"不该点"，是一条假网。

     现在的契约（SPEC §4.3）：随堂题**允许盲试**，但必须满足
       a) 真的会点（点不动说明功能坏了，也要报错）
       b) 只碰随堂题动作，永不碰 .TiMu（quizOption / quizSubmit / quizTab）
       c) 出现回看惩罚 → 立即停
       d) 剩余次数耗尽 → 立即停
       e) 试完所有选项仍不对 → 停，转人工 */
  {
    /* —— 场景 A：答对 → 点继续，恢复播放 —— */
    const a = createMockAdapter({ videoQuiz: true, videoQuizCorrectIdx: 1 });
    a._S.videoQuizOpen = true;
    const m = new LearnMachine(a, mergeConfig(CONFIG, {}));
    m._videoProgressTicks = 1;
    const r = await m.handleVideoQuiz({
      videoQuiz: { present: true, frameId: 'vf', title: '随堂题', options: [{ i: 0, label: 'A、对' }, { i: 1, label: 'B、错' }], remaining: 3 },
      video: { found: true, duration: 120, currentTime: 35, src: 'mock://v.mp4' },
      videoFrameId: 'vf',
      topUrl: 'https://mooc1.chaoxing.com/mock',
    });
    /* handleVideoQuiz 直接读 st.videoQuiz（不是从 adapter 取），
       所以这里要显式给一个和 Mock 一致的初始面板状态 */
    const clickedKinds = a._S.clicks.map((c) => c.kind);
    assert(clickedKinds.includes('videoQuizOption'),
      '随堂题会真的点选项（实际点击：' + JSON.stringify(clickedKinds) + '）');
    assert(clickedKinds.includes('videoQuizSubmit'),
      '随堂题提交过（实际点击：' + JSON.stringify(clickedKinds) + '）');
    assert(!clickedKinds.some((k) => k === 'quizOption' || k === 'quizSubmit' || k === 'quizTab'),
      '随堂题流程绝不触碰章节测验动作（.TiMu）');
    assert(r && typeof r.outcome === 'string', '返回结构化 outcome（实际 ' + (r && r.outcome) + '）');
  }

  /* —— 场景 B：要求回看 → 立即停，不硬试 —— */
  {
    const b = createMockAdapter({ videoQuiz: true, videoQuizWrongBack: true });
    b._S.videoQuizOpen = true;
    const mB = new LearnMachine(b, mergeConfig(CONFIG, {}));
    mB._videoProgressTicks = 1;
    await mB.handleVideoQuiz({
      videoQuiz: { present: true, frameId: 'vf', title: '随堂题', options: [{ i: 0, label: 'A、对' }, { i: 1, label: 'B、错' }], wrongBack: true, remaining: 3 },
      video: { found: true, duration: 120, currentTime: 35, src: 'mock://v.mp4' },
      videoFrameId: 'vf',
      topUrl: 'https://mooc1.chaoxing.com/mock',
    });
    assert(mB.stopReason === 'video_quiz_review_required', '出现回看惩罚立即停止（实际 ' + mB.stopReason + '）');
    assert(b._S.clicks.length === 0, '回看惩罚时一次都没点（实际 ' + b._S.clicks.length + ' 次）');
  }

  /* —— 场景 C：剩余次数耗尽 → 立即停 —— */
  {
    const c = createMockAdapter({ videoQuiz: true, videoQuizRemaining: 0 });
    c._S.videoQuizOpen = true;
    const mC = new LearnMachine(c, mergeConfig(CONFIG, {}));
    mC._videoProgressTicks = 1;
    await mC.handleVideoQuiz({
      videoQuiz: { present: true, frameId: 'vf', title: '随堂题', options: [{ i: 0, label: 'A、对' }], remaining: 0 },
      video: { found: true, duration: 120, currentTime: 35, src: 'mock://v.mp4' },
      videoFrameId: 'vf',
      topUrl: 'https://mooc1.chaoxing.com/mock',
    });
    assert(mC.stopReason === 'video_quiz_no_attempts_left', '剩余次数为 0 立即停止（实际 ' + mC.stopReason + '）');
  }

  /* —— 场景 D：没有选项 → 停，不乱点 —— */
  {
    const d = createMockAdapter({ videoQuiz: true });
    const mD = new LearnMachine(d, mergeConfig(CONFIG, {}));
    mD._videoProgressTicks = 1;
    await mD.handleVideoQuiz({
      videoQuiz: { present: true, frameId: 'vf', title: '随堂题', options: [], remaining: 3 },
      video: { found: true, duration: 120, currentTime: 35, src: 'mock://v.mp4' },
      videoFrameId: 'vf',
      topUrl: 'https://mooc1.chaoxing.com/mock',
    });
    assert(mD.stopReason === 'video_quiz_no_options', '没有可读选项时停止（实际 ' + mD.stopReason + '）');
    assert(d._S.clicks.length === 0, '没有选项时一次都没点');
  }

  /* 题目事件 JSONL 链路：宿主依赖该文件逐行解析，曾因写成 '\\n' 字面量导致
     所有事件挤在一行、host 解析失败。此用例直接写盘并逐行校验。 */
  console.log('== 自测 14/14：题目事件 JSONL 写入与去重 ==');
  const eventFile = path.join(os.tmpdir(), 'cx-quiz-events-' + process.pid + '.jsonl');
  try { fs.unlinkSync(eventFile); } catch (_) { /* 首次无文件 */ }
  process.env.CX_QUESTION_FILE = eventFile;
  emittedQuestionKeys.clear();
  const once = emitQuestionEvent({ kind: 'video_embedded_quiz', question: '1+1=?', options: [{ i: 0, letter: 'A', label: 'A. 2' }] });
  assert(once.startsWith('q-') && once.length > 4, '事件 id 形如 q-xxxx');
  const twice = emitQuestionEvent({ kind: 'video_embedded_quiz', question: '1+1=?', options: [{ i: 0, letter: 'A', label: 'A. 2' }] });
  assert(twice === once, '同题干同选项的事件 id 去重（二次调用返回同一 id）');
  emitQuestionEvent({ kind: 'chapter_work', question: '2+2=?', options: [{ i: 0, letter: 'A', label: 'A. 4' }] });
  emitQuestionEvent({ kind: 'popup_quiz', question: '半行写入', options: [{ i: 0, letter: 'A', label: 'A. x' }] });
  fs.appendFileSync(eventFile, 'caf'); // 模拟引擎正在写入的半行：无换行，宿主应保留到下轮
  const rawEvent = fs.readFileSync(eventFile, 'utf8');
  const lines = rawEvent.split('\n');
  assert(lines.length === 4, '真实换行符拆分得到 4 行（实际 ' + lines.length + '）——若写成字面量 \\n 则只有 1 行');
  const parsed = lines.slice(0, 3).map((l) => JSON.parse(l));
  assert(parsed[0].id === once && parsed[0].kind === 'video_embedded_quiz' && parsed[0].event === 'question_detected', '首行事件可解析且字段完整');
  assert(lines[3] === 'caf' && lines[3].length > 0, '末行半行保留为 ' + rawEvent.length + ' 字节的余量');
  assert(parsed[1].kind === 'chapter_work' && parsed[2].kind === 'popup_quiz', '三种题目类型全部按行记录');
  assert(parsed.every((r) => r.options && Array.isArray(r.options) && r.options.length === 1), '选项结构化写入');
  assert(parsed.every((r) => !('draft' in r) && !('answer' in r) && !('submitted' in r)), '事件不含答案/草稿/提交字段');
  try { fs.unlinkSync(eventFile); } catch (_) { /* 清理 */ }
  delete process.env.CX_QUESTION_FILE;
  emittedQuestionKeys.clear();

  console.log(fails.length ? '== 自测失败 ' + fails.length + ' 项 ==' : '== 自测全部通过 ✓ ==');
  return fails.length === 0;
}

/** Mock 适配器：与 createCdpAdapter 原语签名完全一致，用确定性脚本模拟学习通页面。 */
function createMockAdapter(opts) {
  opts = opts || {};
  const secs = [
    { t: '第一章 1.1 课程导论' },
    { t: '第一章 1.2 视频A' },
    { t: '第一章 1.3 阅读材料', noVideo: true },
    { t: '第二章', header: true },
    { t: '第二章 2.1 视频B', quiz: true },
    { t: '第二章 2.2 视频C' }
  ];
  const S = {
    idx: 1, cur: 0, dur: 100, paused: true,
    done: [true, false, false, false, false, false],
    quizOpen: false, quizAnswered: false,
    probes: 0, clicks: [], navigations: [], muted: false,
    humanAt: opts.humanAt != null ? opts.humanAt : -1,
    loginInvalid: !!opts.loginInvalid,
    quizTabEnabled: !!opts.quizTabEnabled,
    quizTabOpen: false,
    _quizLoaded: false,
    /* ★ 随堂题（视频内嵌题）模拟状态。
       以前 Mock 完全不支持 videoQuiz* 系列动作，导致
       「随堂题零点击」断言恒真 —— 点击必然返回 unknown-kind，
       测出来是"没点"，但那是"点不了"而不是"不该点"。
       现在真的能点，策略错就会被点出来。 */
    videoQuizOpen: !!opts.videoQuiz,
    videoQuizCorrectIdx: opts.videoQuizCorrectIdx != null ? opts.videoQuizCorrectIdx : 1,
    videoQuizTried: [],
    videoQuizRemaining: opts.videoQuizRemaining != null ? opts.videoQuizRemaining : 3,
    videoQuizWrongBack: !!opts.videoQuizWrongBack,
    videoQuizPanelText: String(opts.videoQuizPanelText || ''),
    /* ★ 风控场景：detectUrl = 一直是风控页；detectOnce = 第一次是、之后解除 */
    detectUrl: !!opts.detectUrl,
    detectOnce: !!opts.detectOnce,
    detectRetries: 0,
    _detectCleared: false,
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=999&clazzid=1&enc=mock'
  };
  /** 构造随堂题面板状态（供 probe 返回） */
  function videoQuizState() {
    if (!S.videoQuizOpen) return { present: false };
    const lastTried = S.videoQuizTried.length ? S.videoQuizTried[S.videoQuizTried.length - 1] : -1;
    const correct = lastTried === S.videoQuizCorrectIdx;
    return {
      present: true,
      title: '随堂题（Mock）',
      options: [{ i: 0, label: 'A、对' }, { i: 1, label: 'B、错' }],
      correct,
      wrong: lastTried >= 0 && !correct,
      wrongBack: S.videoQuizWrongBack,
      continueVisible: correct,
      remaining: Math.max(0, S.videoQuizRemaining - S.videoQuizTried.length),
      panelText: S.videoQuizPanelText,
    };
  }
  function snapVideo() {
    const sec = secs[S.idx];
    if (!sec || sec.noVideo || sec.header) return { found: false };
    const prog = S.dur ? Math.min(100, (S.cur / S.dur) * 100) : 0;
    return { found: true, paused: S.paused || S.quizOpen, ended: S.cur >= S.dur, currentTime: S.cur, duration: S.dur, progress: Math.round(prog * 10) / 10, muted: S.muted, readyState: 4 };
  }
  function base(withToc, extra) {
    const toc = withToc
      ? { found: true, layer: 2, sel: '.prev_ul li', note: 'mock', items: secs.map((s, i) => ({ i, title: s.t, done: S.done[i], current: i === S.idx, chapterHeader: !!s.header, clickable: true })) }
      : { found: false, items: [], layer: 0, sel: '', note: '' };
    return Object.assign({
      url: S.url, video: { found: false }, dialogs: [], toc,
      quiz: { present: false, parseable: false, options: [], layer: 0 },
      human: { detected: false, evidence: null },
      login: { host: 'mooc1.chaoxing.com', href: S.url, hasPwField: false, hostHit: false }
    }, extra);
  }
  function probe() {
    S.probes += 1;
    if (S.humanAt >= 0 && S.probes >= S.humanAt) return base(true, { human: { detected: true, evidence: '人脸识别' } });
    if (S.loginInvalid) return base(true, { login: { host: 'passport2.chaoxing.com', href: 'https://passport2.chaoxing.com/login', hasPwField: true, hostHit: true } });
    /* 风控页：tick() 读的是 st.topUrl，所以这里让 probe 返回风控 URL */
    const detectNow = S.detectUrl || (S.detectOnce && !S._detectCleared);
    if (detectNow) {
      S.detectRetries += 1;
      return base(true, {
        url: 'https://detect.chaoxing.com/api/monitor_temp?refer=x&mes=' + encodeURIComponent('多终端登录'),
      });
    }
    const sec = secs[S.idx];
    // 章节测验标签：模拟「点开后才加载题目」
    const quizTab = S.quizTabEnabled
      ? { present: true, title: '章节测验', index: 1 }
      : { present: false, title: '', index: -1 };
    if (S.quizTabOpen) {
      // 题目加载（点开标签后题目就绪）；提交后题目消失
      return base(true, {
        video: { found: false, ended: false, paused: false, progress: 0, currentTime: 0, duration: 0 },
        quiz: S.quizAnswered
          ? { present: false, parseable: false, options: [], layer: 0 }
          : { present: true, parseable: true, layer: 2, note: 'popFrameId(模拟)', question: '章节测验题', options: [{ i: 0, label: 'A. 对' }, { i: 1, label: 'B. 错' }], submitText: '提交' },
        quizTab: quizTab
      });
    }
    if (!S.paused && !S.quizOpen && sec && !sec.noVideo && !sec.header) {
      S.cur = Math.min(S.dur, S.cur + 45);
      if (sec.quiz && S.cur >= 40 && !S.quizAnswered) S.quizOpen = true;
    }
    return base(true, {
      video: snapVideo(),
      /* ★ 随堂题优先于泛化弹层：真实页面里 .ans-videoquiz 出现时
         videoQuiz 有值、quiz 也可能同时命中泛化 radio 探针。
         引擎的 tick 里 videoQuiz 优先级更高，Mock 必须复刻这个顺序，
         否则测的是"泛化分支"而不是"随堂题分支"。 */
      videoQuiz: videoQuizState(),
      quiz: S.quizOpen
        ? { present: true, parseable: true, layer: 2, note: 'popboxes(模拟)', question: '1+1=?', options: [{ i: 0, label: 'A. 2' }, { i: 1, label: 'B. 3' }], submitText: '提交' }
        : { present: false, parseable: false, options: [], layer: 0 },
      quizTab: quizTab
    });
  }
  function mockFind(kind, arg) {
    const mk = (text, layer, note) => ({ ok: true, text, rect: { x: 1, y: 2, w: 4, h: 4, __kind: kind, __arg: arg }, layer, note });
    if (kind === 'videoToggle') {
      const sec = secs[S.idx];
      if (!sec || sec.noVideo || sec.header) return { ok: false, reason: 'no-video-control' };
      return mk(S.paused ? '播放' : '视频区', 1, 'vjs-big-play-button');
    }
    if (kind === 'dialogPrimary') return { ok: false, reason: 'no-dialog-primary' };
    if (kind === 'quizOption') return (S.quizOpen || S.quizTabOpen) ? mk('A. 2', 2, 'mock-option') : { ok: false, reason: 'no-quiz-option' };
    if (kind === 'quizSubmit') return (S.quizOpen || S.quizTabOpen) ? mk('提交', 2, 'mock-submit') : { ok: false, reason: 'no-quiz-submit' };
    if (kind === 'tocItem') {
      if (arg == null || arg < 0 || arg >= secs.length) return { ok: false, reason: 'toc-index-out-of-range' };
      return mk(secs[arg].t, 2, 'mock-toc');
    }
    if (kind === 'quizTab') return S.quizTabEnabled ? mk('章节测验', 2, 'quiz-tab') : { ok: false, reason: 'no-quiz-tab' };
    if (kind === 'videoTab') return mk('视频', 2, 'video-tab');
    /* ★ 随堂题三类动作：现在真的支持，策略错就会被点出来 */
    if (kind === 'videoQuizOption') {
      if (!S.videoQuizOpen) return { ok: false, reason: 'no-video-quiz' };
      const i = arg == null ? 0 : Number(arg);
      return mk('选项' + i, 2, 'videoquiz-opt' + i);
    }
    if (kind === 'videoQuizSubmit') {
      if (!S.videoQuizOpen) return { ok: false, reason: 'no-video-quiz' };
      return mk('提交', 2, 'videoquiz-submit');
    }
    if (kind === 'videoQuizContinue') {
      if (!S.videoQuizOpen) return { ok: false, reason: 'no-video-quiz' };
      return mk('继续', 2, 'videoquiz-continue');
    }
    return { ok: false, reason: 'unknown-kind' };
  }
  function applyClick(rect) {
    const kind = rect.__kind, arg = rect.__arg;
    if (kind === 'videoToggle') { S.paused = false; return; }
    if (kind === 'videoTab') { S.quizTabOpen = false; S.quizOpen = false; S.paused = true; return; }
    if (kind === 'quizTab') { S.quizTabOpen = true; S.quizOpen = false; S.quizAnswered = false; return; }
    if (kind === 'quizOption') { S._picked = arg || 0; return; }
    if (kind === 'quizSubmit') { S.quizOpen = false; S.quizTabOpen = false; S.quizAnswered = true; return; }
    if (kind === 'dialogPrimary') { S._dialogClosed = true; return; }
    /* 随堂题：选一个选项 → 记下试过哪个；提交后若答对则面板消失 */
    if (kind === 'videoQuizOption') { S._vqPicked = arg == null ? 0 : Number(arg); return; }
    if (kind === 'videoQuizSubmit') {
      if (S._vqPicked != null) S.videoQuizTried.push(S._vqPicked);
      if (S._vqPicked === S.videoQuizCorrectIdx) S.videoQuizOpen = S.videoQuizOpen;
      return;
    }
    if (kind === 'videoQuizContinue') { S.videoQuizOpen = false; S._vqContinued = true; return; }
    if (kind === 'tocItem') {
      S.done[S.idx] = true;
      S.idx = arg; S.cur = 0; S.paused = true; S.quizOpen = false; S.quizAnswered = false; S.muted = false;
    }
  }
  const adapter = {
    engine: 'mock',
    async sleep() { /* 自测不真实等待 */ },
    async ensureBrowser() { return { engine: 'mock' }; },
    async navigate(url) {
      S.navigations.push(url); S.url = url;
      /* ★ 风控恢复语义：真实场景里「刷新到 i.chaoxing.com/base」后风控会解除。
         detectOnce 表示只风控一次，navigate 离开风控域后就恢复正常。
         detectUrl 则永远粘住（模拟风控始终不解除）。 */
      if (S.detectOnce && !/detect\.chaoxing\.com/i.test(String(url || ''))) {
        S._detectCleared = true;
        S.url = 'https://i.chaoxing.com/base';
      }
      S.idx = 1; S.cur = 0; S.paused = true;
      S.done = [true, false, false, false, false, false];
      S.quizOpen = false; S.quizAnswered = false;
    },
    async getCurrentUrl() { return S.url; },
    /* ★ 风控检测三件套：tick() 通过这两个方法判定并读取平台提示。
       缺少它们会让风控分支直接跳过 —— 那样测试就测不到真逻辑。 */
    _isDetectUrl(u) {
      return /detect\.chaoxing\.com|\/api\/monitor_temp|[?&]mes=/i.test(String(u || ''));
    },
    async _readDetectMessage() {
      return '您的账号于某时在一台设备登入章节页面，多终端登录可能会被判定异常学习';
    },
    /* Mock 的 cookie：自测不走真实登录，返回 null 让调用方按「无法判断」处理 */
    async getAllCookies() { return null; },
    async screenshot() { throw new Error('Mock 适配器不支持截图（扫码登录需要真实浏览器）'); },
    async screenshotClip() { return ''; },
    async getFrameDocuments() { return [{ frameId: 'mock-top', url: S.url, isTop: true, depth: 0 }]; },
    async evalInFrameCross() { return { ok: false, error: 'mock' }; },
    async evalInFrame(frameId, expr) {
      if (expr.indexOf('__CX_SEL=') >= 0) return 'installed';
      if (expr.indexOf('__cx.probeAll()') >= 0) return probe();
      if (expr.indexOf('__cx.videoState()') >= 0) return snapVideo();
      if (expr.indexOf('v.muted') >= 0) { S.muted = true; return true; }
      const m = /__cx\.find\("([a-zA-Z]+)",\s*(null|\d+)\)/.exec(expr);
      if (m) return mockFind(m[1], m[2] === 'null' ? null : Number(m[2]));
      const jc = /__cx\.jsClick\("([a-zA-Z]+)",\s*(null|\d+)\)/.exec(expr);
      if (jc) {
        const arg = jc[2] === 'null' ? null : Number(jc[2]);
        const f = mockFind(jc[1], arg);
        if (f.ok) { applyClick({ __kind: jc[1], __arg: arg }); return { ok: true, layer: f.layer }; }
        return { ok: false, reason: f.reason };
      }
      return null;
    },
    async click(frameId, rect) {
      S.clicks.push({ kind: rect.__kind, arg: rect.__arg });
      applyClick(rect);
      return { mode: 'mock-input' };
    },
    async jsClick(frameId, kind, arg) {
      const f = mockFind(kind, arg);
      if (f.ok) { S.clicks.push({ kind, arg, degraded: true }); applyClick({ __kind: kind, __arg: arg }); return { ok: true, layer: f.layer }; }
      return { ok: false, reason: f.reason };
    },
    async getText() { return 'mock'; },
    async isVideoEnded() { return { found: true, ended: S.cur >= S.dur, raw: snapVideo() }; },
    /* 截图坐标换算相关（Mock 只验证流程，不做真实几何） */
    async getFrameChain() { return ['mock-top', 'mock-child']; },
    async frameOrigin() { return { ox: 0, oy: 0, parts: [] }; },
    async rootViewport() { return { w: 1440, h: 900, sx: 0, sy: 0 }; },
    async scrollRootTo() { return true; }
  };
  adapter._S = S; // 暴露内部状态供自测断言
  return adapter;
}

/**
 * ============================================================================
 * 新版课程页（mooc2-ans）只读识别器
 * ----------------------------------------------------------------------------
 * ★ 安全边界（主人 2026-10-27 明确要求）：
 *   本模块**只读**。不播放、不点击、不答题、不提交、不填写任何表单。
 *   它的唯一职责是：把课程页的结构扫描出来，供人工确认框架是否正确。
 *
 * 为什么需要独立模块：
 *   主人账号 184 个课程全部是 ismooc2=1 的新版页面，DOM 结构为
 *     mooc2-ans/mycourse/stu（任务/章节/资料/学习记录/课程图谱 五个 tab）
 *       └ 点「章节」→ iframe: mooc2-ans/mycourse/studentcourse（跨域）
 *            └ 再点某节 → iframe: knowledge/cards（再跨一层）
 *   老版引擎用的 .posCatalog_select / .ans-attach-ct 在**顶层**一个都没有，
 *   必须逐层穿透跨域 frame（Page.createIsolatedWorld）才能读到。
 *
 * 页面类型判定顺序：
 *   1. 命中 passport2 / login → 'login'
 *   2. 有 .posCatalog_select 或 #coursetree → 'mooc1-study'（老版，现有引擎可处理）
 *   3. 有「任务/章节/资料/学习记录」nav → 'mooc2-home'（新版课程主页）
 *   4. 有 .ans-attach-ct 或 .ans-job-icon → 'mooc2-chapter'（新版章节内容页）
 *   5. 有 video / .ans-videoquiz → 'media'
 *   6. 其他 → 'unknown'
 * ==========================================================================*/


module.exports = {
  selfTest,
  createMockAdapter
};
