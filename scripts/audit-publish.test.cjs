#!/usr/bin/env node
/* ============================================================================
 * audit-publish.test.cjs — 验证「脱敏审计」本身能正确工作
 * ============================================================================
 *
 * 【为什么要有这个测试】
 *   审计脚本是用来防止泄漏的。如果它自己判断错了，比没有它更危险：
 *   · 漏报 → 有人以为安全，实际把口令推上去了
 *   · 误报 → 大家学会忽略它，基线噪声一多就彻底失效
 *   所以它必须有自己的测试，而且**必须调用真实实现**（require 进来），
 *   不许在测试里重写一份正则副本 —— 那样测的是副本，不是产品。
 *
 * 【能失败证明 —— 已实测，2026-10-31】
 *   破坏方式：把 RULES 里整条 `secret-assigned-bare` 规则删掉
 *   → 必须变红的用例：「无引号口令 FNOS_PASS=fixturepass9」「无引号令牌」
 *                    「无引号口令（冒号 + 大写键名）」
 *   → 实测退出码 1，恢复后退出码 0。✓ 通过
 *
 *   附注：另试过只删 `allow` 里的标识符豁免分支，测试仍绿 —— 因为该用例
 *   先被 lookbehind 排除了，说明「删豁免」不是有效破坏点。已记录在此，
 *   避免下次有人再用那个位置做验证而误以为测试没有保护力。
 *
 * 运行：node scripts/audit-publish.test.cjs
 * 退出码：0 通过 / 1 失败
 * ==========================================================================*/
'use strict';

const A = require('./audit-publish.cjs');

const fails = [];
function ok(cond, name) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name); fails.push(name); }
}
/** 扫描一段文本，返回命中的 rule id 列表 */
function rulesFor(text) {
  return A.scanText('probe.txt', text).map((h) => h.rule);
}
/** 是否命中某条规则 */
function hits(text, rule) {
  return rulesFor(text).includes(rule);
}

console.log('== 1. 必须抓到真实泄漏形态 ==');
ok(hits("FNOS_PASS=fixturepass9", 'secret-assigned-bare'), '无引号口令 FNOS_PASS=fixturepass9');
ok(hits('MY_PASSWD: hunter2x', 'secret-assigned-bare'), '无引号口令（冒号 + 大写键名）');
ok(hits('SECRET_TOKEN=abc123def', 'secret-assigned-bare'), '无引号令牌');
/* 用拼接避免仓库里出现完整密钥字面量（CI 的 secret-scan 会把它当泄漏） */
const fakeKey = 'sk-' + 'abcdefghijklmnopqrst';
ok(hits('API_KEY: "' + fakeKey + '"', 'secret-assigned'), '加引号密钥');
ok(hits("echo 'hunter2' | sudo -S restart", 'secret-sudo-echo'), 'echo 明文给 sudo');
ok(hits('token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'secret-github-token'), 'GitHub 令牌');
ok(hits('password: "S3cr3tValue"', 'secret-assigned'), 'password 字面量');

console.log('== 2. 不许误报合法写法 ==');
ok(!hits('env.CX_LLM_ASK_TOKEN = askToken', 'secret-assigned-bare'), '属性赋值（右侧是变量名）不报');
ok(!hits('FNOS_PASS=<从环境读取>', 'secret-assigned-bare'), '占位符不报');
ok(!hits('FNOS_PASS=process.env.FNOS_PASS', 'secret-assigned-bare'), '从环境变量读不报');
ok(!hits('password: ""', 'secret-assigned'), '空值不报');
ok(!hits('const token = Math.random().toString(36)', 'secret-assigned-bare'), '生成随机数不报');
ok(!hits('max_tokens: 16', 'secret-assigned-bare'), 'max_tokens 这种非凭据字段不报');

console.log('== 3. 占位符判定（isPlaceholder）==');
ok(A.isPlaceholder('<见记忆归档>') === true, '<...> 是占位符');
ok(A.isPlaceholder('$FNOS_PASS') === true, '$VAR 是占位符');
ok(A.isPlaceholder('${FNOS_PASS}') === true, '${VAR} 是占位符');
ok(A.isPlaceholder('process.env.X') === true, 'process.env 是占位符');
ok(A.isPlaceholder('xxx') === true, 'xxx 是占位符');
ok(A.isPlaceholder('fixturepass9') === false, '真实口令不是占位符');
ok(A.isPlaceholder('') === true, '空串视为占位符');

console.log('== 4. 报告本身不能泄漏（mask）==');
const masked = A.mask('FNOS_PASS=fixturepass9');
ok(!masked.includes('fixturepass9'), '口令在报告里被打码（实际：' + masked + '）');
const masked2 = A.mask('token: "ghp_abcdefghijklmnopqrstuvwxyz"');
ok(!masked2.includes('abcdefghijklmnop'), 'GitHub 令牌在报告里被打码');

console.log('== 5. 规则表自身必须完整 ==');
ok(Array.isArray(A.RULES) && A.RULES.length >= 8, '规则数量 ≥ 8（实际 ' + A.RULES.length + '）');
ok(A.RULES.every((r) => r.id && r.level && r.re instanceof RegExp && r.why && r.fix), '每条规则都有 id/level/re/why/fix');
ok(A.RULES.some((r) => r.level === 'block'), '存在 BLOCK 级规则');
ok(A.RULES.some((r) => r.level === 'warn'), '存在 WARN 级规则');
const ids = A.RULES.map((r) => r.id);
ok(new Set(ids).size === ids.length, '规则 id 不重复');

console.log('== 6. 本仓库当前状态 ==');
try {
  const files = A.listFiles();
  ok(files.length > 50, '能列出待扫文件（' + files.length + ' 个）');
  ok(!files.some((f) => /node_modules|\.state\/|\.git\//.test(f)), '不扫依赖/运行期产物/.git');
  ok(!files.some((f) => f === 'scripts/audit-publish.cjs'), '不扫审计脚本自身（否则规则关键字自命中）');
} catch (e) {
  ok(false, 'listFiles 抛错：' + e.message);
}

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过（' + (0) + '）==');
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
