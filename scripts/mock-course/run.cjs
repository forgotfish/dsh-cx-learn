#!/usr/bin/env node
/* ============================================================================
 * run.cjs — 本机端到端：真实浏览器 + 假课程站，验证「登录之后」的整条链路
 * ============================================================================
 * 期望行为（与 FNOS 真机同构）：
 *   1.1 / 1.2 整节完成   → 跳过
 *   1.3 视频完成、测验没做 → 跳过（这是今天修的那个 bug，旧版会重播并死在弹题上）
 *   1.4 没看过           → 播放 → 5 秒处弹随堂题 → 盲试（A 错 B 对）→ 继续播到结束
 *
 * 用法：node scripts/mock-course/run.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8123;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const enginePath = path.join(ROOT, 'engine', 'chaoxing-autolearn.js');
const serverPath = path.join(__dirname, 'server.cjs');

function log(msg) { console.log('[test] ' + msg); }

(async () => {
  const server = spawn(process.execPath, [serverPath, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  server.stdout.on('data', (d) => process.stdout.write(String(d)));

  const stop = () => { try { server.kill(); } catch (_) { /* ignore */ } };
  process.on('exit', stop);

  await new Promise((r) => setTimeout(r, 800));

  const env = {
    ...process.env,
    CX_CHROMIUM: EDGE,
    CX_PROFILE_DIR: path.join(process.env.TEMP || '.', 'cx-mock-course', 'session'),
    CX_EPHEMERAL_LOGIN: '1',
    CX_QUIZ_MODE: 'skip'
  };

  const args = [
    enginePath,
    '--mode=continue_chapters',
    '--max-sections=1',
    '--course-url=http://127.0.0.1:' + PORT + '/mycourse/studentstudy?chapterId=100003'
  ];

  log('启动引擎（Edge headless）…');
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.on('data', (d) => { out += String(d); process.stdout.write(String(d)); });
  child.stderr.on('data', (d) => { out += String(d); process.stderr.write(String(d)); });

  const timer = setTimeout(() => { log('超时 180s，强杀'); try { child.kill('SIGKILL'); } catch (_) {} }, 180000);
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  clearTimeout(timer);

  fs.writeFileSync(path.join(__dirname, 'last-run.log'), out, 'utf8');

  /* ---- 断言 ---- */
  const checks = [];
  const has = (re) => re.test(out);
  checks.push(['读到了完整目录（85 项那一套选择器）', has(/tocFound\\?":true|tocFound: true|tocFound/)]);
  checks.push(['1.3 被判为「视频任务已完成」而跳过', has(/本节视频任务已完成|跳过重播/)]);
  checks.push(['没有因为弹题证据不足停机', !has(/quiz_unclassified_needs_human/)]);
  checks.push(['1.4 正常进入播放', has(/1\.4|作为科学的工程/)]);
  checks.push(['随堂题走了盲试', has(/随堂题盲试选项/)]);
  checks.push(['随堂题最终通过/继续', has(/答对|视为已通过|CONTINUED|CORRECT/)]);

  log('引擎退出码=' + code);
  log('');
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name);
    if (!ok) bad += 1;
  }
  stop();
  log('');
  log(bad ? ('失败 ' + bad + ' 项，完整日志见 scripts/mock-course/last-run.log') : '全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
