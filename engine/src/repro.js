'use strict';
/* ============================================================================
 * repro.js —— 复现包（D-075）
 *
 * 目的：让复测者把他那边「出问题的章节结构」交给维护者，**双方都不泄露隐私**。
 *
 * 为什么不直接发课程 URL：
 *   studentstudy?...&enc=xxx&cpi=xxx&openc=xxx 里的票据是**会话绑定 + 短期有效**，
 *   发出去 ①过期就废 ②绑着他的 cookie，我拿到也进不去 ③能进就等于把账号借出去。
 *   issue 又是公开的 → 贴上去等于公开泄露。所以 URL 这条路直接否掉。
 *
 * 为什么用「白名单投影」而不是「脱敏（黑名单替换）」：
 *   黑名单永远会漏掉我没想到的字段名，而漏一个就等于泄露。
 *   这里改为：**只从输入里挑允许的字段，构造一个全新的对象**，
 *   剩下的（不管是 URL / cookie / 姓名 / 学号 / 机器路径）根本没有机会进包。
 *
 * 三条硬规则：
 *   1) 允许字段清单写死在 ALLOW_* 里，新增字段必须显式加进来（评审可见）。
 *   2) 标识符一律 **per-bundle 随机盐 hash**（盐不出包）→ 包内可关联，包外不可反推。
 *   3) 课程/章节标题只保留**通用词白名单**，其余 hash（可用 --keep-titles 显式放开）。
 * ==========================================================================*/
const crypto = require('node:crypto');

const FORMAT = 'dsh-cx-learn/repro';
const VERSION = 1;

/* ---------------------------------------------------------------------------
 * 1. 通用标题白名单
 *    超星里的卡片标题大多是「教学视频 / 教学课件 / 教案 / 其他相关内容 / 1 / 2」这类，
 *    去掉身份信息后保留它们对诊断**有价值**（能看出末卡是课件卡）。
 *    带人名、单位、课程全名的标题一律 hash。
 * -------------------------------------------------------------------------*/
const GENERIC_TITLES = new Set([
  '教学视频', '教学课件', '教学资料', '教案', '课件', '视频', '音频', '文档', '资料',
  '其他相关内容', '其他', '作业', '章节测验', '测验', '讨论', '直播', '回放',
  '任务点', '知识点', '阅读材料', '拓展阅读', '习题', '练习',
]);

/* ---------------------------------------------------------------------------
 * 2. 允许进入复现包的字段（白名单，逐字段显式列出）
 * -------------------------------------------------------------------------*/
const ALLOW_TASK_KINDS = new Set(['video', 'audio', 'document', 'quiz', 'live', 'discussion', 'unknown']);

/* ---------------------------------------------------------------------------
 * 3. 哈希：per-bundle 盐，包内稳定、包外不可反推
 * -------------------------------------------------------------------------*/
function makeSalter(salt) {
  const s = String(salt || crypto.randomBytes(16).toString('hex'));
  const cache = new Map();
  return {
    salt: s,
    /** 稳定短哈希：同一盐下同一输入 → 同一输出；输出带 h_ 前缀，便于审计 */
    h(value) {
      const v = String(value == null ? '' : value);
      if (!v) return '';
      if (cache.has(v)) return cache.get(v);
      const out = 'h_' + crypto.createHash('sha256').update(s + '|' + v).digest('hex').slice(0, 12);
      cache.set(v, out);
      return out;
    },
  };
}

/** 标题 → 安全的 kind 标记（通用词保留，纯数字保留，其余 hash） */
function titleKind(title, salter, keepTitles) {
  const t = String(title == null ? '' : title).trim();
  if (!t) return 'empty';
  if (keepTitles === true) return 'raw:' + t.slice(0, 40);
  if (/^\d+$/.test(t)) return 'index:' + t;                  /* 「1」「2」这类序号不含身份 */
  if (GENERIC_TITLES.has(t)) return 'generic:' + t;
  return 'hashed:' + salter.h(t);
}

/* ---------------------------------------------------------------------------
 * 4. sanitize：从「诊断快照 / learn.json」构造复现包
 *
 * 输入形状（都来自本插件自己的落盘文件）：
 *   snapshots: [ { reason, section:{title}, tasks:[{kind,finished,label,objectid,frameUrl,duration}] , videos:[{objectid,duration,progress}], toc:{...} } ]
 *   learn:     { sections:[ { chapterId, title, kind, total, cards:[{cardid,num,title,media,finished,failed,collected}] } ] }
 * -------------------------------------------------------------------------*/
function sanitizeRepro(input, opts) {
  const o = opts || {};
  const salter = makeSalter(o.salt);
  const keepTitles = o.keepTitles === true;
  const src = input || {};
  const snapshots = Array.isArray(src.snapshots) ? src.snapshots : [];
  const learn = src.learn || {};

  /* --- 4a. 章节：只从 learn.sections 取「最近一节」，chapterId hash --- */
  const sections = Array.isArray(learn.sections) ? learn.sections : [];
  const lastSec = sections.length ? sections[sections.length - 1] : null;

  let section = null;
  if (lastSec && lastSec.chapterId) {
    const cards = Array.isArray(lastSec.cards) ? lastSec.cards : [];
    section = {
      /* 白名单字段，一个不多 */
      chapterHash: salter.h(lastSec.chapterId),
      titleKind: titleKind(lastSec.title, salter, keepTitles),
      state: String(lastSec.kind || '').slice(0, 16),
      totalCards: Number(lastSec.total) || cards.length,
      cards: cards.map((c) => ({
        cardHash: salter.h(c && c.cardid),
        num: Number(c && c.num) || 0,
        titleKind: titleKind(c && c.title, salter, keepTitles),
        collected: !!(c && c.collected),
        media: Number(c && c.media) || 0,
        finished: Number(c && c.finished) || 0,
        failed: !!(c && c.failed),
      })),
    };
  }

  /* --- 4b. 任务点/视频：从最近一张诊断快照取（含 objectid → hash） --- */
  const snap = snapshots.length ? snapshots[snapshots.length - 1] : null;
  let lastCardGone = false;   /* 是否出现过「本卡无任何任务点」——1.5 死循环的关键形态 */
  const tasks = [];
  const videos = [];
  let toc = null;

  if (snap) {
    const rawTasks = Array.isArray(snap.tasks) ? snap.tasks : [];
    lastCardGone = rawTasks.length === 0;
    for (const t of rawTasks) {
      if (!t) continue;
      const kind = ALLOW_TASK_KINDS.has(String(t.kind)) ? String(t.kind) : 'unknown';
      tasks.push({
        kind,
        finished: t.finished === true,
        /* objectid 只以 hash 形式出现（保留「同一视频」的关联性） */
        objectHash: salter.h(t.objectid),
        duration: Number(t.duration) > 0 ? Math.round(Number(t.duration)) : 0,
        labelKind: titleKind(t.label, salter, keepTitles),
      });
    }
    const rawVideos = Array.isArray(snap.videos) ? snap.videos : [];
    for (const v of rawVideos) {
      if (!v) continue;
      videos.push({
        objectHash: salter.h(v.objectid),
        duration: Number(v.duration) > 0 ? Math.round(Number(v.duration)) : 0,
        progressPct: Number(v.progress) >= 0 ? Math.round(Number(v.progress) * 10) / 10 : null,
      });
    }
    if (snap.toc && typeof snap.toc === 'object') {
      toc = {
        totalSections: Number(snap.toc.total) || 0,
        currentIndex: Number(snap.toc.index) || 0,
        doneCount: Number(snap.toc.doneCount) || 0,
        layer: Number(snap.toc.layer) || 0,
      };
    }
  }

  /* --- 4c. 环境：只留版本与家族，不含路径/主机名/用户名 --- */
  const env = src.env || {};
  const environment = {
    /* ★ D-078：插件版本 —— 用来把复现包归到某个 release（引擎内部 VERSION 恒 1.0.0 不可用） */
    pluginVersion: String(env.pluginVersion || '').slice(0, 20),
    engineVersion: String(env.engineVersion || '').slice(0, 20),
    dshVersion: String(env.dshVersion || '').slice(0, 40),
    nodeMajor: Number(env.nodeMajor) || 0,
    osFamily: ['windows', 'darwin', 'linux'].indexOf(String(env.osFamily)) >= 0 ? String(env.osFamily) : 'other',
    browserFamily: String(env.browserFamily || '').replace(/[^A-Za-z]/g, '').slice(0, 16),
  };

  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    section,
    tasks,
    videos,
    toc,
    /* 关键形态标记：末卡无任务点 —— 复现 1.5 死循环必须靠它 */
    signals: {
      currentCardHasNoTasks: lastCardGone,
      snapshotCount: snapshots.length,
      snapshotReason: String((snap && snap.reason) || '').slice(0, 40),
    },
    environment,
  };
}

/* ---------------------------------------------------------------------------
 * 5. buildReplayFixture：复现包 → 可直接喂给 LearnMachine 的夹具
 *
 * 不碰网络、不需要任何账号：全部是合成对象。
 * -------------------------------------------------------------------------*/
function buildReplayFixture(pkg) {
  const p = pkg || {};
  const sec = p.section || {};
  const chapterHash = String(sec.chapterHash || 'h_unknown');
  const cards = Array.isArray(sec.cards) ? sec.cards : [];

  /* 合成 frameUrl：knowledgeid 用 hash 值 —— 保证 chapterId 绑定仍然成立 */
  const cardsUrl = 'https://repro.invalid/knowledge/cards?knowledgeid=' + encodeURIComponent(chapterHash) + '&num=';
  const topUrl = 'https://repro.invalid/mycourse/studentstudy?chapterId=' + encodeURIComponent(chapterHash);

  const st = {
    url: topUrl,
    topUrl,
    frames: [
      { frameId: 'top', url: topUrl, isTop: true },
      { frameId: 'cards', url: cardsUrl + '0', isTop: false },
    ],
    toc: { found: true, layer: Number((p.toc && p.toc.layer)) || 1, items: [{ chapterId: chapterHash, current: true, title: 'repro', done: false, unfinish: 1 }] },
    /* 末卡无任务点 → 与复测 1.5 同形态 */
    video: { found: p.signals && p.signals.currentCardHasNoTasks ? false : true, paused: false, ended: false, progress: 0, currentTime: 0, duration: 0, frameId: 'cards', objectid: '' },
    videoFrameId: 'cards',
    dialogs: [], human: [], loginInvalid: false, loginEvidence: [],
    quiz: { present: false, parseable: false, options: [], blocks: [] },
    videoQuiz: { present: false }, quizTab: { present: false },
  };

  const cardCollect = {
    key: chapterHash,
    state: 'multi',
    startedAt: Date.now(),
    total: cards.length,
    title: 'repro',
    cards: cards.map((c, i) => ({
      i, seq: i + 1, num: Number(c.num) || i, total: cards.length,
      cardid: String(c.cardHash || ('h_' + i)), title: String(c.titleKind || ''),
    })),
  };

  const cardScan = new Map();
  for (const c of cards) {
    if (c && c.collected) cardScan.set(String(c.cardHash), { media: Number(c.media) || 0, finished: Number(c.finished) || 0, failed: !!c.failed });
  }

  /* 任务点按 video.tasks 的形状回填（label 用 kind，避免任何原始文本进入） */
  const tasks = (Array.isArray(p.tasks) ? p.tasks : []).map((t) => ({
    kind: String(t.kind || 'unknown'),
    finished: t.finished === true,
    objectid: String(t.objectHash || ''),
    frameUrl: cardsUrl + '0',
    label: String(t.kind || ''),
    duration: Number(t.duration) || 0,
  }));

  return { st, cardCollect, cardScan, inventory: { at: Date.now(), tasks } };
}

/* ---------------------------------------------------------------------------
 * 6. 单行口令（gzip + base64url），方便直接贴进 issue
 * -------------------------------------------------------------------------*/
function packToken(pkg) {
  const zlib = require('node:zlib');
  const raw = Buffer.from(JSON.stringify(pkg), 'utf8');
  return 'REPRO1.' + zlib.gzipSync(raw, { level: 9 }).toString('base64url');
}

function unpackToken(token) {
  const zlib = require('node:zlib');
  const t = String(token || '').trim();
  if (t.indexOf('REPRO1.') !== 0) throw new Error('不是 REPRO1 口令');
  const buf = Buffer.from(t.slice(7), 'base64url');
  const json = zlib.gunzipSync(buf).toString('utf8');
  const pkg = JSON.parse(json);
  if (!pkg || pkg.format !== FORMAT) throw new Error('口令内容不是复现包');
  return pkg;
}

module.exports = {
  FORMAT,
  VERSION,
  GENERIC_TITLES,
  makeSalter,
  titleKind,
  sanitizeRepro,
  buildReplayFixture,
  packToken,
  unpackToken,
};
