/* ============================================================================
 * login-flow.js — 扫码登录（2026-10-30 重写，替代原 runLogin 里的二维码会话管理）
 * ============================================================================
 *
 * 【为什么重写，而不是继续打补丁】
 *   原实现自己管整套二维码会话：抓 uuid/enc → 下载 createqr 图 → 调
 *   /getauthstatus 轮询 → 解读 type(2/3/4) → 决定是否换码。
 *   每一环都是自造的失败点，而且语义判断连续错了三次：
 *     · 把 type=3（mes="未登录"）当成「已扫码待确认」
 *     · 把 type=2（码已失效）当成「可恢复，重载换码」
 *     · 拿 /mlogin 页面去取 enc（实测该页无 enc 字段）
 *   结果：线上 442 次 type=3、0 次 status=true，登录从未成功过。
 *
 * 【新方案：只做一件最可靠的事】
 *   打开登录页 → 让页面自己跑它的二维码逻辑（它本来就能工作）→
 *   轮询「当前 URL 是否已离开 passport2.chaoxing.com」→ 离开即成功。
 *
 *   这个判据来自成熟项目 Chaoxing_Fast（zqian6263-design）的 src/login.mjs：
 *     const onLogin = /passport2\.chaoxing\.com/.test(url) || ...
 *     if (!onLogin) { logged = true; break }
 *   它不看 type、不看 status、不碰 createqr —— 因为那些都是页面自己的事，
 *   外部去复刻只会引入不一致。
 *
 * 【关键实测（2026-10-30，FNOS）】
 *   /login?refer=...                     → 200，Set-Cookie 含 JSESSIONID
 *   /login?newversion=true               → 302，**不设 cookie**（会话直接丢）
 *   /login?fid=&newversion=true&refer=.. → 200，含 JSESSIONID
 *   原代码默认用 ?newversion=true 且不带 refer —— 这是长期失败的隐藏原因之一。
 *
 * 【与旧实现的关系】
 *   · runLogin() 保留对外签名与返回值形状，内部改调本模块
 *   · 二维码截图仍然提供（UI 要显示），但只是「顺带截一张」，不再驱动任何判定
 *   · 所有 /getauthstatus、createqr、uuid/enc 逻辑全部不再参与成功判定
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

/** 登录成功后允许落地的域名（离开 passport 才算真的过了） */
const PASSED_HOST_RE = /^https?:\/\/(?!passport2?\.chaoxing\.com)[^/]*chaoxing\.com/i;

/** 仍在登录流程里的判据：域名是 passport2 且不是「登录后跳转中」的中继页 */
function stillOnLogin(hostUrl) {
  const u = String(hostUrl || '');
  if (!u) return true;
  return /^https?:\/\/passport2?\.chaoxing\.com/i.test(u);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 带超时的 Promise 包装。
 *
 * ★ 2026-10-30 血的教训：`waitForLoginByUrl` 第一版直接 `await adapter.getCurrentUrl()`，
 * 结果在 FNOS 上进程 CPU 时间 0 秒、6 分钟没有任何日志 —— 因为 CDP 调用挂住了，
 * 而循环里没有任何超时保护。旧实现有 `cfg.cdp.evalTimeoutMs` 兜底，重写时漏了。
 *
 * 轮询循环里**每一个**外部调用都必须过这个包装，否则一次卡死就整轮静默。
 *
 * @param {Promise} p
 * @param {number} ms
 * @param {string} what 超时后用于日志的标识
 * @returns {Promise<{ok:boolean, value?:any, error?:string}>} 永不 reject
 */
function withTimeout(p, ms, what) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: (what || 'op') + ' 超时 ' + ms + 'ms' }), ms);
  });
  const wrapped = Promise.resolve(p).then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 160) })
  );
  return Promise.race([wrapped, guard]).finally(() => { if (timer) clearTimeout(timer) });
}

/**
 * 取当前 URL，永不抛错、永不挂住。
 * @returns {Promise<string>} 拿不到返回空串
 */
async function safeCurrentUrl(adapter, timeoutMs) {
  const r = await withTimeout(
    (async () => adapter.getCurrentUrl())(),
    timeoutMs || 6000,
    'getCurrentUrl'
  );
  if (!r.ok) return '';
  const v = r.value;
  return typeof v === 'string' ? v : '';
}

/** 截图，永不抛错、永不挂住 */
async function safeShot(adapter, shotPath, timeoutMs) {
  const r = await withTimeout(
    (async () => adapter.screenshot(shotPath))(),
    timeoutMs || 10000,
    'screenshot'
  );
  return r.ok;
}

/**
 * 登录页 URL。
 * 必须带 refer（否则会话不完整），**不能**只带 newversion=true（会 302 丢 cookie）。
 */
function loginUrl() {
  return 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com';
}

/**
 * 判断某个 target 是否已经「登录后」。
 *
 * ★ 域名匹配必须按「主机名后缀」判断，不能用 `/chaoxing\.com/` 这种裸正则：
 *   `https://notchaoxing.com/` 也会匹配上 —— 那是个钓鱼域名或者无关站点，
 *   一旦误判为「已登录」，后续所有 CDP 操作都会打在别人家的页面上。
 *   正确做法：解析 hostname，要求等于 chaoxing.com 或以 `.chaoxing.com` 结尾。
 *
 * @returns {boolean}
 */
function looksLoggedIn(url) {
  const u = String(url || '');
  if (!u || /^about:blank$/i.test(u)) return false;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase() } catch { return false }
  if (!host) return false;

  const isChaoxing = host === 'chaoxing.com' || host.endsWith('.chaoxing.com');
  if (!isChaoxing) return false;

  /* passport / passport2 是登录域，待在那里一律算未完成 */
  if (host === 'passport.chaoxing.com' || host === 'passport2.chaoxing.com') return false;

  return true;
}

/* ============================================================================
 * 自己查 getauthstatus —— 2026-10-31 实测后的必要补充
 * ============================================================================
 *
 * 【为什么必须自己查】
 *   实测（本机 Edge，2026-10-31 14:43~14:48）：手机扫码后服务端已经返回
 *       {"mes":"验证通过","status":true}
 *   但**页面自己的轮询死了** —— 资源记录里 `getauthstatus` 只出现过 1 次
 *   （页面刚加载时），之后 274 秒内再没请求过。于是页面永远不知道要跳转，
 *   用户看到的是「扫了码没反应」。
 *
 *   这不是二维码会话问题，是「谁来问服务端」的问题。页面不问，我们就自己问。
 *
 * 【与旧实现的关键区别（别再混为一谈）】
 *   旧版：自己管整套二维码会话（下载 createqr 图、判 type=2/3/4、自己换码）
 *         —— 那套被证明不可靠，已删除。
 *   新版：只做三件事
 *         ① 从页面 hidden input 读 uuid / enc（不自己生成、不改写）
 *         ② 问一次 /getauthstatus（只读）
 *         ③ status===true 就导航到个人空间
 *         不换码、不重绘、不碰会话归属。
 * ==========================================================================*/

/**
 * 解析 getauthstatus 的响应体。
 *
 * 已实测的真实形态：
 *   成功：{"mes":"验证通过","status":true}
 *   未登录：{"mes":"未登录","status":false,"type":"3"}
 *   已扫码待确认：{"status":false,"type":"4","nickname":"xxx"}
 *
 * ★ 只认 `status === true`。**不看 type** —— type 的语义历史上被误读三次
 *   （3 当成已扫、2 当成可恢复、4 当成唯一成功），status 是服务端给的
 *   最终结论，没有解释空间。
 *
 * @param {string} text 响应体
 * @returns {{ok:boolean, status:boolean, mes:string, type:string}}
 */
function parseAuthStatus(text) {
  const out = { ok: false, status: false, mes: '', type: '' };
  const s = String(text == null ? '' : text).trim();
  if (!s) return out;
  let j = null;
  try { j = JSON.parse(s) } catch (_) {
    /* 有些网关会包一层或返回 JSONP，尽量从文本里抠出来 */
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) { try { j = JSON.parse(m[0]) } catch (_) { j = null } }
  }
  if (!j || typeof j !== 'object') return out;
  out.ok = true;
  out.status = j.status === true;
  out.mes = typeof j.mes === 'string' ? j.mes : '';
  out.type = j.type != null ? String(j.type) : '';
  return out;
}

/**
 * 从登录页读 uuid / enc（只读 hidden input，不生成、不改写）。
 * @returns {Promise<{uuid:string, enc:string, frameId:string}>} 拿不到就返回空串
 */
async function readQrCredentials(adapter, timeoutMs) {
  const empty = { uuid: '', enc: '', frameId: '' };
  const framesRes = await withTimeout((async () => adapter.getFrameDocuments())(), timeoutMs || 6000, 'getFrameDocuments');
  if (!framesRes.ok || !Array.isArray(framesRes.value)) return empty;
  const expr = `(function () {
    var u = document.getElementById('uuid');
    var e = document.getElementById('enc');
    return JSON.stringify({
      uuid: u ? String(u.value || '') : '',
      enc: e ? String(e.value || '') : ''
    });
  })()`;
  for (const f of framesRes.value) {
    const r = await withTimeout(adapter.evalInFrame(f.frameId, expr), timeoutMs || 6000, 'read-uuid');
    if (!r.ok || typeof r.value !== 'string') continue;
    let info = null;
    try { info = JSON.parse(r.value) } catch (_) { continue }
    if (info && info.uuid) return { uuid: String(info.uuid), enc: String(info.enc || ''), frameId: f.frameId };
  }
  return empty;
}

/**
 * 问一次服务端「这个码现在什么状态」。
 *
 * 在**页面上下文**里 fetch，这样带上浏览器自己的 cookie 与会话，
 * 不引入第二套会话（这正是旧实现踩的坑）。
 *
 * @returns {Promise<{ok:boolean, status:boolean, mes:string, type:string, error?:string}>}
 */
async function probeAuthStatus(adapter, frameId, creds, timeoutMs) {
  const q = 'uuid=' + encodeURIComponent(creds.uuid) + '&enc=' + encodeURIComponent(creds.enc);
  const expr = `(async function () {
    try {
      var r = await fetch('/getauthstatus?${q}&_t=' + Date.now(), { credentials: 'include' });
      var t = await r.text();
      return JSON.stringify({ httpStatus: r.status, body: t.slice(0, 400) });
    } catch (e) { return JSON.stringify({ err: String(e).slice(0, 160) }); }
  })()`;
  const r = await withTimeout(adapter.evalInFrame(frameId, expr), timeoutMs || 8000, 'getauthstatus');
  if (!r.ok || typeof r.value !== 'string') {
    return { ok: false, status: false, mes: '', type: '', error: r.error || 'no-result' };
  }
  let wrap = null;
  try { wrap = JSON.parse(r.value) } catch (_) { wrap = null }
  if (!wrap) return { ok: false, status: false, mes: '', type: '', error: 'bad-wrap' };
  if (wrap.err) return { ok: false, status: false, mes: '', type: '', error: String(wrap.err).slice(0, 120) };
  const parsed = parseAuthStatus(wrap.body);
  return {
    ok: parsed.ok,
    status: parsed.status,
    mes: parsed.mes,
    type: parsed.type,
    httpStatus: wrap.httpStatus,
  };
}

/**
 * 扫码登录主流程。
 *
 * @param {object} deps
 * @param {object} deps.adapter        CDP adapter（已 ensureBrowser）
 * @param {object} deps.cfg            引擎配置
 * @param {object} deps.logger         引擎 logger
 * @param {string} deps.shotDir        二维码截图目录（UI 展示用）
 * @param {number} [deps.timeoutMs]    扫码窗口，默认 10 分钟
 * @param {number} [deps.pollMs]       轮询间隔，默认 2000（参考项目用的 2s）
 * @param {(url:string)=>void} [deps.onUrl]  URL 变化回调（可选）
 * @returns {Promise<{ok:boolean, already?:boolean, reason?:string, url?:string, screenshot?:string}>}
 */
async function waitForLoginByUrl(deps) {
  const adapter = deps.adapter;
  const cfg = deps.cfg || {};
  const logger = deps.logger || { log() {}, info() {}, warn() {}, error() {} };
  const shotDir = deps.shotDir || '.';
  const timeoutMs = Number(deps.timeoutMs) > 0 ? deps.timeoutMs : 10 * 60 * 1000;
  const pollMs = Number(deps.pollMs) > 0 ? deps.pollMs : 2000;
  /* 二维码有效期约 2 分钟。页面自己**不会**自动换码，失效后必须点「重新获取」。
     原实现靠轮询 getauthstatus 判 type=2 再换码 —— 那条路已证明不可靠（接口语义错）。
     现在改成一个纯时间驱动 + 页面元素驱动的兜底：
       · 每 refreshEveryMs（默认 100s，留 20s 余量）主动点一次「重新获取」
       · 每次点击前检查页面上是否已经出现「二维码已失效」字样，出现则立刻点
     这样既不依赖状态接口，也不会让用户对着一个失效的码干等。 */
  const refreshEveryMs = Number(deps.refreshEveryMs) > 0 ? deps.refreshEveryMs : 100000;

  const shotPath = path.join(shotDir, 'latest.png');
  try { fs.mkdirSync(shotDir, { recursive: true }) } catch (_) { /* ignore */ }

  const started = Date.now();
  let lastUrl = '';
  let lastShotAt = 0;
  let lastBeatAt = 0;
  let lastRefreshAt = Date.now();
  let sawPassport = false;
  let refreshCount = 0;
  /* ★ 2026-10-31：自己查 getauthstatus 用的状态 */
  let lastAuthProbeAt = 0;
  let authProbed = false;
  let lastCreds = { uuid: '', enc: '', frameId: '' };
  let lastMes = '';

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);

    /* 1) 看当前 target 的 URL（带超时，绝不挂住） */
    const url = await safeCurrentUrl(adapter, 6000);

    if (url !== lastUrl) {
      lastUrl = url;
      if (typeof deps.onUrl === 'function') { try { deps.onUrl(url) } catch (_) { /* ignore */ } }
      if (stillOnLogin(url)) sawPassport = true;
      logger.log('LOGIN', 'INFO', '页面 URL 变化', { url: url.slice(0, 140) });
    }

    /* 每 30 秒打一次心跳：之前重写漏了循环内的任何输出，一次 CDP 挂住导致
       6 分钟内日志完全静默，排查时误以为是「没扫码」而不是「程序卡死」。
       有心跳就能一眼区分这两种情况。 */
    if (Date.now() - lastBeatAt >= 30000) {
      lastBeatAt = Date.now();
      logger.log('LOGIN', 'INFO', '等待扫码中（心跳）', {
        waitedSec: Math.round((Date.now() - started) / 1000),
        url: url.slice(0, 120) || '(取不到)',
        onLoginPage: stillOnLogin(url),
      });
    }

    /* 2) 当前 target 已登录 → 成功 */
    if (looksLoggedIn(url)) {
      logger.log('LOGIN', 'INFO', '★ 判定登录成功（URL 已离开登录域）', { url: url.slice(0, 140) });
      await safeShot(adapter, shotPath);
      return { ok: true, already: false, url, screenshot: shotPath };
    }

    /* 3) 关键补充：站点常把「已登录页」开在**新标签**，当前 target 仍停在登录页。
          只查当前 URL 会永远等下去（原实现踩过）。这里扫一遍所有 target。 */
    try {
      const list = await listPages(adapter, cfg);
      const hit = list.find((t) => looksLoggedIn(t.url));
      if (hit) {
        logger.log('LOGIN', 'INFO', '★ 判定登录成功（其它标签页已登录）', {
          url: String(hit.url || '').slice(0, 140),
        });
        try { if (typeof adapter.attachTarget === 'function') await adapter.attachTarget(hit.id) } catch (_) { /* ignore */ }
        await safeShot(adapter, shotPath);
        return { ok: true, already: false, url: String(hit.url || ''), screenshot: shotPath };
      }
    } catch (_) { /* 拿不到 target 列表不影响主循环 */ }

    /* 3.5) ★ 2026-10-31 新增：自己问一次服务端「这个码什么状态」
       ──────────────────────────────────────────────────────────────
       实测：手机扫码后服务端已返回 status:true，但页面自己的轮询死了
       （资源记录里 getauthstatus 只出现 1 次），于是页面永远不跳转，
       用户看到「扫了码没反应」。页面不问，我们就自己问。
       只认 status === true；不看 type（type 语义被误读过三次）。 */
    if (!authProbed || Date.now() - lastAuthProbeAt >= pollMs) {
      lastAuthProbeAt = Date.now();
      const creds = await readQrCredentials(adapter, 6000);
      if (creds.uuid) {
        lastCreds = creds;
        const st = await probeAuthStatus(adapter, creds.frameId, creds, 8000);
        authProbed = true;
        if (st.status === true) {
          logger.log('LOGIN', 'INFO', '★ 服务端确认登录（getauthstatus status:true），主动导航到个人空间', {
            mes: st.mes, uuid: creds.uuid.slice(0, 10),
          });
          try {
            await adapter.navigate(String((cfg && cfg.login && cfg.login.homeUrl) || 'https://i.chaoxing.com/'));
          } catch (e) {
            logger.log('LOGIN', 'WARN', '导航到个人空间失败，等下一轮', { err: String((e && e.message) || e).slice(0, 100) });
          }
          await sleep(2500);
          const after = await safeCurrentUrl(adapter, 6000);
          if (looksLoggedIn(after)) {
            await safeShot(adapter, shotPath);
            logger.log('LOGIN', 'INFO', '★ 登录成功（我主动导航后已离开登录域）', { url: String(after).slice(0, 140) });
            return { ok: true, already: false, url: String(after), by: 'authstatus', screenshot: shotPath };
          }
          logger.log('LOGIN', 'INFO', '已按 status:true 导航，但还在登录域，等下一轮确认', {
            url: String(after).slice(0, 120),
          });
        } else if (st.status === false && st.mes) {
          /* 只记状态变化，避免每 2 秒刷一行日志 */
          if (st.mes !== lastMes) {
            lastMes = st.mes;
            logger.log('LOGIN', 'INFO', '服务端状态变化', {
              mes: st.mes, type: st.type, uuid: creds.uuid.slice(0, 10),
            });
          }
        }
      }
    }

    /* 4) 二维码失效检测与换码。
       ★ 为什么必须有这一段：页面上的码约 2 分钟过期，过期后显示「二维码已失效」
         和一个「重新获取」按钮。页面自己**不会**自动换 —— 实测用户扫到的是
         一张失效的图，而程序还在傻等，最后超时。
       判据用「页面上有没有失效字样」，这是用户能直接看到的事实，
       比接口返回的 type 更可靠（type 语义已经被证明不可信）。 */
    const needRefresh = Date.now() - lastRefreshAt >= refreshEveryMs
      || consumeRefreshRequest(deps.flagFile);
    if (needRefresh) {
      lastRefreshAt = Date.now();
      refreshCount += 1;
      const r = await refreshQrOnPage(adapter, logger, refreshCount);
      logger.log('LOGIN', 'INFO', r.ok ? '已点击「重新获取」换新码' : '换码未成功', {
        attempt: refreshCount, detail: r.detail || '',
      });
      lastShotAt = 0;  /* 换码后立刻重拍，别让用户看到旧的 */
    }

    /* 5) 顺带刷新二维码截图（UI 展示用，**不参与判定**）。
          节流 5 秒一次，避免文件 mtime 狂跳导致前端图片闪烁。 */
    if (Date.now() - lastShotAt > 5000) {
      lastShotAt = Date.now();
      await safeShot(adapter, shotPath);
    }
  }

  logger.log('LOGIN', 'ERROR', '扫码超时，未检测到登录成功', {
    timeoutMs, lastUrl: lastUrl.slice(0, 140), sawPassport,
  });
  return { ok: false, reason: 'timeout', url: lastUrl, screenshot: shotPath };
}

/**
 * 列出所有 page 类型的 target（带超时，绝不挂住）。
 * 优先用 adapter 自带的方法；没有就走 CDP HTTP。
 */
async function listPages(adapter, cfg) {
  if (typeof adapter.listTargets === 'function') {
    const r = await withTimeout((async () => adapter.listTargets())(), 6000, 'listTargets');
    if (r.ok && Array.isArray(r.value)) return r.value;
  }
  const port = Number(cfg && cfg.cdp && cfg.cdp.port);
  if (!Number.isInteger(port) || port <= 0) return [];
  const r = await withTimeout((async () => {
    const res = await fetch('http://' + (cfg.cdp.host || '127.0.0.1') + ':' + port + '/json/list');
    if (!res.ok) return [];
    const j = await res.json();
    return (Array.isArray(j) ? j : []).filter((t) => t.type === 'page' && !/^devtools/.test(t.url || ''));
  })(), 6000, 'json/list');
  return r.ok && Array.isArray(r.value) ? r.value : [];
}

/**
 * 在页面上点「重新获取」换一张新二维码。
 *
 * 超星登录页二维码失效后会显示一个「二维码已失效」遮罩，中间有「重新获取」按钮。
 * 优先点它；找不到就调页面自己的 refreshQRCode()；再不行就整页重载。
 *
 * ★ 为什么优先「点按钮」而不是直接调 JS：
 *   实测页面上的 refreshQRCode 在 isolated world 里取不到（typeof 读不到），
 *   而点击是真实用户行为，等价性最好，也不会破坏会话。
 *
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
async function refreshQrOnPage(adapter, logger, attempt) {
  const frames = await withTimeout((async () => adapter.getFrameDocuments())(), 6000, 'getFrameDocuments');
  if (!frames.ok || !Array.isArray(frames.value)) return { ok: false, detail: '拿不到 frame' };

  for (const f of frames.value) {
    /* 1) 页面上是否出现「失效」字样，以及「重新获取」按钮在哪 */
    const probe = await withTimeout(adapter.evalInFrame(f.frameId, `(() => {
      const txt = document.body ? document.body.innerText : '';
      const expired = /二维码已失效|已失效|重新获取/.test(txt);
      /* 按钮候选：文字含「重新获取」/「刷新」的可点击元素 */
      const cands = Array.from(document.querySelectorAll('a,button,div,span'))
        .filter((el) => {
          const t = (el.innerText || '').trim();
          if (!t || t.length > 12) return false;
          if (!/重新获取|刷新二维码|刷新/.test(t)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      const el = cands[0] || null;
      let rect = null;
      if (el) {
        const r = el.getBoundingClientRect();
        rect = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      }
      return JSON.stringify({ expired, found: !!el, text: el ? el.innerText.trim() : '', rect });
    })()`), 8000, 'probe-expired');

    if (!probe.ok || typeof probe.value !== 'string') continue;
    let info = null;
    try { info = JSON.parse(probe.value) } catch (_) { continue }
    if (!info || !info.expired) continue;

    logger.log('LOGIN', 'INFO', '检测到二维码失效', { found: info.found, button: info.text || '' });

    /* 2) 优先真实点击（Input.dispatchMouseEvent），失败再退 JS click */
    if (info.found && info.rect) {
      const clickRes = await withTimeout(
        adapter.click(f.frameId, 'point', { x: info.rect.x, y: info.rect.y }),
        8000, 'click-refresh'
      );
      if (clickRes.ok && clickRes.value && clickRes.value.ok) {
        await sleep(1500);
        return { ok: true, detail: 'clicked:' + (info.text || '') };
      }
      const jsRes = await withTimeout(
        adapter.jsClick(f.frameId, 'point', { x: info.rect.x, y: info.rect.y }),
        8000, 'jsclick-refresh'
      );
      if (jsRes.ok && jsRes.value && jsRes.value.ok) {
        await sleep(1500);
        return { ok: true, detail: 'jsclick' };
      }
    }

    /* 3) 兜底：调页面自己的刷新函数 */
    const fnRes = await withTimeout(adapter.evalInFrame(f.frameId, `(() => {
      try {
        if (typeof refreshQRCode === 'function') { refreshQRCode(); return 'refreshQRCode'; }
      } catch (e) { return 'err:' + e.message; }
      return '';
    })()`), 8000, 'refreshQRCode');
    if (fnRes.ok && fnRes.value) {
      await sleep(1500);
      return { ok: true, detail: String(fnRes.value) };
    }
  }
  return { ok: false, detail: '未找到失效遮罩或刷新入口' };
}

/**
 * 检查宿主是否请求了「换一张新码」，读到就删掉（一次性）。
 *
 * 跨进程通信为什么用文件：登录跑在独立子进程里，宿主不持有它的 adapter，
 * 没法直接调 CDP。一个 flag 文件足够了 —— 写入方（宿主）只写不读，
 * 消费方（引擎）只读不写，没有竞争。
 *
 * @param {string} [flagFile]
 * @returns {boolean} 是否有新请求
 */
function consumeRefreshRequest(flagFile) {
  if (!flagFile) return false;
  try {
    if (!fs.existsSync(flagFile)) return false;
    fs.unlinkSync(flagFile);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  waitForLoginByUrl,
  loginUrl,
  looksLoggedIn,
  stillOnLogin,
  PASSED_HOST_RE,
  /* 2026-10-31：自己查 getauthstatus 的三个构件（可单测） */
  parseAuthStatus,
  readQrCredentials,
  probeAuthStatus,
};
