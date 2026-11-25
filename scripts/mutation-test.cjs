#!/usr/bin/env node
/* ============================================================================
 * mutation-battery.cjs —— 变异测试（证明测试有牙）
 *
 * 做法：对源码逐条注入「故意的 bug」（变异），跑对应测试：
 *   · 测试变红  → 该 bug 被测试覆盖（好事）
 *   · 测试仍绿  → 测试有洞（漏测）
 * 每条变异跑完**必定还原原文件**（finally 里写回原始字节）。
 *
 * 用法：node scripts/mutation-test.cjs [--scope=d066|d065|d064|all]
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const scopeArg = (process.argv.find((a) => a.startsWith('--scope=')) || '').slice(8) || 'all';
const node = process.execPath;

/* 每条：{id, scope, file, old, new, test, why} */
const MUTATIONS = [
  /* ---------------- D-066 探针 ---------------- */
  {
    id: 'M1', scope: 'd066',
    file: 'engine/src/learn/selectors.js',
    /* 单行锚点：文件是 CRLF，多行锚点会被 \r 干扰 */
    old: '      ok: played,',
    new: '      ok: true,',
    test: 'engine/playback-fallback.test.cjs',
    why: 'play() 同步抛时仍报 ok:true → A6 应红',
  },
  {
    id: 'M2', scope: 'd066',
    file: 'engine/src/learn/selectors.js',
    old: '        if (m && m[0].toLowerCase() === want) { v = all[i]; break; }',
    new: '        if (m) { v = all[i]; break; }',
    test: 'engine/playback-fallback.test.cjs',
    why: '不按 objectid 匹配、抓到第一个就播 → A1 应红',
  },
  {
    id: 'M3', scope: 'd066',
    file: 'engine/src/learn/selectors.js',
    old: '    try { v.muted = true; } catch (e2) { /* ignore */ }',
    new: '    /* mutation: 去掉静音 */',
    test: 'engine/playback-fallback.test.cjs',
    why: '不静音 → A1 断言 muted 应红',
  },
  {
    id: 'M4', scope: 'd066',
    file: 'engine/src/learn/machine.js',
    old: '        if (!fb.ok) {',
    new: '        if (false) {',
    test: 'engine/playback-fallback.test.cjs',
    why: '兜底失败也当成功 → B3 应红',
  },
  {
    id: 'M5', scope: 'd066',
    file: 'engine/src/learn/machine.js',
    old: '    if (!(rate > 0) || rate === 1) return;',
    new: '    return;',
    test: 'engine/playback-fallback.test.cjs',
    why: '倍速永不应用 → B5 应红',
  },
  {
    id: 'M6', scope: 'd066',
    file: 'engine/src/learn/machine.js',
    old: '        const verified = await this._verifyVideoStarted(oid, beforeTime, 6000, frameId);',
    new: '        const verified = { ok: true, note: \'mutation: skip verify\' };',
    test: 'engine/playback-fallback.test.cjs',
    why: '跳过起播验证 → B4（调用成功但没真播）应红',
  },
  /* ---------------- D-065 provider 链 ---------------- */
  {
    id: 'M7', scope: 'd065',
    file: 'engine/src/core/ai-providers.js',
    old: '        if (String(text || \'\').trim()) {',
    new: '        if (true) {',
    test: 'engine/ai-providers.test.cjs',
    why: '空文本也算成功 → 回退链用例（4b）应红',
  },
  {
    id: 'M8', scope: 'd065',
    file: 'engine/src/core/ai-providers.js',
    old: '      if (inst && typeof inst.ask === \'function\' && inst.available()) instances.push(inst);',
    new: '      if (inst && typeof inst.ask === \'function\') instances.push(inst);',
    test: 'engine/ai-providers.test.cjs',
    why: '不检查 available() → M8 对应用例应红',
  },
  {
    id: 'M9', scope: 'd065',
    file: 'engine/src/core/ai-providers.js',
    old: '    const err = new Error(\'ALL_PROVIDERS_FAILED [\' + errors.join(\' | \') + \']\');\n    err.code = \'ALL_PROVIDERS_FAILED\';\n    throw err;',
    new: '    return { ok: true, text: \'mutation-fake\' };',
    test: 'engine/ai-providers.test.cjs',
    why: '全失败也返回成功 → 用例 5 应红',
  },
  /* ---------------- D-064 多卡片 ---------------- */
  {
    id: 'M10', scope: 'd064',
    file: 'engine/src/learn/selectors.js',
    old: "        if (oc.indexOf('changeDisplayContent') < 0) continue;",
    new: '        /* mutation: 不再鉴别 */',
    test: 'engine/cards-switch.test.cjs',
    why: '不再鉴别 changeDisplayContent → A1（只认 2 张真卡片）应红',
  },
  {
    id: 'M11', scope: 'd064',
    file: 'engine/src/learn/machine.js',
    old: '    const next = col.cards.find((c) => !this._cardScan.has(String(c.cardid)));',
    new: '    const next = null;',
    test: 'engine/cards-switch.test.cjs',
    why: '永不找未采集的卡（永不切卡）→ B2 应红',
  },
  {
    id: 'M12', scope: 'd064',
    file: 'engine/src/learn/machine.js',
    old: '      if (r.failed) return false;',
    new: '      if (r.failed) continue;   /* mutation: 回退到旧 bug —— 让 failed 卡虚过并集 */',
    test: 'engine/cards-switch.test.cjs',
    why: 'failed 卡重新被忽略（并集虚 true）→ B5「failed 卡不得参与并集通过」应红',
  },
  /* ---------------- D-067（第二批破坏测试的产物） ---------------- */
  {
    id: 'M13', scope: 'd067',
    file: 'engine/src/learn/selectors.js',
    old: '    if (!v && all.length === 1) { v = all[0]; }',
    new: '    if (false) { v = all[0]; }',
    test: 'engine/playback-chaos2.test.cjs',
    why: '去掉「单播放器兜底」→ C1/C2/C5（未加载视频）应红',
  },
  {
    id: 'M14', scope: 'd067',
    file: 'engine/src/learn/machine.js',
    old: '      } else if (info.ok && info.cards.length === 0) {',
    new: '      } else if (false) {',
    test: 'engine/d069-union-gate.test.cjs',
    why: '「读到成功但列表为空」不再判确认无 → 该用例应红（会一直等到超时）',
  },
  /* ---------------- D-068（第三批） ---------------- */
  {
    id: 'M15', scope: 'd068',
    file: 'engine/src/learn/machine.js',
    old: '    if (!this._cardCollect || this._cardCollect.key !== secKey) {',
    new: '    if (false) {',
    test: 'engine/playback-chaos3.test.cjs',
    why: '切节不清卡片账 → E1（陈旧账卡住新节）应红',
  },
  {
    id: 'M16', scope: 'd068',
    file: 'engine/src/learn/selectors.js',
    old: '    try { m.v.playbackRate = r; }',
    new: '    try { m.v.playbackRate = r; m.v.play(); }',
    test: 'engine/playback-chaos3.test.cjs',
    why: 'setRate 里偷偷 play() → E3 应红',
  },
  {
    id: 'M17', scope: 'd068',
    file: 'engine/src/learn/machine.js',
    old: '    if (tries > 3) {',
    new: '    if (false) {',
    test: 'engine/d069-union-gate.test.cjs',
    why: '取消「同一张卡限次」→ F3 后续点击不再受控（配合 _cardAwait 失效时暴露）',
  },
  /* ---------------- D-069（复测报告三处 fail-open） ---------------- */
  {
    id: 'M18', scope: 'd069',
    file: 'engine/src/learn/machine.js',
    old: '    if (col.state === \'pending\' || col.state === \'timeout\') return false;',
    new: '    if (col.state === \'pending\' || col.state === \'timeout\') return null;',
    test: 'engine/d069-union-gate.test.cjs',
    why: '采集未完成/超时不再 fail-closed（改成 null 放行）→ F2 应红',
  },
  {
    id: 'M19', scope: 'd069',
    file: 'engine/src/learn/machine.js',
    old: '      if (!r) return false;                       /* 有卡未采集 → 不许切节（fail-closed） */',
    new: '      if (!r) continue;',
    test: 'engine/d069-union-gate.test.cjs',
    why: '未采集的卡被跳过 → F2「只采 1/2 张」应红（复测 1.3 漏刷的形态）',
  },
  {
    id: 'M20', scope: 'd069',
    file: 'engine/src/learn/machine.js',
    old: '    if (!col || col.key !== secKey) return false;',
    new: '    if (!col) return null;',
    test: 'engine/d069-union-gate.test.cjs',
    why: '不再绑 chapterId → F2「换节后立刻 false」应红',
  },
  {
    id: 'M21', scope: 'd069',
    file: 'engine/src/learn/machine.js',
    old: '      if (doneNow.ok && !greenEarly) {',
    new: '      if (doneNow.ok) {',
    test: 'engine/d069-union-gate.test.cjs',
    why: '恢复「平台标绿就切节」→ F4 应红（86% 直接切走）',
  },
  /* ---------------- D-070（targetKinds + 状态落盘） ---------------- */
  {
    id: 'M22', scope: 'd070',
    file: 'engine/src/learn/judge.js',
    old: '  return out.length ? out : DEFAULT_TARGET_KINDS.slice();',
    new: '  return out;',
    test: 'engine/d070-targetkinds-state.test.cjs',
    why: '空/非法 targetKinds 不再回落默认 → A4 应红',
  },
  {
    id: 'M23', scope: 'd070',
    file: 'engine/src/learn/judge.js',
    old: "  const kinds = normalizeKinds(targetKinds);\n  const media = scoped.filter((t) => t && isTargetKind(t, kinds));",
    new: "  const kinds = normalizeKinds(targetKinds);\n  const media = scoped.filter((t) => t && (t.kind === 'video' || t.kind === 'audio'));",
    test: 'engine/d070-targetkinds-state.test.cjs',
    why: '忽略 targetKinds、写死 video/audio → A2/A3 应红',
  },
  {
    id: 'M24', scope: 'd070',
    file: 'engine/state-bus.js',
    old: '  if (idx >= 0) list[idx] = item; else list.push(item);',
    new: '  list.push(item);',
    test: 'engine/d070-targetkinds-state.test.cjs',
    why: '不 upsert、只追加 → B1「K1 只保留一条」应红',
  },
  {
    id: 'M25', scope: 'd070',
    file: 'engine/src/learn/machine.js',
    old: '      this._persistSectionState(col);',
    new: '      /* mutation: 不落盘 */',
    test: 'engine/d070-targetkinds-state.test.cjs',
    why: '采集后不落盘 → 该路径无断言，仅作占位（见下方说明）',
  },
];

const list = MUTATIONS.filter((m) => scopeArg === 'all' || m.scope === scopeArg);

function runTest(rel) {
  const r = spawnSync(node, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

if (require.main === module) {
  console.log('变异测试：共 ' + list.length + ' 条（scope=' + scopeArg + '）');
  console.log('预期：每条都让测试**变红**；若仍绿 = 漏测\n');

  let caught = 0;
  const missed = [];

  for (const m of list) {
    const abs = path.join(ROOT, m.file);
    const orig = fs.readFileSync(abs, 'utf8');
    let applied = false;
    try {
      if (!orig.includes(m.old)) {
        console.log('  ⚠ ' + m.id + ' 跳过：锚点未匹配（' + m.file + '）');
        missed.push(m.id + ' (anchor-miss)');
        continue;
      }
      fs.writeFileSync(abs, orig.replace(m.old, m.new), 'utf8');
      applied = true;
      const t = runTest(m.test);
      const red = t.status !== 0;
      if (red) { caught += 1; console.log('  ✓ ' + m.id + ' 注入后测试变红（符合预期）— ' + m.why); }
      else { missed.push(m.id); console.log('  ✗ ' + m.id + ' 注入后测试**仍绿**（漏测！）— ' + m.why); }
    } finally {
      if (applied) fs.writeFileSync(abs, orig, 'utf8');   /* 必定还原 */
    }
  }

  console.log('\n抓到 ' + caught + ' / ' + list.length);
  if (missed.length) { console.log('漏测/未注入：' + missed.join(', ')); process.exit(1); }
  console.log('全部变异均被测试捕获 ✓');










}

/* ★ 供 scripts/lessons-check.cjs 做「锚点唯一性」自检；直接运行时不受影响 */
module.exports = { MUTATIONS };
