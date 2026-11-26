#!/usr/bin/env node
/* ============================================================================
 * repro.test.cjs —— 复现包的「双向不泄露」破坏测试（D-075）
 *
 * 这是隐私红线，按**对抗**思路写：先构造一份「什么都有的恶意输入」，
 * 然后断言输出的**全文**里不含任何一项原始敏感值/键。
 *
 * 覆盖：
 *   R1 白名单投影：enc/cpi/openc/cookie/token/姓名/学号/课程地址 一律不进包
 *   R2 标识符只以 h_ hash 出现（原 objectid / chapterId / cardid 不可反推）
 *   R3 包内 hash 稳定、跨 bundle 不稳定（盐随机）
 *   R4 标题白名单：通用词保留，含人名/课程全名的 hash
 *   R5 --keep-titles 才放开标题
 *   R6 单行口令往返一致 + 坏口令明确报错
 *   R7 复现夹具形状正确（末卡无任务点 → video.found=false）
 *   R8 空/垃圾输入不崩
 *   R9 ★ 整条链路：用复现包驱动真状态机，末卡无任务点必须有限拍内收敛（不得空转）
 * ==========================================================================*/
'use strict';
const path = require('node:path');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const R = require(path.join(__dirname, 'src', 'repro.js'));
const E = require(path.join(__dirname, 'chaoxing-autolearn.js'));

/* ---------- 一份「什么都带上」的恶意输入：真实身份信息全在里面 ---------- */
const SECRETS = {
  enc: 'ENCSECRET1234567890abcdef',
  cpi: 'CPISECRET0987654321',
  openc: 'OPENSECRETaaaaaaaaaaaa',
  objectid: 'a627ac356031f944d4bed6ad8ce9baaf',
  objectid2: '255361786031f944d4bed6ad8ce9baaf',
  cardid: 'CARDIDSECRET0001',
  chapterId: 'CHAPTERIDSECRET42',
  courseTitle: '某课程全名-含班级标识-A',
  cardTitle: '某用户自建的教案-内部版',
  realName: '某用户A',
  studentNo: '2023012345678',
  courseUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=999&clazzid=88&enc=ENCSECRET1234567890abcdef&cpi=CPISECRET0987654321&openc=OPENSECRETaaaaaaaaaaaa',
  cookie: 'JSESSIONID=ABCDEF1234567890',
  home: 'C:\\Users\\zhangsanfeng\\AppData\\Roaming\\dsh\\profiles\\desktop',
  host: 'wuxue-nas-192-168-10-163',
};

const EVIL_INPUT = {
  snapshots: [{
    reason: 'card_detect_timeout',
    url: SECRETS.courseUrl,
    tasks: [
      { kind: 'video', finished: true, objectid: SECRETS.objectid, frameUrl: SECRETS.courseUrl, label: 'P39 深厚的为民情怀', duration: 238.5 },
      { kind: 'audio', finished: false, objectid: SECRETS.objectid2, frameUrl: SECRETS.courseUrl, label: SECRETS.cardTitle, duration: 100 },
      { kind: 'quiz', finished: false, label: '章节测验' },
    ],
    videos: [{ objectid: SECRETS.objectid2, duration: 100, progress: 0 }],
    cookie: SECRETS.cookie,
    home: SECRETS.home,
  }, {
    /* ★ 最后一张必须是「末卡无任务点」那张 —— sanitizeRepro 取最近一张，
       这正是复测 1.5 真机的形态（切到教学课件卡，0 个任务点）。 */
    reason: 'no_target_video_on_card',
    section: { title: SECRETS.courseTitle },
    toc: { total: 6, index: 4, doneCount: 1, layer: 2 },
    tasks: [],
    videos: [{ objectid: SECRETS.objectid, duration: 5211.6, progress: 90.3 }],
  }],
  learn: {
    sections: [{
      chapterId: SECRETS.chapterId,
      title: SECRETS.courseTitle,
      kind: 'multi',
      total: 2,
      cards: [
        { cardid: SECRETS.cardid, num: 0, title: '教学视频', collected: true, media: 1, finished: 1, failed: false },
        /* ★ 复测 1.5 真实形态：末卡也采集过，只是 0 条任务点（不是采集失败） */
        { cardid: SECRETS.cardid + 'B', num: 1, title: '教学课件', collected: true, media: 0, finished: 0, failed: false },
      ],
    }],
  },
  env: {
    engineVersion: '1.0.0', dshVersion: 'DSH 0.2.1-rc.5 / Node v24.21.0',
    nodeMajor: 24, osFamily: 'windows', browserFamily: 'Edg/158.0',
    home: SECRETS.home, hostname: SECRETS.host, userName: SECRETS.realName,
  },
};

console.log('== R1. 白名单投影：敏感值/键一律不进包 ==');
{
  const pkg = R.sanitizeRepro(EVIL_INPUT);
  const text = JSON.stringify(pkg);
  /* 值层面：任何一项原始秘密都不许出现 */
  for (const [k, v] of Object.entries(SECRETS)) {
    ok(text.indexOf(v) < 0, '★ 包内不含 ' + k + ' 的原值（' + String(v).slice(0, 18) + '…）');
  }
  /* 键层面：敏感键名不许出现 */
  for (const bad of ['enc', 'cpi', 'openc', 'cookie', 'JSESSIONID', 'frameUrl', 'iframeSrc', 'courseUrl', 'password', 'token', 'home', 'hostname', 'userName', 'realName', 'studentNo', 'avatar']) {
    ok(!new RegExp('"' + bad + '"\\s*:', 'i').test(text), '★ 包内不含键 ' + bad);
  }
  /* 路径分隔符/盘符也不该出现 */
  ok(text.indexOf('C:\\') < 0 && text.indexOf('/Users/') < 0, '★ 不含本机路径');
}

console.log('== R2. 标识符只以 h_ hash 出现 ==');
{
  const pkg = R.sanitizeRepro(EVIL_INPUT);
  const text = JSON.stringify(pkg);
  ok(/^h_[0-9a-f]{12}$/.test(pkg.section.chapterHash), '★ chapterHash 形如 h_+12hex（实际 ' + pkg.section.chapterHash + '）');
  ok(pkg.section.cards.every((c) => /^h_[0-9a-f]{12}$/.test(c.cardHash)), '★ 每张卡 cardHash 也是 h_ 形式');
  ok(pkg.videos.every((v) => /^h_[0-9a-f]{12}$/.test(v.objectHash)), '★ 视频 objectHash 也是 h_ 形式');
  /* 全文不出现裸 32 位 hex（真 objectid 的形态） */
  ok(!/[0-9a-f]{32}/i.test(text), '★ ★ 全文没有裸 32 位 hex（真 objectid 不可能残留）');
}

console.log('== R3. 同包内稳定 / 跨包不可关联 ==');
{
  const a = R.sanitizeRepro(EVIL_INPUT, { salt: 'fixed-salt' });
  const b = R.sanitizeRepro(EVIL_INPUT, { salt: 'fixed-salt' });
  ok(a.section.chapterHash === b.section.chapterHash, '★ 同盐 → 同 hash（包内可关联）');
  const c = R.sanitizeRepro(EVIL_INPUT);
  ok(c.section.chapterHash !== a.section.chapterHash, '★ ★ 随机盐 → 不同 hash（跨包不可关联）');
  /* 同一 chapter 的两个不同 id 必须得到不同 hash */
  ok(a.section.cards[0].cardHash !== a.section.cards[1].cardHash, '★ 不同卡 → 不同 hash（不塌缩）');
}

console.log('== R4/R5. 标题白名单 + --keep-titles ==');
{
  const pkg = R.sanitizeRepro(EVIL_INPUT);
  ok(pkg.section.cards[0].titleKind === 'generic:教学视频', '★ 通用词保留（实际 ' + pkg.section.cards[0].titleKind + '）');
  /* 末卡标题用通用词（复测 1.5 的「教学课件」），所以直接对 titleKind 单测含人名/含课程名的情形 */
  const saltR4 = R.makeSalter('t-salt');
  ok(/^hashed:h_/.test(R.titleKind(SECRETS.cardTitle, saltR4)), '★ 含人名的标题被 hash（实际 ' + R.titleKind(SECRETS.cardTitle, saltR4) + '）');
  ok(R.titleKind('教学课件', saltR4) === 'generic:教学课件', '★ 通用词「教学课件」保留');
  ok(R.titleKind('1', saltR4) === 'index:1', '★ 纯序号保留');
  ok(R.titleKind(SECRETS.courseTitle, saltR4) !== R.titleKind(SECRETS.cardTitle, saltR4), '★ 不同标题不同 hash');
  ok(/^hashed:h_/.test(pkg.section.titleKind), '★ 章节全名被 hash');

  const raw = R.sanitizeRepro(EVIL_INPUT, { keepTitles: true });
  ok(raw.section.cards[0].titleKind === 'raw:教学视频', '★ --keep-titles 才原样保留');
  /* 即便放开标题，敏感值仍不许进包 */
  const rawText = JSON.stringify(raw);
  ok(rawText.indexOf(SECRETS.enc) < 0 && rawText.indexOf(SECRETS.objectid) < 0,
    '★ ★ 放开标题也不泄露票据/objectid');
}

console.log('== R6. 单行口令往返 ==');
{
  const pkg = R.sanitizeRepro(EVIL_INPUT);
  const tok = R.packToken(pkg);
  ok(tok.indexOf('REPRO1.') === 0 && tok.length < 8000, '★ 口令前缀正确且体积可贴（' + tok.length + ' 字符）');
  const back = R.unpackToken(tok);
  ok(JSON.stringify(back) === JSON.stringify(pkg), '★ ★ 往返完全一致');
  /* 口令本身也不能藏秘密 */
  const decoded = Buffer.from(tok.slice(7), 'base64url').toString('binary');
  ok(decoded.indexOf(SECRETS.objectid) < 0, '★ 口令的二进制里没有原 objectid');
  let threw = false;
  try { R.unpackToken('GARBAGE'); } catch (_) { threw = true; }
  ok(threw, '★ 坏口令明确报错（不静默）');
}

console.log('== R7. 复现夹具形状 ==');
{
  const pkg = R.sanitizeRepro(EVIL_INPUT);
  const fx = R.buildReplayFixture(pkg);
  ok(!!fx.st && !!fx.cardCollect && fx.cardScan instanceof Map, '★ 返回 st/cardCollect/cardScan');
  ok(fx.st.video.found === false, '★ ★ 末卡无任务点 → video.found=false（复刻 1.5 形态）');
  ok(fx.cardCollect.cards.length === 2, '★ 两卡');
  ok(fx.st.frames.some((f) => f.url.indexOf('knowledgeid=' + pkg.section.chapterHash) >= 0),
    '★ 合成 frameUrl 带 chapterHash（chapterId 绑定仍成立）');
  ok(fx.st.toc.items[0].chapterId === pkg.section.chapterHash, '★ 目录 chapterId 也是 hash');
  /* 夹具里也不许出现原值 */
  const fxText = JSON.stringify({ st: fx.st, cc: fx.cardCollect, inv: fx.inventory });
  ok(fxText.indexOf(SECRETS.chapterId) < 0 && fxText.indexOf(SECRETS.objectid) < 0, '★ ★ 夹具不含原值');
}

console.log('== R8. 空/垃圾输入不崩 ==');
{
  for (const bad of [null, undefined, {}, { snapshots: null, learn: null }, { snapshots: [null, {}], learn: { sections: [null] } }]) {
    let threw = false; let pkg = null;
    try { pkg = R.sanitizeRepro(bad); } catch (_) { threw = true; }
    ok(!threw && pkg && pkg.format === R.FORMAT, '★ 输入 ' + JSON.stringify(bad) + ' 不崩且仍是合法包');
  }
}

main().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });

async function main() {
  console.log('== R9. 端到端：复现包驱动真状态机，必须收敛（不得空转）==');
  {
    const pkg = R.sanitizeRepro(EVIL_INPUT);
    const fx = R.buildReplayFixture(pkg);

    const cfg = E.mergeConfig(E.CONFIG, {
      humanize: { clickDelayMs: [1, 1], sectionCooldownMs: [1, 1], quizThinkMs: [1, 1], longPauseEveryOps: [99, 99], longPauseMs: [1, 1], pollMs: [1, 1] },
      safety: { sectionStuckTimeoutMs: 300 },
    });
    E.humanize.configure(cfg.humanize);

    const adv = { n: 0 };
    const adapter = {
      engine: 'repro', async evalInFrame() { return { ok: false, noProbe: true }; },
      async click() { return { mode: 'repro' }; }, async jsClick() { return { ok: false }; },
      getTargetId() { return 'top'; }, shutdown() { },
    };
    const m = new E.LearnMachine(adapter, cfg);
    m.gatherState = async () => fx.st;
    m.advanceSection = async () => { adv.n += 1; return { progress: true, outcome: 'SECTION_ADVANCED' }; };
    m._cardCollect = fx.cardCollect;
    m._cardScan = fx.cardScan;
    m._lastInventory = fx.inventory;
    m._videoSeenThisSection = true;
    m._cardSwitchAt = Date.now() - 30000;
    m._recordCurrentCard = () => { };

    const before = m.counters.sectionsCompleted + m.counters.sectionsSkipped;
    let ticks = 0;
    for (; ticks < 40 && !m.stopReason && adv.n === 0; ticks += 1) await m.tick();
    const after = m.counters.sectionsCompleted + m.counters.sectionsSkipped;

    ok(adv.n >= 1 || !!m.stopReason, '★ ★ 复现包驱动后有限拍内产出结论（ticks=' + (ticks + 1) + ' adv=' + adv.n + ' stop=' + String(m.stopReason) + '）');
    ok(after === before + 1, '★ ★ 计数恰好 +1（before=' + before + ' after=' + after + '）');
  }

  console.log('');
  if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('== 全部通过（' + pass + ' 项）==');

}
