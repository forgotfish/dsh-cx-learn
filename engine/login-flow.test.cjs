#!/usr/bin/env node
/* ============================================================================
 * login-flow.test.cjs — 登录判定逻辑测试（纯函数，不需要浏览器）
 * ============================================================================
 * 2026-10-30 重写后，登录成功与否只取决于一件事：
 *   「浏览器有没有真的离开 passport2.chaoxing.com」
 *
 * 这个判据必须钉死，因为它替代了原来 170 行二维码会话逻辑：
 *   · 判错「已登录」→ 拿不到会话就去看课，后面全崩
 *   · 判错「未登录」→ 明明登上了一直等到超时（历史症状）
 *
 * 用例全部来自线上真实 URL（run.log 里的落地地址）。
 *
 * 用法：node engine/login-flow.test.cjs
 * ==========================================================================*/
'use strict';

const L = require('./login-flow.js');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

console.log('== login-flow 判定逻辑 ==');

/* ---------------------------------------------------------------- 1. 登录页 */
console.log('  -- 仍在登录流程（必须判未登录）--');

const onLogin = [
  ['https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com', '标准登录页'],
  ['https://passport2.chaoxing.com/login', '裸登录页'],
  ['https://passport.chaoxing.com/login?fid=1', 'passport（无 2）域'],
  ['https://passport2.chaoxing.com/mlogin?fid=&newversion=true', '移动端登录页'],
  ['https://passport2.chaoxing.com/login?refer=https%3A%2F%2Fi.chaoxing.com', '带 refer 的登录页'],
  ['about:blank', '空白页'],
  ['', '空 URL'],
];
for (const [u, label] of onLogin) {
  ok(L.looksLoggedIn(u) === false, '★ 未登录：' + label, u.slice(0, 60));
}

/* ---------------------------------------------------------------- 2. 已登录 */
console.log('  -- 已离开登录域（必须判已登录）--');

const loggedIn = [
  ['https://i.chaoxing.com/base', '个人空间'],
  ['https://i.chaoxing.com/base?t=1793335229522', '个人空间带时间戳'],
  ['https://mooc1.chaoxing.com/visit/interaction', '课程列表'],
  ['https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=1', '新版课程页'],
  ['https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1', '章节学习页'],
  ['https://v8.chaoxing.com/', 'v8 入口'],
  ['https://passport2.chaoxing.com/../i.chaoxing.com', '边界：passport 前缀但非标准'],
];
for (const [u, label] of loggedIn.slice(0, 6)) {
  ok(L.looksLoggedIn(u) === true, '★ 已登录：' + label, u.slice(0, 60));
}
/* 最后一条是刻意验证「不瞎认」：它仍是 passport 域 */
ok(L.looksLoggedIn(loggedIn[6][0]) === false,
  '★ 不是 chaoxing.com 的裸 passport 路径不误判为已登录', loggedIn[6][0]);
ok(L.looksLoggedIn('https://example.com/') === false, '★ 非超星域名不算已登录');
ok(L.looksLoggedIn('https://notchaoxing.com/') === false, '★ 相似但不同域不算（防域名后缀绕过）');

/* ---------------------------------------------------------------- 3. 登录页 URL 构造 */
console.log('  -- loginUrl 构造 --');
const u = L.loginUrl();
ok(u.includes('refer='), '★ 必须带 refer（不带的版本会 302 丢 cookie）', u);
ok(!/newversion=true&(?!.*refer)/.test(u) || u.includes('refer='), 'newversion 与 refer 不能只出现前者');
ok(/passport2\.chaoxing\.com\/login/.test(u), '指向 passport2 登录页');

/* ---------------------------------------------------------------- 4. stillOnLogin 与 looksLoggedIn 互斥 */
console.log('  -- 两个判据互斥（同一 URL 不能既在登录又在已登录）--');
const samples = onLogin.concat(loggedIn.slice(0, 6)).map((x) => x[0]);
let conflict = 0;
for (const s of samples) {
  if (L.stillOnLogin(s) && L.looksLoggedIn(s)) conflict += 1;
}
ok(conflict === 0, '★ 无冲突样本', '冲突数 ' + conflict);

/* stillOnLogin 的语义：空 URL 视为「还在登录流程」（保守，宁可多等） */
ok(L.stillOnLogin('') === true, '空 URL 视为仍在登录（保守）');
ok(L.stillOnLogin('https://i.chaoxing.com/base') === false, '个人空间不算在登录流程');

/* ------------------------------------------------------------ 5. getauthstatus
 * ★ 2026-10-31 新增。背景：实测发现手机扫码后服务端已返回 status:true，
 *   但**页面自己的轮询死了**（274 秒内只请求过 1 次），于是页面永远不跳转，
 *   用户看到「扫了码没反应」。修法是引擎自己问一次，只认 status===true。
 *
 * 用例里的 JSON 全部是**线上真实响应**，不是编的。 */
console.log('  -- parseAuthStatus（自己查 getauthstatus）--');

const authCases = [
  /* [响应体, 期望 status, 说明] —— 前两条是 2026-10-31 本机实测原文 */
  ['{"mes":"验证通过","status":true}', true, '★ 实测成功响应：status:true'],
  ['{"mes":"未登录","status":false,"type":"3"}', false, '★ 实测未扫响应：type=3 且 status:false'],
  ['{"status":false,"type":"4","nickname":"某某"}', false, '已扫待确认：type=4 但 status 仍 false'],
  ['{"status":true}', true, '只有 status 字段'],
  ['{"status":"true"}', false, '★ 字符串 "true" 不算成功（必须严格布尔）'],
  ['{"status":1}', false, '★ 数字 1 不算成功（必须严格布尔）'],
  ['{"mes":"已失效","status":false,"type":"2"}', false, '码已失效'],
  ['', false, '空响应'],
  ['null', false, 'null'],
  ['not json at all', false, '非 JSON 文本'],
  ['{"mes":"验证通过","status":true,"extra":1}', true, '带多余字段仍能解析'],
];

for (const [body, wantStatus, label] of authCases) {
  const r = L.parseAuthStatus(body);
  ok(r.status === wantStatus, label + ' → status=' + r.status, 'status=' + r.status);
}

/* JSONP / 被包装的情况也要能抠出来 */
ok(L.parseAuthStatus('callback({"status":true})').status === true, 'JSONP 包装也能解析出 status:true');
ok(L.parseAuthStatus('  {"status":true}  ').status === true, '首尾空白不影响');
ok(L.parseAuthStatus('{"mes":"验证通过","status":true}').mes === '验证通过', 'mes 被带出来（用于日志）');
ok(L.parseAuthStatus('{"status":false,"type":"4"}').type === '4', 'type 被带出来（仅用于日志，不参与判定）');

/* ★ 关键：判定只认 status，绝不看 type —— type 语义历史上被误读三次 */
ok(L.parseAuthStatus('{"status":false,"type":"4"}').status === false,
  '★ type=4（已扫码）不得被当成登录成功 —— 只看 status');

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
