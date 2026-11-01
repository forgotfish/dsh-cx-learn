/* ============================================================================
 * engine/src/browser/args.js — 内核启动参数、调试端口发现、启动失败归因（纯函数）
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { fs, path, spawn } = require('../core/base.js');
const { CONFIG } = require('../core/config.js');

/* ============================================================================
 * 第 0 节 · 内核启动参数（纯函数，可单测，不含任何 I/O）
 * ----------------------------------------------------------------------------
 * 为什么要单独抽出来：
 *   1. 这些参数决定「无头内核能不能稳定跑完一节 40 分钟的视频」，
 *      是最容易悄悄失效的一层，必须能被自测直接断言。
 *   2. 用户/环境追加的参数（extraArgs）不可信：可能重复、可能与引擎必需的
 *      参数冲突（典型：自己填了 --remote-debugging-port=9222 把引擎的顶掉，
 *      或填了 --user-data-dir 导致登录态进错目录）。这里统一去重合并。
 *
 * 参数来源与依据（2026-10-29 对照上游源码）：
 *   · Playwright  chromiumSwitches.ts   → 防节流/防遮挡那三条 + 一批降噪开关
 *   · browser-use profile.py（:84）     → CalculateNativeWinOcclusion 的用途注释
 *   · Chromium    media_switches.cc:46  → autoplay-policy=no-user-gesture-required
 * ==========================================================================*/

/**
 * 单值参数（同名只保留一个，后者覆盖前者）。
 * 判断依据：`--name=value` 形式且语义上「只有一个取值有意义」。
 * 列全是为了避免出现 `--window-size=1366,900 --window-size=800,600` 这种
 * 「谁生效看 Chromium 心情」的状态。
 */
const CHROMIUM_SINGLE_VALUED_FLAGS = [
  '--remote-debugging-port', '--remote-debugging-address', '--remote-debugging-pipe',
  '--user-data-dir', '--profile-directory', '--window-size', '--window-position',
  '--headless', '--proxy-server', '--proxy-bypass-list', '--user-agent',
  '--autoplay-policy', '--disable-features', '--enable-features',
  '--blink-settings', '--disk-cache-dir', '--lang', '--force-color-profile',
  '--host-resolver-rules', '--log-level', '--crash-dumps-dir',
];

/** 布尔型参数（无值，出现即生效；去重只保留一次）。 */
const CHROMIUM_BOOLEAN_FLAGS = [
  '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-infobars',
  '--mute-audio', '--no-proxy-server', '--headless', '--hide-scrollbars',
  '--disable-gpu', '--disable-dev-shm-usage', '--disable-session-crashed-bubble',
  '--disable-search-engine-choice-screen', '--disable-breakpad', '--no-service-autorun',
  '--disable-component-update', '--password-store=basic', '--use-mock-keychain',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-background-networking',
  '--disable-ipc-flooding-protection', '--disable-hang-monitor',
  '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-field-trial-config',
  '--metrics-recording-only', '--allow-pre-commit-input', '--start-minimized',
  '--disable-extensions', '--disable-default-apps', '--disable-component-extensions-with-background-pages',
  '--disable-back-forward-cache', '--disable-sync', '--no-pings',
];

/** 解析 `--flag=value` / `--flag` 的名字部分（不含值）。 */
function chromiumFlagName(arg) {
  const s = String(arg || '');
  const i = s.indexOf('=');
  return i < 0 ? s : s.slice(0, i);
}

/**
 * 合并启动参数：按「单值覆盖、布尔去重、其余追加」的语义去重。
 * 后面的覆盖前面的 —— 因此把「用户参数」放在「引擎必需参数」之前调用即可让
 * 引擎的必需值胜出（见 buildChromiumArgs 的调用顺序）。
 *
 * 特别处理 `--disable-features` / `--enable-features`：它们是逗号列表，
 * 直接覆盖会丢掉另一方的条目，所以各自做并集。
 *
 * ★ 2026-10-29 修 bug：原先两个列表共用同一个 featureSet，
 *   结果只要用户传了 --enable-features，引擎的 CalculateNativeWinOcclusion
 *   就会同时出现在 enable 和 disable 两行里 —— 而 Chromium 里 enable 优先，
 *   等于把防遮挡修复悄悄抵消掉。现在两条列表完全独立。
 */
function mergeChromiumArgs(...groups) {
  const single = new Map();   // name -> 完整参数串
  const booleans = new Set(); // name
  const others = [];          // 未登记的其它参数，保持顺序并去重
  const disableFeatures = new Set();
  const enableFeatures = new Set();
  let disableSeen = false;
  let enableSeen = false;

  for (const group of groups) {
    for (const raw of (group || [])) {
      if (!raw || typeof raw !== 'string') continue;
      const name = chromiumFlagName(raw);

      if (name === '--disable-features' || name === '--enable-features') {
        const val = raw.indexOf('=') < 0 ? '' : raw.slice(raw.indexOf('=') + 1);
        const bucket = name === '--disable-features' ? disableFeatures : enableFeatures;
        for (const f of val.split(',')) { const t = f.trim(); if (t) bucket.add(t); }
        if (name === '--disable-features') disableSeen = true; else enableSeen = true;
        // 记下是 disable 还是 enable，稍后按名字回填
        single.set(name, name);
        continue;
      }
      if (CHROMIUM_SINGLE_VALUED_FLAGS.indexOf(name) >= 0) { single.set(name, raw); continue; }
      if (CHROMIUM_BOOLEAN_FLAGS.indexOf(name) >= 0) { booleans.add(name); continue; }
      if (others.indexOf(raw) < 0) others.push(raw);
    }
  }

  const out = [];
  for (const [name, val] of single) {
    if (name === '--disable-features' || name === '--enable-features') continue; // 下面单独拼
    out.push(val);
  }
  if (disableSeen) out.push('--disable-features=' + Array.from(disableFeatures).join(','));
  if (enableSeen) out.push('--enable-features=' + Array.from(enableFeatures).join(','));
  for (const b of booleans) out.push(b);
  out.push(...others);
  return out;
}

/**
 * 构造完整的 Chromium 启动参数。
 *
 * 顺序即优先级：先用户参数，再引擎必需参数 —— 后者覆盖前者。
 * 返回的数组**不含** `about:blank`（由调用方追加，便于单测断言）。
 *
 * @param {object} opts
 * @param {boolean} opts.headless        无头模式
 * @param {number}  opts.port            CDP 端口；0 = 让浏览器自选
 * @param {string}  opts.profileDir      user-data-dir（空则不加）
 * @param {boolean} opts.shellKernel     内核是 chrome-headless-shell（旧 headless 独立二进制）
 * @param {string[]} opts.userArgs       用户/环境追加参数（会被去重合并）
 */
function buildChromiumArgs(opts) {
  const o = opts || {};
  const userArgs = Array.isArray(o.userArgs) ? o.userArgs : [];

  /* 引擎必需：稳定性与可控性，优先级高于用户参数 */
  const required = [];

  /* 端口：0 让 Chromium 自己挑空闲端口，避免多实例互抢 */
  required.push('--remote-debugging-port=' + (o.port === undefined ? 0 : o.port));
  required.push('--remote-debugging-address=127.0.0.1');

  /* 无头。chrome-headless-shell 本身就是旧 headless 二进制，不需要也不该再带
     --headless=new（它不是新版 Chrome，收到该参数没有「新无头」可切）。
     这一条是 2026-10-29 对照官方文档后的修正：旧 headless 自 Chrome 120 起
     以独立二进制发布，与 --headless=new 是两条不同的实现路径。 */
  if (o.headless) {
    if (o.shellKernel) required.push('--headless');
    else required.push('--headless=new');
  }

  if (o.profileDir) required.push('--user-data-dir=' + o.profileDir);

  /* ★ 防节流三件套（Playwright / browser-use 同款）
     无头跑长任务时，Chromium 会把「不可见/被遮挡」的页面判为后台：
       · 定时器降频（setInterval 从 4s 变几十秒）→ 轮询播放态像卡死
       · 渲染进程降优先级（rAF 停摆）→ 播放器进度条不再刷新
       · 遮挡判定（CalculateNativeWinOcclusion）在 Windows 上尤其激进
     本项目靠定时器轮询 + 页面内播放器自身推进，这三条缺一不可。 */
  required.push('--disable-background-timer-throttling');
  required.push('--disable-backgrounding-occluded-windows');
  required.push('--disable-renderer-backgrounding');
  required.push('--disable-features=CalculateNativeWinOcclusion');

  /* ★ 2026-10-30：/dev/shm 兜底。
     无头 Chromium 的 renderer 会把共享内存映射到 /dev/shm，而容器默认只给 64MB，
     渲染进程随即 SIGABRT —— 表现为「内核莫名 exit 21/-6、stderr 空」。
     加了这个开关后 Chromium 改用 /tmp 上的普通文件，代价是少量 I/O。

     实测口径：本项目生产机（飞牛）的 /dev/shm 是 4.9G，**并不需要**这条；
     但它是幂等的低成本保险 —— 换到 Docker/K8s 部署时不必再改代码。
     注意它不能治「/tmp 也满」的情况（那属于 ENOSPC，见 describeLaunchExit）。 */
  required.push('--disable-dev-shm-usage');

  /* ★ 自动播放：不要求用户手势。
     没有它时，跨域 iframe 里的 video.play() 可能被拒（NotAllowedError），
     本引擎虽有 Runtime.evaluate{userGesture:true} 兜底，但那是每次打补丁；
     内核级放开更接近「用户已允许」的稳定语义。 */
  required.push('--autoplay-policy=no-user-gesture-required');

  /* 静默与降噪：不弹首启向导、不弹恢复气泡、不连更新/崩溃上报 */
  required.push('--no-first-run');
  required.push('--no-default-browser-check');
  required.push('--disable-session-crashed-bubble');
  required.push('--disable-search-engine-choice-screen');
  required.push('--disable-breakpad');
  required.push('--no-service-autorun');
  required.push('--disable-component-update');
  required.push('--password-store=basic');
  required.push('--disable-infobars');

  /* 无头下没有可用音频设备，静音避免音频线程空转；也防止真实发声打扰 */
  if (o.headless) required.push('--mute-audio');

  return mergeChromiumArgs(userArgs, required);
}

/**
 * 从 profile 目录读回 Chromium 实际监听的端口。
 *
 * Chromium 在 --remote-debugging-port=<非0> 或 0 时，会把真实端口写进
 * <user-data-dir>/DevToolsActivePort，格式为两行（Chromium
 * content/browser/devtools/devtools_http_handler.cc:313）：
 *     54195
 *     /devtools/browser/5c80ab5f-690a-4294-a449-6178518687c7
 *
 * 返回 { port, browserPath } 或 null（文件还没写出来 / 内容不合法）。
 */
function readDevToolsActivePort(profileDir) {
  if (!profileDir) return null;
  const file = path.join(profileDir, 'DevToolsActivePort');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const lines = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, browserPath: lines[1] || '' };
}

/**
 * 判断内核是不是 chrome-headless-shell 这类「旧 headless 独立二进制」。
 * 依据文件名 —— 与 README 里列出的可执行文件名保持一致。
 */
function isHeadlessShellKernel(exePath) {
  const base = path.basename(String(exePath || '')).toLowerCase().replace(/\.exe$/, '');
  return base === 'chrome-headless-shell' || base === 'headless_shell';
}

/**
 * 判断内核路径是不是「裸命令名」（依赖 PATH 查找，如 'chromium'）。
 *
 * 为什么必须区分：
 *   CONFIG.chromium.executablePath 的默认值就是 'chromium' —— 一个靠 PATH 解析的裸名。
 *   实测（2026-10-29，Windows）：PATH 里能解析的命令（where.exe / ping.exe / certutil.exe），
 *   fs.existsSync('where.exe') === false，但 spawn 能正常启动。
 *   所以任何用 existsSync 判断「内核是否存在」的代码，都会把这种合法配置误杀成
 *   「内核可执行文件不存在」。
 *
 * 判定口径：不含路径分隔符、不是绝对路径、不是显式相对路径（./x、../x）。
 */
function isBareCommandName(exePath) {
  const s = String(exePath || '').trim();
  if (!s) return false;
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) return false;
  if (/^[A-Za-z]:/.test(s)) return false;          // Windows 盘符
  if (s === '.' || s === '..') return false;
  if (s.indexOf('./') === 0 || s.indexOf('../') === 0) return false;
  return true;
}

/**
 * 解析出「当前实际可用的 CDP 端口」。
 *
 * cfg.cdp.port 非 0 → 直接用（用户显式指定 / 附着外部浏览器）。
 * cfg.cdp.port 为 0 → 从 profile 目录的 DevToolsActivePort 读回真实端口。
 * 都拿不到 → 返回 0（调用方应视作「端点未知」，不要拼 URL 硬试）。
 *
 * 供模块级函数（listTargets / 登录流程清理标签页等）使用，
 * 它们不在 createCdpAdapter 闭包里，拿不到 _activePort。
 */
function resolveCdpPort(cfg) {
  const c = cfg || CONFIG;
  const explicit = Number((c.cdp && c.cdp.port) || 0);
  if (explicit > 0) return explicit;
  const prof = (c.chromium && c.chromium.profileDir) || '';
  const active = readDevToolsActivePort(prof);
  return active ? active.port : 0;
}

/* ----------------------------------------------------------------------------
 * 内核启动失败的归因（纯函数，可单测）
 * ----------------------------------------------------------------------------
 * 2026-10-29 实测出来的两条事实：
 *   1. Chromium 启动失败时**基本不往 stderr 写东西**给上层看 —— 我们接到的
 *      stderr 常常是空的，真正的错误在它自己打的主进程日志里。
 *   2. 两种完全不同的故障给出**同一个退出码 21**：
 *        a) profile 已被另一个浏览器实例占用（ProcessSingleton 冲突）
 *        b) profile 目录不可写（Lock file can not be created）
 *      实测：共用同一 --user-data-dir 的第二个实例，4 秒内静默退出，exit=21，
 *      stderr 为空；而不可写目录同样是 exit=21，但 stderr 里有
 *      "Lock file can not be created! Error code: 5"。
 * 所以只看退出码无法区分，必须结合 stderr 与 profile 现状一起判断。
 * --------------------------------------------------------------------------*/

/** Chromium 的退出码含义（只收录我们能给出可操作建议的那几个）。 */
const CHROMIUM_EXIT_CODES = {
  21: 'profile 被占用或不可写（RESULT_CODE_PROFILE_IN_USE）',
  22: '命令行走参数有误',
  33: '初始化失败（常见于缺少系统依赖）',
  127: '找不到动态库',
};

/**
 * 判断 profile 目录当前是否被别的浏览器实例占着。
 *
 * 依据（都是实测存在的产物）：
 *   · Windows / 跨平台通用：<profile>/Default/LOCK（单文件锁）
 *   · Linux/macOS：<profile>/SingletonLock（符号链接，指向 hostname-pid）
 *   · 部分版本：<profile>/SingletonSocket / SingletonCookie
 *
 * 注意：LOCK 文件存在**不等于**一定被占用（异常退出会留下残留文件），
 * 所以本函数只作为「提示」，不单独用来否决启动。
 * 返回 { locked, evidence }。
 */
function inspectProfileLock(profileDir) {
  if (!profileDir) return { locked: false, evidence: [] };
  const evidence = [];
  const candidates = [
    path.join(profileDir, 'SingletonLock'),
    path.join(profileDir, 'SingletonSocket'),
    path.join(profileDir, 'SingletonCookie'),
    path.join(profileDir, 'Default', 'LOCK'),
  ];
  for (const f of candidates) {
    try { if (fs.existsSync(f)) evidence.push(f); } catch (_) { /* 无权限就读不到，忽略 */ }
  }
  return { locked: evidence.length > 0, evidence };
}

/** profile 目录是否可写（真正尝试建一个临时文件，比查 ACL 可靠）。 */
function isProfileWritable(profileDir) {
  if (!profileDir) return true;
  const probe = path.join(profileDir, '.cx-write-probe-' + process.pid);
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    try { fs.unlinkSync(probe); } catch (__) { /* ignore */ }
    return false;
  }
}

/**
 * 把「spawn 错误 / 退出码 / stderr / profile 现状」翻译成一句人能照着做的话。
 *
 * @param {number|null} code        进程退出码（拿不到传 null）
 * @param {string} stderr           内核 stderr（通常为空）
 * @param {object} cfg              配置（用其中的 chromium.profileDir）
 * @param {string} [spawnError]     spawn 自身抛的错（如 'ENOENT spawn ...'），优先级最高
 * @param {string} [signal]         进程被信号杀死时的信号名（'SIGKILL' 等）。
 *                                  向后兼容：不传也能工作，只是少了 OOM 归因。
 * @returns {{code, reason, hint, detail}} 永远返回对象，便于日志与测试断言
 */
function describeLaunchExit(code, stderr, cfg, spawnError, signal) {
  const text = String(stderr || '');
  const spawn = String(spawnError || '');
  const sig = String(signal || '');
  const prof = (cfg && cfg.chromium && cfg.chromium.profileDir) || '';
  const exe = (cfg && cfg.chromium && cfg.chromium.executablePath) || '';
  const out = {
    code: code === undefined ? null : code,
    reason: '',
    hint: '',
    detail: text ? text.slice(-600) : '',
  };

  /* ★ 2026-10-30：被信号杀死时退出码通常是 null，必须单独判。
     最高频的是 SIGKILL —— 在没有 swap 或刚被刷满的机器上，几乎都是
     OOM killer 干的（dmesg 里能查到 "Killed process ... chrome"）。
     这类故障 stderr 一定是空的，只看退出码会误报成「无可用 stderr 的启动失败」。 */
  if (sig === 'SIGKILL' || code === -9 || code === 137) {
    out.reason = '内核被 SIGKILL 强制终止（最常见原因：内存不足被 OOM killer 杀掉）';
    out.hint = '用 `dmesg -T | grep -i "killed process"` 确认；'
      + '降低并发/减少同时开的实例，或加 swap。注意本项目浏览器是 detached 的，'
      + '宿主退出不会带走它，残留实例会持续吃内存（见 D0 修复）。';
    return out;
  }
  if (sig) {
    out.reason = '内核被信号 ' + sig + ' 终止';
    out.hint = '若非人为 Ctrl+C / systemd stop，检查系统日志与内存压力。';
    return out;
  }

  /* spawn 层面的错误最确定：进程根本没起来，不必再看退出码 */
  if (spawn) {
    if (/ENOENT/.test(spawn)) {
      /* 裸命令名（默认值 'chromium'）找不到，是 PATH 问题，不是"路径写错" */
      if (isBareCommandName(exe)) {
        out.reason = '在 PATH 中找不到内核命令「' + exe + '」';
        out.hint = '把内核放到 PATH 里，或用 CX_CHROMIUM / 设置页指定内核的绝对路径。';
      } else {
        out.reason = '内核可执行文件不存在：' + exe;
        out.hint = '检查路径是否正确（可用 CX_CHROMIUM 指定）；NAS/容器里注意挂载点与架构。';
      }
      return out;
    }
    if (/EACCES|EPERM/.test(spawn)) {
      out.reason = '内核不可执行（权限不足）：' + exe;
      out.hint = '检查文件执行权限（Linux 上需 chmod +x），以及是否被安全策略拦截。';
      return out;
    }
    if (/ENOEXEC/.test(spawn)) {
      out.reason = '内核不是可执行文件或架构不匹配：' + exe;
      out.hint = '确认下载的是对应平台/架构的构建（x64 机器上别放 arm64 包）。';
      return out;
    }
  }

  /* stderr 里的原文优先级最高 —— 它最具体 */
  if (/Lock file can not be created/i.test(text)) {
    out.reason = 'profile 目录不可写（Chromium 无法创建锁文件）';
    out.hint = '检查目录权限：' + prof + '；容器里注意属主是否为运行用户。';
    return out;
  }
  if (/Failed to create a ProcessSingleton/i.test(text)) {
    out.reason = 'profile 被另一个浏览器实例占用（ProcessSingleton 冲突）';
    out.hint = '先确认没有残留实例，或换一个 --user-data-dir：' + prof;
    return out;
  }
  if (/No usable sandbox/i.test(text)) {
    out.reason = '内核缺少可用沙箱（容器/NAS 常见）';
    out.hint = '在 extraArgs 里加 --no-sandbox（本项目默认已加）。';
    return out;
  }
  if (/cannot open shared object file|error while loading shared libraries/i.test(text)) {
    out.reason = '内核缺少系统动态库';
    out.hint = '补齐依赖库；chrome-headless-shell 的依赖比完整 Chrome 少，可优先试它。';
    return out;
  }
  /* ★ 2026-10-30 新增两类「容器/小内存机器」高频死法。
     它们共同点是：stderr 往往为空（被内核自己吞掉），只能靠退出码与 stderr 片段归因。 */
  if (/No space left on device|ENOSPC/i.test(text)) {
    out.reason = '磁盘空间不足（内核无法写 profile / 缓存）';
    out.hint = '清理磁盘或把 CX_PROFILE_DIR 指到有空间的分区：' + prof;
    return out;
  }
  if (/\/dev\/shm|shared memory|shm_open/i.test(text)) {
    out.reason = '共享内存不足（/dev/shm 太小）';
    out.hint = '容器默认 /dev/shm 仅 64MB，无头内核的 renderer 会直接崩。'
      + '加 --disable-dev-shm-usage（本项目默认已加），或用 docker 的 --shm-size=1g。';
    return out;
  }
  /* 内核崩在渲染进程初始化阶段常见 exit -6(SIGABRT) / 11(SIGSEGV)：
     在容器里几乎都是 /dev/shm 或内存不足。 */
  if (code === -6 || code === 134 || code === -11 || code === 139) {
    out.reason = '内核在初始化阶段崩溃（信号 ' + (code === -6 || code === 134 ? 'SIGABRT' : 'SIGSEGV') + '）';
    out.hint = '容器里优先查 /dev/shm 是否过小、内存是否被 cgroup 限制；'
      + '本机先试 `df -h /dev/shm`（<256MB 就会出这个问题）。';
    return out;
  }

  /* 没有可用 stderr 时，按退出码 + 现场推断 */
  if (code === 21) {
    const lock = inspectProfileLock(prof);
    const writable = isProfileWritable(prof);
    if (!writable) {
      out.reason = 'profile 目录不可写（退出码 21，且写入探测失败）';
      out.hint = '修正目录权限：' + prof;
      return out;
    }
    if (lock.locked) {
      out.reason = 'profile 疑似被占用（退出码 21，发现锁文件）';
      out.hint = '若无其它实例在跑，删掉这些残留锁后重试：' + lock.evidence.join(', ');
      return out;
    }
    out.reason = 'profile 不可用（退出码 21 = PROFILE_IN_USE，但未找到锁文件）';
    out.hint = '可能是并发启动的竞态；稍后重试，或为每个实例使用独立 --user-data-dir。';
    return out;
  }

  if (code !== null && CHROMIUM_EXIT_CODES[code]) {
    out.reason = CHROMIUM_EXIT_CODES[code];
    out.hint = '检查内核是否完整、命令行参数是否被 extraArgs 覆盖。';
    return out;
  }

  out.reason = '内核启动失败（退出码 ' + code + '，无可用 stderr）';
  out.hint = '用 --headless=new 手动跑一次内核看完整报错；确认可执行文件路径与架构匹配。';
  return out;
}

/**
 * 计算一次 CDP 调用的超时毫秒数。
 *
 * ★ 2026-10-30 修 bug：原写法是
 *     `timeoutMs || (cfg.cdp.evalTimeoutMs + 25000)`
 *   当 cfg 里没有 evalTimeoutMs 时（例如测试或外部调用只传了部分 cfg），
 *   右边会得到 **NaN**，而 `setTimeout(fn, NaN)` 被 Node 当成 **1ms** ——
 *   于是每一个 CDP 调用都瞬间超时，报「CDP 调用超时: Target.attachToTarget」，
 *   但真正的原因是配置缺字段。这种 bug 极难从报错信息反推，必须显式兜底。
 *
 * @param {number|undefined} explicit 调用方显式指定的超时
 * @param {object} cfg                引擎配置
 * @returns {number} 一定是一个有限正数
 */
function resolveSendTimeout(explicit, cfg) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return n;
  const base = Number(cfg && cfg.cdp && cfg.cdp.evalTimeoutMs);
  const fallback = Number.isFinite(base) && base > 0 ? base : 15000;
  return fallback + 25000;
}

module.exports = {
  CHROMIUM_SINGLE_VALUED_FLAGS,
  CHROMIUM_BOOLEAN_FLAGS,
  chromiumFlagName,
  mergeChromiumArgs,
  buildChromiumArgs,
  readDevToolsActivePort,
  isHeadlessShellKernel,
  isBareCommandName,
  resolveCdpPort,
  CHROMIUM_EXIT_CODES,
  inspectProfileLock,
  isProfileWritable,
  describeLaunchExit,
  resolveSendTimeout
};
