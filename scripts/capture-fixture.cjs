#!/usr/bin/env node
/* ============================================================================
 * capture-fixture.cjs — 把真实页面的 DOM 存成 fixture（离线回归基准）
 * ============================================================================
 *
 * 【为什么需要】
 *   SPEC §9.3：改选择器必须同时更新真实 DOM 样本，跑 check-selectors 绿了才允许提交。
 *   没有样本时，改选择器只能靠「读代码猜」—— 这个项目历史上因此错了至少三次
 *   （.posCatalog_select 判过时、type=3 语义、catalog_jindu 口径）。
 *
 * 【安全边界】
 *   · 只读：只 dump HTML，不点击、不播放、不答题、不填表
 *   · **引擎在跑时拒绝执行**：并行连同一个浏览器会把引擎的 CDP 调用拖到超时
 *     （文档记载过：并行 probe 把引擎逼成 3/3 FATAL）
 *   · 输出做脱敏：URL 里的 enc/cpi/uuid 打成 ***，避免 fixture 泄授权参数
 *
 * 【用法】
 *   node scripts/capture-fixture.cjs --name=course-section
 *   node scripts/capture-fixture.cjs --name=xxx --port=12345
 *
 * 输出：docs/fixtures/<name>.json
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'docs', 'fixtures');
const PROFILE = path.join(os.tmpdir(), 'cx-learn-ephemeral', 'session');

function argOf(k, d) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
}

/** 引擎是否在跑（并行探测会拖垮它，必须拒绝） */
function engineRunning() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing-autolearn*' } | Measure-Object).Count",
      ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      return Number(String(out).trim()) > 0;
    } catch { return false }
  }
  try {
    const out = execFileSync('pgrep', ['-fc', 'chaoxing-autolearn'], { encoding: 'utf8', timeout: 5000 });
    return Number(String(out).trim()) > 0;
  } catch { return false }
}

function readPort() {
  const explicit = Number(argOf('port', ''));
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  try {
    return Number(String(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim());
  } catch { return 0 }
}

/** URL 脱敏：enc / cpi / openc / uuid 一律打码 */
function redactUrl(u) {
  return String(u || '').replace(/([?&](?:enc|cpi|openc|uuid|_uid|uf|vc3|token)=)([^&#\s"']*)/gi, '$1***');
}

/**
 * HTML 正文脱敏。
 *
 * ★ 只脱帧 URL 是不够的 —— 正文里到处是带 enc/cpi 的 href、script 变量、
 *   iframe src。第一次抓完 fixture 就发现 `enc=xxxx` 还在，属于真泄漏。
 *   这里把「参数名=值」的值打掉，参数名保留（排查时看得出脱了什么）。
 */
function redactHtml(html) {
  return String(html || '')
    /* ★ 不能只匹配 `?enc=` / `&enc=`：HTML 里 & 会被转义成 &amp;，
       实测第一版就是这么漏的。改成「参数名前面不是字母数字」即可，
       同时兼容 ? & &amp; 换行与引号。 */
    .replace(/((?<![A-Za-z0-9_])(?:enc|cpi|openc|uuid|_uid|uf|vc3)=)([A-Za-z0-9%._-]{4,})/gi, '$1***')
    /* JS 里常见的 "enc":"xxx" / url:'...' 形态 */
    .replace(/(((?<![A-Za-z0-9_])(?:enc|cpi|openc|uuid))\s*[:=]\s*['"])([^'"]{6,})(['"])/gi, '$1***$4');
}

/* ── 极简 CDP 客户端（只做本脚本需要的几件事）────────────────────────── */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map(); this.events = [] }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connect timeout')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve() };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) j(new Error(JSON.stringify(msg.error).slice(0, 200)));
          else r(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
          if (this.events.length > 500) this.events.shift();
        }
      };
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')) }, timeoutMs || 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      });
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
    });
  }
  close() { try { this.ws.close() } catch {} }
}

/** 在某个 frame 的上下文里求值（用 createIsolatedWorld 拿 contextId） */
async function evalInFrame(cdp, frameId, expression) {
  const w = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: '__cx_fixture' });
  const r = await cdp.send('Runtime.evaluate', {
    expression, contextId: w.executionContextId, returnByValue: true, awaitPromise: false,
  }, 20000);
  if (r && r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 160));
  return r && r.result ? r.result.value : undefined;
}

async function main() {
  const name = String(argOf('name', '')).trim();
  if (!name) { console.log('用法：node scripts/capture-fixture.cjs --name=<名称>'); return 2 }
  if (!/^[a-z0-9_-]+$/i.test(name)) { console.log('name 只允许字母数字下划线短横'); return 2 }

  if (engineRunning()) {
    console.log('✗ 引擎正在跑（chaoxing-autolearn 进程存在）。');
    console.log('  并行连同一个浏览器会把引擎的 CDP 调用拖到超时，历史上有过 3/3 FATAL。');
    console.log('  先等它跑完再取证。');
    return 3;
  }

  const port = readPort();
  if (!port) { console.log('✗ 找不到调试端口（浏览器没起）'); return 2 }

  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const pages = list.filter((t) => t.type === 'page' && !/^(devtools|edge:|chrome:)/.test(t.url || ''));
  if (!pages.length) { console.log('✗ 没有可用的 page target'); return 2 }

  /* 优先选学习通课程页；没有就选第一个非空白页 */
  const target = pages.find((t) => /chaoxing\.com/.test(t.url || '')) || pages[0];
  console.log('目标页面：' + redactUrl(target.url).slice(0, 120));

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    await cdp.send('Page.enable');
    const tree = await cdp.send('Page.getFrameTree');
    const frames = [];
    const walk = async (node, depth) => {
      const f = node.frame;
      if (f && !/^(devtools|edge:|chrome-extension:)/.test(f.url || '')) {
        frames.push({ frameId: f.id, url: redactUrl(f.url), depth });
      }
      for (const c of (node.childFrames || [])) await walk(c, depth + 1);
    };
    await walk(tree.frameTree, 0);

    const out = [];
    for (const f of frames) {
      let html = '';
      let note = '';
      try {
        html = String(await evalInFrame(cdp, f.frameId,
          '(document.documentElement ? document.documentElement.outerHTML : "")') || '');
      } catch (e) {
        note = String((e && e.message) || e).slice(0, 120);
      }
      const safeHtml = redactHtml(html);
      out.push({
        url: f.url,
        depth: f.depth,
        bytes: safeHtml.length,
        note,
        html: safeHtml.slice(0, 400000),   // 单帧上限 400KB，防止 fixture 爆炸
      });
    }

    const fixture = {
      name,
      capturedAt: new Date().toISOString(),
      source: 'scripts/capture-fixture.cjs',
      note: '真实页面 DOM 快照。URL 已脱敏（enc/cpi/uuid → ***）。仅供离线选择器回归，不含任何凭据。',
      /* ★ 这里也要脱敏：第一版漏了，导致 fixture 顶部就带着完整 enc/cpi */
      browser: redactUrl(String((list[0] && list[0].url) || '')),
      frameCount: out.length,
      frames: out,
    };

    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const file = path.join(FIXTURE_DIR, name + '.json');
    fs.writeFileSync(file, JSON.stringify(fixture, null, 1), 'utf8');
    console.log('\n已保存：' + path.relative(ROOT, file));
    console.log('  帧数：' + out.length + '  总字节：' + out.reduce((a, f) => a + f.bytes, 0));
    for (const f of out) {
      console.log('    [' + f.depth + '] ' + (f.bytes + 'B').padStart(8) + '  ' + f.url.slice(0, 90) + (f.note ? '  ← ' + f.note : ''));
    }
    return 0;
  } finally {
    cdp.close();
  }
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('取证失败：' + ((e && e.stack) || e));
  process.exit(2);
});
