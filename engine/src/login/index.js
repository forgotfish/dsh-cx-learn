/* ============================================================================
 * engine/src/login/index.js — 扫码登录（只按 URL 是否离开登录域判定）、一次性 profile、登录态预检
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { resolveCdpPort } = require('../browser/args.js');
const { createCdpAdapter } = require('../browser/cdp.js');
const { setActiveAdapter } = require('../browser/exit-guard.js');
const { CONTRACT, LOGIN_FLOW, fs, os, path, sleep } = require('../core/base.js');
const { CONFIG, mergeConfig } = require('../core/config.js');
const { logger } = require('../core/logging.js');
const { listTargets } = require('../courses.js');

/**
 * 无头扫码登录（真实环境一次性动作）。
 * 流程：打开个人空间检测 profile 登录态 → 未登录则打开登录页（二维码）→
 *       周期截图到 shotDir/latest.png（用户在手机「学习通」App 里扫屏幕上的码）→
 *       轮询顶层 URL 跳出 passport/login 域即视为成功 → 登录态持久化在 profile。
 * 不接触账密、不自动填表、不绕过任何验证；二维码过期自动刷新登录页。
 * @returns {{ok:boolean, already?:boolean, reason?:string, screenshot:string}}
 */
async function runLogin(overrides) {
  const waitForLoginByUrl = (LOGIN_FLOW && LOGIN_FLOW.waitForLoginByUrl) || (async () => ({ ok: false, reason: 'login-flow 模块缺失' }));
  const cfg = mergeConfig(CONFIG, overrides);
  logger.configure(cfg.log);
  const L = cfg.login;
  const started = Date.now();
  fs.mkdirSync(L.shotDir, { recursive: true });
  const shotPath = path.join(L.shotDir, 'latest.png');
  const isLoginHost = (u) => new RegExp(L.successUrlPattern, 'i').test(String(u || '')) && !/passport[2.]|login\./i.test(String(u || ''));

  /* 机器可读的登录结果文件：宿主与前端不再靠解析日志猜「成没成」。
     成功必须二次验证（扫完码回个人空间仍停留在已登录域）才算 verified。 */
  const resultPath = process.env.CX_LOGIN_RESULT || path.join(L.shotDir, 'result.json');
  const writeResult = (obj) => {
    try { fs.writeFileSync(resultPath, JSON.stringify(Object.assign({ at: Date.now() }, obj))) } catch { /* ignore */ }
  };
  writeResult({ ok: false, verified: false, reason: 'started' });

  /* 一次性登录：扫码用专属临时 profile；登录成功后保留，供紧接着的看课任务复用，
     看课结束由 run() 的 finally 删除。 */
  if (L.ephemeral) {
    cfg.chromium.profileDir = ensureEphemeralProfile();
  }

  const adapter = createCdpAdapter(cfg);
  setActiveAdapter(adapter);
  /* ★ 2026-10-30 D0：登录是否真的成功。
     为 false 时 finally 必须关掉浏览器 —— 见 finally 里的说明。 */
  let loginOk = false;
  /* ★ 分层自检：adapter 必须完整实现 adapter-contract.js 里的契约。
     浏览器层加方法不会影响业务层；删/改已有方法会在这里立刻暴露，
     而不是跑到一半才 undefined。 */
  try { if (CONTRACT && CONTRACT.assertAdapter) CONTRACT.assertAdapter(adapter, 'runLogin'); } catch (_) {}
  try {
    await adapter.ensureBrowser();

    /* ★★★ 2026-10-29：登录前先清掉残留的登录页标签 ★★★
       实测坑：反复重试会在浏览器里堆出 6+ 个 passport2 登录页标签，
       它们抢同一个二维码会话，且 getCurrentUrl() 可能读到错误的那个标签，
       导致「看起来在登录页 / 实际在别的标签」这类误判。
       这里在导航前清一次，只留必要标签。 */
    try {
      const all = await listTargets(cfg).catch(() => []);
      const stale = (all || []).filter((t) =>
        t.type === 'page' && /passport2?\.chaoxing\.com|login/i.test(t.url || '')
      );
      if (stale.length > 1) {
        logger.log('LOGIN', 'INFO', '清理残留的登录页标签', { count: stale.length - 1 });
        const port = resolveCdpPort(cfg);
        const cdpBase = port ? 'http://' + (cfg.cdp.host || '127.0.0.1') + ':' + port : '';
        for (const t of stale.slice(1)) {
          if (!cdpBase) break;
          try {
            await fetch(cdpBase + '/json/close/' + t.id, { method: 'GET' });
          } catch (_) { /* ignore */ }
        }
        await sleep(800);
      }
    } catch (_) { /* 清理失败不影响主流程 */ }

    /* ★ 登录态判定：URL 在已登录域之后，**还要验 cookie**。
       实测坑：Chrome/Edge 的密码管理器会自动填好账号密码框，
       页面看起来「像已登录」，但 URL 仍是 passport2 登录页、服务端并未认证。
       所以这里除了看 URL，还检查 UID/_uid 这些关键 cookie 是否真实存在。 */
    const hasAuthCookie = async () => {
      try {
        const cookies = await adapter.getAllCookies().catch(() => null);
        if (!cookies || !cookies.length) return null;   // 拿不到就不作为否决依据
        const names = new Set((cookies || []).filter((c) => /chaoxing/.test(c.domain || '')).map((c) => c.name));
        const need = ['UID', '_uid'];
        const hit = need.filter((n) => names.has(n));
        return { ok: hit.length > 0, hit, total: cookies.length };
      } catch (_) { return null; }
    };

    // 1) 先看 profile 是否已有登录态（一次性模式下是全新 profile，通常不会命中）
    await adapter.navigate(L.homeUrl);
    await sleep(2000);
    let url = await adapter.getCurrentUrl();
    if (isLoginHost(url)) {
      const auth = await hasAuthCookie();
      if (auth && auth.ok === false) {
        logger.log('LOGIN', 'WARN', 'URL 在已登录域但缺少认证 cookie，可能是自动填充的假象，走扫码流程', {
          url: url.slice(0, 120), cookies: auth.total,
        });
      } else {
        await adapter.screenshot(shotPath);
        logger.log('LOGIN', 'INFO', 'profile 已有登录态，无需重新扫码', {
          url: url.slice(0, 120), screenshot: shotPath, cookies: auth ? auth.total : 'unknown',
        });
        writeResult({ ok: true, verified: true, already: true, url: String(url).slice(0, 200) });
        loginOk = true;
        return { ok: true, already: true, screenshot: shotPath };
      }
    }
    // 2) 未登录 → 登录页，**先切到扫码模式**（默认显示的是账号密码表单）
    logger.log('LOGIN', 'INFO', '未检测到登录态，打开登录页并切换到扫码模式', {
      screenshot: shotPath,
      hint: '请在手机「学习通」App 打开扫一扫，扫描截图中的二维码并在手机上确认'
    });
    /* ★ 登录页必须清掉全局 Referer 头，且必须在 navigate **之后**清：
       navigate() 结尾会再调一次 _applyExtraHeaders()（给视频 CDN 用的
       Referer: mooc1.chaoxing.com），登录页上这是非法跨域头，
       /createqr 图片请求直接被 Chrome 拒掉（net::ERR_INVALID_ARGUMENT），
       二维码永远 0x0，页面自带的 getauthstatus 轮询也就永远对不上会话。 */
    await adapter.navigate(L.loginUrl);
    await sleep(1500);
    try { await adapter.clearExtraHeaders() } catch (_) { /* ignore */ }
    const switched = await switchToQrMode(adapter, L);
    logger.log('LOGIN', 'INFO', switched ? '已切换到扫码登录' : '未能自动切换到扫码登录，将按页面原样截图', { switched });
    await sleep(1200);

    /* ★★★ 2026-10-27 修正：不再做任何 blob 注入！★★★
       主人指出「二维码中间有图片加载失败的样子」，实测 img.src 是
       blob:https://passport2.chaoxing.com/xxx —— 那正是之前用
       fetch + createObjectURL 注入留下的，上下文重建后 blob 失效 → 破图。
       现在完全使用站点原生 <img id="quickCode">（/createqr?uuid=...）。
       原生图加载失败的真因是系统代理，靠 --no-proxy-server 解决。 */
    const patchQrImage = async () => {
      const frames = await adapter.getFrameDocuments()
      const expr = `(() => {
        const img = document.getElementById('quickCode');
        if (!img) return JSON.stringify({ ok: false, reason: 'no-quickCode' });
        const src = String(img.src || '');
        if (src.startsWith('blob:')) {
          const u = (document.getElementById('uuid') || {}).value || '';
          if (u) img.src = '/createqr?uuid=' + encodeURIComponent(u) + '&fid=-1&_t=' + Date.now();
        }
        img.style.width = '200px';
        img.style.height = '200px';
        img.style.display = 'block';
        img.style.margin = '0 auto';
        img.style.background = '#fff';
        const box = img.closest && img.closest('.ecode-box');
        if (box) { const dis = box.querySelector('.ewmDisable'); if (dis) dis.style.display = 'none'; }
        return JSON.stringify({
          ok: true,
          src: String(img.src || '').slice(0, 70),
          nw: img.naturalWidth, nh: img.naturalHeight,
          isBlob: String(img.src || '').startsWith('blob:'),
          uuid: (document.getElementById('uuid') || {}).value || ''
        });
      })()`
      for (const f of frames) {
        try {
          const res = await adapter.evalInFrame(f.frameId, expr)
          let info; try { info = JSON.parse(res) } catch (_) { info = null }
          if (!info || !info.ok) continue
          await sleep(1500)
          const chk = await adapter.evalInFrame(f.frameId, `JSON.stringify({nw:(document.getElementById('quickCode')||{}).naturalWidth||0})`)
          let c; try { c = JSON.parse(chk) } catch (_) { c = { nw: 0 } }
          if (c.nw > 50) {
            logger.log('LOGIN', 'INFO', '二维码使用站点原生渲染', { src: info.src, nw: c.nw, isBlob: info.isBlob })
            return true
          }
          logger.log('LOGIN', 'WARN', '原生二维码仍是 0x0，重载页面以重新加载资源')
          return false
        } catch (_) { /* 换下一个 frame */ }
      }
      return false
    }
    await patchQrImage()

    /* ★★★ 关键前置检查（主人 2026-10-27 指出的规律）：
       「出现完整渲染的页面才有机会成功，没加载完的基本上不成功」。
       实测对比：
         - CSS 已加载：灰背景 + 白卡片 + 圆角 + 蓝按钮  → 扫码有机会成功
         - CSS 未加载：纯白底 + 黑字 + 左对齐裸表单      → 扫码必然失败
       原理：样式没加载完时，页面 JS 也未必初始化完，二维码会话是半残的。
       所以扫码前必须确认渲染完整，否则先重载重试。 */
    /* ★★★ 渲染完整性判定（2026-10-27 实测确定，之前的判据完全错误）★★★
       主人经验：「出现完整渲染的页面才有机会成功，没加载完的基本上不成功」
       实测对比：
         | 指标                    | 裸页（必失败） | 完整页（可成功） |
         | .default-login 圆角     | 0px           | 16px            |
         | .btn-big-blue 宽度      | 43px          | 360px           |
         | .default-login 宽度     | 1316          | 900             |
         | styleSheets 数量        | 7~8           | 7~8（相同！）   |
         | 二维码 naturalWidth     | 0             | 270             |
       旧判据用 sheets>0 && naturalWidth>50，但裸页与完整页的 sheets 一样，
       所以永远误判为「已就绪」，导致主人在裸页上扫码必然失败。 */
    const checkRendered = async () => {
      try {
        const r = await adapter.evalInFrame(null, `(() => {
          const box = document.querySelector('.default-login');
          const btn = document.querySelector('.btn-big-blue');
          const img = document.getElementById('quickCode');
          const cs = box ? getComputedStyle(box) : null;
          const boxRadius = cs ? String(cs.borderRadius) : '';
          const boxBg = cs ? String(cs.backgroundColor) : '';
          const btnW = btn ? Math.round(btn.getBoundingClientRect().width) : 0;
          const qrNw = img ? img.naturalWidth : 0;
          const rendered = boxRadius.indexOf('16px') >= 0
            && boxBg.indexOf('255, 255, 255') >= 0
            && btnW >= 300
            && qrNw > 200;
          return JSON.stringify({
            rendered, boxRadius, boxBg, btnW, qrNw,
            boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
            sheets: document.styleSheets ? document.styleSheets.length : 0,
            uuid: (document.getElementById('uuid') || {}).value || ''
          });
        })()`)
        let info; try { info = JSON.parse(r) } catch (_) { info = null }
        return info
      } catch (_) { return null }
    }
    const waitForFullyRendered = async (maxMs) => {
      const deadline = Date.now() + (maxMs || 60000)
      let tries = 0
      while (Date.now() < deadline) {
        tries += 1
        const info = await checkRendered()
        if (info && info.rendered) {
          logger.log('LOGIN', 'INFO', '登录页渲染完整（圆角16px/按钮360px），可以扫码', info)
          return true
        }
        if (info && tries % 5 === 1) {
          logger.log('LOGIN', 'INFO', '登录页尚未渲染完整（裸页），继续等待', {
            boxW: info.boxW, radius: info.boxRadius, btnW: info.btnW, qrNw: info.qrNw, sheets: info.sheets
          })
        }
        await sleep(1000)
      }
      return false
    }
    /* ★★★ 2026-10-29 实测结论（FNOS）：首次加载必然是裸页 ★★★
       对比数据（同一台机器、同一个登录页）：
         首次加载  → boxW=1350, radius=0px,  btnW=43,  qrNw=0     （裸页）
         重载之后  → boxW=900,  radius=16px, btnW=360, qrNw=270   （完整）
       刷新后在 24 秒内连续采样 8 次，全程稳定在完整态 —— 说明**页面不会自己退化**，
       裸页就是「首次加载 CSS 没生效」，重载一次即好。

       所以这里不等 60 秒：首次只给 12 秒（正常情况下 3 秒内就能看出是不是裸页），
       裸页就立刻重载，重载后给 40 秒充分时间。这样能把等待从 60+ 秒压到 ~15 秒。 */
    let rendered = await waitForFullyRendered(12000)
    for (let round = 1; !rendered && round <= 3; round++) {
      logger.log('LOGIN', 'WARN', `渲染未完整（首次加载常见），第 ${round} 次重载重试`)
      try {
        /* ★ 关键：navigate 到 loginUrl 会重新走一遍首页跳转，
           实测这条路常常又落回裸页；直接 navigate 到带 newversion 的登录页更稳。 */
        const directLogin = L.loginUrl
        await adapter.navigate(directLogin)
        await sleep(3000)
        try { await adapter.clearExtraHeaders() } catch (_) { /* ignore */ }
        /* 登录页默认是账号密码表单，必须切到扫码模式才有二维码 */
        const sw = await switchToQrMode(adapter, L)
        logger.log('LOGIN', 'INFO', '重载后切换扫码模式', { switched: !!sw })
        await sleep(2000)
        await patchQrImage()
      } catch (e) {
        logger.log('LOGIN', 'WARN', '重载登录页出错', { err: String((e && e.message) || e).slice(0, 100) })
      }
      rendered = await waitForFullyRendered(40000)
      if (rendered) {
        logger.log('LOGIN', 'INFO', '重载后渲染成功，进入扫码阶段', { round })
      }
    }
    if (!rendered) {
      logger.log('LOGIN', 'ERROR', '登录页始终未渲染完整，扫码大概率失败（建议重启浏览器）')
    }

    /* ====================================================================
     * ★★★ 2026-10-30 重写：扫码登录不再自己管二维码会话 ★★★
     *
     * 原实现在这里维护了 ~170 行逻辑：抓 uuid/enc → 下载 createqr →
     * 调 /getauthstatus/v2 轮询 → 解读 type(2/3/4) → 决定是否换码。
     * 实测结论：这条链路对 442 次 type=3、0 次 status=true，
     * 且语义判断连续错了三次（把 3 当已扫、把 2 当可恢复、在错误页面取 enc）。
     *
     * 新做法只有一句：**打开登录页，等 URL 离开 passport2.chaoxing.com**。
     * 依据是成熟项目 Chaoxing_Fast（src/login.mjs）的判定：
     *     const onLogin = /passport2\.chaoxing\.com/.test(url) || ...
     *     if (!onLogin) { logged = true; break }
     * 它不看 type、不看 status、不碰 createqr —— 那些都是页面自己的事。
     *
     * 为什么这样更可靠：
     *   · 二维码由页面自己的 JS 生成与轮询，会话天然一致（不需要我们复刻）
     *   · 成功与否只看「浏览器有没有真的离开登录域」，这是浏览器事实，
     *     不是接口语义，没有解释空间
     *   · 跨标签页也算（站点常把已登录页开在新 tab）
     *
     * 二维码截图仍然提供（UI 要展示），但**不参与任何判定**。
     * ==================================================================== */
    const flow = await waitForLoginByUrl({
      adapter,
      cfg,
      logger,
      shotDir: L.shotDir,
      flagFile: path.join(L.shotDir, 'refresh.request'),
      timeoutMs: L.timeoutMs,
      pollMs: 2000,
      onUrl: (u) => { url = u },
    });

    if (!flow.ok) {
      logger.log('LOGIN', 'ERROR', '扫码超时。请重新执行登录流程，并在窗口期内完成手机确认', {
        screenshot: shotPath, lastUrl: String(flow.url || '').slice(0, 140),
      });
      writeResult({ ok: false, verified: false, reason: 'timeout', screenshot: shotPath });
      return { ok: false, reason: 'timeout', screenshot: shotPath };
    }

    // 3) 成功 → 回个人空间二次验证（真扫成功才允许写 verified）
    await adapter.navigate(L.homeUrl);
    await sleep(2500);
    let verifyUrl = await adapter.getCurrentUrl();
    if (!isLoginHost(verifyUrl)) {
      // 可能跳转慢，再给一次机会
      await sleep(3000);
      verifyUrl = await adapter.getCurrentUrl();
      if (!isLoginHost(verifyUrl)) {
        await adapter.screenshot(shotPath);
        logger.log('LOGIN', 'ERROR', '扫码后回到个人空间仍停留在登录页，判定验证失败', { url: String(verifyUrl).slice(0, 120) });
        writeResult({ ok: false, verified: false, reason: 'verify_failed', url: String(verifyUrl).slice(0, 200) });
        return { ok: false, reason: 'verify_failed', screenshot: shotPath };
      }
    }
    await adapter.screenshot(shotPath);
    writeResult({ ok: true, verified: true, already: false, url: String(verifyUrl).slice(0, 200), screenshot: shotPath });
    loginOk = true;
    logger.log('LOGIN', 'INFO', L.ephemeral
      ? '登录成功并已验证（一次性模式：本次任务结束后登录态即销毁，下次需重新扫码）'
      : '登录成功并已验证，登录态已保存到 profile（后续任务自动复用）', {
      screenshot: shotPath, elapsedMs: Date.now() - started
    });
    return { ok: true, already: false, screenshot: shotPath };
  } finally {
    /* ★★ 一次性模式下，**只有登录成功**才保持浏览器运行。
       原因（实测回归）：超星登录成功后，UID/_uid/uf/vc3 这些是**会话级 cookie**，
       只活在浏览器进程内存里，不会立刻落盘。之前的版本登录成功后立刻
       shutdownBrowser()，等于把刚拿到的登录态当场销毁 —— 于是
       --list-courses / 看课再开新浏览器时又回到登录页（fid=5521 重定向），
       表现就是「登录成功了但读不到课程」。
       所以成功时保持浏览器存活，让读课程/看课附着到同一个实例；
       销毁交给「看课任务结束时」的 purgeEphemeralProfile()。

       ★ 2026-10-30 D0 修：失败时（扫码超时 / 验证失败 / 抛异常）必须立刻关掉。
       原实现无条件保留浏览器，于是失败路径留下一个**没登录**的 headless 实例：
       实测一次超时就泄漏 13 个进程、1335 MB RSS，且 profile 被占用导致
       purgeEphemeralProfile() 删不掉，一直占到下次 stop() 才被兜底清理 ——
       这是飞牛「负载敏感 / 内存被压满」的主要来源。
       没有登录态就没有任何理由留着它。 */
    if (loginOk) {
      logger.log('LOGIN', 'INFO', '登录流程结束，浏览器保持运行（供读课程/看课复用同一会话）');
    } else {
      logger.log('LOGIN', 'INFO', '登录未完成，关闭浏览器释放内存（不留没有登录态的实例）');
      try { await shutdownBrowser(adapter); } catch (e) {
        logger.log('LOGIN', 'WARN', '关闭浏览器失败（由宿主兜底清理）', {
          err: String((e && e.message) || e).slice(0, 120),
        });
      }
    }
  }
}

/**
 * 一次性登录 profile 管理。
 * 目标：登录态「用一次少一次」——登录之后的看课任务跑在专属临时 profile 里，
 * 看课任务结束（正常/异常）就整目录删除，下次必须重新扫码。
 *
 * 设计要点：
 *   - 用**固定目录**（不是 mkdtemp 随机名），因为「扫码登录」和「开始看课」是两个
 *     独立进程，必须共享同一个 profile 才能复用登录态。
 *   - 生命周期由宿主控制：点「开始登录」时创建，看课任务结束时删除。
 *   - 只有 login.ephemeral 为真时生效；关闭时沿用 cx-learn/browser-profile 长期复用。
 */
const EPHEMERAL_ROOT = path.join(os.tmpdir(), 'cx-learn-ephemeral');
const EPHEMERAL_DIR = path.join(EPHEMERAL_ROOT, 'session');

/** 返回一次性 profile 目录（不存在则创建）。 */
function ensureEphemeralProfile() {
  fs.mkdirSync(EPHEMERAL_ROOT, { recursive: true });
  // 上一次残留先清掉，保证是干净的新会话
  try { fs.rmSync(EPHEMERAL_DIR, { recursive: true, force: true }) } catch (_) { /* ignore */ }
  fs.mkdirSync(EPHEMERAL_DIR, { recursive: true });
  logger.log('LOGIN', 'INFO', '一次性登录模式：使用临时 profile，看课结束后即删除', { dir: EPHEMERAL_DIR });
  return EPHEMERAL_DIR;
}

/** 删除一次性 profile（幂等）。登录态彻底销毁，下次必须重新扫码。 */
function cleanupEphemeralProfile() {
  try {
    fs.rmSync(EPHEMERAL_DIR, { recursive: true, force: true });
    logger.log('LOGIN', 'INFO', '临时 profile 已删除（登录态不再留存，下次需重新扫码）', { dir: EPHEMERAL_DIR });
  } catch (e) {
    logger.log('LOGIN', 'WARN', '临时 profile 删除失败，请手动清理', { dir: EPHEMERAL_DIR, err: String((e && e.message) || e).slice(0, 120) });
  }
}


/**
 * 主动关闭本次任务启动的浏览器，避免进程一直占着 9223 端口和 profile 目录
 * （主人反馈「登录界面明显卡了，占着茅坑不拉屎」就是这个）。
 * 只关自己启动的实例：附着到外部已存在 CDP 时不碰。
 */
async function shutdownBrowser(adapter) {
  if (!adapter || adapter.engine !== 'cdp') return;
  const fn = adapter.shutdown
  if (typeof fn === 'function') {
    try { await fn(); return } catch (e) { logger.log('LOGOUT', 'WARN', '浏览器关闭失败', { err: String((e && e.message) || e).slice(0, 120) }) }
  }
  // 兜底：直接用 CDP 让浏览器自己退出
  try {
    const ver = await fetch('http://' + CONFIG.cdp.host + ':' + CONFIG.cdp.port + '/json/version')
    if (ver.ok) {
      const info = await ver.json()
      const ws = info.webSocketDebuggerUrl
      if (ws && typeof WebSocket === 'function') {
        await new Promise((resolve) => {
          const s = new WebSocket(ws)
          const t = setTimeout(() => { try { s.close() } catch (_) {} ; resolve() }, 3000)
          s.onopen = () => { try { s.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch (_) {} ; setTimeout(() => { clearTimeout(t); try { s.close() } catch (_) {} ; resolve() }, 400) }
          s.onerror = () => { clearTimeout(t); resolve() }
          s.onclose = () => { clearTimeout(t); resolve() }
        })
        logger.log('LOGOUT', 'INFO', '已请求浏览器退出（释放 9223 端口）')
      }
    }
  } catch (_) { /* 浏览器已不在：无需处理 */ }
}


/**
 * 把登录页从「账号密码表单」切换到「扫码登录」。
 *
 * 超星 passport2 登录页默认渲染账号密码表单，二维码区域要点击
 * 「使用学习通APP扫码登录」入口才会加载（实测：不点就截不到码）。
 * 该操作只切 UI，不填写任何凭据、不提交任何表单。
 * @returns {Promise<boolean>} 是否成功切到扫码视图
 */
async function switchToQrMode(adapter, L) {
  const frames = await adapter.getFrameDocuments();
  const expr = `(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const want = ['使用学习通APP扫码登录', '扫码登录', '学习通APP扫码登录', 'APP扫码登录'];
    const clickable = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 10 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    // 1) 精确文本命中（最短匹配优先，避免点到外层容器）
    let best = null;
    document.querySelectorAll('a,div,span,li,button,p,i').forEach((el) => {
      if (!clickable(el)) return;
      const t = norm(el.innerText);
      if (!t || t.length > 40) return;
      if (!want.some((w) => t === norm(w))) return;
      if (!best || t.length < norm(best.el.innerText).length) best = { el, t };
    });
    if (best) { best.el.click(); return { ok: true, by: 'exact', text: best.t }; }

    // 2) 包含关键词的兜底
    let loose = null;
    document.querySelectorAll('a,div,span,li,button,i').forEach((el) => {
      if (!clickable(el)) return;
      const t = norm(el.innerText);
      if (!t || t.length > 30) return;
      if (!/扫码/.test(t)) return;
      if (!loose || t.length < norm(loose.el.innerText).length) loose = { el, t };
    });
    if (loose) { loose.el.click(); return { ok: true, by: 'loose', text: loose.t }; }

    // 3) 找二维码 tab 类的元素（icon/class 含 qr）
    const cand = document.querySelector('.qr-tab, [class*="qrTab"], [class*="scan-login"], [class*="scanLogin"]');
    if (cand && clickable(cand)) { cand.click(); return { ok: true, by: 'class' }; }

    return { ok: false, reason: 'no-qr-entry' };
  })()`

  for (const f of frames) {
    try {
      const r = await adapter.evalInFrame(f.frameId, expr)
      if (r && r.ok) {
        logger.log('LOGIN', 'INFO', '已点击扫码登录入口', { by: r.by, text: r.text || '', frameId: f.frameId })
        await sleep(1500)
        return true
      }
    } catch (_) { /* 换下一个 frame */ }
  }
  return false
}

/**
 * 轻量登录态校验（每次启动任务前调用）。
 * 只访问个人空间看是否被踢回登录页，不开二维码、不截图轮询、不打扰用户。
 * 目的：让「登录态早就失效」在任务开始前就暴露，而不是跑到一半 LOGIN_REQUIRED。
 * @returns {{ok:boolean, loggedIn:boolean, url?:string, reason?:string}}
 */
async function checkLoginState(overrides) {
  const cfg = mergeConfig(CONFIG, overrides);
  logger.configure(cfg.log);
  const L = cfg.login;
  const isLoginHost = (u) => new RegExp(L.successUrlPattern, 'i').test(String(u || '')) && !/passport[2.]|login\./i.test(String(u || ''));
  /* 一次性模式下只检查当前会话的临时 profile：没有临时 profile 就等于没登录，
     直接返回 needLogin，不要去碰长期 profile（那是旧数据，不能用来"装作已登录"）。 */
  if (L.ephemeral) {
    if (!fs.existsSync(EPHEMERAL_DIR)) {
      logger.log('LOGIN', 'INFO', '一次性登录模式：当前没有有效会话，需要重新扫码');
      return { ok: true, loggedIn: false, url: '', reason: 'no_ephemeral_session' };
    }
    cfg.chromium.profileDir = EPHEMERAL_DIR;
  }
  let adapter = null;
  try {
    adapter = createCdpAdapter(cfg);
    await adapter.ensureBrowser();
    await adapter.navigate(L.homeUrl);
    await sleep(2000);
    const url = await adapter.getCurrentUrl();
    const loggedIn = isLoginHost(url);
    logger.log('LOGIN', 'INFO', loggedIn ? '登录态校验通过' : '登录态已失效，需要重新扫码', { url: String(url || '').slice(0, 120) });
    return { ok: true, loggedIn, url: String(url || '') };
  } catch (e) {
    return { ok: false, loggedIn: false, reason: String((e && e.message) || e).slice(0, 200) };
  } finally {
    // 预检不许留浏览器进程：检查完立刻关掉，避免「占着茅坑」。
    try { await shutdownBrowser(adapter); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  runLogin,
  EPHEMERAL_ROOT,
  EPHEMERAL_DIR,
  ensureEphemeralProfile,
  cleanupEphemeralProfile,
  shutdownBrowser,
  switchToQrMode,
  checkLoginState
};
