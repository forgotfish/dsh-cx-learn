#!/usr/bin/env node
/* ============================================================================
 * lessons-check.cjs —— 把 docs/LESSONS.md 里的教训变成**能失败的检查**
 *
 * 为什么要有：这次会话里我反复踩同一批坑（探针单反斜杠、忘 bump 探针版本、
 * 变异锚点重复），每次都要浪费数轮才由人工发现。凡是能机械判定的，就不该靠记性。
 *
 * 检查项（全绿才通过，任一失败 exit=1）：
 *   L1  探针 PAGE_PROBE_SRC 内**禁止单反斜杠转义**（模板字面量会把 \d 吃成 d）
 *   L2  探针内容变了就必须 bump version（内容哈希锁：engine/probe-version.lock.json）
 *   L3  变异条目自检：file/test 存在、old 锚点在目标文件里**恰好出现 1 次**
 *   L4  DECISIONS 的 D 编号不重复
 *
 * 用法：
 *   node scripts/lessons-check.cjs            # 检查
 *   node scripts/lessons-check.cjs --update   # 探针内容确认无误后，刷新 version 锁
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const UPDATE = process.argv.includes('--update');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  \u2190 ' + extra)); }
}

/* ---------------- L1：探针内禁止单反斜杠 ---------------- */
console.log('== L1. 探针 PAGE_PROBE_SRC 内禁止单反斜杠转义 ==');
{
  /* ★ 关键：必须检查**文件源码**，不能检查字符串值。
     因为正确写法 \\d 在字符串里就是 \d，与"被吃掉的错误写法"在字符串层面无法区分；
     而单反斜杠写 \d 会被模板字面量吃掉变成 d（正则语义丢失 / 括号失衡 → 语法错）。 */
  const file = path.join(ROOT, 'engine', 'src', 'learn', 'selectors.js');
  const text = fs.readFileSync(file, 'utf8');
  const mk = 'const PAGE_PROBE_SRC = `';
  const i0 = text.indexOf(mk);
  let region = '';
  if (i0 >= 0) {
    const from = i0 + mk.length;
    /* 结束标记：模板字面量收尾 `; （该文件里 PAGE_PROBE_SRC 以 `; 结束） */
    const i1 = text.indexOf('`;', from);
    region = i1 > from ? text.slice(from, i1) : text.slice(from);
  }
  ok(region.length > 1000, '  取到探针源码区（' + region.length + ' 字符）');

  /* 合法转义（文件层面）：\\ 开头的一切双写都合法；这里只找**孤立单反斜杠**。 */
  const bad = [];
  for (let i = 0; i < region.length; i += 1) {
    if (region[i] !== '\\') continue;
    /* 跳过双写 \\ */
    if (region[i + 1] === '\\') { i += 1; continue; }
    const c = region[i + 1];
    /* 单反斜杠后面跟字母 → 在模板字面量里会被"消化"，几乎都是 bug */
    if (/[a-zA-Z]/.test(c)) {
      const line = region.slice(0, i).split('\n').length;
      bad.push('\\' + c + ' (第' + line + '行)');
    }
  }
  ok(bad.length === 0,
    '★ 探针源码里没有孤立单反斜杠字母转义（正则须双写 \\\\d）',
    bad.length ? bad.slice(0, 6).join(', ') : undefined);
}

/* ---------------- L2：探针内容哈希锁 ---------------- */
console.log('== L2. 探针内容变了必须 bump version ==');
{
  const sel = require(path.join(ROOT, 'engine', 'src', 'learn', 'selectors.js'));
  const src = String(sel.PAGE_PROBE_SRC || '');
  const ver = Number(sel.SELECTORS && sel.SELECTORS.version);
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  const lockFile = path.join(ROOT, 'engine', 'probe-version.lock.json');

  ok(Number.isFinite(ver) && ver > 0, '  探针 version 是正数（实际 ' + ver + '）');

  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (_) { lock = null; }

  if (UPDATE) {
    fs.writeFileSync(lockFile, JSON.stringify({ version: ver, hash: hash, updatedAt: new Date().toISOString() }, null, 1) + '\n', 'utf8');
    console.log('  ↻ 已刷新锁：version=' + ver + ' hash=' + hash);
    ok(true, '  锁已更新');
  } else if (!lock) {
    ok(false, '★ 缺少 ' + path.relative(ROOT, lockFile) + '（首次请运行 --update）');
  } else if (lock.hash !== hash && Number(lock.version) === ver) {
    ok(false, '★ 探针内容变了但 version 没变（锁 ' + lock.version + '/' + lock.hash + ' vs 现在 ' + ver + '/' + hash + '）—— 必须 bump version，否则页面沿用旧探针、修复静默不生效');
  } else if (lock.hash !== hash && Number(lock.version) !== ver) {
    console.log('  ↻ 探针内容与版本都变了（' + lock.version + '→' + ver + '），锁待刷新');
    ok(true, '  内容与版本同步变更（提交前请运行 --update 刷新锁）');
  } else {
    ok(true, '  探针未变（version=' + ver + '）');
  }
}

/* ---------------- L3：变异条目自检 ---------------- */
console.log('== L3. 变异条目自检（锚点必须唯一存在）==');
{
  const M = require(path.join(ROOT, 'scripts', 'mutation-test.cjs'));
  const list = Array.isArray(M && M.MUTATIONS) ? M.MUTATIONS : null;
  if (!list) {
    ok(false, '★ mutation-test.cjs 未导出 MUTATIONS（无法自检）');
  } else {
    ok(list.length > 0, '  变异条目数 = ' + list.length);
    const badFile = [];
    const badTest = [];
    const badAnchor = [];
    for (const m of list) {
      const f = path.join(ROOT, m.file);
      if (!fs.existsSync(f)) { badFile.push(m.id); continue; }
      const tf = path.join(ROOT, m.test);
      if (!fs.existsSync(tf)) badTest.push(m.id + '(' + m.test + ')');
      const content = fs.readFileSync(f, 'utf8');
      const n = content.split(m.old).length - 1;
      if (n !== 1) badAnchor.push(m.id + ':' + n);
    }
    ok(badFile.length === 0, '★ 所有 file 存在', badFile.join(', '));
    ok(badTest.length === 0, '★ 所有 test 文件存在', badTest.join(', '));
    ok(badAnchor.length === 0,
      '★ ★ 每个 old 锚点在目标文件里恰好出现 1 次（0=失效，>1=会打到错误位置）',
      badAnchor.length ? badAnchor.join(', ') : undefined);
  }
}

/* ---------------- L4：D 编号不重复 ---------------- */
console.log('== L4. DECISIONS 的 D 编号不重复 ==');
{
  const f = path.join(ROOT, 'docs', 'DECISIONS.md');
  const txt = fs.readFileSync(f, 'utf8');
  const ids = [];
  const re = /^## (D-\d{3})\b/gm;
  let m;
  while ((m = re.exec(txt)) !== null) ids.push(m[1]);
  const seen = new Map();
  const dup = [];
  for (const id of ids) {
    if (seen.has(id)) dup.push(id);
    seen.set(id, 1);
  }
  ok(ids.length > 0, '  D 条目数 = ' + ids.length);
  ok(dup.length === 0, '★ 没有重复的 D 编号', dup.join(', '));
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项（见 docs/LESSONS.md）==');
  fails.forEach((x) => console.log('  ✗ ' + x));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
