/**
 * dsh-cx-learn —— host 半端
 * ============================================================================
 * 把「学习通自动看课」做成 DSH 插件：
 *   1. 引擎（engine/chaoxing-autolearn.js）原样保留，本插件只做**包装**：
 *      配置、进程生命周期、HTTP 接口、设置页 UI。
 *   2. 设置页（client.js）通过 /api/cx-learn/* 读写配置、看状态、扫码登录、启停任务。
 *   3. 运行期数据落在 $DSH_HOME/cx-learn/：
 *      config.json / state.json / run.log / .login/latest.png / browser-profile/
 *
 * 设计要点：
 *   - 浏览器内核与插件解耦：内核放在一个**共享目录**里，设置页可选择不同内核，
 *     换机器时只要把内核丢进那个目录就能直接用，不用改插件。
 *   - 默认安全模式只识别题目并暂停，题目进入人工审阅队列；不会自主答题、填空或提交。
 *   - 不接模型、不答题：章节测验只识别不碰；随堂题的分支在引擎侧（skip 模式）。
 * ============================================================================
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const name = 'cx-learn'

/* ★ B-精简：会话生命周期。
   直接复用引擎里的同一份实现（engine/src/session.js），不在这里重写一遍 ——
   两处实现必然漂移，「会话状态」这种东西漂移一次就会让 UI 与实际打架。 */
const requireCjs = createRequire(import.meta.url)
let sessionLib = null
try {
  sessionLib = requireCjs('./engine/src/session.js')
} catch (e) {
  // 降级：会话功能不可用，但不让插件起不来
  sessionLib = null
}
/**
 * ★★★ inject 的最终结论（三次踩坑后）★★★
 *
 * cordis 的 inject **只识别数组形式**。写成对象 `{ webServer: {required:false} }`
 * 会被忽略 —— 表现为插件照样报 `cannot get property "webServer" without inject`
 * 并且在 apply() 构造函数里直接抛错（try/catch 抓不到，因为发生在取值那一刻）。
 *
 * 三次踩坑记录：
 *   坑1（2026-10-27 本机）：数组写全是「硬要求」，宿主缺服务 → 插件 pending
 *        → 阻塞整个 DSH 启动。本机 Electron 版缺 webServer/attachments。
 *   坑2（2026-10-28 FNOS）：为躲坑1 把 inject 砍成 ['llm'] → apply 里访问
 *        ctx.webServer 直接抛错 → 插件崩 → 设置页状态栏三项全空。
 *   坑3（本次）：试图用对象形式做「可选」→ cordis 不认，仍抛同样错误。
 *
 * 最终方案：**按目标环境写数组**。
 *   · FNOS（web/headless profile，Node 服务版）：webServer / llm / attachments 都存在 → 三个都写
 *   · 本机 Electron 版：缺 webServer/attachments → 只写 llm
 * 由环境变量 CX_INJECT_MINIMAL 控制：
 *   CX_INJECT_MINIMAL=1 → 只注入 llm（本机用）
 *   未设置            → 注入全部三个（FNOS 用）
 */
const _minimalInject = String(process.env.CX_INJECT_MINIMAL || '') === '1'
export const inject = _minimalInject
  ? ['llm']
  : ['webServer', 'llm', 'attachments']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(PLUGIN_DIR, 'engine', 'chaoxing-autolearn.js')
const DSH_HOME = process.env.DSH_HOME || process.env.HOME || '/tmp'
const STATE = join(DSH_HOME, 'cx-learn')
const CFG_FILE = join(STATE, 'config.json')
const STATE_FILE = join(STATE, 'state.json')
const LOG_FILE = join(STATE, 'run.log')
const QUESTION_FILE = join(STATE, 'questions.jsonl')

const questionQueue = []
const questionSeen = new Set()
let questionOffset = 0
let questionRemainder = ''

/**
 * 浏览器内核共享目录。
 * 每个子目录是一个内核，内核目录里放可执行文件（chrome / chromium / headless_shell）。
 * 这样换机器时只要把内核丢进这个目录，UI 上就能直接选，不用改插件。
 *
 * 解析顺序：
 *   1. 环境变量 CX_BROWSER_ROOT（显式指定，最高优先级）
 *   2. DSH_HOME/cx-learn/browsers（跟插件数据放一起，默认）
 *   3. 若干常见共享位置（fnOS / NAS 场景）
 */
const BROWSER_ROOT_CANDIDATES = [
  process.env.CX_BROWSER_ROOT,
  join(DSH_HOME, 'cx-learn', 'browsers'),
  '/opt/dsh-shared/browsers',
  '/opt/dsh-shared/browsers',
  join(PLUGIN_DIR, '.browser'),
].filter(Boolean)

/** 选定的内核根目录（启动时探测一次，探测不到就用第一个候选）。 */
const BROWSER_ROOT = BROWSER_ROOT_CANDIDATES.find((p) => {
  try { return statSync(p).isDirectory() } catch { return false }
}) || BROWSER_ROOT_CANDIDATES[0]

/** 系统里可能存在的 chromium 可执行名（按顺序探测）。 */
const SYSTEM_CHROMIUM_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']

const DEFAULT_CFG = {
  courseUrl: '',
  mode: 'continue_chapters',
  maxSections: 5,
  videoDoneAt: '98.5%',
  // 浏览器内核：'' = 自动（优先共享区，其次系统）
  browserId: '',
  // 自定义内核路径（非空时优先于 browserId）
  chromiumPath: '',
  headless: true,
  /* 默认 skip 模式（2026-10-28 行为已更新）：
     · 视频内随堂题（.ans-videoquiz）：按选项顺序盲试，答错换下一个直到答对
       （主人确认随堂题不计入课程成绩）；遇「回看」惩罚或次数耗尽立即停。
     · 章节测验/作业（.TiMu）：只识别、记录，绝不作答、绝不提交；
       视频看完后直接 advanceSection 跳到下一节继续看。
     引擎侧对应开关：CONFIG.safety.skipChapterQuiz（默认 true）。 */
  quizMode: 'skip',
}

let child = null
/* ★ 2026-10-31：登录进程单独留个引用。
   原来 loginState() 用 `running()`（任何任务在跑）判断「是不是在等扫码」，
   于是看课跑到一半时 /login-state 仍返回 waiting，GUI 显示「等待扫码…」
   而实际早就登录成功、正在看课。 */
let loginChild = null

const ensureDir = () => { if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true }) }
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
const writeJson = (p, v) => { ensureDir(); writeFileSync(p, JSON.stringify(v, null, 2)) }
const nowLog = (s) => { ensureDir(); appendFileSync(LOG_FILE, `[plugin] ${new Date().toISOString()} ${s}\n`) }

const getCfg = () => ({ ...DEFAULT_CFG, ...readJson(CFG_FILE, {}) })
const saveCfg = (patch) => {
  const next = { ...getCfg(), ...(patch || {}) }
  writeJson(CFG_FILE, next)
  return next
}
/**
 * 是否有一轮任务在跑。
 * 不能只看内存里的 child：插件重启（DSH 重启 / 热重载）后 child 变 null，
 * 但引擎子进程可能还活着 —— 那样界面会显示「空闲」而实际还在刷课，
 * 主人点「开始看课」就会重复启动。所以额外用 pid 探活兜底。
 */
const running = () => {
  if (child && child.exitCode === null) return true
  const pid = Number(readJson(STATE_FILE, {}).pid || 0)
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function readQuestionEvents() {
  let text = ''
  try { text = readFileSync(QUESTION_FILE, 'utf8') } catch { return }
  // 文件被轮换/清空时从头读；旧的半行也不能带到新文件。
  if (questionOffset > text.length) {
    questionOffset = 0
    questionRemainder = ''
  }
  const fresh = questionRemainder + text.slice(questionOffset)
  questionOffset = text.length
  const lines = fresh.split('\n')
  // 最后一段没有换行，说明引擎可能仍在写入；保留到下一轮再解析。
  questionRemainder = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const q = JSON.parse(line)
      if (!q.id || questionSeen.has(q.id)) continue
      questionSeen.add(q.id)
      questionQueue.push({ ...q, status: 'pending', draftedAt: null })
    } catch { /* 完整但损坏的记录丢弃；半行不会进入这里 */ }
  }
  while (questionQueue.length > 100) questionQueue.shift()
}

function questionDraft(q) {
  const title = q.kind === 'video_embedded_quiz' ? '[视频内随堂题]' : q.kind === 'chapter_work' ? '[章节测验]' : '[待确认题目]'
  const opts = Array.isArray(q.options) ? q.options.map((o) => (o.letter || '') + '. ' + (o.label || '')).join('\n') : ''
  const context = [
    title,
    q.chapterTitle ? '[来源章节] ' + q.chapterTitle : '',
    q.videoTime != null ? '[视频时间] ' + q.videoTime + 's / ' + (q.duration || '?') + 's' : '',
  ].filter(Boolean).join('\n')
  return context + '\n\n题目：' + (q.question || '') + (opts ? '\n选项：\n' + opts : '') +
    '\n\n请先分析这道题，但不要替我操作学习通页面。'
}

/* ── 预留的 AI 答题接口（占位，未实现）──────────────────────────────────
 * 主人要求「只给个接口，以后再用」：契约现在定死，实现时只改这一个函数，
 * 调用方（设置页 / 脚本 / 以后的引擎回调）不用跟着改。
 *
 * 契约（见 docs/SPEC.md §8.2）：
 *   POST /api/cx-learn/ask
 *     { question?: string, options?: string[], image?: string, model?: string }
 *     question 与 image 至少给一个；options 可选。
 *   成功（将来实现后）：200 { ok:true, answer:'B', model:string, raw?:string }
 *   现在：              200 { ok:false, code:'AI_ANSWER_DISABLED', error:string }
 *   参数不全：          400 { ok:false, error:string }
 *
 * 实现时的硬边界（写在这里防止以后忘）：
 *   · 只服务「随堂题」；章节测验/作业仍然只识别、绝不答（铁律，有测试）
 *   · 这个函数**只返回文本**，不许在这里点页面、选选项或提交
 *   · 不引入新的出站依赖前，先确认宿主有没有 llm 服务
 */
function askReserved(body) {
  const question = String(body?.question || '').trim()
  const image = String(body?.image || '').trim()
  if (!question && !image) {
    return { status: 400, body: { ok: false, error: 'question 或 image 必填（options 可选）' } }
  }
  return {
    status: 200,
    body: {
      ok: false,
      code: 'AI_ANSWER_DISABLED',
      error: 'AI 答题未启用：接口已预留，实现后自动生效',
    },
  }
}

function tailLog(n = 40) {
  try {
    const t = readFileSync(LOG_FILE, 'utf8')
    return t.slice(-12000).split('\n').slice(-n).join('\n')
  } catch { return '' }
}

/* ── 浏览器内核目录 ─────────────────────────────────────────────────────── */

/** 在一个内核目录里找到可执行文件（chrome / chromium / headless_shell / chrome-headless-shell）。 */
function findBinaryIn(dir) {
  const names = ['chrome', 'chromium', 'chromium-browser', 'headless_shell', 'chrome-headless-shell']
  for (const n of names) {
    const p = join(dir, n)
    try { if (existsSync(p) && statSync(p).isFile()) return p } catch { /* ignore */ }
  }
  return ''
}

/** 扫描共享目录，列出所有可用内核。 */
function listBrowsers() {
  const out = []
  let entries = []
  try { entries = readdirSync(BROWSER_ROOT, { withFileTypes: true }) } catch { entries = [] }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(BROWSER_ROOT, e.name)
    const bin = findBinaryIn(dir)
    if (!bin) continue
    let version = ''
    try {
      version = execFileSyncSafe(bin, '--version')
    } catch { version = '' }
    out.push({
      id: 'shared:' + e.name,
      label: '共享内核 · ' + e.name + (version ? '（' + version + '）' : ''),
      path: bin,
      source: 'shared',
    })
  }
  // 系统内核：按平台给候选路径，保证「换电脑装个 DSH 就能用」
  for (const [p, label] of systemBrowserCandidates()) {
    if (!existsSync(p)) continue
    let version = ''
    try { version = execFileSyncSafe(p, '--version') } catch { version = '' }
    out.push({
      id: 'system:' + label.replace(/\s+/g, '-'),
      label: '系统内核 · ' + label + (version ? '（' + version + '）' : ''),
      path: p,
      source: 'system',
    })
  }
  return out
}

/**
 * 各平台常见 Chrome / Edge / Chromium 安装路径。
 * 目标是「用户什么都不配，插件自己找到本机浏览器」。
 */
function systemBrowserCandidates() {
  const out = []
  if (process.platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'] || 'C:\\Program Files',
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'] || '',
    ].filter(Boolean)
    for (const r of roots) {
      out.push([join(r, 'Google\\Chrome\\Application\\chrome.exe'), 'Chrome'])
      out.push([join(r, 'Microsoft\\Edge\\Application\\msedge.exe'), 'Edge'])
      out.push([join(r, 'Chromium\\Application\\chrome.exe'), 'Chromium'])
    }
  } else if (process.platform === 'darwin') {
    out.push(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'])
    out.push(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'])
    out.push(['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium'])
    out.push(['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'])
  } else {
    for (const n of SYSTEM_CHROMIUM_NAMES) {
      for (const d of ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/snap/bin']) {
        out.push([join(d, n), n])
      }
    }
  }
  return out
}

/**
 * 同步取内核版本号。
 *
 * ★★★ 2026-10-31 重大修复：Windows 上**绝对不能**执行 `chrome.exe --version` ★★★
 *   实测（本机 Edge 156）：`msedge.exe --version` 不会打印版本，而是
 *   **直接启动一个完整浏览器**（一次 10 个进程），并且**不退出**。
 *
 *   而 `listBrowsers()` 会给每个候选内核执行一次，`status()` 每次被 UI 轮询
 *   都会调 `listBrowsers()` —— UI 每 3 秒轮询 → 每 3 秒弹一堆浏览器窗口，
 *   而且越积越多。这就是「装插件后一直弹窗」的真因。
 *
 *   修法：Windows 上不做版本探测，直接返回空串。
 *   版本号本来就有更好的来源：引擎启动内核后会把它写进
 *   `engine/.state/browser.json` 的 `browserVersion`（CDP /json/version 拿的，
 *   免费且准确），UI 读那里即可。
 *
 * @returns {string} 版本字符串；拿不到返回空串（绝不抛错）
 */
function execFileSyncSafe(bin, arg) {
  /* Windows：--version 会开浏览器，一律不执行 */
  if (process.platform === 'win32' && String(arg || '').indexOf('--version') >= 0) {
    return ''
  }
  try {
    return String(execFileSync(bin, [arg], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim()
  } catch { return '' }
}

/** 解析当前生效的浏览器内核路径。 */
function chromiumPath() {
  const cfg = getCfg()
  // 1) 自定义路径优先
  if (cfg.chromiumPath && existsSync(cfg.chromiumPath)) return cfg.chromiumPath
  // 2) 选中的内核
  const browsers = listBrowsers()
  if (cfg.browserId) {
    const hit = browsers.find((b) => b.id === cfg.browserId)
    if (hit) return hit.path
  }
  // 3) 自动：共享区第一个，其次系统
  const shared = browsers.find((b) => b.source === 'shared')
  if (shared) return shared.path
  const sys = browsers.find((b) => b.source === 'system')
  if (sys) return sys.path
  return 'chromium'
}

/* ── 会话（B-精简）──────────────────────────────────────────────────────
 * 语义：浏览器允许活着的时间窗。窗口内可以「读课程 → 看课 → 再读课程 →
 * 再看第二门课」，全程复用同一个内核，不重扫。
 * 窗口关闭：① 用户点「结束会话」 ② 闲置超时 ③ 插件卸载/DSH 关闭。
 *
 * 写方唯一：宿主。引擎只读（通过 CX_KEEP_BROWSER 知道「别关」）。
 * ---------------------------------------------------------------------- */

/** 闲置多久自动结束会话（毫秒）。默认 30 分钟，可用 CX_SESSION_KEEP_MS 覆盖。 */
const SESSION_KEEP_MS = (() => {
  const n = Number(process.env.CX_SESSION_KEEP_MS)
  return Number.isFinite(n) && n > 0 ? n : (sessionLib ? sessionLib.DEFAULT_KEEP_ALIVE_MS : 30 * 60 * 1000)
})()

/** 读会话状态（永不抛错）。 */
function readSessionState() {
  if (!sessionLib) return null
  try { return sessionLib.readSession(STATE) } catch { return null }
}

/** 会话是否处于「可用」：状态活着 **且** 登录已验证 **且** 内核端口还响应。 */
async function sessionUsable() {
  const s = readSessionState()
  if (!s || !s.active) return { usable: false, session: s, reason: 'no_session' }
  if (!s.loginVerified) return { usable: false, session: s, reason: 'not_logged_in' }
  const alive = await probeKernelPort(s.port)
  if (!alive) return { usable: false, session: s, reason: 'kernel_dead' }
  return { usable: true, session: s, reason: '' }
}

/**
 * 刷新会话的最后使用时间。
 * 每个「用浏览器」的动作（读课程 / 开始看课 / 取二维码）都要调，
 * 否则闲置计时器会把正在使用的会话当成闲置杀掉。
 */
function touchSession() {
  if (!sessionLib) return
  const s = readSessionState()
  if (!s || !s.active) return
  try { sessionLib.writeSession(STATE, { lastUsedAt: new Date().toISOString() }) } catch { /* ignore */ }
}

/** 探一下内核端口是否响应（< 2s，永不抛错）。 */
async function probeKernelPort(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  try {
    const res = await fetch('http://127.0.0.1:' + p + '/json/version', { signal: ctrl.signal })
    return res.ok
  } catch { return false } finally { clearTimeout(timer) }
}

/** 用 browser.json 校正会话里记录的端口/内核 pid（登录进程退出后才拿得到）。 */
function syncSessionFromBrowserJson() {
  if (!sessionLib) return
  const b = readBrowserState()
  if (!b) return
  const cur = readSessionState() || {}
  const patch = {}
  if (Number.isInteger(b.port) && b.port !== cur.port) patch.port = b.port
  if (Number.isInteger(b.pid) && b.pid !== cur.kernelPid) patch.kernelPid = b.pid
  if (Object.keys(patch).length) sessionLib.writeSession(STATE, patch)
}

/**
 * 结束会话：关内核 + 删 profile + 标记 closed。
 * 幂等；任何一步失败都不抛错（收尾动作不该把调用方带崩）。
 * @returns {{ok:boolean, killed:boolean, purged:boolean, reason:string}}
 */
async function endSession(reason) {
  const s = readSessionState()
  let killed = false
  try { killed = (await killStrayBrowser()) === true } catch { killed = false }
  const purged = purgeEphemeralProfile()
  if (sessionLib) {
    try { sessionLib.closeSession(STATE, reason || 'user') } catch { /* ignore */ }
  }
  nowLog('session ended: reason=' + (reason || 'user') + ' killed=' + killed + ' purged=' + purged
    + ' wasActive=' + !!(s && s.active))
  return { ok: true, killed, purged, reason: reason || 'user' }
}

/**
 * 会话看护：每 5 秒一次。
 *  - 会话标记活着但内核端口不响应 → 判定内核已死，清掉会话（不留脏状态）
 *  - 闲置超过 SESSION_KEEP_MS → 自动结束会话
 */
let _sessionTimer = null
function startSessionWatcher() {
  if (_sessionTimer) return
  _sessionTimer = setInterval(async () => {
    try {
      let s = readSessionState()
      if (!s || !s.active) return
      /* ★★★ 2026-10-31 真机事故：看课任务跑满 30 分钟后，闲置计时器判定
         「30 分钟没有请求」→ endSession('idle_timeout') → 杀内核 + 删 profile，
         引擎下一次 tick 直接 CDP 断连 → 连续 3 次失败 → FATAL UNRECOGNIZED_PAGE。
         任务在跑时绝不能判闲置，顺手刷新 lastUsedAt。 */
      if (running()) {
        touchSession()
        return
      }
      if (!child) {
        /* ★ 2026-10-31：端口未知时**不能**直接判死。
           登录刚成功的那一瞬间，browser.json 可能还没同步进会话；
           原实现此时 port=null → probe 失败 → 判 kernel_dead → 删 profile，
           也就是「扫码成功 2.4 秒后登录态被清空」。
           正确做法：先尝试从 browser.json 补端口；补不到就跳过这一轮。 */
        if (!Number.isInteger(s.port) || s.port <= 0) {
          syncSessionFromBrowserJson()
          s = readSessionState()
          if (!s || !s.port) {
            nowLog('session watcher: 会话端口未知，跳过存活判定（等 browser.json）')
            return
          }
        }
        const alive = await probeKernelPort(s.port)
        if (!alive) {
          nowLog('session watcher: 内核端口不再响应，会话标记为关闭 port=' + s.port)
          if (sessionLib) sessionLib.closeSession(STATE, 'kernel_dead')
          /* ★ 不删 profile：内核异常死亡 ≠ 登录态失效。
             下一次启动还能复用同 profile 里的 cookie，删了就必须重扫。 */
          nowLog('session watcher: profile 保留（内核死亡不代表登录失效，下次可复用）')
          return
        }
      }
      const ex = sessionLib.shouldExpire(STATE, SESSION_KEEP_MS)
      if (ex.expire) {
        nowLog('session watcher: 闲置 ' + Math.round(ex.idleMs / 1000) + 's 超过阈值，自动结束会话')
        await endSession('idle_timeout')
      }
    } catch (e) {
      nowLog('session watcher 异常：' + String(e?.message ?? e))
    }
  }, 5000)
  _sessionTimer.unref?.()
}

/* ── 引擎进程 ──────────────────────────────────────────────────────────── */

function spawnEngine(args) {
  ensureDir()
  clearProfileLock()
  const cfg = getCfg()
  const env = {
    ...process.env,
    CX_CHROMIUM: chromiumPath(),
    // 一次性登录：profile 用临时目录，任务跑完即删（见 purgeEphemeralProfile）
    CX_PROFILE_DIR: ephemeralProfileDir(),
    // 登录结果写机器可读文件，宿主/前端不再靠解析日志猜状态
    CX_LOGIN_RESULT: join(STATE, '.login', 'result.json'),
    // 登录截图必须落在「当前用户」的 state 目录，否则多用户共用一份会互相覆盖
    CX_LOGIN_SHOT_DIR: join(STATE, '.login'),
    // 引擎只把识别到的题目追加到事件文件；该通道不包含答案与页面操作。
    CX_QUESTION_FILE: QUESTION_FILE,
    // 登录态用完就废：引擎跑在独立临时 profile 里
    CX_EPHEMERAL_LOGIN: '1',
  }
  // 强制安全闸门：本任务只负责观看视频，绝不自主答题或提交。
  // 即使旧 config.json 保存过 ai，也不能通过配置把真实作业答题打开。
  env.CX_QUIZ_MODE = 'skip'

  /* ★ B-精简：看课任务结束时**不要**关内核/删 profile，因为会话可能还开着
     （用户要接着刷第二门课）。引擎侧据此走 detach 而不是 shutdown。
     其它命令（--login / --check-login / --list-courses）有自己的收尾逻辑，不设这个。 */
  if (isWatchRun(args)) env.CX_KEEP_BROWSER = '1'

  const c = spawn(process.execPath, [ENGINE, ...args], {
    cwd: STATE, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  c.stdout.on('data', (d) => { try { appendFileSync(LOG_FILE, d) } catch { /* ignore */ } })
  c.stderr.on('data', (d) => { try { appendFileSync(LOG_FILE, d) } catch { /* ignore */ } })
  c.on('exit', (code) => {
    try { appendFileSync(LOG_FILE, `\n[engine exit] code=${code}\n`) } catch { /* ignore */ }
    if (child === c) child = null

    /* ★ 2026-10-31：引擎把「为什么停」写在自己的 engine/.state/learn.json，
       而 /status.state 读的是宿主 state.json —— 两边从来没对上过，
       所以真机上看不到 stopReason（只有 null）。这里退出时合并一次。 */
    mergeLearnIntoState()

    /* ★★★ 2026-10-31（B-精简）：看课任务结束**不再**销毁登录态 ★★★
       原实现是 `if (isWatchRun(args)) purgeEphemeralProfile()`，
       于是跑完一门课就删 profile + 关内核，想接着刷第二门必须重扫。
       现在改成：
         · 引擎侧已按 CX_KEEP_BROWSER=1 走了 detach（内核留着）
         · 这里只刷新会话的 lastUsedAt，供闲置超时判定
         · 会话真正结束由「结束会话」按钮 / 闲置超时 / 插件卸载负责
       例外：引擎以 LOGIN_REQUIRED 收场时，它自己会关内核并删 profile，
       这里把会话标记关掉，避免 UI 还显示「会话可用」。 */
    if (isWatchRun(args)) {
      const st = readJson(STATE_FILE, null) || {}
      const loginLost = st.stopReason === 'LOGIN_REQUIRED'
      if (loginLost) {
        if (sessionLib) { try { sessionLib.closeSession(STATE, 'login_lost') } catch { /* ignore */ } }
        purgeEphemeralProfile()
      } else if (sessionLib) {
        /* 先按 browser.json 校正端口/pid ——
           如果这次任务是引擎自己重新起的内核（会话曾经断过），
           会话里记的还是旧端口，不校正的话下一次会连不上。 */
        syncSessionFromBrowserJson()
        try { sessionLib.writeSession(STATE, { lastUsedAt: new Date().toISOString() }) } catch { /* ignore */ }
      }
    }

    /* ★ 2026-10-30 D0：引擎退出后兜底清内核。
       背景：浏览器是 detached + unref 起的（登录后要跨进程复用会话），父进程死了照活。
       原来这里只删 profile、从不关浏览器，于是：
         · 扫码超时（引擎 exit=2）→ 留下一个**没登录**的 headless 实例
         · 实测一次泄漏 13 个进程 / 1335 MB RSS
         · profile 被占用 → purgeEphemeralProfile() 也删不掉，一直占到下次 stop()

       只处理 **--login 且失败** 这一种：其它命令各自有 finally（run() / checkLoginState()
       都会 shutdownBrowser），重复兜底会误杀它们正在收尾的实例。
       登录成功则必须保留浏览器 —— 那次登录的会话要留给紧接着的
       --list-courses / 看课任务复用，杀了等于白扫。

       安全边界：killStrayBrowser() 只按本插件自己的 profile 标记匹配
       （tmpdir()/cx-learn-ephemeral 与 STATE/browser-profile），不碰 9223 上的生产 Chrome。 */
    if (args.includes('--login')) {
      const lr = readJson(join(STATE, '.login', 'result.json'), null)
      const loginSucceeded = !!(lr && lr.ok === true && lr.verified === true)
      if (!loginSucceeded) {
        /* killStrayBrowser 现在是异步的（Windows 走 CDP 关闭），
           这里不 await：它只是退出后的兜底清理，不该拖住 exit 回调。 */
        Promise.resolve().then(() => killStrayBrowser()).catch(() => { /* ignore */ })
        if (sessionLib) { try { sessionLib.closeSession(STATE, 'login_failed') } catch { /* ignore */ } }
      } else {
        /* ★ 登录成功 = 会话开始。把浏览器端口/内核 pid 记进会话，
           后续「读课程 / 看课」都靠它找到同一个内核。
           ★ 2026-10-31 真机事故：原来是「先 sync 再 openSession」，而 openSession
           的默认值 port:null 会把 sync 刚写进去的端口覆盖掉 → watcher 5 秒内
           判 kernel_dead → 清会话并删 profile。现在先开会话（直接带上端口），
           再补一次 sync 兜底。 */
        const b = readBrowserState() || {}
        if (sessionLib) {
          try {
            sessionLib.openSession(STATE, {
              loginVerified: true,
              verifiedAt: new Date().toISOString(),
              port: Number.isInteger(b.port) ? b.port : null,
              kernelPid: Number.isInteger(b.pid) ? b.pid : null,
            })
          } catch { /* ignore */ }
        }
        syncSessionFromBrowserJson()
        nowLog('session opened（登录成功，内核保留供后续复用）port=' +
          ((readSessionState() || {}).port ?? 'null'))
      }
    }
  })
  child = c
  return c
}

/** 判断这次 spawn 是不是「看课任务」（登录/预检/读课程/自测都不算）。 */
function isWatchRun(args) {
  const skip = ['--login', '--check-login', '--self-test', '--list-courses', '--serve-mcp']
  return !skip.some((f) => args.includes(f))
}

/**
 * 删除一次性登录 profile（登录态用完即废）。
 * profile 位置与引擎一致：$TMPDIR/cx-learn-ephemeral/session
 *
 * ★ 2026-10-31 修：原来重试之间用 `execFileSyncSafe('sleep', '0.5')` 等待，
 *   而 Windows 上没有 `sleep` 命令（实测 `spawnSync sleep ENOENT`）——
 *   于是 6 次重试之间**完全没有间隔**，浏览器还没释放文件就删，
 *   6 次连续失败后报「purge failed」。本机一直是这个状态。
 *   改成同步阻塞等待，跨平台都有效。
 */
function purgeEphemeralProfile() {
  const dir = join(tmpdir(), 'cx-learn-ephemeral', 'session')
  // 登录结果文件也一起清，避免旧的 verified 残留误导 /login-state
  try { unlinkSync(join(STATE, '.login', 'result.json')) } catch { /* ignore */ }
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      nowLog('login state purged: ' + dir)
      return true
    } catch (e) {
      // 浏览器刚退出时可能还占着文件，稍等重试（同步阻塞，跨平台可用）
      sleepSync(500)
    }
  }
  nowLog('purge login state failed: ' + dir)
  return false
}

/** 同步阻塞等待。用 Atomics.wait 而不是 `sleep` 命令：Windows 上没有 sleep。 */
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch {
    /* 极端环境不支持则退化为忙等（最多几百毫秒，可接受） */
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

/* ── 业务动作 ──────────────────────────────────────────────────────────── */

function start(args = {}) {
  if (running()) return { ok: false, error: '已经有一轮在跑了，先停止' }
  const cfg = getCfg()
  const url = String(args.courseUrl || cfg.courseUrl || '').trim()
  if (!url) return { ok: false, error: '还没填课程地址（学习通 studentstudy 页 URL）' }
  if (!existsSync(ENGINE)) return { ok: false, error: '引擎文件缺失：engine/chaoxing-autolearn.js' }

  const mode = String(args.mode || cfg.mode || 'continue_chapters')
  const maxSections = Math.max(1, Math.min(200, Number(args.maxSections || cfg.maxSections) || 5))
  const argv = ['--mode=' + mode, '--max-sections=' + maxSections, '--course-url=' + url]

  /* ★ B-精简：看课会消耗会话，刷新最后使用时间，别让它被闲置计时器误杀 */
  touchSession()

  try {
    const c = spawnEngine(argv)
    // 记 pid：插件重启后靠它探活，避免「界面空闲但实际还在跑」
    writeJson(STATE_FILE, { startedAt: Date.now(), mode, maxSections, url, pid: c.pid })
    nowLog('start pid=' + c.pid + ' mode=' + mode + ' max=' + maxSections)
    return { ok: true, pid: c.pid }
  } catch (e) {
    return { ok: false, error: '启动失败：' + (e?.message ?? e) }
  }
}

/**
 * 启动前的登录态预检（每次「开始看课」都会调）。
 * 单独跑一次引擎 --check-login：只访问个人空间判断是否已登录，不开二维码。
 * 返回 { ready:true } 表示可以开跑；{ ready:false, needLogin:true } 表示要先扫码。
 */
function precheckLogin() {
  return new Promise((resolve) => {
    if (!existsSync(ENGINE)) return resolve({ ready: false, error: '引擎文件缺失' })
    const env = {
      ...process.env,
      CX_CHROMIUM: chromiumPath(),
      CX_PROFILE_DIR: ephemeralProfileDir(),
      CX_LOGIN_SHOT_DIR: join(STATE, '.login'),
      // 与 spawnEngine 保持一致：一次性模式，只认当前会话的临时 profile
      CX_EPHEMERAL_LOGIN: '1',
    }
    let out = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    let c
    try {
      c = spawn(process.execPath, [ENGINE, '--check-login'], {
        cwd: STATE, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return finish({ ready: false, error: '预检启动失败：' + (e?.message ?? e) })
    }
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', () => { /* 引擎日志走 stderr，预检不看 */ })
    c.on('error', (e) => finish({ ready: false, error: '预检进程错误：' + (e?.message ?? e) }))
    c.on('close', (code) => {
      const idx = out.lastIndexOf('{')
      if (idx < 0) return finish({ ready: false, error: '预检无输出（code=' + code + '）' })
      let j
      try { j = JSON.parse(out.slice(idx)) } catch { return finish({ ready: false, error: '预检结果解析失败' }) }
      if (j && j.ok && j.loggedIn) return finish({ ready: true, url: j.url })
      return finish({
        ready: false,
        needLogin: true,
        url: j && j.url,
        error: j && j.reason ? j.reason : '登录态已失效',
      })
    })
    // 兜底超时：预检不该超过 90 秒
    setTimeout(() => {
      try { c.kill('SIGKILL') } catch { /* ignore */ }
      finish({ ready: false, error: '登录态预检超时' })
    }, 90000).unref?.()
  })
}

function stop() {  if (!running()) return { ok: false, error: '当前没有任务在跑' }
  const pid = child && child.exitCode === null ? child.pid : Number(readJson(STATE_FILE, {}).pid || 0)
  try {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    else if (pid) process.kill(pid, 'SIGTERM')
  } catch { /* ignore */ }
  nowLog('stop requested pid=' + pid)
  // SIGTERM 可能让引擎来不及跑 finally，这里兜底关浏览器，避免一直占着调试端口。
  setTimeout(() => { Promise.resolve().then(() => killStrayBrowser()).catch(() => { /* ignore */ }) }, 2500)
  // 清掉 pid，避免探活误判；同时留下「谁停的」——否则 /status 只有 running:false，
  // 前端与监视脚本都看不到原因（2026-10-31 真机实测：stop 后 stopReason 恒为 null）。
  try {
    const st = readJson(STATE_FILE, {})
    delete st.pid
    st.stopReason = 'stopped_by_user'
    st.stoppedAt = new Date().toISOString()
    writeJson(STATE_FILE, st)
  } catch { /* ignore */ }
  return { ok: true, pid }
}

/**
 * 兜底关掉残留的 headless Chrome。
 * 只在「本插件自己的 profile 目录」上动手，绝不碰其它 Chrome 实例。
 *
 * ★ 2026-10-31 修：原实现只调 `ps`，在 Windows 上 `ps` 不存在
 *   （实测 `spawnSync ps ENOENT`），所以本机这套兜底**从来没生效过** ——
 *   进程泄漏在本机根本没被这层管到，只是没人发现。
 *
 *   现在分两条路：
 *     · POSIX：`ps` 按 profile 标记精确匹配（能区分「我们的」和「别人的」）
 *     · Windows：走 CDP `/json/list` + `Browser.close`（拿不到进程表，
 *       但能通过端口找到自己那个实例，并让它体面退出）
 *   两条路都只在「本插件自己的 profile」上动手。
 */
function killStrayBrowser() {
  if (process.platform === 'win32') return killStrayBrowserByCdp()
  const marker = join(tmpdir(), 'cx-learn-ephemeral')
  const legacy = join(STATE, 'browser-profile')
  let out = ''
  // 依次尝试几种 ps 写法，兼容不同发行版
  for (const args of [['-eo', 'pid=,args='], ['-eo', 'pid,args'], ['-ef']]) {
    try {
      out = String(execFileSync('ps', args, { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '')
      if (out.trim()) break
    } catch { /* 换下一种 */ }
  }
  if (!out.trim()) { nowLog('killStrayBrowser: ps 输出为空（本平台可能没有 ps）'); return false }
  let killed = 0
  for (const line of out.split('\n')) {
    if (!line.includes('--remote-debugging-port')) continue
    if (!line.includes(marker) && !line.includes(legacy)) continue
    const m = /^\s*(\d+)/.exec(line)
    if (!m) continue
    try { process.kill(Number(m[1]), 'SIGKILL'); killed += 1 } catch (e) { /* ignore */ }
  }
  nowLog('killed stray browser procs: ' + killed)
  return killed > 0
}

/**
 * Windows 下的兜底：通过 CDP 让内核自己退出。
 *
 * 为什么不按进程名杀：插件是共享的，一台机器上可能有别人的 Chrome。
 * 只处理「状态文件/DevToolsActivePort 指向的那个实例」，且只在
 * 我们自己的 profile 目录里找端口号 —— 别的实例不会在我们的 profile 里留端口文件。
 *
 * @returns {boolean} 是否真的关掉了什么
 */
async function killStrayBrowserByCdp() {
  const ports = collectOurPorts()
  let closed = 0
  for (const port of ports) {
    const ws = await getWsDebuggerUrl(port)
    if (!ws) continue
    if (await closeBrowserViaWs(ws)) {
      closed += 1
      nowLog('killStrayBrowser(Win): 已请求端口 ' + port + ' 的内核退出')
    }
  }
  if (!closed) nowLog('killStrayBrowser(Win): 没有发现可关闭的内核（端口：' + [...ports].join(',') + '）')
  return closed > 0
}

/** 收集「属于本插件」的 CDP 端口：状态文件 + 我们自己 profile 里的 DevToolsActivePort */
function collectOurPorts() {
  const ports = new Set()
  try {
    const b = readJson(join(PLUGIN_DIR, 'engine', '.state', 'browser.json'), null)
    const p = b && Number(b.port)
    if (Number.isInteger(p) && p > 0) ports.add(p)
  } catch { /* ignore */ }
  for (const dir of [ephemeralProfileDir(), join(STATE, 'browser-profile')]) {
    try {
      const first = String(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim()
      const p = Number(first)
      if (Number.isInteger(p) && p > 0) ports.add(p)
    } catch { /* 没有这个文件：说明该 profile 从未启动过内核 */ }
  }
  return ports
}

/**
 * 取 /json/version 里的 webSocketDebuggerUrl。
 * @returns {Promise<string>} 拿不到返回空串（端口没开 / 不是 Chromium / 超时）
 */
async function getWsDebuggerUrl(port) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ctrl.signal })
    if (!res.ok) return ''
    const j = await res.json()
    return String((j && j.webSocketDebuggerUrl) || '')
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 发 Browser.close 并等连接关闭。
 * @returns {Promise<boolean>} 是否成功发出并观察到关闭
 */
function closeBrowserViaWs(wsUrl) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function') return resolve(false)
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.close() } catch { /* ignore */ }
      resolve(ok)
    }
    let sock
    try {
      sock = new WebSocket(wsUrl)
    } catch { return resolve(false) }
    const guard = setTimeout(() => finish(false), 4000)
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch { finish(false) }
    }
    sock.onclose = () => { clearTimeout(guard); finish(true) }
    sock.onerror = () => { clearTimeout(guard); finish(false) }
  })
}

function login() {
  if (running()) return { ok: false, error: '先停止当前任务，再点登录' }
  if (!existsSync(ENGINE)) return { ok: false, error: '引擎文件缺失' }
  try {
    const c = spawnEngine(['--login'])
    loginChild = c
    c.on('exit', () => { if (loginChild === c) loginChild = null })
    nowLog('login pid=' + c.pid)
    return { ok: true, pid: c.pid, hint: '约 10 秒后生成二维码，点「刷新二维码」' }
  } catch (e) {
    return { ok: false, error: '登录进程启动失败：' + (e?.message ?? e) }
  }
}

/**
 * 让登录进程**真的换一张新二维码**，然后返回新图。
 *
 * ★ 2026-10-30 修：原来的「刷新二维码」只是重读 latest.png 这个文件
 *   （见 qr()），根本没有让浏览器换码 —— 用户点了很多次，看到的还是
 *   同一张已经「已失效」的图，所以体感是「按钮没反应」。
 *
 * 做法：给登录引擎发一个信号文件，引擎侧轮询到就点页面上的「重新获取」。
 * 为什么用文件而不是直接操作 CDP：登录跑在独立子进程里，宿主不持有它的
 * adapter；跨进程通信用文件最省事，也不会引入新的并发问题。
 *
 * @returns {{ok:boolean, requested?:boolean, error?:string}}
 */
function requestQrRefresh() {
  if (!running()) return { ok: false, error: '当前没有登录进程在跑，请先点「开始登录」' }
  try {
    ensureDir()
    const flag = join(STATE, '.login', 'refresh.request')
    writeFileSync(flag, String(Date.now()), 'utf8')
    nowLog('qr refresh requested')
    return { ok: true, requested: true }
  } catch (e) {
    return { ok: false, error: '写入刷新请求失败：' + (e?.message ?? e) }
  }
}

function qr() {
  // 引擎把截图写在 CX_LOGIN_SHOT_DIR（= 当前用户的 state/.login）下。
  // 优先给「纯二维码图」qr.png（270x270，扫起来最直接）；没有再回退整页截图。
  const shotDir = join(STATE, '.login')
  const rawQr = join(shotDir, 'qr.png')
  if (existsSync(rawQr)) {
    try {
      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + readFileSync(rawQr).toString('base64'),
        raw: true,
        mtime: statSync(rawQr).mtimeMs,
        path: rawQr,
      }
    } catch { /* fall through */ }
  }
  const candidates = [
    join(shotDir, 'latest.png'),
    join(PLUGIN_DIR, 'engine', '.login', 'latest.png'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const b = readFileSync(p)
      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + b.toString('base64'),
        mtime: statSync(p).mtimeMs,
        path: p,
      }
    } catch { /* try next candidate */ }
  }
  return { ok: false, error: '还没有二维码（先点「扫码登录」，等 10 秒再点「刷新二维码」）' }
}

/**
 * 扫码登录进度（前端轮询用）。
 *
 * 以引擎写的机器可读结果文件（.login/result.json）为准，不再靠解析日志猜：
 *   - 登录进程在跑      → waiting（等待扫码）
 *   - verified=true   → logged_in（扫完码且回个人空间验证通过）
 *   - reason=timeout  → timeout
 *   - profile 残留但未验证 → stale（上次中断了，登录态不可信，建议重扫）
 */
async function loginState() {
  const out = { ok: true, state: 'idle', hint: '' }
  const hasProfile = existsSync(ephemeralProfileDir())
  let res = {}
  try { res = readJson(join(STATE, '.login', 'result.json'), {}) } catch { res = {} }

  /* ★ 只看「登录进程」是否在跑，不看是不是有别的任务在跑（看课）——
     否则看课期间 /login-state 会一直返回 waiting，GUI 显示「等待扫码…」。 */
  if (loginChild && loginChild.exitCode === null) {
    out.state = 'waiting'
    out.hint = '等待扫码…'
    return out
  }

  /* ★ B-精简：登录态的权威来源改成「会话」。
     原判据是「结果文件说 verified + profile 目录存在」——
     这是**猜**：目录在 ≠ 内核活着 ≠ cookie 还在。
     现在要求三件事同时成立：会话 active + loginVerified + 内核端口真的响应。 */
  const ses = await sessionUsable()
  if (ses.usable) {
    out.state = 'logged_in'
    out.hint = res.already ? '登录态已就绪（无需扫码）' : '登录成功，会话进行中（可连续刷多门课）'
    out.session = {
      active: true,
      startedAt: ses.session.startedAt,
      lastUsedAt: ses.session.lastUsedAt,
      port: ses.session.port,
      kernelPid: ses.session.kernelPid,
    }
    return out
  }

  /* 会话标记活着但内核没了 → 明确告诉前端会话已断，而不是含糊的 stale */
  if (ses.session && ses.session.active && ses.reason === 'kernel_dead') {
    out.state = 'stale'
    out.hint = '会话已中断（内核不再响应），请重新点「开始登录」扫码'
    return out
  }

  if (res.reason === 'timeout') {
    out.state = 'timeout'
    out.hint = '扫码超时，请重新点「开始登录」'
    return out
  }
  if (res.reason === 'verify_failed') {
    out.state = 'timeout'
    out.hint = '扫码后验证失败，请重新点「开始登录」'
    return out
  }
  if (hasProfile) {
    out.state = 'stale'
    out.hint = '上次扫码流程被中断，登录态未确认，请点「开始登录」重新扫码'
    return out
  }
  return out
}

/**
 * 一次性登录的 profile 目录（与引擎 EPHEMERAL_DIR 保持一致）。
 * 登录态只活在这个目录里；看课/读课程都必须用它，不能用旧的 browser-profile。
 */
function ephemeralProfileDir() {
  return join(tmpdir(), 'cx-learn-ephemeral', 'session')
}

/** 清掉残留的 Chrome 单实例锁（pkill 之后必然留下，不清会直接 abort）。 */
function clearProfileLock() {
  // 两个位置都清：一次性临时 profile + 历史长久 profile
  for (const dir of [ephemeralProfileDir(), join(STATE, 'browser-profile')]) {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        const p = join(dir, f)
        if (existsSync(p)) unlinkSync(p)
      } catch { /* ignore */ }
    }
  }
}

/** 读课程列表：跑引擎的 --list-courses（CDP 读渲染后的 DOM），解析 JSON。 */
function listCourses() {
  return new Promise((resolve) => {
    // 引擎在跑时不能起第二个 Chrome（同一 profile 并发会损坏 Cookie）
    if (running()) {
      return resolve({ ok: false, error: '正在看课，先停止再读取课程' })
    }
    const cp = chromiumPath()
    if (cp === 'chromium') return resolve({ ok: false, error: '没找到可用的浏览器内核' })
    if (!existsSync(ENGINE)) return resolve({ ok: false, error: '引擎文件缺失' })
    clearProfileLock()
    /* ★ B-精简：读课程也算使用会话，刷新时间戳 */
    touchSession()

    const env = {
      ...process.env,
      CX_CHROMIUM: cp,
      // 一次性登录模式下，登录态在临时 profile 里；读课程必须用同一份，否则读不到。
      CX_PROFILE_DIR: ephemeralProfileDir(),
      CX_LOGIN_SHOT_DIR: join(STATE, '.login'),
      CX_EPHEMERAL_LOGIN: '1',
    }
    execFile(process.execPath, [ENGINE, '--list-courses'], {
      cwd: STATE, env, maxBuffer: 16 * 1024 * 1024, timeout: 90000,
    }, (err, stdout) => {
      const out = String(stdout || '')
      // 引擎的日志也走 stdout，JSON 是最后那句 console.log
      const idx = out.lastIndexOf('\n{')
      const start = idx >= 0 ? idx + 1 : out.indexOf('{')
      if (start < 0) {
        return resolve({ ok: false, error: '引擎没有返回结果' + (err ? '：' + err.message : '') })
      }
      try {
        const j = JSON.parse(out.slice(start))
        if (j && j.ok) {
          return resolve({
            ok: true,
            count: j.count || 0,
            courses: (j.courses || []).map((c) => ({
              courseId: c.courseId,
              clazzid: c.clazzid || '',
              enc: c.enc || '',
              title: c.title || '',
              href: c.href || '',
            })),
          })
        }
        return resolve({ ok: false, error: (j && j.error) || '引擎返回异常' })
      } catch (e) {
        return resolve({ ok: false, error: '解析结果失败：' + String(e?.message ?? e) })
      }
    })
  })
}

async function status() {
  readQuestionEvents()
  const cfg = getCfg()
  const cp = chromiumPath()
  const browsers = listBrowsers()
  return {
    ok: true,
    running: running(),
    /* ★ 2026-10-31（L5）：原来写 `running() ? child.pid : null`。
       running() 还会按 state.json 里的 pid 探活，插件重启后 child 为 null 而
       running() 仍为 true → 这行直接抛 TypeError → /status 500。
       SPEC §11 L5 验收明确要求「child === null 时仍返回 200」。 */
    pid: running() && child ? child.pid : null,
    state: readJson(STATE_FILE, {}),
    config: cfg,
    chromium: cp,
    chromiumReady: cp !== 'chromium' && existsSync(cp),
    browserRoot: BROWSER_ROOT,
    browsers,
    engineReady: existsSync(ENGINE),
    home: STATE,
    /* ★ 2026-10-30：浏览器层写进 .state/browser.json 的现状（内核 pid/端口/心跳）。
       读不到就是 null，前端显示「—」，绝不因此让 status() 失败。 */
    browser: readBrowserState(),
    /* ★ B-精简：会话状态。前端据此决定显示「会话进行中 / 已结束」，
       以及「结束会话」按钮是否可点。读不到会话就是 null。 */
    session: (() => {
      const s = readSessionState()
      if (!s) return null
      return {
        active: s.active === true,
        loginVerified: s.loginVerified === true,
        startedAt: s.startedAt || null,
        lastUsedAt: s.lastUsedAt || null,
        port: s.port ?? null,
        kernelPid: s.kernelPid ?? null,
        reason: s.reason || '',
        keepAliveMs: SESSION_KEEP_MS,
      }
    })(),
    logTail: tailLog(25),
    quizMode: String(cfg.quizMode || 'skip'),
    questions: questionQueue.map((q) => ({ ...q, draft: undefined })),
  }
}

/**
 * 读浏览器层写的中间状态（engine/.state/browser.json）。
 * 契约见 docs/TEAM-CONTRACT-2026-10-30.md §3.1。
 *
 * ★ 三条硬规则（写方是引擎、读方是插件，两边独立发布，字段必然有先有后）：
 *   1. 文件不存在 / JSON 坏 / 不是对象 → 返回 null，绝不抛错
 *   2. 字段缺失 → 保持 undefined，由调用方显示「—」，不做假默认值
 *   3. 只读不写：浏览器层是这份文件的唯一写方
 */
function readBrowserState() {
  try {
    const p = join(PLUGIN_DIR, 'engine', '.state', 'browser.json')
    if (!existsSync(p)) return null
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/**
 * 读引擎写的 learn.json（engine/.state/learn.json，L4 层产物）。
 * 文件不存在 / 坏 JSON → 返回 {}，绝不抛错。
 */
function readLearnState() {
  try {
    const p = join(PLUGIN_DIR, 'engine', '.state', 'learn.json')
    if (!existsSync(p)) return {}
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

/**
 * 把引擎的停止原因合并进宿主 state.json。
 * 两个文件此前完全脱节：引擎写 learn.json，/status 读 state.json，
 * 所以真机上 stopReason 永远是 null。合并时只取状态字段，不覆盖宿主自己的
 * startedAt/mode/maxSections/url/pid（那些是启动参数，以宿主为准）。
 */
function mergeLearnIntoState() {
  const learn = readLearnState()
  if (!learn || !Object.keys(learn).length) return
  try {
    const st = readJson(STATE_FILE, {}) || {}
    const next = { ...st }
    if (learn.phase) next.phase = learn.phase
    if (learn.stopReason) next.stopReason = learn.stopReason
    if (learn.section !== undefined) next.section = learn.section
    if (learn.counters) next.counters = learn.counters
    if (learn.updatedAt) next.learnUpdatedAt = learn.updatedAt
    writeJson(STATE_FILE, next)
  } catch { /* ignore */ }
}

/**
 * 轻量健康快照：给 GET /api/cx-learn/health 和 status() 共用，避免两份逻辑漂移。
 *
 * ★ 为什么单独抽一个而不是复用 status()：
 *   status() 还要读 run.log 尾部、遍历内核目录（listBrowsers）。
 *   监测脚本每 5 分钟轮询一次，不能拖着这些 I/O 跑。
 *   这里只做同步文件探测，**不调模型服务、不读大文件**，稳定在毫秒级。
 *
 * @returns {object} 永远返回可序列化对象；内部异常由调用方兜底成 ok:false
 */
function collectHealth() {
  const at = new Date().toISOString()
  const cp = chromiumPath()
  const browser = readBrowserState()

  /* ★ 内核版本从这里拿，但**不能调 listBrowsers()** ——
     它会对每个候选内核 spawn 一次 `--version`（200~800ms/个，本机 3 个就是 1~2 秒），
     直接把 /health 拖出毫秒级预算，监测脚本每 5 分钟轮询会被拖垮。
     改读 browser.json 里引擎自己上报的版本（引擎起内核时才探一次，是免费的）：
       老引擎没有该字段 → 空字符串，UI 显示「—」，不算异常。 */
  const chromiumVersion = (browser && browser.browserVersion) || ''

  /* 心跳年龄：只有浏览器层真的写过 heartbeatAt 才算得出来。
     老版本引擎没这个字段 → ageMs 为 null，UI 显示「—」，不算异常。 */
  let ageMs = null
  if (browser && browser.heartbeatAt) {
    const t = Date.parse(browser.heartbeatAt)
    if (Number.isFinite(t)) ageMs = Math.max(0, Date.now() - t)
  }

  return {
    ok: true,
    at,
    engine: { ready: existsSync(ENGINE), path: ENGINE },
    chromium: { path: cp, ready: cp !== 'chromium' && existsSync(cp), version: chromiumVersion },
    browser: browser ? {
      alive: browser.alive === true,
      port: browser.port ?? null,
      heartbeatAt: browser.heartbeatAt ?? null,
      ageMs,
      restarts: Number.isFinite(browser.restarts) ? browser.restarts : 0,
      lastErrorKind: browser.lastErrorKind || '',
      executablePath: browser.executablePath || '',
      browserVersion: browser.browserVersion || '',
    } : null,
    task: {
      running: running(),
      pid: running() && child ? (child.pid ?? null) : null,
      startedAt: readJson(STATE_FILE, {}).startedAt ?? null,
    },
    /* ★ B-精简：会话状态（只读文件，不发网络探测 —— 保持毫秒级）。
       「内核是否真的活着」由 browser.alive（引擎心跳写）与
       session watcher 负责；/health 只如实转述。 */
    session: (() => {
      const s = readSessionState()
      if (!s) return null
      const last = Date.parse(s.lastUsedAt || s.startedAt || '')
      return {
        active: s.active === true,
        loginVerified: s.loginVerified === true,
        startedAt: s.startedAt || null,
        lastUsedAt: s.lastUsedAt || null,
        idleMs: Number.isFinite(last) ? Math.max(0, Date.now() - last) : null,
        port: s.port ?? null,
        kernelPid: s.kernelPid ?? null,
        reason: s.reason || '',
      }
    })(),
    home: STATE,
  }
}

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(b.length),
    'cache-control': 'no-store',
  })
  res.end(b)
}

async function readBody(req) {
  if (req.method !== 'POST' && req.method !== 'PUT') return {}
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

export function apply(ctx, config) {
  ensureDir()
  nowLog('mounted, plugin dir=' + PLUGIN_DIR)
  /* ★ B-精简：会话看护。插件一挂上就开始盯着——
     内核死了要清账，闲置超时要收尾，否则浏览器会一直挂着占内存。 */
  try { startSessionWatcher() } catch (e) {
    nowLog('session watcher 启动失败（不影响加载）：' + String(e?.message ?? e))
  }

  /* ★ 运行时能力探测。
     ★★★ 关键：访问 ctx.webServer 这个**动作本身**在 cordis 里就可能抛错
     （"cannot get property webServer without inject"）。
     所以必须用 try/catch 包住**取值**，不能只判断它是不是 undefined。 */
  let webServer = null
  try {
    webServer = ctx.webServer
  } catch (e) {
    nowLog('宿主未注入 webServer，设置页/HTTP 接口不可用（仅 CLI 模式）：' + String(e?.message ?? e))
    return
  }
  if (!webServer || typeof webServer.register !== 'function') {
    nowLog('警告：宿主无 webServer 服务，设置页/HTTP 接口不可用（仅 CLI 可用）')
    return
  }

  /* ★ 2026-10-30 踩坑记录：这里**不能**把 ctx.webServer 抽成外部变量 webServer。
     试过 `ctx.effect(() => webServer.register(...))`，结果 cordis 的 effect 依赖
     追踪拿不到 ctx.webServer，路由注册不上 —— 表现为 /api/cx-learn/* 全部 400
     （连不存在的子路径也 400，而其它 /api/* 是 401），插件日志却显示 ready。
     effect 回调必须原样访问 ctx.webServer，让 cordis 自己建立依赖。
     防护改为**包住整个注册动作**的 try/catch（见下），而不是换变量。 */
  try {
    ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/cx-learn',
    handler: async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      const path = u.pathname.replace(/^\/api\/cx-learn/, '') || '/'
      try {
        const body = await readBody(req)
        if (path === '/status' && req.method === 'GET') return sendJson(res, 200, await status())
        /* ★ 2026-10-30：轻量健康快照，给设置页与远端监测脚本用。
           刻意不碰模型服务、不读日志，必须稳定在毫秒级。
           任何内部异常都折叠成 200 + ok:false：监测脚本只看体里的 ok，
           不靠 HTTP 码判故障（这样反向代理/网关的 502 才能和业务故障区分开）。 */
        if (path === '/health' && req.method === 'GET') {
          try {
            return sendJson(res, 200, collectHealth())
          } catch (e) {
            return sendJson(res, 200, {
              ok: false,
              at: new Date().toISOString(),
              error: String(e?.message ?? e).slice(0, 200),
            })
          }
        }
        if (path === '/config' && req.method === 'GET') return sendJson(res, 200, { ok: true, config: getCfg() })
        if (path === '/config' && req.method === 'POST') return sendJson(res, 200, { ok: true, config: saveCfg(body) })
        if (path === '/questions' && req.method === 'GET') {
          readQuestionEvents()
          return sendJson(res, 200, {
            ok: true,
            questions: questionQueue.map((q) => ({ ...q, draft: undefined })),
          })
        }
        const draftMatch = path.match(/^\/questions\/([^/]+)\/draft$/)
        if (draftMatch && req.method === 'POST') {
          readQuestionEvents()
          const id = decodeURIComponent(draftMatch[1])
          const q = questionQueue.find((item) => item.id === id)
          if (!q) return sendJson(res, 404, { ok: false, error: '题目不存在或已被清理' })
          q.status = 'drafted'
          q.draftedAt = new Date().toISOString()
          // 只生成文本返回给 client；client 负责显式调用 setDraft，宿主不发送消息。
          return sendJson(res, 200, { ok: true, id, draft: questionDraft(q), submitted: false })
        }
        if (path === '/ask' && req.method === 'POST') {
          const r = askReserved(body)
          return sendJson(res, r.status, r.body)
        }
        if (path === '/browsers' && req.method === 'GET') return sendJson(res, 200, { ok: true, browsers: listBrowsers(), root: BROWSER_ROOT })
        if (path === '/start' && req.method === 'POST') return sendJson(res, 200, start(body))
        // 每次开跑前刷新登录态：预检失效则明确告知需要扫码，避免跑到一半才 LOGIN_REQUIRED。
        if (path === '/check-login' && req.method === 'POST') {
          const r = await precheckLogin()
          return sendJson(res, 200, { ok: true, ...r })
        }
        if (path === '/start-precheck' && req.method === 'POST') {
          if (running()) return sendJson(res, 200, { ok: false, error: '已经有一轮在跑了，先停止' })
          const pre = await precheckLogin()
          if (!pre.ready) {
            return sendJson(res, 200, {
              ok: false,
              needLogin: true,
              error: (pre.error || '登录态已失效') + ' —— 请先点「开始登录」扫码，再开始看课',
              url: pre.url,
            })
          }
          return sendJson(res, 200, start(body))
        }
        if (path === '/stop' && req.method === 'POST') return sendJson(res, 200, stop())
        /* ★ 2026-10-30：只清「本插件自己的」内核，用于 UI 上的「重启内核」。
           安全边界沿用 killStrayBrowser()：只按 tmpdir()/cx-learn-ephemeral 与
           STATE/browser-profile 两个 profile 标记匹配，绝不按进程名模糊杀，
           也绝不碰生产 Chrome（9223）。同时删掉 browser.json，避免前端继续
           显示一个已经不存在的端口的陈旧心跳。 */
        if (path === '/browser/restart' && req.method === 'POST') {
          if (running()) return sendJson(res, 200, { ok: false, error: '任务运行中，先停止再重启内核' })
          let killed = false
          try { killed = (await killStrayBrowser()) === true } catch { killed = false }
          let cleared = false
          try {
            const p = join(PLUGIN_DIR, 'engine', '.state', 'browser.json')
            if (existsSync(p)) { rmSync(p, { force: true }); cleared = true }
          } catch { cleared = false }
          nowLog('browser/restart: killed=' + killed + ' clearedState=' + cleared)
          return sendJson(res, 200, { ok: true, killed, clearedState: cleared })
        }
        if (path === '/login' && req.method === 'POST') return sendJson(res, 200, login())
        if (path === '/qr' && req.method === 'GET') return sendJson(res, 200, qr())
        /* ★ 真正换一张新码（不只是重读旧截图）。UI 的「刷新二维码」调这个。 */
        if (path === '/qr/refresh' && req.method === 'POST') {
          const r = requestQrRefresh()
          if (!r.ok) return sendJson(res, 200, r)
          /* 给引擎 2.5 秒去点「重新获取」并重拍，然后返回新图 */
          await new Promise((ok) => setTimeout(ok, 2500))
          return sendJson(res, 200, Object.assign({ refreshed: true }, qr()))
        }
        // 扫码登录进度：前端轮询它来判断「扫完了没」，成功就自动拉课程。
        if (path === '/login-state' && req.method === 'GET') return sendJson(res, 200, await loginState())
        /* ★ B-精简：结束会话（关内核 + 删 profile + 标记 closed）。
           用户「刷完了」时点这个按钮，比等闲置超时更可控。 */
        if (path === '/session/end' && req.method === 'POST') {
          if (running()) return sendJson(res, 200, { ok: false, error: '任务运行中，先停止再结束会话' })
          return sendJson(res, 200, await endSession('user'))
        }
        if (path === '/courses' && req.method === 'GET') return sendJson(res, 200, await listCourses())
        if (path === '/log' && req.method === 'GET') return sendJson(res, 200, { ok: true, log: tailLog(80) })
        return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + path })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    },
    }), 'cx-learn: /api/cx-learn 路由')
  } catch (e) {
    /* webServer 取值本身在 cordis 里可能抛（宿主未注入时）。
       包住整个注册动作：抛了就降级为「仅 CLI 模式」，不让插件崩掉、
       更不能让 DSH 因为一个插件起不来而整站 400。 */
    nowLog('注册 /api/cx-learn 路由失败（设置页不可用，CLI 仍可跑）：' + String(e?.message ?? e))
  }

  ctx.effect(() => () => {
    try { child?.kill('SIGTERM') } catch { /* ignore */ }
    /* ★ 停止会话看护，避免插件卸载后定时器还在跑 */
    if (_sessionTimer) { try { clearInterval(_sessionTimer) } catch { /* ignore */ } ; _sessionTimer = null }
    nowLog('unmounted, child killed')
  }, 'cx-learn: 卸载时收子进程')

  nowLog('ready, home=' + STATE)
}
