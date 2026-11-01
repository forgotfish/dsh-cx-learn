#!/usr/bin/env node
/* ============================================================================
 * check-selectors.cjs — 选择器注册表的静态闸门（L3）
 * ============================================================================
 * 契约（docs/SPEC.md §9）：**选择器只允许出现在 SELECTORS 表里**，
 * 探针代码从表读；不许在探测逻辑里写裸选择器。
 *
 * 这个脚本不打开浏览器，只做静态检查：
 *   1. PAGE_PROBE_SRC 里不得残留裸选择器字面量（正则片段、标签名除外）
 *   2. 表里每个 key 都要真的被引用（防止加了没人用、或者拼错 key 后静默失效）
 *   3. 数组型候选（tocItem / dialogContainer / quizOption）每项必须有 layer/sel/note
 *   4. installProbeExpression 必须同时注入 SELECTORS 与探针代码
 *   5. 版本号必须是正整数（页面侧靠它做幂等，改表忘了升版本会导致旧探针不刷新）
 *
 * 为什么值得有这道闸门：超星改版时，只有这里能逼着人「改表 + 升版本」，
 * 而不是在某个函数里偷偷补一个 querySelector，然后三个月后没人知道有几套选择器。
 *
 * 运行：node scripts/check-selectors.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine', 'src', 'learn', 'selectors.js');

const fails = [];
let pass = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const mod = require(SRC);
const { SELECTORS, PAGE_PROBE_SRC, installProbeExpression } = mod;

/* 允许出现在探针里的非「完整选择器」字面量：
 *   · 纯标签名 / 很短的片段（closest('label') 之类）
 *   · 正则片段（[^、(\d 等）
 *   · 表格里已经有的完整选择器（允许被拆开使用？不允许——拆开就说明没走表）
 */
const TAG_ONLY = /^[a-z][a-z0-9-]*$/i;

/** 把表里所有字符串值摊平成一个集合。 */
function tableSelectors() {
  const out = new Set();
  for (const v of Object.values(SELECTORS)) {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') out.add(x);
        else if (x && typeof x === 'object' && typeof x.sel === 'string') out.add(x.sel);
      }
    }
  }
  return out;
}

function looksLikeSelector(s) {
  if (!s || s.length > 160) return false;
  if (TAG_ONLY.test(s)) return false;
  if (/^[^(),'"\s]*$/.test(s) === false && !/[.#\[][\w-]/.test(s)) return false;
  return /[.#\[]/.test(s) && /^[\w.#\[\]="*' -]+$/.test(s);
}

console.log('== 1. 探针里不得有裸选择器 ==');
{
  const known = tableSelectors();
  const lits = [...PAGE_PROBE_SRC.matchAll(/'([^'\n]{2,160})'/g)].map((m) => m[1]);
  const remaining = [...new Set(lits)].filter((s) => looksLikeSelector(s) && !known.has(s));
  console.log('  探针内候选字面量 ' + lits.length + ' 个，其中不在表里的 ' + remaining.length + ' 个');
  ok(remaining.length === 0, '★ 没有「表外裸选择器」', remaining.join(' | '));
}

console.log('== 2. 表里每项都要被引用 ==');
{
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.js') && p !== SRC) files.push(p);
    }
  };
  walk(path.join(ROOT, 'engine', 'src'));
  files.push(path.join(ROOT, 'engine', 'chaoxing-autolearn.js'));
  const srcs = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n') + '\n' + PAGE_PROBE_SRC;

  const unused = Object.keys(SELECTORS).filter((k) => k !== 'version' && !new RegExp('\\bS\\.' + k + '\\b').test(srcs)
    && !new RegExp('SELECTORS\\.' + k + '\\b').test(srcs));
  ok(unused.length === 0, '★ 没有「定义了但没人用」的选择器 key', unused.join(','));
}

console.log('== 3. 候选数组的结构 ==');
{
  const candidates = Object.entries(SELECTORS).filter(([, v]) => Array.isArray(v) && v.some((x) => x && typeof x === 'object'));
  ok(candidates.length > 0, '存在候选数组（layer/sel/note）', String(candidates.length));
  let bad = [];
  for (const [k, arr] of candidates) {
    arr.forEach((x, i) => {
      if (!x || typeof x.sel !== 'string' || typeof x.layer !== 'number' || typeof x.note !== 'string') bad.push(k + '[' + i + ']');
    });
  }
  ok(bad.length === 0, '★ 每个候选都有 sel / layer / note', bad.join(','));
}

console.log('== 4. 注入表达式同时带表与探针 ==');
{
  const expr = installProbeExpression({ safety: { fatalKeywords: ['人脸'], loginHostPattern: 'passport2\\.chaoxing\\.com' } });
  ok(expr.includes('window.__CX_SEL=' + JSON.stringify(SELECTORS)), '注入表达式里带完整 SELECTORS');
  ok(expr.includes(PAGE_PROBE_SRC.slice(0, 40)), '注入表达式里带探针代码');
  ok(expr.includes('window.__CX_KWS='), '注入表达式里带风险关键词');
}

console.log('== 5. 版本号 ==');
{
  ok(Number.isInteger(SELECTORS.version) && SELECTORS.version > 0, 'version 是正整数', String(SELECTORS.version));
  ok(SELECTORS.version >= 7, '★ 版本 >= 7（L3 收口后）', String(SELECTORS.version));
}

console.log('== 6. 探针不得触碰写接口 ==');
{
  ok(!/XMLHttpRequest|fetch\s*\(|\.submit\s*\(/.test(PAGE_PROBE_SRC), '探针里没有 fetch / XHR / form.submit');
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项 ==');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('== 全部通过（' + pass + ' 项）==');
process.exit(0);
