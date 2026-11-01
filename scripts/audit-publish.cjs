#!/usr/bin/env node
/* ============================================================================
 * audit-publish.cjs — 发布物泄漏审计
 * ============================================================================
 *
 * 【为什么需要】
 *   2026-10-31 发现：三个已跟踪文件里写着明文 SSH 口令，仓库当时是**公开**的。
 *   靠人记着「别提交口令」已经失效过一次，所以改成一条能跑的命令。
 *
 * 【管什么】
 *   只管「会被发出去的东西」，不管运行时。
 *     · 运行时（本机/FNOS 自己跑）：enc、cpi、cookie 这类参数允许落盘，方便排查
 *     · 发布物（推仓库 / 打包给别人）：凭据、真实姓名、内网坐标一律不许出现
 *   两者的区别见 docs/SPEC.md §4.6。
 *
 * 【两类规则】
 *   BLOCK  —— 任何情况都不允许，命中即失败（凭据、真实姓名、cookie 值）
 *   WARN   —— 私有仓库阶段允许，转公开前必须清掉（内部路径、服务名、端口）
 *
 * 【扫描范围】
 *   1. 工作区（git 已跟踪 + 未跟踪但未被 gitignore 的文件）
 *   2. 提交历史（--history 时；用于确认某条凭据是否进过历史）
 *
 * 【用法】
 *   node scripts/audit-publish.cjs             # 只扫工作区
 *   node scripts/audit-publish.cjs --history   # 连提交历史一起扫
 *   node scripts/audit-publish.cjs --strict    # WARN 也算失败（转公开前用这个）
 *   node scripts/audit-publish.cjs --json      # 机器可读
 *
 * 退出码：0 = 通过；1 = 有 BLOCK（或 --strict 下的 WARN）；2 = 脚本自身出错
 * ==========================================================================*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/* ── 规则表 ────────────────────────────────────────────────────────────────
 * 每条规则：{ id, level, re, why, fix }
 *   level = 'block' → 命中即失败
 *   level = 'warn'  → 私有仓库允许，转公开前必修
 *
 * 注意：正则里**不要**写真实口令本身，否则这个脚本自己就成了泄漏源。
 *       凭据类一律用「形状」匹配（长度 + 字符集 + 前缀）。
 */
const RULES = [
  /* ===== BLOCK：凭据与身份 ===== */
  {
    id: 'secret-github-token',
    level: 'block',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    why: 'GitHub 令牌',
    fix: '立即到 GitHub 撤销该令牌，并从文件中删除',
  },
  {
    id: 'secret-openai-style',
    level: 'block',
    re: /\bsk-[A-Za-z0-9]{20,}\b/,
    why: 'API 密钥（sk- 前缀）',
    fix: '撤销密钥，改为从环境变量读取',
  },
  {
    id: 'secret-assigned',
    level: 'block',
    /* 形如  FNOS_PASS='xxx' / password: "xxx" / apiKey = "xxx"，值不是占位符 */
    re: /(?:pass(?:word)?|passwd|secret|token|api[_-]?key|apikey)\s*[:=]\s*['"]([^'"\s]{6,})['"]/gi,
    allow: isPlaceholder,
    why: '疑似把凭据写成字面量（口令 / 令牌 / 密钥）',
    fix: '改成从环境变量读取，并在缺失时明确报错',
  },
  {
    id: 'secret-assigned-bare',
    level: 'block',
    /* ★ 不带引号的写法：`FNOS_PASS=fixturepass9`。
       这一条是被历史扫描发现的漏网 —— 加引号的规则抓不到它。
       `(?<![.\w])` 排除属性赋值（`env.CX_LLM_ASK_TOKEN = askToken`）：
       那种写法右边是变量引用，不是字面量凭据，属误报。 */
    re: /(?<![.\w])([A-Z][A-Z0-9_]*(?:PASS|PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY))\s*[:=]\s*([^\s'"<>(){}\[\],;:`]{4,})/g,
    allow: (v, m) => {
      /* 允许：空值、占位符、从环境/变量读取、仅变量名转发 */
      if (!v || v.length < 4) return true;
      if (isPlaceholder(v)) return true;
      if (/^(process\.env|process|\$\{?|env\.)/i.test(v)) return true;
      /* 允许 `FNOS_PASS=FNOS_PASS` 这种同名声明的右值（值本身是变量名） */
      if (m && new RegExp('^[A-Z][A-Z0-9_]*$').test(v) && m[1] === v) return true;
      /* 允许小驼峰标识符：`X_TOKEN = askToken` 是把变量赋给变量，不是字面量凭据。
         必须**含大写字母**才算标识符（`askToken`）——
         纯小写的 `fixturepass9` / `hunter2` 正是典型口令形态，绝不能放行。 */
      if (/^[a-z][A-Za-z0-9]*$/.test(v) && /[A-Z]/.test(v)) return true;
      return false;
    },
    why: '疑似把凭据写成字面量（无引号写法）',
    fix: '改成从环境变量读取，并在缺失时明确报错',
  },
  {
    id: 'secret-sudo-echo',
    level: 'block',
    /* echo '明文' | sudo -S  —— 历史上真实发生过 */
    re: /echo\s+['"]([^'"\s]{4,})['"]\s*\|\s*sudo\s+-S/gi,
    allow: (v) => /^\$|^<.*>$/.test(v),
    why: '把口令直接 echo 给 sudo',
    fix: '改成 echo "$ENV_VAR" | sudo -S',
  },
  {
    id: 'identity-realname',
    level: 'block',
    re: /[\u4e00-\u9fa5]{1,3}(?=同学|老师|先生|女士)/,
    why: '疑似真实姓名',
    fix: '改用「某用户」「nickname 非空」等中性表述',
  },

  /* ===== WARN：私有坐标（私有仓库允许，公开前必修）===== */
  {
    id: 'infra-internal-path',
    level: 'warn',
    re: /\/vol[0-9]+\/@app[a-z]+\//,
    why: '内部 NAS 路径',
    fix: '改成 <共享目录> 之类的占位符，或走环境变量',
  },
  {
    id: 'infra-home-path',
    level: 'warn',
    re: /C:\\Users\\[A-Za-z0-9_.-]+\\/i,
    why: '本机用户目录路径',
    fix: '改成 <用户目录> 或 process.env',
  },
  {
    id: 'infra-private-ip',
    level: 'warn',
    /* ★ 127.0.0.1 排除：它是 loopback，所有机器都一样，不是「能反推出你在哪」
       的私有坐标。源码里到处写 `host: '127.0.0.1'` 是正常的，把它算成泄漏
       只会制造噪声 —— 噪声一多，审计就没人看了。 */
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    why: '内网 IP',
    fix: '改成 <内网地址>',
  },
  {
    id: 'infra-service-name',
    level: 'warn',
    re: /\bdsh(?:sh)?-admin\b|\bdsh-user@/,
    why: '私有部署的 systemd 服务名',
    fix: '改成 <实例服务名>',
  },
  {
    id: 'infra-jump-host',
    level: 'warn',
    re: /fnos\.py|WorkBuddy/,
    why: '私有跳板脚本 / 目录',
    fix: '改成 <跳板脚本>',
  },
];

/* ── 不扫的文件 ────────────────────────────────────────────────────────────
 * · 本脚本自身：规则里必然出现关键字（否则没法匹配）
 * · docs/SPEC.md：会引用规则本身举例
 * · 二进制与运行期产物
 */
const SKIP_FILES = new Set([
  'scripts/audit-publish.cjs',
  /* 审计测试必须写「假的泄漏样本」才能验证审计能不能抓到它们，
     否则测试本身没法写。这个文件里的字符串是**测试夹具**，不是真凭据。
     为避免有人把真口令塞进来当夹具，测试里用的都是明显杜撰的值
     （fixturepass9 / hunter2 / S3cr3tValue 之类），且本文件不参与发布。 */
  'scripts/audit-publish.test.cjs',
  /* 脱敏测试也必须写「假的凭据样本」才能验证脱敏有没有生效。
     这里用的都是明显杜撰的值（hunter2 / abcd1234 / SECRETENC 之类），
     且本文件不参与发布。 */
  'engine/redact.test.cjs',
]);

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.tgz', '.7z', '.exe', '.dll', '.so', '.node',
  '.woff', '.woff2', '.ttf', '.eot', '.map',
]);

/* 这些目录永远不看：运行期产物、依赖、未跟踪的本地归档 */
const SKIP_DIR = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)engine\/\.state\//,
  /(^|\/)\.local-login\//,
  /(^|\/)\.local-profile\//,
  /(^|\/)docs\/memory\//,
  /(^|\/)_archive\//,
  /(^|\/)scripts\/\.migration\//,
];

/* ── 收集待扫文件 ──────────────────────────────────────────────────────── */

function listFiles() {
  let tracked = [];
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    tracked = out.split('\0').filter(Boolean);
  } catch (e) {
    throw new Error('无法读取 git 索引：' + (e.message || e));
  }

  /* ★ 未跟踪文件也必须扫。
     发布物 = 仓库里「会被人看到的东西」，未跟踪文件一样会被 commit 上去。
     之前只扫 git ls-files，导致刚写出来还没 add 的文件完全不在审计范围内。 */
  let untracked = [];
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    untracked = out.split('\0').filter(Boolean);
  } catch (_) { /* 不是 git 仓库时忽略 */ }

  const all = Array.from(new Set(tracked.concat(untracked)));
  return all
    .filter((f) => !SKIP_FILES.has(f))
    .filter((f) => !SKIP_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => !SKIP_DIR.some((re) => re.test(f)))
    .filter((f) => {
      /* 未跟踪项可能是目录；只保留真实存在的文件 */
      try { return fs.statSync(path.join(ROOT, f)).isFile() } catch (_) { return false }
    });
}

/**
 * 判断一个值是不是「占位符」而不是真凭据。
 * 抽成函数是因为多条规则都要用，且必须行为一致 —— 曾经因为只有一条规则
 * 认占位符，导致无引号写法整条漏网。
 */
function isPlaceholder(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true;
  if (/^<.*>$/.test(s)) return true;              // <见记忆归档>
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(s)) return true; // $FNOS_PASS / ${X}
  if (/^(process\.env|process|env\.)/i.test(s)) return true;
  if (/^(x{3,}|\*{3,}|\.{3,}|-{3,})$/i.test(s)) return true;
  if (/^(redacted|hidden|changeme|placeholder|example|your[_-].*|todo|none|null|undefined)$/i.test(s)) return true;
  return false;
}

/* ── 逐行扫描 ──────────────────────────────────────────────────────────── */

function scanText(file, text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      /* 每条规则用独立副本，避免 g 标志的 lastIndex 串场 */
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        /* 取最后一个捕获组作为「值」：不同规则的组数不同，
           `secret-assigned-bare` 的组 1 是键名、组 2 才是值。
           曾经写死 m[1] 导致把键名当值去豁免 → 整条规则形同失效。 */
        const captured = m.length > 2 ? m[m.length - 1] : m[1];
        if (rule.allow && captured !== undefined && rule.allow(captured, m)) continue;
        hits.push({
          file,
          line: i + 1,
          rule: rule.id,
          level: rule.level,
          why: rule.why,
          fix: rule.fix,
          snippet: mask(line.trim().slice(0, 120)),
        });
        if (m.index === re.lastIndex) re.lastIndex += 1; /* 零宽匹配保护 */
      }
    }
  }
  return hits;
}

/**
 * 把可能敏感的片段打码，避免审计报告自己成为泄漏源。
 *
 * ★ 2026-10-31 修：原来的实现只处理「引号包裹」和已知前缀，
 *   结果 `FNOS_PASS=fixturepass9` 这种无引号写法被原样打印 —— 审计工具
 *   成了新的泄漏渠道。现在先按「键=值」形态打码，再处理前缀令牌。
 */
function mask(s) {
  let out = String(s);
  /* 无引号赋值：USER_PASS=xxx / API_KEY: xxx */
  out = out.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:PASS|PASSWORD|PASSWD|SECRET|TOKEN|KEY)\s*[:=]\s*)([^\s'"<>(){}\[\],;:`]+)/gi,
    (all, head, v) => (isPlaceholder(v) ? all : head + v.slice(0, 2) + '***')
  );
  /* 引号包裹 */
  out = out.replace(/([:=]\s*['"])([^'"\s]{4,})(['"])/g, (all, a, v, c) => a + v.slice(0, 2) + '***' + c);
  /* 前缀令牌 */
  out = out.replace(/\b(gh[pousr]_)[A-Za-z0-9]{6,}/g, '$1***');
  out = out.replace(/\b(sk-)[A-Za-z0-9]{6,}/g, '$1***');
  return out;
}

/* ── 历史扫描 ──────────────────────────────────────────────────────────── */

/**
 * 扫历史里的新增行。
 *
 * ★ 为什么不用 `git log -S <关键字>`：
 *   -S 搜的是「某字符串出现次数变化」，而凭据规则的关键字（如 `FNOS_PASS`）
 *   本身是合法变量名，会命中所有出现过该变量名的提交 → 大量误报。
 *   正确做法是**不预设口令长什么样**，而是把历史 patch 的新增行拿出来，
 *   用和工作区完全相同的规则去检测。
 *
 * 只扫 BLOCK 级规则：历史里的私有路径早已在私有仓库内，清不干净也没必要清；
 * 需要确认真伪的只有凭据与身份。
 */
function scanHistory() {
  const hits = [];
  let patch = '';
  try {
    patch = execFileSync('git', ['log', '-p', '--all', '--no-color', '--unified=0'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return [{
      file: '(提交历史)', line: 0, rule: 'history-unavailable', level: 'warn',
      why: '无法读取提交历史：' + String((e && e.message) || e).slice(0, 120),
      fix: '确认 git 可用、仓库完整', snippet: '',
    }];
  }

  const blockRules = RULES.filter((r) => r.level === 'block');
  const lines = String(patch).split(/\r?\n/);
  let commit = '';
  let file = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const mc = /^commit ([0-9a-f]{7,40})/.exec(line);
    if (mc) { commit = mc[1].slice(0, 8); continue }
    const mf = /^\+\+\+ b\/(.+)$/.exec(line);
    if (mf) { file = mf[1]; continue }

    /* 只看新增内容 */
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (!body.trim()) continue;

    for (const rule of blockRules) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m;
      while ((m = re.exec(body)) !== null) {
        const captured = m.length > 2 ? m[m.length - 1] : m[1];
        if (rule.allow && captured !== undefined && rule.allow(captured, m)) { if (m.index === re.lastIndex) re.lastIndex += 1; continue }
        hits.push({
          file: file || '(未知文件)',
          line: 0,
          rule: rule.id,
          level: 'block',
          why: rule.why + ' 出现在历史提交 ' + commit + ' 的新增行里',
          fix: '该提交若未推送可改写历史；已推送需 git filter-repo 后强推，并轮换该凭据',
          snippet: mask(body.trim().slice(0, 120)),
        });
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }
  return hits;
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const wantHistory = argv.includes('--history');
  const strict = argv.includes('--strict');
  const asJson = argv.includes('--json');

  const files = listFiles();
  let hits = [];

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8') } catch (_) { continue }
    hits = hits.concat(scanText(rel, text));
  }

  if (wantHistory) hits = hits.concat(scanHistory());

  const blocks = hits.filter((h) => h.level === 'block');
  const warns = hits.filter((h) => h.level === 'warn');
  const failed = blocks.length > 0 || (strict && warns.length > 0);

  if (asJson) {
    console.log(JSON.stringify({ ok: !failed, scanned: files.length, blocks, warns }, null, 2));
    process.exit(failed ? 1 : 0);
  }

  console.log('发布物泄漏审计');
  console.log('  扫描文件：' + files.length + ' 个（git 已跟踪）');
  if (wantHistory) console.log('  历史扫描：已开启');
  console.log('  模式    ：' + (strict ? '严格（WARN 也失败）' : '普通（仅 BLOCK 失败）'));
  console.log('');

  const dump = (arr, title) => {
    if (!arr.length) return;
    console.log('── ' + title + '（' + arr.length + '）──');
    for (const h of arr) {
      console.log('  ✗ ' + h.file + (h.line ? ':' + h.line : '') + '  [' + h.rule + ']');
      console.log('      ' + h.why);
      console.log('      原文：' + h.snippet);
      console.log('      修法：' + h.fix);
    }
    console.log('');
  };

  dump(blocks, 'BLOCK 必须修');
  dump(warns, 'WARN 私有仓库允许，转公开前必修');

  if (!hits.length) {
    console.log('✓ 未发现泄漏（' + files.length + ' 个文件全部干净）');
  } else if (!failed) {
    console.log('✓ 无 BLOCK 级问题；仍有 ' + warns.length + ' 处 WARN 属私有坐标（私有仓库可接受）');
  } else {
    console.log('✗ 审计失败：存在 ' + blocks.length + ' 处 BLOCK 级泄漏');
  }

  process.exit(failed ? 1 : 0);
}

/* ── 导出（供测试复用同一份实现，避免测试与实现漂移）──────────────────────
 * 这是 L0 §10.1 的要求：测试必须调用真实实现，不能重写一份副本。
 * 曾经的 resume-position.test.cjs 就是重写了一份算法快照，
 * 结果保护的是已经不存在的旧逻辑。
 */
module.exports = {
  RULES,
  scanText,
  scanHistory,
  listFiles,
  main,
  isPlaceholder,
  mask,
};

/* 直接执行时才跑 CLI；被 require 时只导出 */
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('审计脚本自身出错：' + ((e && e.stack) || e));
    process.exit(2);
  }
}
