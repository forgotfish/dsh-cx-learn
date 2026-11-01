#!/usr/bin/env node
/* ============================================================================
 * _barecheck.cjs — 验证裸命令名（PATH 查找）不被误杀
 * ----------------------------------------------------------------------------
 * 背景：config 默认 executablePath = 'chromium'（裸名，靠 PATH 解析）。
 * 实测 Windows：'where.exe'/'ping.exe' 等裸名在 PATH 里可 spawn，
 * 但 fs.existsSync(裸名) 恒为 false。任何用 existsSync 做前置判断的代码
 * 都会把这种合法配置误判成「内核不存在」。
 *
 * 本脚本用真实引擎路径验证：给一个 PATH 里的裸名，ensureBrowser 必须
 * 能走到「尝试启动」阶段，而不是立刻报「文件不存在」。
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createCdpAdapter, mergeConfig, CONFIG, logger } = require('./chaoxing-autolearn.js');

let pass = 0;
const fails = [];
const ok = (c, n, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fails.push(n); console.log('  \u2717 ' + n + (e === undefined ? '' : '  (' + e + ')')); } };

/* 找一个确实在 PATH 里的裸命令名 */
function findPathCommand() {
  for (const name of ['where.exe', 'ping.exe', 'certutil.exe', 'cmd.exe']) {
    try {
      const p = execFileSync('where', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
      if (p && fs.existsSync(p)) return { name, abs: p };
    } catch (_) { /* 下一个 */ }
  }
  return null;
}

(async () => {
  const hit = findPathCommand();
  if (!hit) { console.log('本机找不到可用于测试的 PATH 命令，跳过'); process.exit(0); }

  console.log('用 PATH 命令做替身：' + hit.name + '  → ' + hit.abs);
  console.log('  fs.existsSync("' + hit.name + '") = ' + fs.existsSync(hit.name) + '  （预期 false）');

  /* 证明 existsSync 对裸名不可靠 */
  ok(fs.existsSync(hit.name) === false, '裸命令名 existsSync 为 false（所以不能用它判定存在性）');
  ok(fs.existsSync(hit.abs) === true, '同一命令的绝对路径 existsSync 为 true');

  /* 用引擎真实路径：裸名 + 极短超时，重点看「错误类型」而非成功与否 */
  const collected = [];
  logger.setConsole((l) => collected.push(l));
  const cfg = mergeConfig(CONFIG, {
    chromium: { executablePath: hit.name, headless: true, profileDir: '', extraArgs: ['--no-sandbox'] },
    cdp: { port: 0, attachTimeoutMs: 2500 },
  });

  const adapter = createCdpAdapter(cfg);
  const t0 = Date.now();
  let err = null;
  try { await adapter.ensureBrowser(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  const msg = err ? String(err.message || err) : '';

  console.log('  结果：' + (err ? '失败（预期，' + hit.name + ' 不是浏览器）' : '成功（意外）') + ' 耗时 ' + ms + 'ms');
  console.log('  文案：' + msg.slice(0, 160));

  /* 核心断言：不能报「不存在」，因为它在 PATH 里是存在的 */
  ok(/不存在/.test(msg) === false,
    '没有误报「内核可执行文件不存在」', msg.slice(0, 100));
  /* 应该归到「能启动但不是浏览器」这一类 */
  ok(/未就绪|不是浏览器|端口/i.test(msg) || err === null,
    '归因落在「启动了但端口没就绪」，而非文件缺失', msg.slice(0, 100));
  ok(ms < 6000, '在 attachTimeoutMs 附近返回（没有额外拖延）', ms + 'ms');

  console.log('\n' + (fails.length
    ? '== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==\n' + fails.map((f) => '  - ' + f).join('\n')
    : '== 全部通过（' + pass + ' 项）=='));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('异常: ' + (e && e.stack || e)); process.exit(1); });
