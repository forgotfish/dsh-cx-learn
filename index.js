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
import { randomBytes } from 'node:crypto'

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
  /* 章节测验策略（2026-11-15 主人指令：解开限制，但默认只存草稿不交卷）
       'save'   作答后只点「保存」，绝不交卷（默认）
       'save' 之外还可以选：
       'submit' 真交卷（有真实成绩、不可撤回，必须主人明确选）
       'none'   只填选项，不点任何按钮
       'skip'   完全不碰（旧行为）
     注：视频内随堂题不受此开关影响，仍是「盲试直到答对」。
     旧字段 quizMode 已废弃（老配置里恒为 'skip'，会覆盖新默认），不再读取。 */
  chapterQuiz: 'save',
  /* ── AI 答题（宿主侧 LLM）配置 ──────────────────────────────────────────
     enabled=false 时宿主完全不碰模型；spawn 也**不注入任何** CX_LLM_* 环境
     变量（引擎靠 `CX_LLM_ASK_URL || CX_LLM_MODEL` 判断 useAi，多设一条就会
     让引擎以为自己能答题）。契约见 docs/AI-ANSWER-FRAMEWORK.md §3/§4。 */
  ai: {
    enabled: false,
    /* dryRun=false：开启 AI 后就是「真的答」。仅调试时置 true（只判定不点选）。 */
    dryRun: false,
    provider: 'host',
    model: '',
    vision: true,
    /* 传输通道（v2，见 docs/AI-ANSWER-FRAMEWORK.md §10）：
       'session' = 走 DSH 会话窗口（可见），'direct' = 旧路径隐藏直连 */
    channel: 'session',
    batchSize: 10,
    timeoutMs: 120000,
    workspaceDir: '',
    chapterQuiz: true,
    maxRetries: 2,
    minLetters: 1,
  },
}

let child = null

/* ── AI 答题运行期状态 ────────────────────────────────────────────────────
   _ctxRef       : apply 时记下的 ctx，供调用点 `ctx.get('llm')` 拿服务（缺失不崩）
   _webServerRef : apply 时拿到的 webServer 实例，用来读当前监听端口 `.port`
   _askToken     : 每轮 spawn 新生成的 32-hex 令牌；/llm-ask 用它校验 x-cx-token */
let _ctxRef = null
let _webServerRef = null
let _askToken = ''
/* ── AI 答题「会话窗口」通道状态（v2，见 docs/AI-ANSWER-FRAMEWORK.md §11）──────
   _qaSession  : { sessionId, createdAt, workspacePath }；null = 尚未创建/已重置
   _qaLastSeq  : 上一次 wait 读到的最大 event.seq，下次 wait 用 afterSeq 续读 */
let _qaSession = null
/* 并发创建去重（D-036）：in-flight 的创建 promise，避免同时开出多个会话窗口 */
let _qaCreating = null
let _qaLastSeq = 0
const QA_SESSION_FILE = join(STATE, 'ai-session.json')
/* 答题会话复用 TTL（D-034）：TTL 内盲复用，不调 sc.state() 探活（那个调用会崩 host）。 */
const QA_SESSION_TTL_MS = 30 * 60 * 1000
/* ★ 2026-10-31：登录进程单独留个引用。
   原来 loginState() 用 `running()`（任何任务在跑）判断「是不是在等扫码」，
   于是看课跑到一半时 /login-state 仍返回 waiting，GUI 显示「等待扫码…」
   而实际早就登录成功、正在看课。 */
let loginChild = null

const ensureDir = () => { if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true }) }
const readJson = (p, fb) => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    /* ★ 2026-11-17（D-030）：文件内容是 null / 数字 / 字符串时，按「读不到」返回兜底值。
       破坏性测试实测：state.json 写成 `null` 时，readJson 返回 null，随后 `.pid` 取值抛
       TypeError → /status 直接 500（整页拿不到状态）。数组仍按对象保留。 */
    return (v && typeof v === 'object') ? v : fb
  } catch { return fb }
}
const writeJson = (p, v) => { ensureDir(); writeFileSync(p, JSON.stringify(v, null, 2)) }
const nowLog = (s) => { ensureDir(); appendFileSync(LOG_FILE, `[plugin] ${new Date().toISOString()} ${s}\n`) }

const getCfg = () => {
  const stored = readJson(CFG_FILE, {}) || {}
  const merged = { ...DEFAULT_CFG, ...stored }
  // ai 段做浅合并，避免旧 config.json 里只存了部分 ai 字段时把默认值整体覆盖掉
  merged.ai = { ...DEFAULT_CFG.ai, ...(stored.ai && typeof stored.ai === 'object' ? stored.ai : {}) }
  return merged
}
const saveCfg = (patch) => {
  const p = patch || {}
  const next = { ...getCfg(), ...p }
  if (p.ai && typeof p.ai === 'object') next.ai = { ...getCfg().ai, ...p.ai }
  writeJson(CFG_FILE, next)
  return next
}
/**
 * 是否有一轮任务在跑。
 * 不能只看内存里的 child：插件重启（DSH 重启 / 热重载）后 child 变 null，
 * 但引擎子进程可能还活着 —— 那样界面会显示「空闲」而实际还在刷课，
 * 主人点「开始看课」就会重复启动。所以额外用 pid 探活兜底。
 */
/**
 * 引擎心跳过期阈值。
 * 浏览器层（engine-ensureBrowser 起的 HEALTH）每 15s 往 browser.json 写一次 heartbeatAt，
 * 所以 3 分钟没更新基本可以断定「进程已死 / pid 被系统复用给了别的程序」。
 */
const ENGINE_HB_STALE_MS = 3 * 60 * 1000

const running = () => {
  if (child && child.exitCode === null) return true
  const st = readJson(STATE_FILE, {}) || {}
  const pid = Number((st && st.pid) || 0)
  if (!pid) return false
  try { process.kill(pid, 0) } catch { return false }
  /* ★ 2026-11-17（D-031）：pid 活着**不足以**证明「我们的引擎还在跑」。
     破坏性测试实测：把 state.json 的 pid 写成任意一个活着的无关进程（例如 pwsh），
     /status 与 /health 都会报 running=true —— 界面上「开始」变绿、点「开始看课」被误挡
     （「已经有一轮在跑了」）。这正是 D-023 留下的残留风险。
     现在要求「pid 活着 + 浏览器层心跳的 ownerPid 就是这个 pid + 心跳足够新」。
     注意不能用 learn.json 的 updatedAt 做判据：它只在切节/停止时写，
     直播一跑 57 分钟不写盘，会被误判成「没在跑」。 */
  const b = readBrowserState() || {}
  const ownerPid = Number(b.ownerPid || 0)
  if (ownerPid && ownerPid === pid) {
    const hb = Date.parse(b.heartbeatAt || b.updatedAt || '')
    if (Number.isFinite(hb) && (Date.now() - hb) <= ENGINE_HB_STALE_MS) return true
    nowLog('running(): pid ' + pid + ' 活着但心跳过期（' + Math.round((Date.now() - hb) / 1000) + 's），按未在跑处理')
    return false
  }
  nowLog('running(): pid ' + pid + ' 活着但无心跳证据（ownerPid=' + ownerPid + '），按未在跑处理')
  return false
}

/**
 * 清掉 state.json 里的 pid（引擎本轮已结束，pid 不再是「在跑」的证据）。
 * 幂等：没有 pid 时不动。见 D-023：引擎「自终止」若不清理，会留下死 pid，
 * 被系统复用后 running() 误判为在跑 → 设置页「开始」假绿灯。
 */
export function clearStatePid() {
  try {
    const st = readJson(STATE_FILE, {}) || {}
    if (st.pid !== undefined) { delete st.pid; writeJson(STATE_FILE, st) }
  } catch { /* ignore */ }
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

/* ── AI 答题接口（已实现，见下方 handleAsk / callLlm）──────────────────
 * 契约现在定死，实现只改本文件的 handleAsk / callLlm，
 * 调用方（设置页 / 脚本 / 引擎回调）不用跟着改。
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
/* ── AI 答题实现（宿主侧 LLM）────────────────────────────────────────────
 * 契约见 docs/AI-ANSWER-FRAMEWORK.md §4，DSH LLM API 见 docs/_research/dsh-llm-api.md。
 * 要点：
 *   · 服务用 `ctx.get('llm')` 在调用点拿（缺失返回 undefined，不抛）——不要把 'llm'
 *     之外的依赖硬塞，也不在这里假设宿主一定注入了服务。
 *   · ctx.llm.stream() 是 AsyncIterable<StreamChunk>，没有一次性返回字符串的方法：
 *     遍历流用 BlockAssembler 累积，最后取 type==='text' 块拼接。
 *   · 错误不 throw：终止在 finish 块（reason.kind==='error'，看 reason.failure.code）。
 *   · 图片不能塞 base64：先经 ctx.attachments.admitPromptContent 转 ImageAttachmentRef。
 */
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

/** 当前插件监听端口（用于拼 CX_LLM_ASK_URL）。拿不到返回 0，绝不抛错。 */
function pluginPortNum() {
  try { const p = Number(_webServerRef && _webServerRef.port); if (p > 0) return p } catch { /* ignore */ }
  try { const p = Number(process.env.CX_PLUGIN_PORT); if (p > 0) return p } catch { /* ignore */ }
  try { const u = new URL(String(process.env.DSH_WEB_URL || '')); const p = Number(u.port); if (p > 0) return p } catch { /* ignore */ }
  return 0
}

/**
 * 解析 provider/model：配置留空（或填占位 'host'）时，自动取宿主第一个可用
 * provider 及其第一个模型——这样 UI 上「留空 = 使用宿主默认模型」才算兑现。
 * 解析不到就返回空串，由调用方报 LLM_UNAVAILABLE。绝不抛错。
 */
export async function resolveRoute(llm, provider, model) {
  let p = String(provider || '').trim()
  let m = String(model || '').trim()
  if (!p || p === 'host') {
    try {
      const list = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
      const first = Array.isArray(list) && list.length ? list[0] : null
      if (first) p = String(first.id || first.name || '')
    } catch { /* 拿不到就保持空，下面报错 */ }
  }
  if (p && !m) {
    try {
      const list = typeof llm.listModels === 'function' ? await llm.listModels(p) : []
      const first = Array.isArray(list) && list.length ? list[0] : null
      if (first) m = String(first.id || first.name || '')
    } catch { /* 同上 */ }
  }
  return { provider: p, model: m }
}

/** 把 `data:<mime>;base64,<data>` 拆成 { mediaType, base64 }；非法返回 null。 */
function parseImageInput(image) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(image || ''))
  if (!m) return null
  return { mediaType: m[1].toLowerCase(), base64: m[2] }
}

/** 把 question+options 拼成喂模型的文本（options → 「A. xx」）。 */
function buildAskPrompt(body) {
  const q = String(body?.question || '').trim()
  const opts = Array.isArray(body?.options) ? body.options : []
  const optText = opts.map((o, i) => {
    const letter = String.fromCharCode(65 + i)
    if (o && typeof o === 'object') return (o.letter || letter) + '. ' + (o.label != null ? o.label : (o.text != null ? o.text : ''))
    return letter + '. ' + String(o)
  }).join('\n')
  return (q || '（图片题目，请阅读图片后作答）') +
    (optText ? '\n选项：\n' + optText : '') +
    '\n\n请只回答一个选项字母（如 B），不要解释。'
}

/** 从模型输出里严格解析出唯一选项字母；解析不出返回 { index:-1, letter:null }。 */
function parseAnswerLetter(text, options) {
  const raw = String(text || '').trim()
  const maxLetters = Array.isArray(options) && options.length > 0 ? options.length : 26
  const valid = (ch) => { const idx = ch.toUpperCase().charCodeAt(0) - 65; return idx >= 0 && idx < maxLetters }
  const pack = (ch) => { const L = ch.toUpperCase(); return { index: L.charCodeAt(0) - 65, letter: L } }
  if (!raw) return { index: -1, letter: null }
  // 1) 整段就是一个字母（可带括号/标点包裹）：B / b / B. / （B）
  let m = raw.match(/^[\s（(【\[]*([A-Za-z])[\s.．、,，)）】\]:：]*$/)
  if (m && valid(m[1])) return pack(m[1])
  // 2) 「答案：B」「正确答案是 B」「answer: B」
  m = raw.match(/(?:正确答案|答案|answer)\s*[:：是为]?\s*[（(【\[]?\s*([A-Za-z])\b/i)
  if (m && valid(m[1])) return pack(m[1])
  // 3) 开头就是「B.」「B、」「B)」这类
  m = raw.match(/^[\s（(【\[]*([A-Za-z])\s*[.．、,，)）\]:：]/)
  if (m && valid(m[1])) return pack(m[1])
  return { index: -1, letter: null }
}

/** 一次真实的流式调用：useImage=true 时尝试带图（失败自动降级为纯文本）。 */
/**
 * 消费 `llm.stream()` 的异步迭代器，自己拼文本。形状依据
 * `docs/_research/dsh-llm-api.md` 的 StreamChunk：
 *   · `text-delta` → 累加；
 *   · `block-end` 的完整 text 块 → 没收到 delta 时作兜底；
 *   · `finish` 的 reason → 终止原因；`kind` 为 error/aborted 时按 failure 抛错（DSH 不 throw）。
 * 导出是为了能用假的 chunk 序列单测（host-smoke 第 9 节）。
 */
export async function collectStream(iter) {
  let text = ''
  let lastBlockText = ''
  let finish = null
  for await (const chunk of iter) {
    if (!chunk) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') lastBlockText = chunk.block.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const f = finish.failure || {}
    const err = new Error('LLM 失败 [' + (f.code || 'ERROR') + '] ' + (f.message || ''))
    err.code = f.code || 'LLM_ERROR'
    if (f.status !== undefined) err.status = f.status
    throw err
  }
  if (!text && lastBlockText) text = lastBlockText
  return { text, finish }
}

async function doStream(opts, useImage) {
  const llm = (_ctxRef && typeof _ctxRef.get === 'function') ? _ctxRef.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') {
    const e = new Error('llm 服务不可用'); e.code = 'LLM_UNAVAILABLE'; throw e
  }
  /* ★ 工具包按需加载：DSH 运行时里 `@deepseek-ai/dsh-llm` 一定存在，但从插件目录
     解析不一定成功（profile 的 node_modules 布局各有不同）。**不能**让它成为硬依赖：
     解析失败就退回「自己拼消息对象 + 自己拼文本」，功能等价，不抛错。
     2026-11-15：助手包（BlockAssembler）本来只用于拼文本，我们已经自己拼了，
     这里只借 createUserMessage 生成规范消息对象。 */
  let createUserMessage = null
  try {
    const kit = await import('@deepseek-ai/dsh-llm')
    if (kit && typeof kit.createUserMessage === 'function') createUserMessage = kit.createUserMessage
  } catch { /* 解析失败 → 用字面量消息对象（下面兜底） */ }

  const promptText = String(opts.prompt ?? '')
  const content = [{ type: 'text', text: promptText }]
  let visionUsed = false
  if (useImage && opts.image) {
    const parsed = parseImageInput(opts.image)
    const att = (_ctxRef && typeof _ctxRef.get === 'function') ? _ctxRef.get('attachments') : null
    if (parsed && att && typeof att.admitPromptContent === 'function') {
      try {
        const admitted = await att.admitPromptContent([
          { type: 'text', text: promptText },
          { type: 'image', mediaType: parsed.mediaType, data: parsed.base64 },
        ])
        content.length = 0
        for (const part of admitted) {
          if (part && part.type === 'text') content.push({ type: 'text', text: part.text })
          else if (part && part.type === 'image') { content.push({ type: 'image', attachment: part.attachment }); visionUsed = true }
        }
      } catch {
        // 图片入附件失败 → 忽略图片，只用文本
        visionUsed = false
        content.length = 0
        content.push({ type: 'text', text: promptText })
      }
    }
  }

  const route = await resolveRoute(llm, opts.provider, opts.model)
  if (!route.provider || !route.model) {
    const e = new Error('宿主没有可用的 provider/model（配置留空且自动探测失败）')
    e.code = 'LLM_UNAVAILABLE'; throw e
  }

  const messages = [createUserMessage
    ? createUserMessage({ content, source: { kind: 'user' } })
    : { role: 'user', content, source: { kind: 'user' } }]
  const streamOpts = { provider: route.provider, model: route.model, messages }
  if (opts.system) streamOpts.system = String(opts.system)

  const ac = new AbortController()
  let timedOut = false
  const to = numOr(opts.timeoutMs, 20000)
  const timer = setTimeout(() => { timedOut = true; try { ac.abort() } catch { /* ignore */ } }, to)
  if (timer && typeof timer.unref === 'function') timer.unref()

  /* 自己拼文本，不依赖 BlockAssembler（据 docs/_research/dsh-llm-api.md）：
     · text-delta 累加；
     · block-end 里的完整 text 块做兜底（没收到 delta 时用）；
     · finish 块的 reason 就是终止原因，错误不 throw。 */
  let text = ''
  try {
    text = (await collectStream(llm.stream({ ...streamOpts, signal: ac.signal }))).text
  } catch (e) {
    // 超时优先报超时（abort 会让流以 aborted 结束，别把超时误报成 LLM_ERROR）
    if (timedOut) {
      const te = new Error('LLM 请求超时（' + to + 'ms）'); te.code = 'LLM_TIMEOUT'; throw te
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (timedOut) {
    const e = new Error('LLM 请求超时（' + to + 'ms）'); e.code = 'LLM_TIMEOUT'; throw e
  }
  return { text, visionUsed, model: route.model, provider: route.provider }
}

/** 调用 LLM；图片被目标模型拒绝（UNSUPPORTED_CONTENT）时自动降级为纯文本重试一次。 */
async function callLlm(opts) {
  const wantImage = !!opts.image
  try {
    return await doStream(opts, wantImage)
  } catch (e) {
    if (wantImage && e && e.code === 'UNSUPPORTED_CONTENT') {
      return await doStream(opts, false)
    }
    throw e
  }
}

/** 统一的错误码归类（503 用）。 */
function llmErrCode(e) {
  const code = e && e.code
  if (code === 'LLM_TIMEOUT' || code === 'LLM_UNAVAILABLE' || code === 'LLM_EMPTY' || code === 'SESSION_UNAVAILABLE') {
    return code
  }
  return 'LLM_ERROR'
}

/* ── 会话窗口通道（v2）──────────────────────────────────────────────────────
   契约见 docs/AI-ANSWER-FRAMEWORK.md §11/§12。宿主是哑管道：只把 prompt 丢进一个
   真实的 DSH 会话窗口，等它的 assistant 回复，取出纯文本回给引擎。 */

/** 重置会话：清内存状态 + 删落盘文件（失败忽略）。start() 每轮开跑成功时调用。 */
export function resetQaSession() {
  _qaSession = null
  _qaCreating = null
  _qaLastSeq = 0
  try { rmSync(QA_SESSION_FILE, { force: true }) } catch { /* 文件不存在/被占用都忽略 */ }
}

/**
 * 确保有一个可用的答题会话。已有且 state 可读则复用，否则懒创建。
 * ctx.sessionController 缺失 → SESSION_UNAVAILABLE（引擎退回逐题/盲试，不阻塞看课）。
 */
/** 取可选服务：走 ctx.get(name)（缺失返回 undefined，不抛）。
 *  ★ 不要写成 ctx.sessionController —— 属性访问在服务缺失时会抛，本项目踩过 ctx.webServer。 */
export function getOptionalService(ctx, name) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(name)
      if (v) return v
    }
  } catch { /* ignore */ }
  try { return ctx[name] || null } catch { return null }
}

export async function ensureQaSession(ctx, cfg) {
  const sc = getOptionalService(ctx, 'sessionController')
  if (!sc) {
    const e = new Error('sessionController 不可用'); e.code = 'SESSION_UNAVAILABLE'; throw e
  }
  /* ★★ 2026-11-18（D-034，实炸一次）：**绝不能用 sc.state() 探活**。
     实测 DSH 0.2.2-rc.3：给它一个不存在/已失效的 sessionId 时，
     StateController.readState 抛 `TypeError: Cannot read properties of undefined
     (reading 'throwIfAborted')`；而 state() 返回的是 Promise，这个异常以
     **unhandled rejection** 形式逃出插件 → `dsh: fatal load failure` →
     整个 DSH 桌面端重启（16:14 真炸，用户界面被弹重启）。

     为什么以前没炸：旧版 rc.1 大概不抛；而 askViaSession 内部会二次调用本函数，
     真实答题时**每一题**都会走一次探活 → 第二题必崩。

     改为「按 TTL 盲复用 + 出错重建」：
       · 会话创建后 TTL 内直接复用，完全不碰 sc.state()
       · 过期/失效由 prompt/wait 抛错暴露，askViaSession 里 reset 后重建一次 */
  if (_qaSession && (Date.now() - Number(_qaSession.createdAt || 0)) < QA_SESSION_TTL_MS) {
    return _qaSession
  }
  if (_qaSession) resetQaSession()   /* 过期就丢弃，下面重建 */
  /* ★★ 2026-11-18（D-036，破坏测试发现）：**并发去重**。
     两路同时进来时 _qaSession 都还是 null，会各自 create → 真的开出两个会话窗口。
     用一个 in-flight promise 收敛成一次创建。 */
  if (_qaCreating) return await _qaCreating
  _qaCreating = (async () => {
    const ai = (cfg && cfg.ai) || {}
    const dir = ai.workspaceDir || join(STATE, 'ai-workspace')
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    /* 建项目失败不阻断 —— 退化为不建项目，直接 create({cwd}) */
    const wr = getOptionalService(ctx, 'workspaceRegistry')
    if (wr && typeof wr.create === 'function') {
      try { await wr.create(dir, 'CX 答题') } catch { /* ignore */ }
    }
    const r = await sc.create({ cwd: dir, agentPreset: undefined })
    /* ★★ 2026-11-18（D-036，破坏测试发现）：create() 可能返回空对象/缺 sessionId。
       以前不校验，会把 sessionId=undefined 缓存下来，后面 prompt 往一个不存在的
       会话发请求（错误信息极难懂）。这里显式拒绝。 */
    if (!r || !r.sessionId) {
      const e = new Error('创建答题会话失败：sessionController.create() 未返回 sessionId')
      e.code = 'SESSION_UNAVAILABLE'
      throw e
    }
    _qaSession = { sessionId: r.sessionId, createdAt: Date.now(), workspacePath: dir }
    /* ★ 2026-11-15 修 BUG：会话重建（旧的死了）后必须归零 _qaLastSeq，
       否则 askViaSession 会用**旧会话**的 maxSeq 去 wait 新会话的 afterSeq，
       新会话 seq 起点更低 → wait 空返回 → 误报 LLM_EMPTY、答案丢失。 */
    _qaLastSeq = 0
    try { writeJson(QA_SESSION_FILE, _qaSession) } catch { /* ignore */ }
    return _qaSession
  })()
  try {
    return await _qaCreating
  } finally {
    _qaCreating = null
  }
}

/**
 * 从 wait 的 output.records 里提取「最后一条 assistant/message」的文本。
 * 纯函数，返回 { text, maxSeq }。content 非数组/缺失 → 该条视为空串。
 */
export function extractAssistantText(records) {
  let last = ''
  let maxSeq = 0
  const arr = Array.isArray(records) ? records : []
  for (const rec of arr) {
    const ev = rec && rec.event
    if (!ev) continue
    if (typeof ev.seq === 'number' && ev.seq > maxSeq) maxSeq = ev.seq
    if (ev.type !== 'assistant/message') continue
    const content = ev.data && ev.data.message && ev.data.message.content
    if (!Array.isArray(content)) { last = ''; continue }
    let buf = ''
    for (const blk of content) {
      if (blk && blk.type === 'text' && typeof blk.text === 'string') buf += blk.text
    }
    last = buf
  }
  return { text: last, maxSeq }
}

/**
 * 经会话窗口提问一次：ensure 会话 → prompt（queue）→ wait（afterSeq 续读）→ 取文本。
 * 超时 → LLM_TIMEOUT；空回复 → LLM_EMPTY。
 */
export async function askViaSession(ctx, cfg, { prompt, image, provider, model, timeoutMs } = {}) {
  const s = await ensureQaSession(ctx, cfg)
  const sc = getOptionalService(ctx, 'sessionController')
  if (!sc) {
    const e = new Error('sessionController 不可用'); e.code = 'SESSION_UNAVAILABLE'; throw e
  }
  const content = [{ type: 'text', text: String(prompt || '') }]
  if (image) {
    content.push({ type: 'image', mediaType: 'image/png', data: String(image).replace(/^data:[^,]+,/, '') })
  }
  /* ★★ 2026-11-18（D-035，实测 DSH 0.2.2-rc.3 源码）：
     sessionController 的 prompt/wait/state 都是 `(request, signal)` 两个参数，
     且第一行就是 `signal.throwIfAborted()`。**signal 必传**，不传就是
     `Cannot read properties of undefined (reading 'throwIfAborted')`
     （实测：会话能创建成功，但一 prompt 就 503）。
     这里用 AbortController 提供 signal，并把同一个 timeoutMs 也作为超时兜底。 */
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, Math.max(1000, Number(timeoutMs) || 120000))
  try {
    await sc.prompt({
      requestId: 'cx-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 8),
      sessionId: s.sessionId,
      mode: 'queue',
      content,
    }, ac.signal)
    const w = await sc.wait({ sessionId: s.sessionId, timeoutMs, afterSeq: _qaLastSeq }, ac.signal)
    if (w && w.reason === 'timeout') {
      const e = new Error('会话应答超时'); e.code = 'LLM_TIMEOUT'; throw e
    }
    const { text, maxSeq } = extractAssistantText((w && w.output && w.output.records) || [])
    if (maxSeq) _qaLastSeq = maxSeq
    if (!text) {
      const e = new Error('会话无文本回复'); e.code = 'LLM_EMPTY'; throw e
    }
    return { text, model: model || '', sessionId: s.sessionId }
  } catch (e) {
    /* 我们自己 abort 导致的取消，统一归成超时，避免引擎把它当未知错误 */
    const aborted = (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))
    if (aborted && !(e && e.code === 'LLM_TIMEOUT')) {
      const t = new Error('会话应答超时（已 abort）'); t.code = 'LLM_TIMEOUT'; throw t
    }
    /* LLM_TIMEOUT / LLM_EMPTY 是「模型没答」，会话本身可能还活着 —— 不重置；
       其余（prompt/wait 抛错，通常是会话被关掉/失效）→ 重置，下次重建。 */
    const code = (e && e.code) || ''
    if (code !== 'LLM_TIMEOUT' && code !== 'LLM_EMPTY') resetQaSession()
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST /api/cx-learn/ask 的实现（真答题）。
 *   · enabled=false → 保持 D-015 契约：200 { ok:false, code:'AI_ANSWER_DISABLED' }（有测试断言）
 *   · enabled=true  → 喂 question+options，返回 { ok:true, answer:'B', model, raw }
 */
async function handleAsk(body) {
  const ai = (getCfg().ai) || {}
  const question = String(body?.question || '').trim()
  const image = String(body?.image || '').trim()
  if (!question && !image) {
    return { status: 400, body: { ok: false, error: 'question 或 image 必填（options 可选）' } }
  }
  if (ai.enabled !== true) {
    return { status: 200, body: { ok: false, code: 'AI_ANSWER_DISABLED', error: 'AI 答题未启用' } }
  }
  try {
    const provider = String(ai.provider || '').trim()
    const model = String(ai.model || '').trim()
    if (!provider || !model) { const e = new Error('provider/model 未配置'); e.code = 'LLM_UNAVAILABLE'; throw e }
    const r = await callLlm({ provider, model, prompt: buildAskPrompt(body), image, timeoutMs: numOr(ai.timeoutMs, 20000) })
    const parsed = parseAnswerLetter(r.text, body?.options)
    if (parsed.index < 0) {
      return { status: 200, body: { ok: false, code: 'AI_AMBIGUOUS', error: '无法从模型输出解析出唯一选项字母', model, raw: r.text } }
    }
    return { status: 200, body: { ok: true, answer: parsed.letter, model, raw: r.text } }
  } catch (e) {
    return { status: 503, body: { ok: false, code: llmErrCode(e), error: String((e && e.message) || e).slice(0, 300) } }
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

/* 组装引擎子进程环境变量（纯函数，便于单测，不真正 spawn）。
   ★ AI 答题注入只在这里做，且仅在 config.ai.enabled === true 时。 */
export function buildSpawnEnv(args = []) {
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
  /* ★ 2026-11-15 主人指令：不再是「一律 skip」。
     章节测验策略来自配置 chapterQuiz（默认 'save' = 答完只存草稿、不交卷）。 */
  {
    const cq = String(cfg.chapterQuiz || 'save').toLowerCase()
    env.CX_QUIZ_MODE = (cq === 'skip' || cq === 'submit' || cq === 'none' || cq === 'save') ? cq : 'save'
  }

  /* ★ B-精简：看课任务结束时**不要**关内核/删 profile，因为会话可能还开着
     （用户要接着刷第二门课）。引擎侧据此走 detach 而不是 shutdown。 */
  if (isWatchRun(args)) env.CX_KEEP_BROWSER = '1'

  /* ★ AI 答题注入（仅 config.ai.enabled === true），一字不差按框架 §4.2：
       CX_LLM_ASK_URL / CX_LLM_ASK_TOKEN / CX_LLM_PROVIDER / CX_LLM_MODEL /
       CX_AI_DRYRUN / CX_AI_VISION
     enabled=false 时**一个都不设**——引擎靠 `CX_LLM_ASK_URL || CX_LLM_MODEL`
     判断 useAi，多设任何一条都会让引擎以为自己能答题。先清掉任何残留再按需注入。 */
  for (const k of Object.keys(env)) { if (/^CX_LLM_|^CX_AI_/.test(k)) delete env[k] }
  const ai = cfg.ai || {}
  if (ai.enabled === true) {
    const port = pluginPortNum()
    _askToken = randomBytes(16).toString('hex')
    env.CX_LLM_ASK_URL = 'http://127.0.0.1:' + (port > 0 ? port : 0) + '/api/cx-learn/llm-ask'
    env.CX_LLM_ASK_TOKEN = _askToken
    env.CX_LLM_PROVIDER = String(ai.provider || '')
    env.CX_LLM_MODEL = String(ai.model || '')
    env.CX_AI_DRYRUN = ai.dryRun ? '1' : '0'
    env.CX_AI_VISION = ai.vision ? '1' : '0'
  }
  return env
}

function spawnEngine(args) {
  ensureDir()
  clearProfileLock()
  const env = buildSpawnEnv(args)

  const c = spawn(process.execPath, [ENGINE, ...args], {
    cwd: STATE, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  c.stdout.on('data', (d) => { try { appendFileSync(LOG_FILE, d) } catch { /* ignore */ } })
  c.stderr.on('data', (d) => { try { appendFileSync(LOG_FILE, d) } catch { /* ignore */ } })
  c.on('exit', (code) => {
    try { appendFileSync(LOG_FILE, `\n[engine exit] code=${code}\n`) } catch { /* ignore */ }
    /* ★ 2026-11-15：引擎「自己」结束时（如 max_sections_reached）也要清掉 state.json 里的 pid。
       原来只有手动 stop() 才删 pid，自终止的运行会把一个已死 pid 留在 state.json；
       running() 用 process.kill(pid, 0) 探活，一旦该 pid 被系统复用给别的进程，
       就误判「还在跑」——表现正是设置页「开始」标签在登录阶段就变绿、「内核」却还是红的。 */
    if (child === c) {
      child = null
      clearStatePid()
    }

    /* ★ 2026-10-31：引擎把「为什么停」写在自己的 engine/.state/learn.json，
       而 /status.state 读的是宿主 state.json —— 两边从来没对上过，
       所以真机上看不到 stopReason（只有 null）。这里退出时合并一次。 */
    mergeLearnIntoState()

    /* ★ 2026-11-02：引擎退出时给 browser.json 收尾。
       事故：引擎以 143（SIGTERM）退出、顺手杀了 12 个残留 chrome，
       但没有任何一方把 alive 改成 false —— 心跳停在 29 小时前，
       /health 却还报 alive:true，与 session.json 的 kernel_dead 互相矛盾。
       这里按「内核 pid 是否还活着」决定：死了就写墓碑，活着（keep-alive）就不动。 */
    try {
      const b = readBrowserState()
      if (b && b.alive === true) {
        const pidAlive = Number(b.pid) > 0 && isPidAlive(Number(b.pid))
        if (!pidAlive) {
          const p = join(PLUGIN_DIR, 'engine', '.state', 'browser.json')
          writeFileSync(p, JSON.stringify(Object.assign({}, b, {
            alive: false,
            pid: null,
            port: null,
            heartbeatAt: new Date().toISOString(),
            lastErrorKind: 'ENGINE_EXIT',
          }), null, 2))
        }
      }
    } catch { /* 状态收尾失败不影响主流程 */ }

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
  /* ★ 2026-11-16 修「开始」假绿灯的真正根因：只有「看课任务」才登记为 child（=在跑）。
     登录/预检/读课程/自测等 spawn 绝不能设 child，否则 running() 立刻变 true，
     设置页「开始」标签在登录阶段就亮绿。isWatchRun 之前只用于 env/purge，漏了这里。 */
  if (isWatchRun(args)) child = c
  return c
}

/** 判断这次 spawn 是不是「看课任务」（登录/预检/读课程/自测都不算）。 */
export function isWatchRun(args) {
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
  /* 登录进行中不许开看课（两个任务会抢浏览器）。登录不再算 running，故单列一条。 */
  if (loginChild && loginChild.exitCode === null) return { ok: false, error: '登录进行中，请先等登录完成或停止登录' }
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
    /* v2：每轮开跑成功即重置答题会话 —— 下次 /llm-ask 懒创建，跨运行不膨胀。 */
    resetQaSession()
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

function stop() {
  const loginLive = !!(loginChild && loginChild.exitCode === null)
  if (!running() && !loginLive) return { ok: false, error: '当前没有任务在跑' }
  const pid = child && child.exitCode === null ? child.pid : Number(readJson(STATE_FILE, {}).pid || 0)
  try {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    else if (running() && pid) process.kill(pid, 'SIGTERM')  // 仅在 running() 为真时才按 state.pid 探活杀，避免误杀复用的旧 pid
    // 登录不再登记为 child，running() 覆盖不到，这里显式收掉登录进程
    if (loginLive) loginChild.kill('SIGTERM')
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
  /* 登录不再登记 child，故 running() 覆盖不到「登录正在进行」——这里单独挡重复登录。 */
  if (loginChild && loginChild.exitCode === null) return { ok: false, error: '登录已在进行中' }
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
  /* ★ 2026-11-17（D-032）：以前只要 profile 目录还在就一律说「上次扫码流程被中断」。
     实测会骗人：会话因**闲置超时**正常结束后 profile 目录仍留着，用户看到的是
     「扫码被中断」，以为是登录坏了（主人就是这么被误导的）。按 session.json 里
     记录的结束原因给出真实文案。 */
  const sReason = String((ses.session && ses.session.reason) || '')
  if (sReason === 'idle_timeout') {
    out.state = 'idle'
    out.hint = '登录会话已闲置超时结束，请点「开始登录」重新扫码（一次性登录：每次任务结束登录态即销毁）'
    return out
  }
  if (sReason === 'user' || sReason === 'closed') {
    out.state = 'idle'
    out.hint = '登录会话已结束，请点「开始登录」重新扫码'
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
    /* ★ v2：AI 答题传输层现状（只读快照，供设置页回显「打开答题窗口」）。
       放 config 旁边，不动既有字段。 */
    ai: {
      enabled: cfg.ai && cfg.ai.enabled === true,
      channel: String((cfg.ai && cfg.ai.channel) || 'session'),
      batchSize: Number((cfg.ai && cfg.ai.batchSize) || 10),
      hasSession: !!_qaSession,
      sessionId: _qaSession ? _qaSession.sessionId : '',
    },
    chromium: cp,
    chromiumReady: cp !== 'chromium' && existsSync(cp),
    browserRoot: BROWSER_ROOT,
    browsers,
    engineReady: existsSync(ENGINE),
    home: STATE,
    /* ★ 2026-10-30：浏览器层写进 .state/browser.json 的现状（内核 pid/端口/心跳）。
       读不到就是 null，前端显示「—」，绝不因此让 status() 失败。 */
    browser: reconcileBrowser(readBrowserState()),
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
    /* ★ 2026-11-17（D-031）：允许用 CX_BROWSER_STATE_FILE 覆盖路径 —— 只给测试做隔离，
       生产环境不设置，行为与原来完全一致（PLUGIN_DIR/engine/.state/browser.json）。 */
    const p = process.env.CX_BROWSER_STATE_FILE || join(PLUGIN_DIR, 'engine', '.state', 'browser.json')
    if (!existsSync(p)) return null
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/* ★ 2026-11-02：browser.json 是「最后一次写入」的快照，不是实时状态。
   实测事故：心跳停在 29 小时前、pid 早已不存在、端口也不监听，
   但 /health 仍原样转述 alive:true —— 只有内核 owner 进程才写 alive:false，
   清理路径（kill 残留 chrome）只杀进程/删文件，没把状态改成 false。
   解法：读出来先对账——心跳过期 / 没有端口 / pid 已死 一律降级为 alive:false。 */
const BROWSER_STALE_MS = 90 * 1000

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

export function reconcileBrowser(b) {
  if (!b || typeof b !== 'object') return null
  const out = Object.assign({}, b)
  const hb = Date.parse(b.heartbeatAt || b.updatedAt || '')
  out.heartbeatAgeMs = Number.isFinite(hb) ? Math.max(0, Date.now() - hb) : null
  out.staleReason = ''

  if (b.alive === true) {
    if (out.heartbeatAgeMs != null && out.heartbeatAgeMs > BROWSER_STALE_MS) {
      out.alive = false
      out.staleReason = 'heartbeat_stale'
    } else if (!(Number(b.port) > 0)) {
      out.alive = false
      out.staleReason = 'no_port'
    } else if (Number(b.pid) > 0 && !isPidAlive(Number(b.pid))) {
      out.alive = false
      out.staleReason = 'pid_dead'
    }
  }
  if (out.alive === false && !out.staleReason) {
    out.staleReason = b.alive === true ? 'reconciled' : String(b.lastErrorKind || '')
  }
  return out
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
  const browser = reconcileBrowser(readBrowserState())

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
      staleReason: browser.staleReason || '',
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
  // 记下 ctx 供 /llm-ask、/ask 调用点用 ctx.get('llm')/_ctx.get('attachments')（缺失不崩）
  _ctxRef = ctx
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
  // 记住 webServer 实例，供 buildSpawnEnv 读当前监听端口（.port getter）。取值已 try/catch 过。
  _webServerRef = webServer

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
        /* ★ 内部 LLM 代理端点：只服务本插件的引擎子进程（凭 x-cx-token 校验，
           令牌每轮 spawn 新生成，只在 env 里给引擎）。会话外不可用。
           契约：body { provider?, model?, prompt, image? } → 200 { ok:true, text, model, ms, visionUsed }
           任何异常 → 503 { ok:false, code:'LLM_UNAVAILABLE'|'LLM_ERROR'|'LLM_TIMEOUT', error }，绝不 500。 */
        if (path === '/llm-ask' && req.method === 'POST') {
          const tk = String((req.headers && (req.headers['x-cx-token'] || req.headers['X-Cx-Token'])) || '')
          if (!_askToken || tk !== _askToken) return sendJson(res, 401, { ok: false, error: '无效的 x-cx-token' })
          const ai = (getCfg().ai) || {}
          const prompt = String(body?.prompt ?? '')
          if (!prompt && !body?.image) return sendJson(res, 400, { ok: false, error: 'prompt 必填（image 可选）' })
          const provider = String(body?.provider || ai.provider || '').trim()
          const model = String(body?.model || ai.model || '').trim()
          const channel = String(body?.channel || ai.channel || 'session')
          const t0 = Date.now()
          try {
            if (channel === 'session') {
              const r = await askViaSession(_ctxRef, getCfg(), {
                prompt, image: body?.image, provider, model,
                timeoutMs: numOr(ai.timeoutMs, 120000),
              })
              return sendJson(res, 200, {
                ok: true, text: r.text, model, ms: Date.now() - t0,
                channel: 'session', sessionId: r.sessionId,
              })
            }
            if (!provider || !model) { const e = new Error('provider/model 未配置'); e.code = 'LLM_UNAVAILABLE'; throw e }
            const r = await callLlm({
              provider, model, prompt,
              image: body?.image, system: body?.system,
              timeoutMs: numOr(ai.timeoutMs, 20000),
            })
            return sendJson(res, 200, { ok: true, text: r.text, model, ms: Date.now() - t0, visionUsed: r.visionUsed === true, channel: 'direct' })
          } catch (e) {
            return sendJson(res, 503, { ok: false, code: llmErrCode(e), error: String((e && e.message) || e).slice(0, 300) })
          }
        }
        /* ★ 2026-11-18（D-033）：AI 会话通道自检 —— 本机验证「是否真的创建出一个
           新的 DSH 会话窗口」。走的就是引擎那条 askViaSession 真路径，不做任何模拟。

           为什么要这条路由：/llm-ask 需要本轮 spawn 的随机 token（只在插件内存和子进程
           env 里），外部根本拿不到，所以没法从命令行验证会话通道。而 /ask 走的是
           doStream（直连 llm 服务），不经过会话窗口。

           安全闸门（两道）：
             1. 仅回环地址（127.0.0.1 / ::1）；未知来源（测试桩）不拦。
             2. 必须 ai.enabled === true —— AI 没开就不许触发，避免白烧额度。 */
        if (path === '/ai-selftest' && req.method === 'POST') {
          const ra = String((req.socket && req.socket.remoteAddress) || '')
          const loopback = !ra || ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
          if (!loopback) return sendJson(res, 403, { ok: false, error: '仅允许回环地址调用' })
          const aiCfg = (getCfg().ai) || {}
          if (aiCfg.enabled !== true) {
            return sendJson(res, 403, { ok: false, code: 'AI_ANSWER_DISABLED', error: '需先启用 AI（ai.enabled=true）' })
          }
          const prompt = String(body?.prompt || '请只回复两个字：收到')
          const steps = []
          const t0 = Date.now()
          try {
            const scProbe = getOptionalService(_ctxRef, 'sessionController')
            const wrProbe = getOptionalService(_ctxRef, 'workspaceRegistry')
            steps.push({
              step: 'services',
              sessionController: !!scProbe,
              workspaceRegistry: !!wrProbe,
              ms: Date.now() - t0,
            })
            if (!scProbe) {
              return sendJson(res, 503, { ok: false, code: 'SESSION_UNAVAILABLE', error: 'sessionController 不可用', steps })
            }
            const s = await ensureQaSession(_ctxRef, getCfg())
            steps.push({ step: 'session', sessionId: s.sessionId, workspacePath: s.workspacePath, ms: Date.now() - t0 })
            const r = await askViaSession(_ctxRef, getCfg(), {
              prompt,
              provider: String(aiCfg.provider || '').trim(),
              model: String(aiCfg.model || '').trim(),
              timeoutMs: numOr(aiCfg.timeoutMs, 120000),
            })
            steps.push({ step: 'reply', chars: String(r.text || '').length, ms: Date.now() - t0 })
            return sendJson(res, 200, {
              ok: true,
              channel: 'session',
              sessionId: r.sessionId,
              text: String(r.text || '').slice(0, 400),
              prompt,
              totalMs: Date.now() - t0,
              steps,
            })
          } catch (e) {
            steps.push({ step: 'error', code: (e && e.code) || 'LLM_ERROR', ms: Date.now() - t0 })
            return sendJson(res, 503, {
              ok: false,
              code: llmErrCode(e),
              error: String((e && e.message) || e).slice(0, 300),
              totalMs: Date.now() - t0,
              steps,
            })
          }
        }
        if (path === '/ask' && req.method === 'POST') {
          const r = await handleAsk(body)
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
            /* ★ 2026-11-02：以前只 rm 文件；rm 失败就什么都不留，文件里继续躺着 alive:true。
               现在写「墓碑」：明确 alive:false + 原因（KILLED/STOPPED）。 */
            const prev = readBrowserState() || {}
            writeFileSync(p, JSON.stringify({
              alive: false,
              port: null,
              pid: null,
              heartbeatAt: new Date().toISOString(),
              restarts: Number.isFinite(prev.restarts) ? prev.restarts : 0,
              lastErrorKind: killed ? 'KILLED' : 'STOPPED',
              browserVersion: prev.browserVersion || '',
              executablePath: prev.executablePath || '',
            }, null, 2))
            cleared = true
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
