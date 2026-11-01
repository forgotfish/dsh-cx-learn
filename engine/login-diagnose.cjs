#!/usr/bin/env node
/* ============================================================================
 * login-diagnose.cjs — 扫码登录只读诊断（不修改任何状态）
 * ============================================================================
 * 目的：把「页面上显示的二维码」「页面隐藏域里的 uuid/enc」「状态接口返回」
 *       三者对齐，一次性看清到底是哪一环断了。
 *
 * 背景（2026-10-30）：登录长期失败，日志里 442 次 type=3、0 次 status=true。
 * 已确认的线索：
 *   · /mlogin 页面**没有** enc 字段，只有 /login?fid=&newversion=true 才有
 *   · 拿刚生成的 uuid+enc 去查 /getauthstatus，立刻返回 type=2「二维码已失效」
 *   · type=3 的 mes 是「未登录」，不是「已扫码」—— 代码把它当已扫是误判
 *   · type=4 的 mes 是「已扫码」+ nickname，才是真的扫上了
 *
 * 本脚本不改登录代码，只输出事实，用于决定重写方向。
 *
 * 用法（远端）：
 *   sudo -u fn-deepseek-harness node login-diagnose.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const E = require('./chaoxing-autolearn.js');

const OUT = [];
function say(s) { OUT.push(s); console.log(s) }

async function evalIn(adapter, frameId, expr) {
  try { return await adapter.evalInFrame(frameId, expr) } catch (e) { return { __err: String(e && e.message || e) } }
}

(async () => {
  const cfg = E.mergeConfig(E.CONFIG, {
    chromium: { profileDir: '/tmp/cx-login-diag/profile', headless: true },
    cdp: { port: 0 },
    login: { ephemeral: false, shotDir: '/tmp/cx-login-diag/shots' },
  });

  /* 用两个 URL 各开一次，对比哪一边才有完整 uuid/enc */
  const urls = [
    ['A: /login?newversion=true（当前代码用的）', 'https://passport2.chaoxing.com/login?newversion=true'],
    ['B: /login?fid=&newversion=true&refer=i.chaoxing', 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com'],
    ['C: /mlogin?fid=&newversion=true', 'https://passport2.chaoxing.com/mlogin?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com'],
  ];

  for (const [label, url] of urls) {
    say('\n========================================');
    say(label);
    say(url);
    say('========================================');

    const adapter = E.createCdpAdapter(cfg);
    try {
      await adapter.ensureBrowser();
      await adapter.navigate(url);
      await new Promise((r) => setTimeout(r, 3500));

      const top = await adapter.getCurrentUrl().catch(() => '');
      say('落地 URL: ' + String(top).slice(0, 140));

      const frames = await adapter.getFrameDocuments();
      say('frame 数: ' + frames.length);

      let best = null;
      for (const f of frames) {
        const v = await evalIn(adapter, f.frameId, `(() => {
          const u = document.getElementById('uuid');
          const e = document.getElementById('enc');
          const img = document.querySelector('#quickCode') || document.querySelector('img[src*="createqr"]');
          const q = document.getElementById('quickCode');
          return JSON.stringify({
            uuid: u ? String(u.value || '') : '',
            enc: e ? String(e.value || '') : '',
            imgSrc: img ? String(img.getAttribute('src') || '') : '',
            imgW: q ? q.naturalWidth : (img ? img.naturalWidth : 0),
            imgH: q ? q.naturalHeight : (img ? img.naturalHeight : 0),
          });
        })()`);
        let o = null;
        try { o = JSON.parse(v) } catch (_) { o = null }
        if (o && (o.uuid || o.enc || o.imgSrc)) {
          say('  frame ' + (f.isTop ? '(top)' : '') + ' ' + String(f.url || '').slice(0, 80));
          say('    uuid=' + (o.uuid || '（空）'));
          say('    enc =' + (o.enc || '（空）'));
          say('    图  =' + String(o.imgSrc).slice(0, 90) + '  ' + o.imgW + 'x' + o.imgH);
          if (o.uuid && o.enc) best = { ...o, frameId: f.frameId };
          else if (!best && o.uuid) best = { ...o, frameId: f.frameId };
        }
      }

      if (!best) {
        say('  ✗ 页面里找不到 uuid/enc（这条 URL 不适合做扫码登录）');
        continue;
      }

      /* 关键：直接用页面里的 fetch 查状态（同域、带 cookie、走页面自己的会话） */
      say('  --- 页面内查状态（模拟页面 JS）---');
      const st = await evalIn(adapter, best.frameId, `(async () => {
        const uuid = ${JSON.stringify(best.uuid)};
        const enc  = ${JSON.stringify(best.enc)};
        const out = {};
        for (const api of ['/getauthstatus', '/getauthstatus/v2']) {
          try {
            const r = await fetch(api, {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              body: 'enc=' + encodeURIComponent(enc) + '&uuid=' + encodeURIComponent(uuid),
            });
            out[api] = r.status + ' ' + (await r.text()).slice(0, 160);
          } catch (e) { out[api] = 'ERR ' + String(e && e.message || e); }
        }
        /* 顺带确认 cookie 里有没有 JSESSIONID（纯 HTTP 抓不到它的原因） */
        out.cookieHasJSESSION = /JSESSIONID/.test(document.cookie);
        out.cookieKeys = document.cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean).join(',');
        return JSON.stringify(out);
      })()`);
      say('  ' + String(st));

      /* 隔 3 秒再查一次，看 type 是否稳定 */
      await new Promise((r) => setTimeout(r, 3000));
      const st2 = await evalIn(adapter, best.frameId, `(async () => {
        const r = await fetch('/getauthstatus', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: 'enc=' + encodeURIComponent(${JSON.stringify(best.enc)}) + '&uuid=' + encodeURIComponent(${JSON.stringify(best.uuid)}),
        });
        return await r.text();
      })()`);
      say('  3 秒后: ' + String(st2));

      say('  ✓ 诊断数据已采集');
    } catch (e) {
      say('  ✗ 异常: ' + String(e && e.message || e).slice(0, 200));
    } finally {
      try { await adapter.shutdown() } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  say('\n\n===== 结论速查 =====');
  say('· 哪条 URL 里 uuid 和 enc 都非空 → 它才是扫码登录该用的入口');
  say('· cookieHasJSESSION=true 说明会话在浏览器里，纯 HTTP 拿不到');
  say('· /getauthstatus 若返回 type=2 而码刚生成 → 会话与码不同源');
  say('· type=3 的 mes 应是「未登录」；type=4 才是「已扫码」');

  fs.writeFileSync('/tmp/cx-login-diag/report.txt', OUT.join('\n'), 'utf8');
  process.exit(0);
})().catch((e) => {
  console.error('诊断失败: ' + (e && e.stack || e));
  process.exit(1);
});
