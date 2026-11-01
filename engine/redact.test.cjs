#!/usr/bin/env node
/* ============================================================================
 * redact.test.cjs — 脱敏必须真的脱干净，且不能把有用信息一起抹掉
 * ============================================================================
 *
 * 【为什么需要】
 *   日志里 `url` 被写到几十处，`enc` / `cpi` / `uuid` 是学习通的授权参数：
 *   拿到 URL 的人可以直接打开你的课程页、甚至冒用二维码会话。
 *   逐处打补丁必漏，所以收口到 logger 的 `redact()`。这个测试钉住它。
 *
 * 【四条要求】
 *   1. 值必须消失（否则等于没脱）
 *   2. 键名要保留（`enc=***` 而不是把整个参数删掉，否则排查时看不出脱了什么）
 *   3. 非授权参数必须保留（courseId / clazzid / chapterId 是排查必需）
 *   4. 不能过度脱敏（把普通文本也打成 *** 会让日志失去价值）
 *
 * 【能失败证明（2026-10-31 实测）】
 *   把 logging.js 的 `redact` 改成 `return String(s)`（不脱敏）
 *   → 本测试的第 1 组用例全部变红。已实测：改坏退出 1，恢复退出 0。
 *
 * 运行：node engine/redact.test.cjs
 * ==========================================================================*/
'use strict';

const path = require('node:path');
const { redact, redactDeep } = require('./src/core/logging.js');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

/* ============================================================ 1. URL 授权参数 */
console.log('== 1/5 URL 授权参数必须脱敏 ==');
{
  const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=123&clazzid=4'
    + '&enc=abbf9c2f1e&cpi=164231960&openc=c385d7e2&chapterId=143114597';
  const out = redact(url);
  ok(!out.includes('abbf9c2f1e'), 'enc 的值被脱掉', out);
  ok(!out.includes('164231960'), 'cpi 的值被脱掉', out);
  ok(!out.includes('c385d7e2'), 'openc 的值被脱掉', out);
  ok(out.includes('enc='), 'enc 的键名保留（看得出脱了什么）', out);
  ok(out.includes('courseId=123'), 'courseId 保留（排查必需）', out);
  ok(out.includes('clazzid=4'), 'clazzid 保留（排查必需）', out);
  ok(out.includes('chapterId=143114597'), 'chapterId 保留（排查必需）', out);
}

/* ============================================================ 2. 二维码会话 */
console.log('== 2/5 二维码 uuid 必须脱敏 ==');
{
  const url = 'https://passport2.chaoxing.com/createqr?uuid=91a411e3b7a84dd4bbe61e1d15e02b0b&fid=-1';
  const out = redact(url);
  ok(!out.includes('91a411e3b7a84'), 'uuid 的值被脱掉', out);
  ok(out.includes('uuid='), 'uuid 的键名保留', out);
  ok(out.includes('fid=-1'), 'fid 保留（非授权参数）', out);
}

/* ============================================================ 3. 通用凭据形态 */
console.log('== 3/5 通用凭据形态 ==');
{
  const cases = [
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxx', 'eyJhbGci', 'Bearer'],
    ['password: "hunter2secret"', 'hunter2', 'password'],
    ['token=sk-abcdef123456&x=1', 'abcdef123456', 'token'],
    ['apiKey = "abcd1234efgh"', 'abcd1234', 'apiKey'],
    ['JSESSIONID=ABC123DEF456', 'ABC123DEF456', 'JSESSIONID'],
  ];
  for (const [input, mustVanish, mustKeep] of cases) {
    const out = redact(input);
    ok(!out.includes(mustVanish), '「' + input.slice(0, 28) + '…」的值被脱掉', out);
    ok(out.includes(mustKeep), '「' + mustKeep + '」键名/方案名保留', out);
  }
}

/* ============================================================ 4. 不许过度脱敏 */
console.log('== 4/5 普通内容不许被误脱 ==');
{
  const plain = 'P1 已切换到下一节 {"title":"1.3 工程形态","bypassedDone":1,"progress":96.5}';
  const out = redact(plain);
  ok(out === plain, '普通日志文本原样保留', out);
  ok(redact('https://mooc1.chaoxing.com/visit/interaction') === 'https://mooc1.chaoxing.com/visit/interaction',
    '无参数的 URL 原样保留');
  ok(redact('') === '', '空串仍为空串');
  ok(redact(null) === '', 'null 不抛错');
  ok(redact(undefined) === '', 'undefined 不抛错');
}

/* ============================================================ 5. 结构化脱敏 */
console.log('== 5/5 redactDeep 递归处理对象 ==');
{
  const meta = {
    url: 'https://x.chaoxing.com/a?enc=SECRETENC&courseId=9',
    nested: { href: 'https://y.chaoxing.com/b?cpi=SECRETCPI', count: 3 },
    list: ['https://z.chaoxing.com/c?openc=SECRETOPENC', 'plain'],
    num: 42,
    flag: true,
    nothing: null,
  };
  const out = redactDeep(meta);
  ok(!JSON.stringify(out).includes('SECRETENC'), '嵌套对象里的 enc 被脱掉');
  ok(!JSON.stringify(out).includes('SECRETCPI'), '嵌套对象里的 cpi 被脱掉');
  ok(!JSON.stringify(out).includes('SECRETOPENC'), '数组里的 openc 被脱掉');
  ok(out.num === 42 && out.flag === true && out.nothing === null, '非字符串字段原样保留');
  ok(out.url.includes('courseId=9'), '嵌套里非授权参数保留');
  ok(out.list[1] === 'plain', '数组里的普通字符串保留');
}

/* ============================================================ 6. 幂等 */
console.log('== 6/6 重复脱敏结果不变（可安全多次调用）==');
{
  const once = redact('https://x.chaoxing.com/a?enc=SECRET&courseId=1');
  const twice = redact(once);
  ok(once === twice, '二次脱敏与一次结果相同', once + ' vs ' + twice);
}

console.log(fails.length ? '\n== 失败 ' + fails.length + ' 项 ==' : '\n== 全部通过 ==');
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
process.exit(0);
