/* ============================================================================
 * engine/src/core/config.js — CONFIG 默认值、深合并、参数校验、答案字母解析
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { FatalStop, path } = require('./base.js');

/* ============================================================================
 * 第 1 节 · CONFIG —— 全部可调参数集中于此（含所有随机延迟范围）
 * ==========================================================================*/
const CONFIG = {
  /* P4 模式开关：'current_chapter' 仅处理当前章节 | 'continue_chapters' 连续推进 */
  mode: 'current_chapter',
  maxSections: 20, // 连续推进模式：最多完整看完多少节即停（硬上限）

  course: {
    // 学习通「课程学习」页 URL（地址栏整串复制，含 courseId/clazzid/enc 等参数）。
    // 可被环境变量 CX_COURSE_URL 或 CLI --course-url / MCP 参数 courseUrl 覆盖。
    url: process.env.CX_COURSE_URL || ''
  },

  /* Chromium / CDP（路径 A） */
  chromium: {
    executablePath: process.env.CX_CHROMIUM || 'chromium',
    headless: true,
    // 持久化 profile：首次人工扫码/账密登录后，登录态在此目录复用（脚本不自动登录）
    profileDir: process.env.CX_PROFILE_DIR || '',
    /* --no-sandbox：NAS/Docker 容器普遍未启用非特权用户命名空间，Chrome 无 SUID 沙箱
       可用时必须显式关闭（本机 chrome-headless-shell 158 实测报 "No usable sandbox!"）

       --no-proxy-server：让浏览器直连，不走系统代理。
       2026-10-27 实测：Windows 上 Clash 开了系统代理（127.0.0.1:7897），
        Chrome/Edge 会把**所有**请求送进代理；访问超星这类国内站点走代理会导致
         · CSS 加载不完整 → 页面停在「裸页」（.default-login 圆角 0px、按钮 43px）
         · 二维码图片加载失败 → naturalWidth=0（主人看到的破图图标）
       加此参数后重载实测：CSS 4 个全 200、二维码 270x270 正常。
       Linux 容器（FNOS）本无系统代理，此参数无害。

       ★ 2026-10-29 起：静态部分集中在 buildChromiumArgs()，本数组只放
         「用户/环境追加」的参数，且会被去重合并（同名单值参数后者覆盖前者）。 */
    extraArgs: [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--mute-audio',
      '--window-size=1366,900',
      '--no-proxy-server',
    ]
  },
  cdp: {
    host: '127.0.0.1',
    /* ★ 2026-10-29：端口改为「自动发现」。
       0 = 让 Chromium 自己挑空闲端口（--remote-debugging-port=0），
       启动后从 <profile>/DevToolsActivePort 读回真实端口。
       原因：FNOS 上 admin + 5 个用户实例共用写死的 9223，会互相抢端口；
       而且固定端口无法区分「浏览器还没起来」和「端口被别的进程占了」。
       仍可用 CX_CDP_PORT=<端口> 强制指定（调试/附着已有浏览器时用）。 */
    port: process.env.CX_CDP_PORT === undefined ? 0 : Number(process.env.CX_CDP_PORT || 0),
    attachTimeoutMs: 20000,
    navTimeoutMs: 30000,
    evalTimeoutMs: 15000
  },

  /* 视频判定：progress >= progressDoneRatio% 或 ended === true 视为自然结束 */
  video: { progressDoneRatio: 98.5, mute: true },

  /* 拟人化节奏（所有随机范围集中在 CONFIG，便于统一调节与审计） */
  humanize: {
    clickDelayMs: [300, 1200],        // 每次点击/按键前随机延迟
    sectionCooldownMs: [8000, 15000], // 切换章节后的冷却时间
    quizThinkMs: [2000, 5000],        // 弹题作答前的"思考延迟"，不秒选
    longPauseEveryOps: [12, 20],      // 每隔 N 次操作插入一次长停顿（N 也随机）
    longPauseMs: [3000, 6000],        // 长停顿时长
    pollMs: [4000, 9000]              // 播放态轮询间隔（非固定周期，防机械画像）
  },

  /* 安全停止 */
  safety: {
    maxConsecutiveFailures: 3,        // 连续 N 次无法识别/关键失败 → 停止并输出诊断
    maxLoadRetries: 6,                // 切节后等待新页面加载的探测次数
    maxNoVideoWaitTicks: 4,           // 新节迟迟无视频的等待轮数，超过按非视频任务点跳过
    maxRuntimeMs: 12 * 60 * 60 * 1000, // 单次运行时长兜底（12 小时，覆盖看完一整门课）
    /* ★ 2026-10-28：遇到章节测验时，跳过不答、直接进下一节继续看视频。
       主人要求「课后题一定不要做」，跳过等于不拿这部分分，与要求一致；
       且此时视频任务点已完成（超星已确认），不跳会永远卡在本节。
       设为 false 可恢复旧行为（停下等人）。 */
    skipChapterQuiz: true,
    /* ★ 2026-10-30 主人指令：题目「识别不出来」不再停机，只忽略。
       同一弹层连续忽略到这一次数，才当作「本节没视频可看」切下一节，
       避免弹层永久遮挡导致无限空转。 */
    quizIgnoreMax: 12,
    /* ★ 2026-10-31 真机事故：3.4 播到 97.8%（755.4/772.2s）时播放器触发 ended，
       但超星任务点始终 not-done，目录 current 又被页面自己拉回上一节 →
       「播完 → 未确认 → 跟随外部 → 再点回来 → 再播完」，约 27 秒一轮死循环。
       连续这么多次仍未确认就停止本轮，避免无限重载（也避免风控画像）。
       设为 0 可关闭该保护。 */
    videoNotConfirmedMax: 3,
    /* 出问题（播完但超星不记账）时：暂停视频并保存快照（json + png）。
       stopOnSnapshot=true 则第一次就停，用于取证；默认 false，仍允许重试。 */
    snapshotOnProblem: true,
    stopOnSnapshot: false,
    fatalKeywords: ['人脸识别', '人脸', '活体', '活体检测', '验证码', '安全验证', '滑块验证', '真人验证', '请完成验证', '刮开'],
    loginHostPattern: 'passport|login\\.|auth\\.'
  },

  /* 日志：console + 内存环形缓冲（可选文件） */
  log: { ringSize: 600, file: process.env.CX_LOG_FILE || null },

  /* 无头扫码登录：profile 无登录态时打开登录页二维码，周期截图 + 轮询跳转；
     用户手机「学习通」App 扫截图里的码即可，全程不接触账密、不自动填表 */
  login: {
    homeUrl: 'https://i.chaoxing.com/',
    loginUrl: 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com',
    // 登录成功的判定：URL 命中此正则且不在 passport/login 域（可配置以便对接其他站点/测试）
    successUrlPattern: 'chaoxing\\.com',
    shotDir: process.env.CX_LOGIN_SHOT_DIR || path.join(__dirname, '.login'),
    timeoutMs: 10 * 60 * 1000, // 扫码窗口 10 分钟，二维码过期自动刷新
    pollMs: 2500,
    reloadEveryMs: 60000,
    /* 一次性登录（默认开启）：每次任务使用独立的临时 profile，任务结束即删除，
       下一次必须重新扫码。关闭后回退为「扫码一次长期复用」。 */
    ephemeral: process.env.CX_EPHEMERAL_LOGIN !== '0',
  },

  /* 超星风控检测页：账号多端登录 / 异常操作时被导航到 detect.chaoxing.com。
     该页 JS 会陷入死循环，导致 renderer 不再响应任何 CDP 指令（Page.enable 超时）。
     引擎必须识别并丢弃这样的 target，而不是复用它。 */
  detect: {
    // 命中任一即判定为风控检测页
    urlPattern: 'detect\\.chaoxing\\.com|/api/monitor_temp|[?&]mes=',
    // 检测页上的异常提示关键词（用于日志提示）
    messagePattern: '多终端登录|异常学习|异常操作|请尽快修改密码',
    // 新建 target 失败时的回退：是否允许附着到已有 target（会做探活）
    allowAttachFallback: true,
    /* ★ 2026-10-28 主人要求：命中风控后不立即放弃，先等 30 秒再刷新重试；
       最多重试 2 次，仍失败才真正停止（并在日志里写明原因）。
       依据：实测「手机端退出登录」后风控会自行解除，等一会儿刷新通常能继续。 */
    retryWaitMs: 30000,      // 每次重试前等待时长（30 秒）
    maxRetries: 2,           // 最多重试次数（2 次 → 共尝试 3 轮）
    retryJitterMs: 5000      // 等待时长随机浮动，避免固定节奏被识别
  },

  /* MCP 工具注册 */
  mcp: { serverName: 'cx', toolName: 'cx_learn' }
};

/** 深合并（覆盖值优先；数组整体替换）；返回全新对象，不改默认 CONFIG。 */
function mergeConfig(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  const deep = (dst, src) => {
    for (const k of Object.keys(src || {})) {
      const v = src[k];
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deep(dst[k], v);
      else dst[k] = v;
    }
  };
  deep(out, patch || {});
  return out;
}

/**
 * 从模型回复里解析出选项字母索引（0 基），解析不出返回 -1。
 *
 * 直接 match(/[A-Z]/) 不可靠：模型若回 "The answer is A" 或 "选 B"，
 * 首个大写字母会是 T / 杂音。按三档取：
 *   1. 「答案/正确/选/answer/is」等提示词后面的字母
 *   2. 独立的选项字母（前后不是字母数字），如 "B. 1950年"
 *   3. 兜底：正文里第一个 A-Z
 */
function parseAnswerLetter(text, optCount) {
  const maxIdx = (optCount || 4) - 1;
  const s = String(text || '');
  if (!s) return -1;
  const clamp = function (ch) {
    const i = ch.toUpperCase().charCodeAt(0) - 65;
    return i >= 0 && i <= maxIdx ? i : -1;
  };
  const m1 = s.match(/(?:答案|正确(?:答案|选项)?|选择|选|answer|correct|option|is)\s*[:：是为]?\s*\**\s*([A-H])/i);
  if (m1) { const i = clamp(m1[1]); if (i >= 0) return i; }
  const m2 = s.match(/(?:^|[^A-Za-z0-9])([A-H])(?=$|[^A-Za-z0-9])/);
  if (m2) { const i = clamp(m2[1]); if (i >= 0) return i; }
  const m3 = s.toUpperCase().match(/[A-Z]/);
  if (m3) { const i = m3[0].charCodeAt(0) - 65; if (i >= 0 && i <= maxIdx) return i; }
  return -1;
}

/** 启动前配置校验：非法配置直接致命停止，不进入浏览器流程。 */
function validateConfig(cfg) {
  const errs = [];
  if (['current_chapter', 'continue_chapters'].indexOf(cfg.mode) < 0) errs.push('mode 必须是 current_chapter | continue_chapters');
  if (!(Number(cfg.maxSections) >= 1)) errs.push('maxSections 必须 >= 1');
  const ranges = [
    ['clickDelayMs', cfg.humanize.clickDelayMs], ['sectionCooldownMs', cfg.humanize.sectionCooldownMs],
    ['quizThinkMs', cfg.humanize.quizThinkMs], ['longPauseMs', cfg.humanize.longPauseMs], ['pollMs', cfg.humanize.pollMs]
  ];
  for (const [name, r] of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !(r[0] >= 0 && r[1] >= r[0])) errs.push('humanize.' + name + ' 必须是 [min,max] 且 min<=max');
  }
  if (!(cfg.video.progressDoneRatio >= 90 && cfg.video.progressDoneRatio <= 100)) errs.push('video.progressDoneRatio 应在 90-100 之间');
  if (errs.length) throw new FatalStop('CONFIG_INVALID', errs.join('; '));
}

module.exports = {
  CONFIG,
  mergeConfig,
  parseAnswerLetter,
  validateConfig
};
