/* ============================================================================
 * engine/src/browser/cdp.js — CDP 适配器：连接、target 管理、注入求值、真实输入事件、截图
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { buildChromiumArgs, describeLaunchExit, inspectProfileLock, isBareCommandName, isHeadlessShellKernel, isProfileWritable, readDevToolsActivePort, resolveSendTimeout } = require('./args.js');
const { BUS, FatalStop, HEALTH, busEmit, fs, path, sleep, spawn } = require('../core/base.js');
const { logger } = require('../core/logging.js');

/* ============================================================================
 * 第 2 节 · DSH_ADAPTER —— 浏览器操作最小原语声明区（路径 A：CDP 实现）
 * ----------------------------------------------------------------------------
 * 原语清单（业务层只认识这些，不认识 CDP 细节）：
 *   sleep(ms)                 底层定时。业务代码不得直接使用（humanize 专用）。
 *   ensureBrowser()           前置检查：CDP 端点可达则附着；否则按 CONFIG 启动
 *                             Chromium（独立 profile）。语义：保证"有一个可控浏览器"。
 *   navigate(url, opts)       导航并等待 load 事件；超时不致命，由业务层判断。
 *   getFrameDocuments()       递归遍历 frame 树（含全部同源/跨进程 iframe），返回
 *                             [{frameId,url,isTop}]。满足"不得只操作顶层 document"。
 *   evalInFrame(fid, expr)    在指定 frame 的执行上下文中求值（Runtime.evaluate，
 *                             returnByValue + userGesture），返回 JSON 可序列化值。
 *   click(fid, rect)          以 Input.dispatchMouseEvent 在全局坐标真实点击
 *                             （mouseMoved→Pressed→Released），等价真人输入。
 *   jsClick(fid, kind, arg)   降级原语：页内 element.click()（跨域 iframe 兜底）。
 *   getText(fid, expr)        便捷取文本。
 *   isVideoEnded(fid)         语义原语：ended || progress >= 98.5%。
 *   getCurrentUrl()           当前顶层 URL（前置检查用）。
 * 适配方式：CDP over 原生 WebSocket（Node≥22 全局可用）+ HTTP /json 端点；
 *          每帧上下文经 Runtime.executionContextCreated(auxData.frameId) 映射，
 *          从而对多层同源 iframe 做真正的递归遍历与逐帧求值。
 * 若浏览器能力以 browser_* MCP 工具提供：只需替换下方带 [BRIDGE] 标记的
 * 函数体（每处 3-6 行），见文末适配指南 A。
 * ==========================================================================*/
function createCdpAdapter(cfg) {
  let _conn = null;
  let _targetId = null;
  let _spawnedByUs = false; // true = 本次进程启动了 Chromium，退出时应主动关掉
  /* 内核进程 pid。由 spawnChromium 写入，附着外部浏览器或启动失败时为 null。
     契约 §7.1：写方是启动者；读方（插件/UI/监测）拿不到就按 null 处理，不许抛错。 */
  let _kernelPid = null;
  let _browserClosedByUs = false; // true = 是我们主动请求关闭的（用于区分「正常退出」与「内核崩了」）
  /** CDP 连接：请求-响应关联 + 事件等待 + frame→执行上下文映射。 */
  class CdpConn {
    constructor(wsUrl) {
      this.wsUrl = wsUrl; this.ws = null;
      this._mid = 0; this._pending = new Map(); this._waiters = [];
      this.sessionId = null; this.topFrameId = null;
      this.contexts = new Map(); // frameId -> [contextId, ...]
      /* ★ 2026-10-30：连接被意外关闭时的回调（浏览器层崩溃恢复用）。
         约定：只有**非主动**关闭才触发，避免 shutdown() 自己 close 后
         又被当成崩溃、触发无意义的重启。 */
      this.onUnexpectedClose = null;
      this._closedByUs = false;
    }
    connect() {
      const timeoutMs = cfg.cdp.attachTimeoutMs;
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(this.wsUrl); } catch (e) { reject(new Error('CDP WebSocket 创建失败: ' + e.message)); return; }
        this.ws = ws;
        const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('CDP WebSocket 连接超时: ' + this.wsUrl)); }, timeoutMs);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败: ' + this.wsUrl)); });
        /* 意外断开（内核崩溃/被 OOM 杀掉/页面 renderer 全灭）→ 通知上层。
           'close' 在 error 之后一定触发，所以只监听 close 一个就够，
           但要排除我们自己调 close() 的情况。 */
        ws.addEventListener('close', () => {
          if (this._closedByUs) return;
          const fn = this.onUnexpectedClose;
          if (typeof fn === 'function') {
            try { fn() } catch (_) { /* 回调异常不能污染连接层 */ }
          }
        });
        ws.addEventListener('message', (ev) => {
          let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (msg.id !== undefined && this._pending.has(msg.id)) {
            const p = this._pending.get(msg.id); this._pending.delete(msg.id);
            if (msg.error) p.reject(new Error('CDP 调用失败 ' + p.method + ': ' + msg.error.message));
            else p.resolve(msg.result || {});
          } else if (msg.method) {
            this._onEvent(msg);
            this._waiters = this._waiters.filter((w) => {
              if (w.method === msg.method) { clearTimeout(w.timer); w.resolve(msg.params); return false; }
              return true;
            });
          }
        });
      });
    }
    _onEvent(msg) {
      if (msg.method === 'Runtime.executionContextCreated') {
        const c = msg.params && msg.params.context;
        const fid = c && c.auxData && c.auxData.frameId;
        if (fid) { const arr = this.contexts.get(fid) || []; arr.push(c.id); this.contexts.set(fid, arr); }
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        this.contexts.clear();
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        const cid = msg.params && msg.params.executionContextId;
        for (const [fid, arr] of this.contexts) {
          const i = arr.indexOf(cid);
          if (i >= 0) { arr.splice(i, 1); if (!arr.length) this.contexts.delete(fid); }
        }
      } else if (msg.method === 'Fetch.requestPaused') {
        /* ★ 超星的视频在 cldisk CDN 上，CDN 校验 Referer：
             无效 Referer → 403 → <video> 拿不到字节 → 播放器 readyState=0 卡死。
           Chrome 的媒体请求不继承 Network.setExtraHTTPHeaders（那个只对 XHR/fetch 生效，
           实测页面内 fetch 206 成功、<video> 却 0 字节）。
           ⇒ 必须用 Fetch 域逐个拦截媒体请求，显式把 Referer 换成超星域名。
           注意 headers 必须是 {name, value} 数组格式，传对象会被忽略。 */
        this._onFetchPaused(msg).catch(() => { /* 拦截失败不能拖垮主流程 */ });
      }
    }
    /** 处理被 Fetch 域拦截的请求：补上超星 Referer 后放行。 */
    async _onFetchPaused(msg) {
      const p = msg.params || {};
      const req = p.request || {};
      const headers = req.headers || {};
      const arr = Object.keys(headers).map((k) => ({ name: k, value: String(headers[k]) }));
      const iRef = arr.findIndex((x) => String(x.name).toLowerCase() === 'referer');
      const referer = 'https://mooc1.chaoxing.com/';
      if (iRef >= 0) arr[iRef] = { name: 'Referer', value: referer };
      else arr.push({ name: 'Referer', value: referer });
      /* ★ 必须用事件自带的 sessionId 回包：
         被拦截的请求可能来自子 frame 的 session，用顶层 sessionId 会被 Chrome 拒绝。 */
      const sid = msg.sessionId;
      try {
        await this.send('Fetch.continueRequest', { requestId: p.requestId, headers: arr }, undefined, sid);
        this.fetchPatched = (this.fetchPatched || 0) + 1;
      } catch (e) {
        try { await this.send('Fetch.continueRequest', { requestId: p.requestId }, undefined, sid); } catch (_) { /* ignore */ }
      }
    }
    send(method, params, timeoutMs, sessionId) {
      if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 连接未就绪: ' + method));
      const id = ++this._mid;
      const payload = { id, method, params: params || {} };
      const sid = sessionId !== undefined ? sessionId : this.sessionId;
      if (sid) payload.sessionId = sid;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this._pending.delete(id); reject(new Error('CDP 调用超时: ' + method)); }, resolveSendTimeout(timeoutMs, cfg));
        this._pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        try { this.ws.send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
      });
    }
    close() {
      /* 先打标记，再 close：否则 'close' 事件会把主动关闭误判成崩溃。 */
      this._closedByUs = true;
      try { if (this.ws) this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
      for (const [, p] of this._pending) p.reject(new Error('CDP 连接已关闭'));
      this._pending.clear();
    }
    waitEvent(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._waiters = this._waiters.filter((w) => w.timer !== timer);
          reject(new Error('等待 CDP 事件超时: ' + method));
        }, timeoutMs);
        this._waiters.push({ method, resolve: (p) => { clearTimeout(timer); resolve(p); }, timer });
      });
    }
  }

  /* ★ 2026-10-29：端口不再写死。cfg.cdp.port 为 0 时由 Chromium 自选，
     真实值在每次启动后写回 _activePort，所有 CDP/HTTP 调用都走它。 */
  let _activePort = cfg.cdp.port;
  /* 最近一次拉起的诊断信息：失败时用来给出「为什么起不来」而不是干等超时 */
  let _launchStderr = '';
  let _launchExit = null;
  let _launchError = null;
  /* ★ 2026-10-30 崩溃恢复：本次实例内已自动重启次数 / 是否正在重启 / 是否已销毁。
     _disposed 用来挡住 shutdown 之后迟到的 close 事件，避免「关的时候又重起」。 */
  let _restartCount = 0;
  let _restarting = false;
  let _disposed = false;
  /* 恢复失败时暂存致命错误：下一次 CDP 调用会优先抛出它，
     让业务层看到「内核崩了」而不是「CdpConn 已关闭」这种无关信息。 */
  let _connLostError = null;

  async function cdpHttp(path, method) {
    const url = 'http://' + cfg.cdp.host + ':' + _activePort + path;
    const res = await fetch(url, { method: method || 'GET' });
    if (!res.ok) throw new Error('CDP HTTP ' + res.status + ' ' + url);
    return res.json();
  }

  function spawnChromium() {
    const args = buildChromiumArgs({
      headless: !!cfg.chromium.headless,
      port: cfg.cdp.port,          // 0 = 自选
      profileDir: cfg.chromium.profileDir || '',
      shellKernel: isHeadlessShellKernel(cfg.chromium.executablePath),
      userArgs: cfg.chromium.extraArgs || [],
    });
    args.push('about:blank');
    try {
      /* detached: true + unref —— 登录进程退出后浏览器必须继续活着，
         否则会话级 cookie（UID/_uid）随之消失，读课程/看课就回到登录页。
         销毁统一由看课任务结束时的 purge + killStrayBrowser 负责。

         ★ 2026-10-29：stdio 由 'ignore' 改为 'pipe'（只接 stderr）。
         原因：Chromium 把「为什么起不来」全部写在 stderr，而最常见的那条
         （profile 被占用 / 目录不可写）表现为**进程静默退出、退出码 21、stderr 为空
         但主进程日志里有一行 process_singleton_win.cc**。原来用 'ignore' 时
         这些信息全部丢失，用户只能看到 20 秒后的一句「连不上」。
         detached 下仍要能收尾：unref 只解除父子绑定，不影响 pipe 读取。 */
      const child = spawn(cfg.chromium.executablePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      try { child.unref() } catch (_) { /* ignore */ }
      _spawnedByUs = true;
      /* ★ 2026-10-31：记下内核 pid 并上报。
         契约 §7.1 要求 browser.json 有 pid，UI 的「内核健康行」也读它
         （`内核：就绪 pid 1234 · CDP 34319 · 心跳 4s 前`），
         但原来**没有任何地方写它** —— 三方各说各话，UI 那一段永远显示不出 pid。
         归属规则：谁 spawn 谁写；附着到外部浏览器时 pid 为 null
         （外部实例不归我们管，报一个别人的 pid 只会误导）。 */
      _kernelPid = (typeof child.pid === 'number') ? child.pid : null;
      _browserClosedByUs = false;
      _launchStderr = '';
      _launchExit = null;
      _launchError = null;

      /* 只保留最后若干行，够定位问题即可；限长防止崩溃日志把内存打满 */
      try {
        if (child.stderr) {
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (buf) => {
            _launchStderr = (_launchStderr + buf).slice(-4000);
          });
          child.stderr.on('error', () => { /* 管道断了就算了 */ });
        }
      } catch (_) { /* 拿不到 stderr 不影响主流程 */ }

      child.on('error', (e) => { _launchError = e; /* ensureBrowser 的轮询会捕获失败 */ });
      /* ★ 2026-10-29 实测：spawn 失败时 child.pid **立即**是 undefined，
         而 'error' 事件要等下一轮事件循环。所以在超时 20 秒的等待里，
         只靠 error 事件会白等；这里同步记一笔，等待循环立刻就能看到。 */
      if (child.pid === undefined) {
        const e = new Error('spawn 失败（ENOENT/EACCES）：' + cfg.chromium.executablePath);
        /* 只对「看起来是路径」的值做 existsSync 区分权限问题；
           裸命令名（如 'chromium'）在 PATH 里，existsSync 恒为 false，不能据此判 ENOENT。
           这里先给 ENOENT，'error' 事件若稍后到达会覆盖成真实 code。 */
        const exe = String(cfg.chromium.executablePath || '');
        e.code = (!isBareCommandName(exe) && fs.existsSync(exe)) ? 'EACCES' : 'ENOENT';
        _launchError = e;
      }
      /* 内核崩了要能说出来，否则只能干等 20 秒超时后报「连不上」 */
      child.on('exit', (code, signal) => {
        _launchExit = { code, signal };
        if (_spawnedByUs && !_browserClosedByUs) {
          logger.warn('PRECHECK', '浏览器进程提前退出', {
            code, signal,
            hint: describeLaunchExit(
              code, _launchStderr, cfg,
              _launchError ? (String(_launchError.code || '') + ' ' + String(_launchError.message || '')) : '',
              signal
            ).reason,
          });
        }
      });
    } catch (e) {
      throw new FatalStop('CHROMIUM_LAUNCH_FAILED', '无法启动 Chromium: ' + e.message + '；请检查 CONFIG.chromium.executablePath（可用环境变量 CX_CHROMIUM 指定）。');
    }
    return args;
  }

  /**
   * 等待 CDP 端口就绪，并把真实端口写入 _activePort。
   *
   * 三条发现路径，按可靠性排序：
   *   1. 端口非 0 → 直接探 /json/version（用户指定，最确定）
   *   2. 端口为 0 → 轮询 <profile>/DevToolsActivePort，读出 Chromium 自报的端口
   *   3. 兜底 → 解析 Chromium 打到 stderr 的 "DevTools listening on ws://..."
   *
   * 必须在「轮询端口」之前先确认端口号，所以这里先拿端口再探活，
   * 而不是像旧实现那样对着一个假定端口死等 —— 后者无法区分
   * 「还没起来」与「端口被别人占着」。
   */
  async function waitForCdpEndpoint(deadline) {
    let lastErr = null;
    /* 给「内核提前退出」留出宽限期：刚起时的正常启动也可能瞬间退，
       但如果 1.5 秒后还没有端口线索、且进程已退出，就没必要再等满 20 秒。 */
    const startedAt = Date.now();
    while (Date.now() < deadline) {
      if (!_activePort && cfg.chromium.profileDir) {
        const active = readDevToolsActivePort(cfg.chromium.profileDir);
        if (active) {
          _activePort = active.port;
          logger.info('PRECHECK', '已从 DevToolsActivePort 读到调试端口', {
            port: _activePort, profile: cfg.chromium.profileDir,
          });
        }
      }
      if (_activePort) {
        try { return await cdpHttp('/json/version'); } catch (e) { lastErr = e; }
      }
      /* ★ 2026-10-29：进程已死就立刻返回，让上层用真实退出码报错。
         否则用户要等 20 秒，最后看到的还是一句「连不上」。 */
      if (_launchExit && Date.now() - startedAt > 1500) {
        logger.warn('PRECHECK', '内核在端口就绪前已退出，停止等待', {
          code: _launchExit.code, signal: _launchExit.signal, waitedMs: Date.now() - startedAt,
        });
        return null;
      }
      /* ★ 2026-10-29 补：spawn 失败（可执行文件不存在 ENOENT / 权限 EACCES）
         **不会**触发 exit，只会触发 error，有时也不触发 —— 因此两种都要查。否则会白等满 attachTimeoutMs。

         注意：不能用 fs.existsSync(executablePath) 在这里做判断。
         实测（本机 Windows）：裸命令名如 'where.exe' / 'ping.exe' / 'certutil.exe'
         在 PATH 里可解析、spawn 能正常启动，但 existsSync 对裸名一律返回 false。
         config 的默认值恰好就是裸名 'chromium'（依赖 PATH 查找），
         若在这里 existsSync 一下就会把合法配置误判成"内核不存在"。
         只认 spawn 自己的结论（_launchError），它才是权威。 */
      if (_launchError) {
        logger.warn('PRECHECK', '内核无法执行，停止等待', {
          code: _launchError.code, message: String(_launchError.message || '').slice(0, 160),
        });
        return null;
      }
      await sleep(300);
    }
    return null;
  }

  function requireConn() {
    /* ★ 恢复失败的致命错误优先抛出：业务层看到的是「内核崩了 + 原因」，
       而不是「浏览器尚未连接」这种没信息量的话。抛一次就清掉，避免每轮
       都重复报同一条。 */
    if (_connLostError) {
      const err = _connLostError
      _connLostError = null
      throw err
    }
    if (!_conn) throw new FatalStop('CDP_NOT_CONNECTED', '浏览器尚未连接（ensureBrowser 未调用或已断开）。');
    return _conn;
  }

  const adapter = {
    engine: 'cdp',
    sleep,

    /**
     * 主动关闭本次任务启动的浏览器，释放调试端口与 profile 目录。
     * 只关自己启动的实例（_spawnedByUs）；若附着到外部已有浏览器则不动。
     *
     * ★★★ 2026-10-31 重要修正（L2 §1，已取证）★★★
     * 原实现**先**把 `alive:false` 写进 browser.json，**再**判断
     * `if (!_spawnedByUs) return` —— 于是附着方（--list-courses / 看课）
     * 结束时会发生：
     *     browser.json alive = false
     *     内核端口仍然响应 = true
     * 即「内核明明还活着，UI 却显示已停止」，而且附着时还把 pid 覆盖成 null。
     * 实测脚本：scripts/l2-probe-ownership.cjs
     *
     * 现在的规则（L2 契约 §3.1）：
     *   · 只有**启动过内核**的一方（owner）才能宣告它死了
     *   · 附着方只断开自己的连接，**绝不写 alive / pid**
     *   · owner 关闭成功后，才把 alive 置 false
     */
    /**
     * 只断开本次连接：不停内核、不删 profile、**不写 alive/pid**。
     *
     * 【与 shutdown 的区别】
     *   shutdown = owner 收工，内核该关掉
     *   detach   = 本次任务用完这条连接，但会话还开着（B-精简）
     *
     * 【为什么必须有它】
     *   B-精简的语义是「刷课会话期间内核不死」。跑完一门课要退出引擎进程，
     *   但又不能关内核 —— 如果直接调 shutdown，owner 进程会把自己起的
     *   内核关掉，下一门课又得重新扫码，会话就形同虚设。
     */
    async detach() {
      /* disposed 挡住断连后被误判成崩溃并触发自动重启 */
      _disposed = true;
      try { if (HEALTH && typeof HEALTH.stopHeartbeat === 'function') HEALTH.stopHeartbeat() } catch (_) { /* ignore */ }
      try { if (_conn) { try { _conn.close() } catch (_) {} ; _conn = null; _targetId = null } } catch (_) { /* ignore */ }
      logger.info('LOGOUT', '已断开本次连接（会话保持，内核继续运行）', {
        spawnedByUs: !!_spawnedByUs,
        kernelPid: _kernelPid,
      });
    },

    async shutdown() {
      /* ★ 先置 disposed：挡住 shutdown 之后迟到的 close 事件，
         否则「主动关浏览器」会被 onUnexpectedClose 当成崩溃、又去重起一个。 */
      _disposed = true;
      /* ★ 再停心跳：后面会主动关内核，心跳再探到「连不上」就会把它标成
         CRASHED，让 UI 误报崩溃。停掉后 browser.json 保留最后一个真实快照。 */
      try { if (HEALTH && typeof HEALTH.stopHeartbeat === 'function') HEALTH.stopHeartbeat() } catch (_) { /* ignore */ }
      /* 只断开自己的 CDP 连接（附着方与 owner 都要做） */
      try { if (_conn) { try { _conn.close() } catch (_) {} ; _conn = null; _targetId = null } } catch (_) { /* ignore */ }
      /* ★ 附着方到此为止：不关内核、不碰 browser.json。
         它的任务只是「用完这次连接」，内核归 owner 管。 */
      if (!_spawnedByUs) return
      /* 标记「主动关闭」，避免 exit 回调把正常退出误报成「内核崩溃」 */
      _browserClosedByUs = true
      /* ★ 只有 owner 才写 alive:false —— 而且放到「关闭动作之后」，
         这样文件里的事实与实际一致。 */
      const markDead = () => {
        try {
          if (BUS && typeof BUS.readBrowser === 'function' && typeof BUS.reportBrowser === 'function') {
            const prev = BUS.readBrowser()
            if (prev && typeof prev === 'object') {
              BUS.reportBrowser(Object.assign({}, prev, {
                alive: false,
                pid: null,                 /* owner 已收工，pid 不再有效 */
                heartbeatAt: new Date().toISOString(),
              }))
            }
          }
        } catch (_) { /* ignore */ }
      }
      try {
        const ver = await cdpHttp('/json/version')
        const ws = ver && ver.webSocketDebuggerUrl
        if (ws) {
          await new Promise((resolve) => {
            let done = false
            const fin = () => { if (!done) { done = true; resolve() } }
            try {
              const s = new WebSocket(ws)
              const timer = setTimeout(() => { try { s.close() } catch (_) {} ; fin() }, 3000)
              s.onopen = () => {
                try { s.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch (_) {}
                setTimeout(() => { clearTimeout(timer); try { s.close() } catch (_) {} ; fin() }, 500)
              }
              s.onerror = () => { clearTimeout(timer); fin() }
              s.onclose = () => { clearTimeout(timer); fin() }
            } catch (_) { fin() }
          })
        }
      } catch (_) { /* 已退出 */ }
      // 等端口真正释放，最多 8 秒
      let exited = false
      for (let i = 0; i < 16; i++) {
        await sleep(500)
        try { await cdpHttp('/json/version'); } catch (_) { exited = true; break }
      }
      if (exited) logger.info('LOGOUT', '浏览器已退出，端口已释放')
      else logger.warn('LOGOUT', '浏览器未在预期时间内退出')
      /* ★ 关闭动作走完才宣告死亡：这样 browser.json 的 alive 与端口实际状态一致。
         即使没能在预期时间内退出，也按「owner 已收工」写 false，并保留 lastErrorKind
         让 UI 能显示异常 —— 但不能像原来那样在**还没尝试关闭**时就先写 false。 */
      markDead()
      /* ★ 关键：Chrome 退出后仍需要时间把 Cookies 落盘（LevelDB 异步写）。
         实测直接关会导致 /tmp/.../Default/Cookies 根本不存在，
         于是「登录成功但读课程 0 门」。这里多等一会并轮询确认文件出现。 */
      const prof = (cfg.chromium && cfg.chromium.profileDir) || ''
      if (prof) {
        const cookieFile = path.join(prof, 'Default', 'Cookies')
        for (let i = 0; i < 20; i++) {
          if (fs.existsSync(cookieFile)) {
            const sz = (() => { try { return fs.statSync(cookieFile).size } catch { return 0 } })()
            if (sz > 1024) { logger.info('LOGOUT', 'Cookies 已落盘', { bytes: sz }); break }
          }
          await sleep(400)
        }
        if (!fs.existsSync(cookieFile)) {
          logger.warn('LOGOUT', 'Cookies 未落盘（读课程可能会失败）', { prof })
        }
      }
    },

    async ensureBrowser() {
      let version = null;
      /* 端口为 0（自选）时不能盲目探活，得先有端口号；
         已有 profile 且上次遗留了 DevToolsActivePort，先读一次再探。 */
      if (!_activePort && cfg.chromium.profileDir) {
        const prev = readDevToolsActivePort(cfg.chromium.profileDir);
        if (prev) _activePort = prev.port;
      }
      if (_activePort) {
        try { version = await cdpHttp('/json/version'); } catch (_) { version = null; }
      }
      if (!version) {
        _browserClosedByUs = false;
        _launchStderr = '';
        _launchExit = null;
        _launchError = null;
        /* 重新启动前清掉旧的端口线索，避免连到上一次残留的端口 */
        if (cfg.chromium.profileDir) {
          try { fs.unlinkSync(path.join(cfg.chromium.profileDir, 'DevToolsActivePort')); } catch (_) { /* 不存在即忽略 */ }
        }

        /* ★ 2026-10-29：起之前先做两项前置体检，比事后从退出码猜要准。
           profile 被别的实例占着 / 目录不可写，Chromium 只会静默退出（exit=21），
           stderr 常常是空的 —— 干等 20 秒再报「连不上」对用户毫无帮助。 */
        if (cfg.chromium.profileDir) {
          if (!isProfileWritable(cfg.chromium.profileDir)) {
            throw new FatalStop(
              'PROFILE_NOT_WRITABLE',
              '浏览器 profile 目录不可写：' + cfg.chromium.profileDir
              + '。请修正权限（容器里注意属主是否为运行用户），或改用其它 CX_PROFILE_DIR。'
            );
          }
          const lock = inspectProfileLock(cfg.chromium.profileDir);
          if (lock.locked) {
            /* 只提示不阻断：异常退出会留下残留锁文件，拦下来反而会误伤 */
            logger.warn('PRECHECK', 'profile 存在锁文件，若随即启动失败多半是被占用', {
              evidence: lock.evidence,
              hint: '确认没有旧实例在跑；Chromium 报 exit=21 时删掉这些文件再试',
            });
          }
        }

        _activePort = cfg.cdp.port;
        const args = spawnChromium();
        logger.info('PRECHECK', 'CDP 端点未就绪，启动 Chromium 实例', {
          exec: cfg.chromium.executablePath,
          port: cfg.cdp.port || 'auto',
          shellKernel: isHeadlessShellKernel(cfg.chromium.executablePath),
          /* 只记录关键开关，避免把整串参数刷进日志 */
          antiThrottle: args.filter((a) => /throttl|Backgrounding|Occlusion|autoplay-policy/i.test(a)),
        });
        version = await waitForCdpEndpoint(Date.now() + cfg.cdp.attachTimeoutMs);
        if (!version) {
          /* 失败时别再给一句「连不上」—— 把退出码、stderr、profile 现场一起报出来。
             优先级：spawn 自身的错误（路径/权限） > 进程退出码 > 现场推断。 */
          const spawnErr = _launchError
            ? (String(_launchError.code || '') + ' ' + String(_launchError.message || '')).trim()
            : '';
          const diag = describeLaunchExit(
            _launchExit ? _launchExit.code : null,
            _launchStderr,
            cfg,
            spawnErr,
            _launchExit ? _launchExit.signal : ''
          );
          const earlyDeath = !!(_launchExit || _launchError);
          logger.error('PRECHECK', '浏览器启动失败', {
            exitCode: diag.code,
            exitedEarly: earlyDeath,
            reason: diag.reason,
            hint: diag.hint,
            spawnError: spawnErr ? spawnErr.slice(0, 200) : '',
            stderrTail: diag.detail ? diag.detail.slice(-300) : '',
          });
          throw new FatalStop(
            'CDP_ATTACH_FAILED',
            '无法连接或启动 Chromium（' + cfg.chromium.executablePath + ' @ '
            + cfg.cdp.host + ':' + (_activePort || cfg.cdp.port || 'auto') + '）。'
            + '原因：' + diag.reason + '。' + diag.hint
            + (diag.code !== null
              ? '［内核在端口就绪前就退出了，退出码 ' + diag.code + '］'
              : (earlyDeath
                ? '［内核无法执行，见上方原因］'
                : '［内核仍在运行但端口未就绪，可能是版本过旧或参数被覆盖］'))
            + '（若内核是 chrome-headless-shell，注意它不使用 --headless=new）'
          );
        }
        logger.info('PRECHECK', '调试端口已就绪', { port: _activePort, browser: String((version && version.Browser) || '').slice(0, 60) });
      }

      /* ★ 分层：浏览器层把自己的现状写进中间文件，业务层/插件从这里读，
         不用再猜「内核起没起来、端口是多少」。见 engine/state-bus.js */
      try {
        if (BUS && BUS.reportBrowser) {
          /* ★ 2026-10-31（L2 §3.1）：附着方**必须保留** owner 写的 pid，
             不能用自己的 null 覆盖掉。原实现里任何一个附着进程结束，
             pid 就变成 null，UI 的「内核健康行」再也显示不出来。
             规则：只有 owner 写 pid / ownerPid；附着方原样继承。 */
          const prevState = (BUS.readBrowser && BUS.readBrowser()) || null
          const ownedByUs = _spawnedByUs
          const prevPid = prevState && Number.isInteger(prevState.pid) ? prevState.pid : null
          BUS.reportBrowser({
            executablePath: cfg.chromium.executablePath,
            port: _activePort || cfg.cdp.port || 'auto',
            host: cfg.cdp.host,
            browserVersion: String((version && version.Browser) || '').slice(0, 80),
            profileDir: cfg.chromium.profileDir || '',
            headless: !!cfg.chromium.headless,
            ready: true,
            /* owner：自己 spawn 就用自己的 pid；附着方继承上一个 owner 的 pid */
            pid: ownedByUs ? _kernelPid : prevPid,
            /* 谁在负责这个内核：owner 写入自己的进程 pid；附着方保留原值 */
            ownerPid: ownedByUs ? process.pid : ((prevState && prevState.ownerPid) ?? null),
          });
        }
        busEmit('browser', 'ready', { port: _activePort || cfg.cdp.port || 'auto' });
      } catch (_) { /* 上报失败不影响启动 */ }

      /* ★ 2026-10-30：启动心跳。上面那次 reportBrowser 只是「启动那一刻」的快照，
         内核中途死了文件里的 ready 仍是 true。心跳每 15s 探一次 CDP，
         把 alive / heartbeatAt / uptimeMs / restarts 持续刷进同一份文件，
         设置页与远端监测才能区分「就绪」和「还活着」。
         getPort 必须读闭包里的 _activePort：端口是 Chromium 自选的，cfg 里还是 0。 */
      try {
        if (HEALTH && typeof HEALTH.startHeartbeat === 'function') {
          HEALTH.startHeartbeat({
            cfg,
            bus: BUS,
            getPort: () => _activePort || cfg.cdp.port || 0,
              /* ★ 只有真正 spawn 内核的一方才有资格宣告它死亡（见 browser-health.js） */
              isOwner: !!_spawnedByUs,
          });
        }
      } catch (_) { /* 心跳起不来不影响主流程 */ }

      // 每次都开一个干净的新 target。
      // 原因：复用旧 target 会被超星风控检测页（detect.chaoxing.com）劫持，
      //       该页 JS 死循环使 renderer 不再响应任何 CDP 命令 → Page.enable 超时。
      const target = await this._openFreshTarget();
      const conn = new CdpConn(target.webSocketDebuggerUrl);
      await conn.connect();
      // /json/list 的目标标识字段是 id（即 targetId）；老版本字段名兜底
      const targetId = target.id || target.targetId;
      const attached = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      conn.sessionId = attached.sessionId;
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      await this._applyExtraHeaders(conn);
      try {
        const t = await conn.send('Page.getFrameTree');
        conn.topFrameId = t.frameTree && t.frameTree.frame && t.frameTree.frame.id;
      } catch (_) { conn.topFrameId = null; }
      await sleep(400); // 协议层：等待 executionContext 事件到齐（非业务节奏）
      _conn = conn;
      _targetId = targetId;

      /* ★ 2026-10-30：挂上崩溃恢复钩子。
         为什么需要：CDP 连接断开后，原来的实现只会在下一次 send() 时抛
         「CDP 调用失败」，业务层看到的是一句莫名其妙的中断；内核可能已经
         被 OOM 杀掉、端口也没了，但没人去重起。这里在连接层收到「意外关闭」
         时主动恢复。

         边界（重要）：
           · 只在自己拉起的内核上重启（_spawnedByUs）。附着到别人的浏览器
             时绝不重起 —— 那可能是主人的生产 Chrome（9223）。
           · 最多 2 次，退避 2s / 6s；超过就抛 BROWSER_CRASHED 并写明历史。
           · cfg.cdp.autoRestart === false 时完全不重启，只记录并抛错。 */
      conn.onUnexpectedClose = () => {
        if (_restarting || _disposed) return
        /* 主动 shutdown 期间不处理：那时 _closedByUs 已被置位，正常不会走到这 */
        if (_browserClosedByUs) return
        const kind = _spawnedByUs ? 'CRASHED' : 'DETACHED'
        try {
          if (HEALTH && typeof HEALTH.recordCrash === 'function') {
            HEALTH.recordCrash({
              bus: BUS,
              code: _launchExit ? _launchExit.code : null,
              signal: _launchExit ? _launchExit.signal : null,
              kind,
            })
          }
          busEmit('browser', 'cdp-closed', { spawnedByUs: !!_spawnedByUs, kind })
        } catch (_) { /* ignore */ }
        logger.warn('PRECHECK', 'CDP 连接意外断开', {
          spawnedByUs: !!_spawnedByUs,
          restarts: _restartCount,
          lastExit: _launchExit,
          autoRestart: cfg.cdp.autoRestart !== false,
        })
        /* 异步派发：onUnexpectedClose 是同步回调，直接 throw 会变成
           uncaughtException 把进程打挂。这里把失败折叠成 fatalStop 语义 ——
           通过 _connLostError 交给下一次 send() 抛出，业务层的 try/catch 接得住。 */
        Promise.resolve()
          .then(() => _onCdpLost(kind))
          .catch((e) => {
            _connLostError = e
            logger.error('PRECHECK', '内核恢复失败，已终止本次连接', {
              code: (e && e.code) || 'BROWSER_CRASHED',
              message: String((e && e.message) || e).slice(0, 240),
            })
          })
      }

      logger.info('PRECHECK', '已连接浏览器目标', { targetId, url: (target.url || '').slice(0, 100) });
      return { engine: 'cdp', targetId };
    },

    /**
     * CDP 连接丢失后的恢复入口。
     *
     * 规则（见 ensureBrowser 里 onUnexpectedClose 的注释）：
     *   附着别人的浏览器 → 不重启，直接抛
     *   autoRestart === false → 不重启，直接抛
     *   已重启 2 次 → 不再试，抛 BROWSER_CRASHED 并附上历史
     *   否则 → 退避后重建连接（重启内核 + 重连 + 重新挂钩子）
     *
     * 这里的失败一律转成 FatalStop：业务层只认识「致命停止」这一种终态，
     * 让它自己重试会把状态机搅乱（可能重复点同一节）。
     */
    async _onCdpLost(kind) {
      if (_restarting || _disposed) return
      if (!_spawnedByUs) {
        throw new FatalStop('BROWSER_DETACHED',
          'CDP 连接断开，但当前浏览器不是本进程拉起的（附着了外部实例），不会自动重启。'
          + '请确认该浏览器是否仍存活：' + cfg.cdp.host + ':' + (_activePort || cfg.cdp.port || 'auto'));
      }
      if (cfg.cdp.autoRestart === false) {
        throw new FatalStop('BROWSER_CRASHED',
          'CDP 连接断开，且 autoRestart 已关闭（cfg.cdp.autoRestart=false）。'
          + '最后一次退出：' + JSON.stringify(_launchExit || null));
      }
      const maxRestarts = Number.isFinite(cfg.cdp.maxRestarts) ? cfg.cdp.maxRestarts : 2;
      if (_restartCount >= maxRestarts) {
        throw new FatalStop('BROWSER_CRASHED',
          '内核连续崩溃，已自动重启 ' + _restartCount + ' 次仍失败，停止重试。'
          + '最后一次退出码：' + (_launchExit ? _launchExit.code : 'unknown')
          + (kind === 'DETACHED' ? '（附着实例）' : '')
          + '。建议：检查 /dev/shm 与内存（dmesg | grep -i oom），或调低并发后再试。');
      }

      _restarting = true
      _restartCount += 1
      const backoff = Array.isArray(cfg.cdp.restartBackoffMs) ? cfg.cdp.restartBackoffMs : [2000, 6000]
      const waitMs = backoff[Math.min(_restartCount - 1, backoff.length - 1)] || 2000
      logger.warn('PRECHECK', '准备自动重启内核', { attempt: _restartCount, max: maxRestarts, waitMs })
      busEmit('browser', 'restart', { attempt: _restartCount, waitMs })

      try {
        await sleep(waitMs)
        if (_disposed) return
        /* 清掉旧连接与端口线索，否则 ensureBrowser 会去连一个已经死掉的端口 */
        try { if (_conn) { _conn.onUnexpectedClose = null; _conn.close() } } catch (_) { /* ignore */ }
        _conn = null; _targetId = null; _activePort = cfg.cdp.port
        if (cfg.chromium.profileDir) {
          try { fs.unlinkSync(path.join(cfg.chromium.profileDir, 'DevToolsActivePort')) } catch (_) { /* ignore */ }
        }
        /* 回收可能残留的内核进程，避免新旧两个实例抢同一个 profile */
        if (typeof killStrayBrowser === 'function') {
          try { killStrayBrowser() } catch (_) { /* ignore */ }
        }
        _browserClosedByUs = false
        await this.ensureBrowser()
        logger.info('PRECHECK', '内核已自动重启并重连', { attempt: _restartCount })
      } catch (e) {
        _restarting = false
        if (e instanceof FatalStop) throw e
        throw new FatalStop('BROWSER_CRASHED',
          '自动重启内核失败（第 ' + _restartCount + ' 次）：' + String((e && e.message) || e).slice(0, 200))
      } finally {
        _restarting = false
      }
    },

    /**
     * 打开一个全新的 target（优先），并清理掉超星风控检测页等异常 target。
     * 流程：
     *   1. /json/new?about:blank 建新页
     *   2. 新建失败 → 回退到 /json/list 里挑一个「可探活」的 page
     *   3. 探活 = 发 Page.enable，能回应才算可用（卡死的 renderer 会被丢弃）
     */
    async _openFreshTarget() {
      // 1) 优先新建
      try {
        const t = await cdpHttp('/json/new?about:blank', 'PUT').catch(() => cdpHttp('/json/new?about:blank'));
        if (t && t.webSocketDebuggerUrl) {
          logger.info('PRECHECK', '已新建浏览器 target', { targetId: (t.id || '').slice(0, 12) });
          return t;
        }
      } catch (e) {
        logger.warn('PRECHECK', '新建 target 失败，尝试复用已有 target', { error: e.message });
      }

      // 2) 回退：逐个探活已有 target
      const targets = await cdpHttp('/json/list');
      const candidates = (targets || []).filter((t) => t.type === 'page' && !/^devtools/.test(t.url || ''));
      const detectRe = new RegExp(cfg.detect.urlPattern, 'i');
      for (const t of candidates) {
        const isDetect = detectRe.test(t.url || '');
        if (isDetect) {
          logger.warn('PRECHECK', '发现超星风控检测页 target，跳过', {
            targetId: (t.id || '').slice(0, 12),
            url: (t.url || '').slice(0, 140)
          });
          this._closeTargetQuietly(t.id);
          continue;
        }
        if (!cfg.detect.allowAttachFallback) continue;
        // 探活：卡死的 renderer 不会回应 Page.enable
        const alive = await this._probeTarget(t);
        if (alive) {
          logger.info('PRECHECK', '复用已有 target（探活通过）', { targetId: (t.id || '').slice(0, 12) });
          return t;
        }
        logger.warn('PRECHECK', 'target 无响应（renderer 卡死），丢弃', {
          targetId: (t.id || '').slice(0, 12),
          url: (t.url || '').slice(0, 100)
        });
      }

      throw new FatalStop('CDP_NO_USABLE_TARGET',
        '浏览器中没有可用的标签页（现有 target 全部卡死或为超星风控检测页）。' +
        '请重启浏览器后重试。');
    },

    /** 探活某个 target：发 Page.enable 并等一个短超时 */
    async _probeTarget(t) {
      let conn = null;
      try {
        conn = new CdpConn(t.webSocketDebuggerUrl);
        await conn.connect();
        await conn.send('Page.enable', {}, 6000);
        return true;
      } catch (_) {
        return false;
      } finally {
        try { if (conn) conn.close(); } catch (_) { /* ignore */ }
      }
    },

    /** 静默关闭一个 target（忽略错误） */
    _closeTargetQuietly(targetId) {
      if (!targetId) return;
      try {
        cdpHttp('/json/close/' + targetId).catch(() => {});
      } catch (_) { /* ignore */ }
    },

    /**
     * 给所有请求带上 Referer / Origin。
     *
     * ★ 超星的视频文件放在 cldisk CDN 上，CDN 会校验 Referer（实测）：
     *     裸 curl（无 Referer）            → **403 Forbidden**
     *     带 Referer: https://mooc1.chaoxing.com/ → **206 Partial Content** ✓
     *   而浏览器里 <video> 的媒体请求默认不带 Referer ⇒ 拿不到字节 ⇒
     *   播放器表现为 readyState=0 / buffered=[] / 进度卡住，
     *   点播放按钮完全无效（实测引擎会原地空点 170+ 次）。
     *
     *   实测加头后：readyState 0→4、buffered []→[0-31,357-467]、duration null→955.968、
     *   进度 360→364.9→372.9 正常前进。
     *
     * ★ 必须每次导航后都重新设：跨文档导航会清掉 extra headers。
     */
    async _applyExtraHeaders(connIn) {
      const conn = connIn || (() => { try { return requireConn(); } catch (_) { return null; } })();
      if (!conn) return false;
      try {
        await conn.send('Network.enable');
        /* ★ 2026-10-30：只在**超星域**才加 Referer/Origin。
           实测坑：这两个头是**全局生效**的（Network.setExtraHTTPHeaders 没有按域过滤），
           一旦给非超星页面（本机假课程站、localhost 调试页）也带上
           `Origin: https://mooc1.chaoxing.com`，Chrome 会把跨域顶层导航判成非法请求，
           直接返回 net::ERR_BLOCKED_BY_CLIENT，页面根本打不开。
           真站上不会踩到（本来就同域），所以这个 bug 只在非超星页面暴露。 */
        const cur = await this.getCurrentUrl().catch(() => '');
        const isChaoxing = /chaoxing\.com|cldisk\.com/i.test(String(cur));
        if (!isChaoxing) {
          try { await conn.send('Network.setExtraHTTPHeaders', { headers: {} }) } catch (_) { /* ignore */ }
          return true;
        }
        await conn.send('Network.setExtraHTTPHeaders', {
          headers: {
            Referer: 'https://mooc1.chaoxing.com/',
            Origin: 'https://mooc1.chaoxing.com',
          },
        });
        /* ★ 同时用 Fetch 域拦截**媒体请求**。
           Network.setExtraHTTPHeaders 对 XHR/fetch 生效（实测页面内 fetch 拿到 206），
           但 <video> 的媒体请求不继承它 ⇒ 播放器 readyState=0、缓冲空、进度卡死。
           Fetch 域能拦到媒体请求并显式补 Referer（实测补后 rs=4、buffered 正常、进度前进）。 */
        try {
          await conn.send('Fetch.enable', {
            patterns: [
              { urlPattern: '*cldisk.com*', resourceType: 'Media' },
              { urlPattern: '*cldisk.com*', resourceType: 'XHR' },
            ],
          });
          logger.info('PRECHECK', '已启用 Fetch 域（媒体请求补 Referer）', { pattern: '*cldisk.com*' });
        } catch (e2) {
          logger.warn('PRECHECK', '启用 Fetch 域失败（视频可能仍会 403）', { err: String((e2 && e2.message) || e2).slice(0, 100) });
        }
        return true;
      } catch (e) {
        logger.warn('PRECHECK', '设置请求头失败（视频可能仍会 403）', { err: String((e && e.message) || e).slice(0, 100) });
        return false;
      }
    },

    /**
     * 清掉全局注入的 Referer/Origin。
     *
     * ★ 登录时必须清：_applyExtraHeaders 给所有请求强加
     *   Referer/Origin = https://mooc1.chaoxing.com/（那是给视频 CDN 用的）。
     *   在 passport2 登录页上这是非法跨域头，浏览器加载 `/createqr` 直接
     *   报 net::ERR_INVALID_ARGUMENT（实测），二维码永远是 0x0 破图，
     *   而 getauthstatus 又因为会话对不上一直回 type=2「会话已失效」。
     */
    async clearExtraHeaders() {
      const conn = requireConn();
      try {
        await conn.send('Network.enable');
        await conn.send('Network.setExtraHTTPHeaders', { headers: {} });
        return true;
      } catch (_) { return false; }
    },

    async navigate(url, opts) {
      const conn = requireConn();
      conn.contexts.clear(); // 导航后旧执行上下文全部失效，等待新事件重建映射
      const timeout = (opts && opts.timeoutMs) || cfg.cdp.navTimeoutMs;
      const loaded = conn.waitEvent('Page.loadEventFired', timeout).catch(() => null);
      const res = await conn.send('Page.navigate', { url });
      if (res.errorText) throw new Error('Page.navigate 失败: ' + res.errorText);
      await loaded;
      await sleep(300); // 上下文重建窗口
      // ★ 跨文档导航会清掉 extra headers ⇒ 每次导航后都要重新补 Referer
      await this._applyExtraHeaders();

      // 超星风控检测页自检：多端登录/异常操作时会被重定向到 detect.chaoxing.com，
      // 该页 JS 死循环，renderer 随即不响应任何 CDP 命令。
      const landed = await this.getCurrentUrl().catch(() => '');
      if (this._isDetectUrl(landed)) {
        const msg = await this._readDetectMessage().catch(() => '');
        /* ★ 2026-10-28 主人要求：命中风控不立刻放弃，先等 30 秒再刷新重试，最多 2 次。
           实测：手机端退出登录后，等一会儿刷新通常就能继续。
           重试计数挂在 adapter 上（_detectRetry），整个 run 期间累计，
           避免每节都重置导致「无限重试」。 */
        this._detectRetry = (this._detectRetry || 0) + 1;
        const maxRetries = Number(cfg.detect.maxRetries) || 2;
        const baseWait = Number(cfg.detect.retryWaitMs) || 30000;
        const jitter = Number(cfg.detect.retryJitterMs) || 5000;

        if (this._detectRetry <= maxRetries) {
          const waitMs = baseWait + Math.floor(Math.random() * jitter);
          logger.warn('RISK_CONTROL', '命中超星风控检测页，等待后刷新重试', {
            attempt: this._detectRetry,
            maxRetries,
            waitSeconds: Math.round(waitMs / 1000),
            url: String(landed).slice(0, 160),
            message: String(msg).slice(0, 160),
            hint: '超星判定多端登录/异常学习。建议关闭手机端超星 App 的会话。',
          });
          await sleep(waitMs);
          // 刷新到一个已知安全页（个人空间），避免还停在检测页
          try {
            const safeUrl = 'https://i.chaoxing.com/base';
            const r2 = await conn.send('Page.navigate', { url: safeUrl });
            if (r2 && r2.errorText) throw new Error(String(r2.errorText));
            await conn.waitEvent('Page.loadEventFired', timeout).catch(() => null);
            await sleep(1200);
            await this._applyExtraHeaders();
            const now2 = await this.getCurrentUrl().catch(() => '');
            if (!this._isDetectUrl(now2)) {
              logger.info('RISK_CONTROL', '风控已解除，继续本次流程', {
                attempt: this._detectRetry,
                url: String(now2).slice(0, 140),
              });
              return true;
            }
            logger.warn('RISK_CONTROL', '刷新后仍在风控页，将再试一次', {
              attempt: this._detectRetry,
              url: String(now2).slice(0, 140),
            });
            // 递归一次，让上层重试逻辑接管（受 maxRetries 约束）
            return await this.navigate(url, opts);
          } catch (e) {
            logger.warn('RISK_CONTROL', '风控刷新重试时出错', {
              attempt: this._detectRetry,
              err: String((e && e.message) || e).slice(0, 120),
            });
          }
        }

        /* 重试用尽：明确写清原因后停止 */
        const attemptsUsed = Math.min(this._detectRetry, maxRetries + 1);
        logger.error('RISK_CONTROL', '风控重试已达上限，停止运行', {
          attempts: attemptsUsed,
          maxRetries,
          url: String(landed).slice(0, 200),
          message: String(msg).slice(0, 200),
          reason:
            '超星判定「多终端登录 / 异常学习」，页面被重定向到 detect.chaoxing.com 检测页。'
            + ' 已按策略等待 30 秒并刷新重试 ' + maxRetries + ' 次，仍未解除。'
            + ' 处理办法：① 手机端「学习通」App 完全退出登录（或杀掉进程）；'
            + '② 确认没有其他电脑/浏览器同时登录同一账号；'
            + '③ 等待 10-30 分钟后再运行。',
        });
        throw new FatalStop('RISK_CONTROL_DETECTED',
          '超星风控未解除（已重试 ' + maxRetries + ' 次）：多终端登录或异常学习判定。'
          + (msg ? ' 平台提示：' + String(msg).slice(0, 120) : '')
          + ' 请退出手机端学习通 App 后，等待 10-30 分钟再试。');
      }
      // 走到这里说明导航成功且未命中风控；重置重试计数，供下次独立事件使用
      this._detectRetry = 0;
      return true;
    },

    /** 判断 URL 是否为超星风控检测页 */
    _isDetectUrl(u) {
      try { return new RegExp(cfg.detect.urlPattern, 'i').test(String(u || '')); }
      catch (_) { return false; }
    },

    /** 尽力读取检测页上的异常提示文本（读不到就算了） */
    async _readDetectMessage() {
      try {
        const r = await this.evalInFrame(null,
          'document.body ? (document.body.innerText || document.title || "") : ""');
        const s = String(r && r.value !== undefined ? r.value : r || '');
        const m = s.match(new RegExp('[^。\\n]{0,60}(' + cfg.detect.messagePattern + ')[^。\\n]{0,80}'));
        return m ? m[0] : s.slice(0, 200);
      } catch (_) { return ''; }
    },

    /**
     * 切换引擎当前操作的 target（用于「点课程卡片 → 新标签页打开」的场景）。
     * 关闭旧连接、附着到新 target、重建上下文映射。
     */
    async attachTarget(targetId) {
      if (!targetId) throw new Error('attachTarget: 缺少 targetId');
      try { if (_conn) { try { _conn.close() } catch (_) {} } } catch (_) { /* ignore */ }
      _conn = null; _targetId = null;
      const list = await cdpHttp('/json/list');
      const t = (list || []).find((x) => x.id === targetId);
      if (!t || !t.webSocketDebuggerUrl) throw new Error('attachTarget: target 不存在 ' + targetId);
      const conn = new CdpConn(t.webSocketDebuggerUrl);
      await conn.connect();
      const attached = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      conn.sessionId = attached.sessionId;
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      try {
        const tree = await conn.send('Page.getFrameTree');
        conn.topFrameId = tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
      } catch (_) { conn.topFrameId = null; }
      await sleep(400);
      _conn = conn;
      _targetId = targetId;
      logger.info('PRECHECK', '已切换到新 target', {
        targetId: String(targetId).slice(0, 12),
        url: String(t.url || '').slice(0, 100),
      });
      return { engine: 'cdp', targetId };
    },

    async getFrameDocuments() {
      const conn = requireConn();
      const tree = await conn.send('Page.getFrameTree');
      const out = [];
      const walk = (node, depth) => {
        if (!node) return;
        if (node.frame) {
          out.push({
            frameId: node.frame.id,
            url: node.frame.url || '',
            isTop: depth === 0,
            depth,
            name: node.frame.name || '',
          });
        }
        (node.childFrames || []).forEach((c) => walk(c, depth + 1));
      };
      walk(tree.frameTree, 0);
      return out;
    },

    /**
     * ★ 跨域 frame 求值：为指定 frame 建一个 isolated world 再求值。
     *
     * 为什么需要：mooc2-ans 新版课程页把章节树/任务点放在**跨域 iframe** 里
     * （mooc2-ans.chaoxing.com ← → studentcourse / knowledge/cards），
     * 顶层 JS 读不到 contentDocument，而 Runtime.evaluate 用默认 contextId
     * 只会落在顶层。Page.createIsolatedWorld 能给任意 frame 造一个独立
     * 执行上下文，绕开同源限制（CDP 特权）。
     *
     * 只读用途：仅用于读取页面结构，不点击、不提交。
     */
    async evalInFrameCross(frameId, expression) {
      const conn = requireConn();
      let world;
      try {
        world = await conn.send('Page.createIsolatedWorld', {
          frameId,
          worldName: 'cx-probe-' + Math.random().toString(36).slice(2, 8),
          grantUniveralAccess: true,
        });
      } catch (e) {
        return { ok: false, error: 'isolatedWorld: ' + String((e && e.message) || e).slice(0, 120) };
      }
      const ctxId = world && world.executionContextId;
      if (!ctxId) return { ok: false, error: 'no executionContextId' };
      try {
        const res = await conn.send('Runtime.evaluate', {
          contextId: ctxId,
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (res && res.exceptionDetails) {
          return { ok: false, error: 'eval: ' + String((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || '').slice(0, 150) };
        }
        return { ok: true, value: res && res.result ? res.result.value : undefined };
      } catch (e) {
        return { ok: false, error: 'evaluate: ' + String((e && e.message) || e).slice(0, 120) };
      }
    },

    /**
     * 取某个 frame 到顶层 frame 的**祖先链**（root 在前，target 在后）。
     * 用于跨 frame 的坐标换算（截图裁剪必须换算到顶层文档坐标）。
     */
    async getFrameChain(targetFrameId) {
      const conn = requireConn();
      const tree = await conn.send('Page.getFrameTree');
      const par = {};
      (function walk(n, p) {
        if (!n) return;
        if (n.frame) par[n.frame.id] = p;
        (n.childFrames || []).forEach(c => walk(c, n.frame ? n.frame.id : p));
      })(tree.frameTree, null);
      const chain = [];
      let cur = targetFrameId;
      while (cur) { chain.unshift(cur); cur = par[cur]; }
      return chain;
    },

    /**
     * 目标 frame 的**视口原点在顶层文档里的偏移**（逐层累加）。
     *
     * 公式（实测唯一正确形式）：
     *   对链上每一层 child ← parent：
     *     R = child.frameElement.getBoundingClientRect()   （在 parent 的视口坐标）
     *     s = parent 的 scrollX/scrollY
     *     累加 (R + s)
     *   得到的是 child 视口原点在**顶层文档**里的坐标。
     *
     * 为什么每层都要加 parent 的滚动量：R 是视口坐标，
     * 视口坐标 + 滚动量 才是 parent 的文档坐标；两层一相加，
     * 中间层的内容滚动就被正确折算进来（只加顶层滚动量会让整块区域错位）。
     *
     * 注意 R 必须在 **child 上下文**里取（child.frameElement 属于 parent 文档），
     * parent 的滚动量必须在 **parent 上下文**里取（跨源读不到 window.parent.scrollY）。
     */
    async frameOrigin(chain) {
      let ox = 0, oy = 0;
      const parts = [];
      for (let i = 1; i < chain.length; i++) {
        const childId = chain[i], parentId = chain[i - 1];
        let R = null;
        try {
          R = await this.evalInFrame(childId,
            '(() => { try { const fe = window.frameElement; if (!fe) return null; const b = fe.getBoundingClientRect(); return { x: b.x, y: b.y }; } catch (e) { return null; } })()');
        } catch (e) { R = null; }
        if (!R || typeof R.x !== 'number') { parts.push('null'); continue; }
        let s = { x: 0, y: 0 };
        try { s = await this.evalInFrame(parentId, '({ x: window.scrollX || 0, y: window.scrollY || 0 })'); } catch (e) { /* 读不到就按 0 */ }
        ox += R.x + (s.x || 0);
        oy += R.y + (s.y || 0);
        parts.push('+' + Math.round(R.x + (s.x || 0)) + ',' + Math.round(R.y + (s.y || 0)));
      }
      return { ox: ox, oy: oy, parts: parts };
    },

    /** 顶层视口尺寸与滚动量 */
    async rootViewport() {
      const conn = requireConn();
      try {
        const v = await this.evalInFrame(conn.topFrameId,
          '({ w: window.innerWidth, h: window.innerHeight, sx: window.scrollX || 0, sy: window.scrollY || 0 })');
        if (v && v.h) return v;
      } catch (e) { /* ignore */ }
      return { w: 1440, h: 900, sx: 0, sy: 0 };
    },

    /** 把顶层页面滚到指定位置（截图裁剪区必须落在顶层视口内） */
    async scrollRootTo(y) {
      const conn = requireConn();
      try {
        await this.evalInFrame(conn.topFrameId, 'window.scrollTo(0, ' + Math.max(0, Math.round(y)) + ')');
        return true;
      } catch (e) { return false; }
    },

    async evalInFrame(frameId, expression, opts) {
      const conn = requireConn();
      const params = { expression, returnByValue: true, awaitPromise: !(opts && opts.awaitPromise === false), userGesture: true };
      if (frameId) {
        const arr = conn.contexts.get(frameId);
        if (arr && arr.length) params.contextId = arr[arr.length - 1];
        else if (frameId !== conn.topFrameId) throw new Error('frame 执行上下文未就绪: ' + frameId);
        // 顶层 frame 无独立上下文事件时，缺省上下文即顶层主世界，直接求值
      }
      const res = await conn.send('Runtime.evaluate', params);
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error('页面执行异常: ' + String((d.exception && d.exception.description) || d.text || 'unknown').slice(0, 200));
      }
      return res.result ? res.result.value : undefined;
    },

    async click(frameId, rect) {
      const conn = requireConn();
      if (!rect || !(rect.w > 0 && rect.h > 0)) throw new Error('无效矩形: ' + JSON.stringify(rect));
      const x = rect.x + rect.w / 2, y = rect.y + rect.h / 2;
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(60 + Math.floor(Math.random() * 90)); // 按下-抬起微抖动（协议层，非业务节奏）
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      return { mode: 'cdp-input' };
    },

    async jsClick(frameId, kind, arg) {
      return adapter.evalInFrame(frameId, '__cx.jsClick(' + JSON.stringify(kind) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')');
    },

    async getText(frameId, expression) {
      const v = await adapter.evalInFrame(frameId, expression || 'document.body ? document.body.innerText.slice(0, 400) : \'\'');
      return typeof v === 'string' ? v : JSON.stringify(v);
    },

    async isVideoEnded(frameId) {
      const v = await adapter.evalInFrame(frameId, '__cx.videoState()');
      if (!v || !v.found) return { found: false, ended: false };
      return { found: true, ended: !!v.ended || (v.progress || 0) >= cfg.video.progressDoneRatio, raw: v };
    },

    async getCurrentUrl() {
      if (!_conn) return '';
      try {
        const t = await _conn.send('Page.getFrameTree');
        return (t.frameTree && t.frameTree.frame && t.frameTree.frame.url) || '';
      } catch (_) { return ''; }
    },

    /**
     * 读出浏览器里所有 cookie（用于判断「是否真的已登录」）。
     *
     * ★ 2026-10-29：为什么需要它 ——
     * Chrome/Edge 的密码管理器会自动填好超星登录页的账号密码框，
     * 页面看起来「像已登录」，但 URL 仍是 passport2 登录页、服务端并未认证。
     * 只看 URL 会把这个假象当成已登录，导致扫码流程被跳过、后面全部失败。
     * 真实判据是 UID / _uid 这些认证 cookie 是否存在。
     *
     * Network.getAllCookies 不传 domain 即返回全部域的 cookie。
     * 失败返回 null（调用方当作「无法判断」，不作为否决依据）。
     */
    async getAllCookies() {
      if (!_conn) return null;
      try {
        const r = await _conn.send('Network.getAllCookies');
        return (r && Array.isArray(r.cookies)) ? r.cookies : null;
      } catch (_) { return null; }
    },

    /** 全页截图（登录扫码取证/失败诊断现场）。写文件并返回 base64。 */
    async screenshot(filePath) {
      if (!_conn) throw new Error('CDP 未连接，无法截图');
      const shot = await _conn.send('Page.captureScreenshot', { format: 'png' });
      const b64 = shot && shot.data || '';
      if (filePath && b64) fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
      return b64;
    },

    /**
     * 按**顶层文档坐标**裁剪截图（返回 base64 PNG，不写文件）。
     *
     * 超星的题干/选项用加密字体渲染，DOM 里读出来是密文，
     * 只有把这一块区域**渲染出来**给视觉模型看，才能拿到明文。
     *
     * 注意 captureBeyondViewport 必须为 false：
     *   置 true 时 Chrome 会为渲染「视口以外的内容」而重排整页，
     *   页面里的 sticky/fixed 元素会被重新画到裁剪区顶部
     *   （实测多出一条无关的章节蓝条，题干也被顶掉）。
     *   置 false 则严格按当前视口渲染，代价是裁剪区必须落在视口内
     *   —— 由调用方（ensureDocRectVisible）先把顶层页面滚到位。
     *
     * @param {{x:number,y:number,w:number,h:number}} rect 顶层文档 CSS 像素坐标
     * @returns {Promise<string>} base64 PNG
     */
    async screenshotClip(rect) {
      if (!_conn) throw new Error('CDP 未连接，无法截图');
      if (!rect || !(rect.w > 0 && rect.h > 0)) throw new Error('无效截图矩形: ' + JSON.stringify(rect));
      const clip = {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.w)),
        height: Math.max(1, Math.round(rect.h)),
        scale: 1,
      };
      const shot = await _conn.send('Page.captureScreenshot', {
        format: 'png', clip, captureBeyondViewport: false,
      });
      return (shot && shot.data) || '';
    }
  };
  return adapter;
}

module.exports = {
  createCdpAdapter
};
