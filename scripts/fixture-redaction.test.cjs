#!/usr/bin/env node
/* ============================================================================
 * fixture-redaction.test.cjs — fixture 不许带授权参数
 * ============================================================================
 *
 * 【为什么】
 *   `docs/fixtures/*.json` 是真实页面 DOM 快照，会被提交进仓库。
 *   第一次抓取时漏了脱敏：帧 URL、HTML 正文、顶层 browser 字段里
 *   全带着完整的 `enc` / `cpi` / `openc`。
 *   这些参数能直接打开对应课程页，属于授权参数，不该进版本库。
 *
 * 【能失败证明（2026-10-31 实测）】
 *   去掉 capture-fixture.cjs 里的 redactHtml → 重新抓 → 本测试变红。
 *   已实测：改坏退出 1，恢复退出 0。
 *
 * 运行：node scripts/fixture-redaction.test.cjs
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'fixtures');

const fails = [];
function ok(cond, name, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); fails.push(name); }
}

/* 授权参数：值至少有 6 位，且前面不是字母数字（避免误伤 `xenc=` 之类） */
const PARAM_RE = /(?<![A-Za-z0-9_])(enc|cpi|openc|uuid)=([A-Za-z0-9%._-]{6,})/g;

let files = [];
try {
  files = fs.readdirSync(DIR).filter((n) => n.endsWith('.json'));
} catch (_) {
  console.log('（docs/fixtures 不存在，跳过）');
  process.exit(0);
}

console.log('== fixture 脱敏检查（' + files.length + ' 个文件）==');
if (!files.length) {
  console.log('  （还没有 fixture，跳过）');
  process.exit(0);
}

let totalLeaks = 0;
for (const f of files) {
  const p = path.join(DIR, f);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8') } catch (e) {
    ok(false, f + ' 可读', e.message);
    continue;
  }
  const hits = [];
  PARAM_RE.lastIndex = 0;
  let m;
  while ((m = PARAM_RE.exec(raw)) !== null) {
    hits.push(m[1] + '=' + m[2].slice(0, 8) + '…');
    if (hits.length > 5) break;
  }
  totalLeaks += hits.length;
  ok(hits.length === 0, f + ' 无未脱敏授权参数',
    hits.length ? hits.join(', ') : undefined);

  /* 结构完整性：脱敏不能把 DOM 改坏（抽一个关键选择器确认还在） */
  const hasToc = /posCatalog_select|chapter_item/.test(raw);
  ok(hasToc, f + ' 目录选择器仍在（脱敏没破坏结构）');
}

console.log('');
if (fails.length) {
  console.log('== 失败 ' + fails.length + ' 项 ==');
  fails.forEach((x) => console.log('  - ' + x));
  process.exit(1);
}
console.log('== 全部通过 ==');
process.exit(0);
