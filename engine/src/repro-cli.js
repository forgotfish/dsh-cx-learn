'use strict';
/* ============================================================================
 * repro-cli.js —— `--export-repro` / `--replay` 的命令实现（D-075）
 *
 * export-repro：从**本机已落盘的诊断快照 + learn.json** 生成脱敏复现包。
 *              不新开浏览器、不再访问课程页，所以：不产生额外流量、不触碰账号、
 *              也不需要主人再登录一次。复测者跑完一轮后执行即可。
 *
 * replay：      把复现包还原成夹具，用 mock 适配器驱动真状态机。
 *              维护者**不需要任何账号**就能确定性复现问题并回归。
 * ==========================================================================*/
const fs = require('node:fs');
const path = require('node:path');

const repro = require('./repro.js');

function stateDir() {
  return process.env.CX_STATE_DIR || path.join(__dirname, '..', '.state');
}

/** 读目录下最近的 N 个诊断快照（按文件名时间戳排序） */
function readRecentSnapshots(dir, limit) {
  const out = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
    const pick = files.slice(-(limit || 3));
    for (const f of pick) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && typeof j === 'object') { j.__file = f; out.push(j); }
      } catch (_) { /* 坏文件跳过 */ }
    }
  } catch (_) { /* 目录不存在 */ }
  return out;
}

function readLearn() {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), 'learn.json'), 'utf8'));
  } catch (_) { return null; }
}

function engineEnv() {
  /* ★ D-078（复测）：原来读的是引擎内部 VERSION（恒 1.0.0），导致 0.3.5 与 0.3.8 导出的包
     完全一样、没法把包归到某个 release。现在读**插件** package.json 的 version。 */
  let engineVersion = '';
  let pluginVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    pluginVersion = String(pkg.version || '');
  } catch (_) { /* ignore */ }
  try { engineVersion = require('../chaoxing-autolearn.js').VERSION || ''; } catch (_) { /* ignore */ }
  return {
    engineVersion,
    pluginVersion,
    dshVersion: String(process.env.DSH_VERSION || '').slice(0, 40),
    nodeMajor: Number(String(process.versions.node || '').split('.')[0]) || 0,
    osFamily: process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux'),
    browserFamily: String(process.env.CX_BROWSER_FAMILY || '').slice(0, 16),
  };
}

/**
 * --export-repro [--out=<file>] [--token] [--keep-titles] [--snapshots=N]
 * 输出：写 .state/repro-<ts>.json；--token 时额外打印单行口令
 */
function exportRepro(args) {
  const a = args || {};
  const sd = stateDir();
  const snapshots = readRecentSnapshots(path.join(sd, 'diagnostics'), Number(a.snapshots) || 3);
  const learn = readLearn();

  const pkg = repro.sanitizeRepro({ snapshots, learn, env: engineEnv() }, {
    keepTitles: a['keep-titles'] === true,
    maxSectionsInBundle: Number(a.sections) > 0 ? Number(a.sections) : undefined,
    sectionIndex: a.section,
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = String(a.out || path.join(sd, 'repro-' + ts + '.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const report = {
    ok: true,
    file: out,
    bytes: fs.statSync(out).size,
    snapshotsUsed: snapshots.length,
    hasSection: !!pkg.section,
    sectionsInBundle: Array.isArray(pkg.sections) ? pkg.sections.length : 0,
    cardCount: pkg.section ? pkg.section.cards.length : 0,
    currentCardHasNoTasks: pkg.signals.currentCardHasNoTasks,
    note: '文件已脱敏：不含 enc/cpi/openc/cookie/账号/路径，标识符只以 h_ hash 出现',
    /* ★ D-078（复测第 2 条）：导出时机很重要 —— 跑完一轮再导，拿到的是「跑完时那一节」的
       平凡态（例如单卡已完成），出问题的节结构已经不在 learn.sections 里了。
       所以：**症状还在屏幕上时就导**。这里给出显式提醒。 */
    tip: '请在「症状还在屏幕上」时导出（例如卡在某一节不动时立刻执行）；跑完一轮再导只能拿到收尾那一节的平凡态。',
    lastSection: pkg.section ? { titleKind: pkg.section.titleKind, cards: pkg.section.cards.length, state: pkg.section.state } : null,
    snapshotsHint: snapshots.length === 0
      ? '本次没有诊断快照（0 张）。若确实卡住了，说明还没触发主动快照：0.3.9 起「连续 3 拍结不了论」会自动拍一张。'
      : null,
  };
  if (a.token === true) report.token = repro.packToken(pkg);
  return report;
}

/**
 * --replay=<file|token> [--ticks=N] [--json]
 * 用复现包驱动状态机，断言「有限拍内产出结论」。返回 {ok, ticks, advanced, stopReason, counters}
 */
async function replay(args, deps) {
  const a = args || {};
  const src = String(a.replay || a._ || '');
  if (!src || src === 'true') throw new Error('缺少 --replay=<文件路径 或 REPRO1.xxx 口令>');

  let pkg;
  if (src.indexOf('REPRO1.') === 0) pkg = repro.unpackToken(src);
  else pkg = JSON.parse(fs.readFileSync(src, 'utf8'));

  if (!pkg || pkg.format !== repro.FORMAT) throw new Error('不是合法的复现包（format 不符）');

  const E = deps && deps.engine ? deps.engine : require('../chaoxing-autolearn.js');
  const fx = repro.buildReplayFixture(pkg);

  const cfg = E.mergeConfig(E.CONFIG, {
    humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
    safety: { sectionStuckTimeoutMs: Number(a['stuck-ms']) > 0 ? Number(a['stuck-ms']) : 5000 },
  });
  E.humanize.configure(cfg.humanize);

  const adapter = {
    engine: 'repro',
    async evalInFrame() { return { ok: false, noProbe: true }; },
    async click() { return { mode: 'repro' }; },
    async jsClick() { return { ok: false }; },
    getTargetId() { return 'top'; },
    shutdown() { },
  };

  const m = new E.LearnMachine(adapter, cfg);
  m.gatherState = async () => fx.st;
  m.advanceSection = async () => ({ progress: true, outcome: 'SECTION_ADVANCED' });
  m._cardCollect = fx.cardCollect;
  m._cardScan = fx.cardScan;
  m._lastInventory = fx.inventory;
  m._videoSeenThisSection = !!(pkg.signals && pkg.signals.currentCardHasNoTasks);
  m._cardSwitchAt = Date.now() - 60000;
  /* 复现包只描述结构，不重放「采集动作」——禁用重录以免覆盖包里的采集结果 */
  m._recordCurrentCard = () => { };

  const before = m.counters.sectionsCompleted + m.counters.sectionsSkipped;
  const maxTicks = Number(a.ticks) > 0 ? Number(a.ticks) : 40;
  let ticks = 0;
  let advanced = 0;
  const origAdvance = m.advanceSection;
  m.advanceSection = async (st) => { advanced += 1; return origAdvance(st); };

  for (; ticks < maxTicks && !m.stopReason && advanced === 0; ticks += 1) {
    await m.tick();
  }
  const after = m.counters.sectionsCompleted + m.counters.sectionsSkipped;

  const converged = advanced >= 1 || !!m.stopReason;
  return {
    ok: converged && (after - before) === 1,
    converged,
    ticks: ticks + 1,
    advanced,
    stopReason: m.stopReason || null,
    outcome: advanced ? 'advanced' : (m.stopReason || 'spun'),
    counters: {
      sectionsCompleted: m.counters.sectionsCompleted,
      sectionsSkipped: m.counters.sectionsSkipped,
      delta: after - before,
    },
    bundle: {
      createdAt: pkg.createdAt,
      cardCount: pkg.section ? pkg.section.cards.length : 0,
      currentCardHasNoTasks: !!(pkg.signals && pkg.signals.currentCardHasNoTasks),
      taskCount: Array.isArray(pkg.tasks) ? pkg.tasks.length : 0,
    },
  };
}

module.exports = { exportRepro, replay, stateDir, readRecentSnapshots, readLearn };
