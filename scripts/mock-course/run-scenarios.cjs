#!/usr/bin/env node
/* ============================================================================
 * run-scenarios.cjs — 本机场景测试（真实 Edge 内核 + 假课程站）
 * ============================================================================
 * run.cjs 只测「主链路」（跳过已完成 → 播放 → 随堂题盲试）。
 * 这里补三个容易出事、又必须在本机先验的场景：
 *
 *   S1 断点续看：课程地址落在**已完成**的 1.3 上，
 *      引擎必须往前找到 1.4 播放，而不是原地重播 1.3 或退回 1.1。
 *
 *   S2 章节测验不触碰：当前节有「章节测验」标签，点开后是 .TiMu 题块。
 *      引擎绝不能点任何选项/提交，只能记录后进入下一节。
 *
 * 用法：node scripts/mock-course/run-scenarios.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8124;
const enginePath = path.join(ROOT, 'engine', 'chaoxing-autolearn.js');
const serverPath = path.join(__dirname, 'server.cjs');

function runEngine(url, maxSections) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CX_CHROMIUM: EDGE,
      CX_PROFILE_DIR: path.join(process.env.TEMP || '.', 'cx-mock-scenario', 'session'),
      CX_EPHEMERAL_LOGIN: '1',
      CX_QUIZ_MODE: 'skip'
    };
    const args = [enginePath, '--mode=continue_chapters', '--max-sections=' + maxSections, '--course-url=' + url];
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch (_) {} }, 150000);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

(async () => {
  const server = spawn(process.execPath, [serverPath, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => { try { server.kill() } catch (_) {} });
  await new Promise((r) => setTimeout(r, 800));

  let bad = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (ok || !extra ? '' : '  (' + extra + ')'));
    if (!ok) bad += 1;
  };

  /* ---------------- S1 断点续看 ---------------- */
  console.log('== S1 断点续看：落在已完成的 1.3，应前进到 1.4 ==');
  const s1 = await runEngine('http://127.0.0.1:' + PORT + '/mycourse/studentstudy?chapterId=100003', 1);
  fs.writeFileSync(path.join(__dirname, 'scenario-s1.log'), s1, 'utf8');
  check('1.3 被判「视频任务已完成」并跳过', /本节视频任务已完成|跳过重播/.test(s1));
  check('没有原地重播 1.3', !/1\.3 工程形态[^\n]*PLAYING/.test(s1));
  /* ★ 2026-10-31 修：原断言找 "PLAYING|播放中" 字样，而引擎日志里根本没有这两个词
     （进度只出现在 PLAY/QUIZ 等事件里），所以它从某次日志改版起就恒红。
     改为「切到 1.4」+「播放器时间确实前进了」两个可观测证据。 */
  const s1Advanced = /1\.4|作为科学的工程/.test(s1);
  const s1Played = /currentTime":\s*[1-9][0-9]*/.test(s1) || /PLAYING|播放中/.test(s1);
  check('进入 1.4 并播放', s1Advanced && s1Played, 'advanced=' + s1Advanced + ' played=' + s1Played);

  /* ---------------- S2 章节测验绝不触碰 ---------------- */
  console.log('== S2 章节测验：只识别、不点选项、不提交 ==');
  const s2 = await runEngine('http://127.0.0.1:' + PORT + '/mycourse/studentstudy?chapterId=100004&quizTab=1', 1);
  fs.writeFileSync(path.join(__dirname, 'scenario-s2.log'), s2, 'utf8');
  check('识别到章节测验入口', /章节测验|QUIZTAB|quizTab/.test(s2));
  check('★ 没有点击任何题目选项', !/CLICK[^\n]*quizOption/.test(s2));
  check('★ 没有点击提交', !/CLICK[^\n]*quizSubmit/.test(s2));
  check('没有因「章节测验」整轮 fatal', !/FATAL[^\n]*quiz/i.test(s2));

  try { server.kill() } catch (_) {}
  console.log('');
  console.log(bad ? ('失败 ' + bad + ' 项，见 scenario-s1.log / scenario-s2.log') : '全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
