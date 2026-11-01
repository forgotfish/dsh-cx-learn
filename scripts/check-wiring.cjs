#!/usr/bin/env node
/* ============================================================================
 * check-wiring.cjs — 静态检查「跨模块名字是否都接上了线」
 * ============================================================================
 * 为什么必须有它：
 *   把单文件拆成模块时，最容易犯的错不是语法错，而是**漏接一根线**——
 *   `spawn(args)` 写在那儿，语法没问题，node --check 也过，
 *   只有真跑起来才 `ReferenceError: spawn is not defined`。
 *   2026-10-30 上机登录就是这么炸的（`const { spawn } = require(...)` 是解构声明，
 *   拆分生成器没把它算进「可导出名字」，于是 cdp.js 没拿到 import）。
 *
 * 判据（只有一个，避免噪音）：
 *   收集**所有模块**在顶层声明过的名字（含解构），得到一个全局名单；
 *   然后逐文件检查：名单里的名字如果在本文件被引用，
 *   而本文件既没声明它、也没 import 它 → 就是漏接线。
 *
 *   这样对象字面量里的方法名（send/close/navigate…）不会被误报，
 *   因为它们不是任何模块的顶层声明。
 *
 * 用法：node scripts/check-wiring.cjs [--verbose]
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine', 'src');
const ENTRY = path.join(ROOT, 'engine', 'chaoxing-autolearn.js');

const verbose = process.argv.includes('--verbose');

function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 顶层声明（列 0），含解构 */
function topLevelDeclared(body) {
  const out = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) out.add(n); };
  for (const m of body.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of body.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of body.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) add(m[1]);
  for (const m of body.matchAll(/^(?:const|let|var)\s*\{([^{}]*)\}\s*=/gm)) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().replace(/^\.\.\./, '');
      if (!clean) continue;
      add(clean.split(':').pop().split('=')[0].trim());
    }
  }
  return out;
}

/** 本文件里所有「本地可用」的名字 */
function localNames(code) {
  const names = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); };
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().replace(/^\.\.\./, '');
      if (!clean) continue;
      add(clean.split(':').pop().split('=')[0].trim());
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) add(part.trim().replace(/^\.\.\./, ''));
  }
  /* 参数（含方法参数） */
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().replace(/^\.\.\./, '');
      if (!clean || /[=:]/.test(clean.split('=')[0]) && !/^[A-Za-z_$][\w$]*$/.test(clean.split('=')[0].trim())) continue;
      add(clean.split(':').pop().split('=')[0].trim());
    }
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  return names;
}

function importedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\s*\(/g)) {
    for (const part of m[1].split(',')) {
      const clean = part.trim();
      if (!clean) continue;
      const name = clean.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g)) names.add(m[1]);
  return names;
}

/* ---------- 1. 收集所有文件 ---------- */
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(SRC);
files.push(ENTRY);

/* ---------- 2. 全局顶层名字表 ---------- */
const globalDecls = new Map(); // name -> 定义它的文件
for (const f of files) {
  const body = stripNoise(fs.readFileSync(f, 'utf8'));
  for (const name of topLevelDeclared(body)) {
    if (!globalDecls.has(name)) globalDecls.set(name, path.relative(ROOT, f).replace(/\\/g, '/'));
  }
}

/* ---------- 3. 逐文件检查 ---------- */
const EXCLUDE = new Set(['process', 'console', 'require', 'module', 'exports', 'Buffer', 'globalThis']);

let problems = 0;
for (const f of files) {
  const code = stripNoise(fs.readFileSync(f, 'utf8'));
  const local = localNames(code);
  const imported = importedNames(code);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');

  const missing = [];
  for (const [name, owner] of globalDecls) {
    if (owner === rel) continue;
    if (EXCLUDE.has(name) || local.has(name) || imported.has(name)) continue;
    /* 引用判据：非属性访问（前面不是 .）且非对象键（行首缩进 + 冒号） */
    const re = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      const start = m.index + m[1].length;
      const before = code.slice(0, start);
      const after = code.slice(start + name.length);
      const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
      if (/^\s*$/.test(lineBefore) && /^\s*:/.test(after)) continue; // 对象键
      if (/^\s*\(/.test(after) && /[{,]\s*$/.test(lineBefore)) continue; // 对象方法定义
      missing.push({ name, owner, line: before.split('\n').length });
      break;
    }
  }
  if (missing.length) {
    problems += missing.length;
    console.log('✗ ' + rel);
    for (const m of missing) console.log('    L' + m.line + '  ' + m.name + '（顶层声明于 ' + m.owner + '）—— 本文件没声明也没 import');
  } else if (verbose) {
    console.log('✓ ' + rel + '  (本地 ' + local.size + ' / 导入 ' + imported.size + ')');
  }
}

console.log('');
if (problems) {
  console.log('== 接线检查失败：' + problems + ' 处 ==');
  process.exit(1);
}
console.log('== 接线检查通过（' + files.length + ' 个文件，' + globalDecls.size + ' 个顶层名字）==');
