#!/usr/bin/env node
/* ============================================================================
 * chaos-api.mjs —— dsh-cx-learn 插件的破坏性测试（本地集成，手动运行）
 * ============================================================================
 *
 * 这不是单元测试：它会**真的**改写插件状态目录（state.json / session.json /
 * config.json / .login/result.json）并反复打 HTTP 接口，用来看「脏数据下界面还
 * 能不能活」。所以：
 *   · 文件名不是 *.test.cjs —— 默认测试套件（Get-ChildItem -Filter *.test.cjs）不会带上它
 *   · 跑之前会自动备份，跑完自动还原；备份目录保留以便翻查
 *
 * 用法：
 *   node scripts/chaos-api.mjs                       # 默认 http://127.0.0.1:64294
 *   node scripts/chaos-api.mjs --base=http://127.0.0.1:3290
 *   node scripts/chaos-api.mjs --keep                # 跑完不还原（取证用）
 *
 * 判据：任何一项「500 / 非 JSON / 接口挂起」都算失败。
 * ==========================================================================*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const KEEP = process.argv.includes('--keep');
const BASE = (argOf('base', 'http://127.0.0.1:64294') + '/api/cx-learn').replace(/\/+$/, '');

const results = [];
const rec = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + ' :: ' + detail);
};

async function api(method, p, body, timeoutMs = 20000) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const out = { code: 0, body: '', ms: 0, err: '' };
  try {
    const res = await fetch(BASE + p, {
      method,
      signal: ac.signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    out.code = res.status;
    out.body = await res.text();
  } catch (e) {
    out.code = -1;
    out.err = String((e && e.message) || e);
  } finally {
    clearTimeout(timer);
    out.ms = Date.now() - t0;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---- 0. 定位状态目录（从 /status.home 推：\tmp\cx-learn → C:\tmp\cx-learn） ---- */
  const boot = await api('GET', '/status');
  if (boot.code !== 200) {
    console.error('✗ 插件不可达：' + BASE + '（code=' + boot.code + ' ' + boot.err + '）');
    process.exit(2);
  }
  let home = '';
  try { home = JSON.parse(boot.body).home || ''; } catch { /* ignore */ }
  const stateDir = argOf('state', '') || (home ? path.normalize(home.replace(/^[\\/]+/, (m) => m).replace(/^\\(?=[A-Za-z]:)/, '')) : '');
  const DIR = stateDir && fs.existsSync(stateDir) ? stateDir : 'C:\\tmp\\cx-learn';
  console.log('base=' + BASE + '\nstateDir=' + DIR);

  const BK = path.join(os.tmpdir(), 'cx-learn-chaos-' + Date.now());
  fs.mkdirSync(BK, { recursive: true });
  for (const f of ['state.json', 'session.json', 'config.json']) {
    const s = path.join(DIR, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(BK, f));
  }
  console.log('backup -> ' + BK);

  const W = (f, c) => fs.writeFileSync(path.join(DIR, f), c, 'utf8');
  const restore = () => {
    for (const f of ['state.json', 'session.json', 'config.json']) {
      const b = path.join(BK, f);
      const d = path.join(DIR, f);
      if (fs.existsSync(b)) fs.copyFileSync(b, d);
      else { try { fs.unlinkSync(d) } catch { /* ignore */ } }
    }
    try { fs.unlinkSync(path.join(DIR, 'browser.json')) } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(DIR, '.login', 'result.json')) } catch { /* ignore */ }
  };
  const jok = (s) => { try { JSON.parse(s); return true } catch { return false } };

  /* ---- A. state.json 坏值：必须 200 + 可解析 ---- */
  console.log('\n=== A. state.json 各种坏值 -> /status 必须 200 且可解析 ===');
  for (const [name, content] of [
    ['非法 JSON', '{ this is not json'],
    ['空文件', ''],
    ['null', 'null'],
    ['数组', '[]'],
    ['字符串', '"hello"'],
    ['pid:"abc"', '{"pid":"abc"}'],
    ['pid:-5', '{"pid":-5}'],
    ['pid:999999999', '{"pid":999999999}'],
  ]) {
    W('state.json', content);
    const r = await api('GET', '/status');
    rec('A/' + name, r.code === 200 && jok(r.body), 'code=' + r.code + ' ms=' + r.ms + (r.err ? ' err=' + r.err : ''));
    restore();
  }

  /* ---- B. 假 pid：活着的无关进程不许判成在跑 ---- */
  console.log('\n=== B. state.pid 指向活着的无关进程（本进程）===')
  W('state.json', JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const rb = await api('GET', '/status');
  let running = null; try { running = JSON.parse(rb.body).running } catch { /* ignore */ }
  rec('B//status 不误判 running', running === false, 'running=' + running + '（期望 false）');
  const rh = await api('GET', '/health');
  let trun = null; try { trun = JSON.parse(rh.body).task.running } catch { /* ignore */ }
  rec('B//health 不误判 running', trun === false, 'task.running=' + trun + '（期望 false）');
  restore();

  /* ---- C. session / browser / login-result 损坏 ---- */
  console.log('\n=== C. session.json / browser.json / .login/result.json 损坏 ===');
  W('session.json', '{ broken');
  const c1 = await api('GET', '/status');
  const c2 = await api('GET', '/login-state');
  rec('C/session.json 坏 -> /status 200', c1.code === 200, 'code=' + c1.code);
  rec('C/session.json 坏 -> /login-state 200', c2.code === 200, 'code=' + c2.code);
  restore();

  W('browser.json', '{ broken');
  const c3 = await api('GET', '/status');
  const c4 = await api('GET', '/health');
  rec('C/browser.json 坏 -> /status 200', c3.code === 200, 'code=' + c3.code);
  rec('C/browser.json 坏 -> /health 200', c4.code === 200, 'code=' + c4.code);
  restore();

  fs.mkdirSync(path.join(DIR, '.login'), { recursive: true });
  W(path.join('.login', 'result.json'), '{ broken');
  const c5 = await api('GET', '/login-state');
  rec('C/.login/result.json 坏 -> /login-state 200', c5.code === 200, 'code=' + c5.code);
  restore();

  /* ---- D. config 损坏 / 非法值 ---- */
  console.log('\n=== D. config.json 损坏与非法值 ===');
  W('config.json', 'not json at all');
  const d1 = await api('GET', '/status');
  const d2 = await api('GET', '/config');
  rec('D/config 坏 -> /status 200', d1.code === 200, 'code=' + d1.code);
  rec('D/config 坏 -> /config 200', d2.code === 200, 'code=' + d2.code);
  restore();

  W('config.json', JSON.stringify({ maxSections: 'abc', mode: 'garbage_mode', videoDoneAt: 9999, chapterQuiz: 'weird', ai: { batchSize: -3, timeoutMs: 'x' } }));
  const d3 = await api('GET', '/status');
  rec('D/config 非法值 -> /status 200', d3.code === 200, 'code=' + d3.code);
  const d4 = await api('POST', '/config', { mode: 'continue_chapters' });
  rec('D/config 非法值下仍可 POST 修复', d4.code === 200, 'code=' + d4.code);
  restore();

  /* ---- E. 空操作接口（不该 500） ---- */
  console.log('\n=== E. 空操作/边界接口 ===');
  /* /session/end 会**真的删掉**一次性登录 profile（不可还原），默认跳过；加 --unsafe 才跑 */
  const unsafe = process.argv.includes('--unsafe');
  const eps = ['/stop', '/browser/restart', '/qr/refresh'];
  if (unsafe) eps.push('/session/end');
  for (const p of eps) {
    const r = await api('POST', p, {});
    rec('E/' + p, r.code < 500, 'code=' + r.code + ' body=' + r.body.slice(0, 70));
  }
  if (!unsafe) console.log('  (跳过 /session/end：会删登录 profile；需要时加 --unsafe)');
  const e1 = await api('POST', '/questions/__nope__/draft', {});
  rec('E/题目草稿 不存在 id', e1.code < 500, 'code=' + e1.code);
  const e2 = await api('GET', '/log?lines=abc');
  rec('E//log?lines=abc', e2.code === 200, 'code=' + e2.code);
  const e3 = await api('GET', '/log?lines=999999');
  rec('E//log?lines=999999', e3.code === 200, 'code=' + e3.code + ' len=' + e3.body.length);
  const e4 = await api('GET', '/__nope__');
  rec('E/未知路由 -> 404', e4.code === 404, 'code=' + e4.code);

  /* ---- F. 连打（稳定性 / 时延） ---- */
  console.log('\n=== F. 连打 20 次 ===');
  for (const ep of ['/status', '/health']) {
    let bad = 0, maxMs = 0;
    for (let i = 0; i < 20; i++) {
      const r = await api('GET', ep, undefined, 10000);
      if (r.code !== 200) bad++;
      if (r.ms > maxMs) maxMs = r.ms;
    }
    rec('F/20x ' + ep, bad === 0, 'bad=' + bad + ' maxMs=' + maxMs);
  }

  /* ---- G. 没配课程地址就 start（应干净报错） ---- */
  console.log('\n=== G. 空课程地址 start ===');
  W('config.json', JSON.stringify({ courseUrl: '' }));
  const g1 = await api('POST', '/start', {}, 30000);
  rec('G/空课程地址 start 不 500', g1.code < 500, 'code=' + g1.code + ' body=' + g1.body.slice(0, 90));
  await sleep(500);
  restore();

  /* ---- 收尾 ---- */
  if (!KEEP) { restore(); console.log('\n已还原现场（备份保留在 ' + BK + '）'); }
  else { console.log('\n--keep：未还原，备份在 ' + BK); }
  const after = await api('GET', '/status');
  rec('Z/测试后 /status 正常', after.code === 200, 'code=' + after.code);

  const fails = results.filter((r) => !r.pass);
  console.log('\n===== 汇总：' + results.length + ' 项，失败 ' + fails.length + ' =====');
  fails.forEach((f) => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
