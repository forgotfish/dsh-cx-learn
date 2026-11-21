/* ============================================================================
 * engine/src/courses.js — 课程列表、只读结构扫描、任务点扫描、课程报告（2026-10-27 新版页面适配）
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { resolveCdpPort } = require('./browser/args.js');
const { createCdpAdapter } = require('./browser/cdp.js');
const { sleep } = require('./core/base.js');
const { CONFIG, mergeConfig } = require('./core/config.js');
const { logger } = require('./core/logging.js');

/** 单个 frame 内运行的结构扫描表达式（纯只读，不触发任何点击）。 */
const STRUCT_SCAN_EXPR = `(() => {
  const d = document;
  const txt = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const out = {
    url: (location.href || '').slice(0, 300),
    title: document.title || '',
    ready: document.readyState,
  };

  // ── 新版导航 tab ──
  out.navTabs = [];
  d.querySelectorAll('li, a, span').forEach((el) => {
    if (!vis(el)) return;
    const t = txt(el);
    if (!t || t.length > 6) return;
    if (!/^(任务|章节|资料|学习记录|课程图谱|讨论|作业|考试|统计)$/.test(t)) return;
    out.navTabs.push({ tag: el.tagName, text: t, cls: String(el.className || '').slice(0, 40) });
  });

  // ── 老版目录 ──
  out.tocOld = d.querySelectorAll('.posCatalog_select').length;
  out.tocTree = d.querySelectorAll('#coursetree').length;

  // ── 新版章节树（★ 2026-10-27 实测确认：化工热力学课程） ──
  //     .chapter_unit → 7 个（章），.chapter_item → 32 个（节）
  //     这两个选择器在 studentcourse iframe 里有效，老版选择器在新版全为 0
  const chapSel = [
    '.chapter_unit', '.chapter_item',
    '.chapter_itemBox', '.chapter',
    '.posCatalog_select', '#coursetree li',
    '.catalog_list li', '.catalogList li'
  ];
  out.chapterCandidates = chapSel.map((s) => {
    let n = 0;
    try { n = d.querySelectorAll(s).length; } catch (_) { n = -1; }
    return { sel: s, count: n };
  }).filter((x) => x.count > 0);

  // 章节明细（只读文本，供人工核对）
  out.chapters = [];
  d.querySelectorAll('.chapter_unit').forEach((unit, ci) => {
    if (ci >= 40) return;
    const items = [];
    unit.querySelectorAll('.chapter_item').forEach((it) => {
      if (items.length >= 60) return;
      const t = txt(it);
      if (!t || t.length > 120) return;
      items.push({
        text: t.slice(0, 90),
        finished: /已完成|completed|完成/i.test(String(it.className || '')),
        cls: String(it.className || '').slice(0, 60),
      });
    });
    const head = txt(unit).slice(0, 60);
    out.chapters.push({ index: ci, head, itemCount: items.length, items });
  });

  // ── 任务点（老版选择器，在新版 iframe 里可能仍有效） ──
  out.attachCt = d.querySelectorAll('.ans-attach-ct').length;
  out.jobIcon = d.querySelectorAll('.ans-job-icon').length;
  out.taskItems = [];
  d.querySelectorAll('.ans-attach-ct').forEach((el, i) => {
    if (i >= 30) return;
    const icon = el.querySelector('.ans-job-icon');
    const ifr = el.querySelector('iframe');
    out.taskItems.push({
      i,
      finished: el.classList.contains('ans-job-finished'),
      iconLabel: icon ? (icon.getAttribute('aria-label') || '').slice(0, 30) : '',
      iframeSrc: ifr ? (ifr.getAttribute('src') || '').slice(0, 110) : '',
      text: txt(el).slice(0, 40),
    });
  });

  // ── 媒体 ──
  out.videos = d.querySelectorAll('video').length;
  out.audios = d.querySelectorAll('audio').length;
  out.videoQuiz = d.querySelectorAll('.ans-videoquiz').length;

  // ── 题目表单特征（只统计数量，不读内容、不填） ──
  out.quizForms = d.querySelectorAll('form, .questionLi, .TiMu, .Zy_TItle').length;
  out.quizMarkers = d.querySelectorAll('[id^="question"], [class*="questionLi"], [class*="TiMu"]').length;

  // ── iframe 清单（供逐层穿透） ──
  out.iframes = [];
  d.querySelectorAll('iframe').forEach((f, i) => {
    if (i >= 15) return;
    out.iframes.push({
      i,
      src: (f.getAttribute('src') || '').slice(0, 130),
      module: f.getAttribute('module') || '',
      w: f.offsetWidth, h: f.offsetHeight,
      visible: vis(f),
    });
  });

  // ── 正文摘要（判断页面性质） ──
  out.bodyHead = txt(d.body).slice(0, 260);

  // ── 页面类型判定 ──
  if (/passport2\\.chaoxing\\.com|\\/login/i.test(out.url) && d.querySelector('input[type="password"], #quickCode')) {
    out.kind = 'login';
  } else if (out.tocOld > 0 || out.tocTree > 0) {
    out.kind = 'mooc1-study';
  } else if (out.attachCt > 0 || out.jobIcon > 0) {
    out.kind = 'mooc2-chapter';
  } else if (out.videos > 0 || out.videoQuiz > 0) {
    out.kind = 'media';
  } else if (out.navTabs.length >= 3) {
    out.kind = 'mooc2-home';
  } else {
    out.kind = 'unknown';
  }
  return JSON.stringify(out);
})()`;

/**
 * 点开新版课程页的「章节」tab（只读导航，不播放不答题）。
 *
 * 为什么必须点：mooc2-ans 主页默认停在「任务」tab，章节树在
 * 点「章节」后才被加载进 iframe（studentcourse）。
 * 本操作只是切换页签，等价于用户点一下导航，不触发任何学习行为。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function openChapterTab(adapter) {
  const frames = await adapter.getFrameDocuments();
  const top = frames.find((f) => f.isTop);
  if (!top) return { ok: false, reason: 'no-top-frame' };

  /* ★ 实测坑：刚进课程页时导航尚未渲染完成，「章节」的坐标会偏移
     （实测正确位置 y≈348，但页面未加载完时 y≈315，点到的是「任务」）。
     所以先等导航稳定：连续两次读到相同坐标才认为布局就绪。 */
  const locateExpr = `(() => {
    const txt = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, '').trim();
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    /* ★ 2026-11-16（D-027 现场）：有的课程点进去直接落在 studentstudy 学习页，
       那里的页签叫「目录」且**已经激活**（章节树内联在主页里，不是 mooc2-ans 的
       跨域 iframe）。只认「章节」会 tab-not-found → ENTRY_CHAPTER_FAILED。
       两个名字都接受；点已激活的「目录」是无副作用的空操作。 */
    const isTab = (s) => s === '章节' || s === '目录';
    let best = null;
    document.querySelectorAll('a, li, span, div').forEach((el) => {
      if (!vis(el)) return;
      if (!isTab(txt(el))) return;
      const inner = [...el.querySelectorAll('a, li, span, div')].some((c) => vis(c) && isTab(txt(c)));
      if (inner) return;
      if (!best) best = el;
    });
    if (!best) return JSON.stringify({ ok: false, reason: 'tab-not-found' });
    const clickable = best.closest('a') || best.closest('li') || best;
    const r = clickable.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      tag: clickable.tagName,
      cls: String(clickable.className || '').slice(0, 40),
      id: clickable.id || '',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  })()`;

  // 等布局稳定：最多 12 秒，连续两次坐标一致
  let prev = '';
  let hit = null;
  for (let i = 0; i < 12; i++) {
    let raw;
    try { raw = await adapter.evalInFrame(top.frameId, locateExpr); } catch (_) { raw = ''; }
    let r; try { r = JSON.parse(raw); } catch (_) { r = { ok: false }; }
    if (!r || !r.ok) { await sleep(1000); continue; }
    const sig = r.x + ',' + r.y + ',' + r.w + ',' + r.h;
    if (sig === prev) { hit = r; break; }
    prev = sig;
    await sleep(1000);
  }
  if (!hit) {
    // 布局没稳定也再试一次最后的读数
    let raw;
    try { raw = await adapter.evalInFrame(top.frameId, locateExpr); } catch (_) { raw = ''; }
    try { hit = JSON.parse(raw); } catch (_) { hit = null; }
  }
  if (!hit || !hit.ok) return { ok: false, reason: (hit && hit.reason) || 'not-found' };

  /* ★★ 点击策略（2026-10-27 实测修正）：
     不能依赖坐标点击 —— 页面布局在加载后会移动（实测同一元素
     在布局未稳时 y=369，稳定后 y=348，差 21px，点到了别的 tab）。
     改为：在页面内用 elementFromPoint 找到真实元素后直接 click()，
     这样与坐标无关，也不会因滚动/布局变化而偏移。 */
  const doClickExpr = `(() => {
    const txt = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, '').trim();
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    // 找最内层的「章节」/「目录」文字元素（D-027：两种叫法都接受）
    const isTab = (s) => s === '章节' || s === '目录';
    let best = null;
    document.querySelectorAll('a, li, span, div').forEach((el) => {
      if (!isTab(txt(el))) return;
      if (!vis(el)) return;
      const inner = [...el.querySelectorAll('a, li, span, div')].some((c) => vis(c) && isTab(txt(c)));
      if (inner) return;
      if (!best) best = el;
    });
    if (!best) return JSON.stringify({ ok: false, reason: 'tab-not-found' });

    // 优先点 <a> 祖先（站点把跳转绑在 a 上）
    const a = best.closest('a');
    const target = a || best;
    const before = location.href;
    try { target.click(); } catch (e) {
      return JSON.stringify({ ok: false, reason: 'click-err:' + String(e.message || e).slice(0, 50) });
    }
    return JSON.stringify({
      ok: true,
      tag: target.tagName,
      cls: String(target.className || '').slice(0, 30),
      href: (target.getAttribute && target.getAttribute('href') || '').slice(0, 60),
      before: before.slice(0, 100),
    });
  })()`;

  let clickRes;
  try {
    const raw = await adapter.evalInFrame(top.frameId, doClickExpr);
    try { clickRes = JSON.parse(raw); } catch (_) { clickRes = { ok: false, reason: 'bad-json' }; }
  } catch (e) {
    return { ok: false, reason: 'click: ' + String((e && e.message) || e).slice(0, 90) };
  }
  if (!clickRes || !clickRes.ok) {
    return { ok: false, reason: (clickRes && clickRes.reason) || 'click-failed' };
  }
  logger.log('PROBE', 'INFO', '已点开「章节」tab（页面内 click·只读导航）', {
    tag: clickRes.tag, cls: clickRes.cls, href: clickRes.href,
  });

  await sleep(4000);
  return { ok: true };
}

/**
 * 点开「章节」后等待 studentcourse iframe 真正加载出来。
 *
 * ★ 实测坑：点「章节」会让页面重新导航（URL 的 pageHeader 参数变化），
 *   期间旧 iframe 被销毁、新 iframe 尚未创建。固定 sleep 4s 有时太短，
 *   抓到的还是没有章节树的空壳页面。这里改为轮询等待，最多 25 秒。
 *
 * @returns {Promise<boolean>} 是否等到章节 iframe
 */
async function waitForChapterFrame(adapter, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  let tries = 0;
  let lastDiag = null;
  while (Date.now() < deadline) {
    tries += 1;
    try {
      const frames = await adapter.getFrameDocuments();
      const hit = frames.find((f) => /studentcourse/i.test(f.url || ''));
      if (hit) {
        // 再确认这一帧里真的能读到章节元素，避免「壳已加载但内容还没渲染」
        const r = await adapter.evalInFrameCross(
          hit.frameId,
          'document.querySelectorAll(".chapter_unit").length'
        );
        if (r && r.ok && Number(r.value) > 0) {
          logger.log('PROBE', 'INFO', '章节 iframe 已就绪', { tries, units: Number(r.value) });
          return true;
        }
        lastDiag = { foundFrame: true, url: String(hit.url || '').slice(0, 90), units: r && r.ok ? r.value : 'eval-fail' };
      } else {
        lastDiag = {
          foundFrame: false,
          frameCount: frames.length,
          frameUrls: frames.map((f) => String(f.url || '').slice(0, 55)).slice(0, 8),
        };
      }
    } catch (_) { /* 间歇失败继续等 */ }
    await sleep(1200);
  }
  logger.log('PROBE', 'WARN', '等待章节 iframe 超时', { tries, diag: lastDiag });
  return false;
}

/**
 * 探测「任务型课程」：这类课没有章节树，只有活动列表（stuActiveList）。
 *
 * ★ 2026-10-27 实测：「典型建模技术」「优化理论与方法」两门课
 *   帧里是 mobilelearn.chaoxing.com/page/active/stuActiveList，
 *   整页 .chapter_unit / .chapter_item / [class*=chapter] 全为 0。
 *   这不是故障，是课程本身的结构不同，应记为「任务型」而不是失败。
 *
 * @returns {Promise<{taskType:boolean, frameId?:string, url?:string}>}
 */
async function detectTaskTypeCourse(adapter) {
  try {
    const frames = await adapter.getFrameDocuments();
    const active = frames.find((f) => /stuActiveList|mobilelearn\.chaoxing\.com\/page\/active/i.test(f.url || ''));
    if (active) {
      return { taskType: true, frameId: active.frameId, url: String(active.url || '').slice(0, 120), kind: '活动列表' };
    }
    /* ★ 2026-10-27 实测：「典型建模技术」这门课点开章节后，
       studentcourse 帧里只有 <div class="fanyaChapter">，
       内容是「已完成任务点: 0/0」「目录 暂无章节内容」——
       这门课在系统里**根本没挂章节**，不是程序问题。
       判据：出现「暂无章节内容 / 0/0」且 chapter 计数为 0。 */
    const sc = frames.find((f) => /studentcourse/i.test(f.url || ''));
    if (sc && sc.frameId) {
      /* ★★ 关键：先给章节树充分的加载时间（最多 ~18 秒）。
         实测【智变·重构·共生】这门课：刚打开时页面同样显示
         「已完成任务点: 0/0」「暂无章节内容」，但章节树是**后加载**的，
         几秒后才出现 4 章 19 节。若此刻就判「无内容」会误伤正常课程。
         所以：先等 units/items 出现；只有在**持续 18 秒都没有**、
         且页面一直显示「暂无章节内容」时，才认定是无内容课程。 */
      let o = null;
      for (let k = 0; k < 12; k++) {
        const r = await adapter.evalInFrameCross(sc.frameId, `(() => {
          const t = (document.body ? document.body.innerText : '') || '';
          const empty = /暂无章节内容|暂无内容/.test(t);
          const units = document.querySelectorAll('.chapter_unit').length;
          const items = document.querySelectorAll('.chapter_item').length;
          const heads = document.querySelectorAll('.chapter_head').length;
          return JSON.stringify({ empty, units, items, heads, sample: t.replace(/\\s+/g,' ').trim().slice(0, 80) });
        })()`);
        if (r && r.ok) { try { o = JSON.parse(r.value) } catch (_) { o = null } }
        if (o && (o.units > 0 || o.items > 0)) return { taskType: false };
        await sleep(1500);
      }
      /* 18 秒后仍然完全没有章节元素，且页面明确说「暂无章节内容」→ 判为无内容课程 */
      if (o && o.empty && o.units === 0 && o.items === 0) {
        return { taskType: true, frameId: sc.frameId, url: String(sc.url || '').slice(0, 120), kind: '暂无章节内容', sample: o.sample };
      }
    }
    // 顶层若没有任何章节元素、也没有 studentcourse 帧，也视为任务型
    const top = frames.find((f) => f.isTop) || frames[0];
    if (top && top.frameId) {
      const r = await adapter.evalInFrameCross(top.frameId, `(() => {
        const n = document.querySelectorAll('.chapter_unit').length;
        const hasChapterFrame = [...document.querySelectorAll('iframe')].some((f) => /studentcourse/i.test(f.src || ''));
        return JSON.stringify({ n, hasChapterFrame });
      })()`);
      if (r && r.ok) {
        let o; try { o = JSON.parse(r.value) } catch (_) { o = null }
        if (o && o.n === 0 && !o.hasChapterFrame) {
          return { taskType: true, url: '(no chapter tree)', kind: '无章节树' };
        }
      }
    }
  } catch (_) { /* ignore */ }
  return { taskType: false };
}

/**
 * 只读识别一个课程页（含逐层 iframe 穿透）。
 *
 * @param {object} adapter CDP 适配器
 * @param {object} opts { maxDepth, maxFrames }
 * @returns {Promise<object>} 结构化报告，不含任何页面操作痕迹
 */
async function probePageStructure(adapter, opts) {
  const o = opts || {};
  const maxDepth = typeof o.maxDepth === 'number' ? o.maxDepth : 4;
  const maxFrames = typeof o.maxFrames === 'number' ? o.maxFrames : 20;

  const frames = await adapter.getFrameDocuments();
  const report = {
    at: new Date().toISOString(),
    topUrl: '',
    frameCount: frames.length,
    frames: [],
    summary: null,
  };

  const walk = async (f) => {
    if (f.depth > maxDepth) return;
    if (report.frames.length >= maxFrames) return;
    const entry = {
      frameId: f.frameId,
      depth: f.depth,
      isTop: !!f.isTop,
      url: f.url,
      kind: 'unreadable',
    };
    // 顶层用普通 evalInFrame；其余一律走跨域 isolated world
    try {
      const res = f.isTop
        ? { ok: true, value: await adapter.evalInFrame(f.frameId, STRUCT_SCAN_EXPR) }
        : await adapter.evalInFrameCross(f.frameId, STRUCT_SCAN_EXPR);
      if (res && res.ok && res.value) {
        let parsed;
        try { parsed = JSON.parse(res.value); } catch (_) { parsed = null; }
        if (parsed) Object.assign(entry, parsed);
        else entry.kind = 'unparsed';
      } else {
        entry.error = (res && res.error) || 'empty';
      }
    } catch (e) {
      entry.error = String((e && e.message) || e).slice(0, 120);
    }
    report.frames.push(entry);
    if (f.isTop) report.topUrl = entry.url || '';
    // 子 frame 由 getFrameDocuments 已经线性返回，无需递归 children
  };

  for (const f of frames) {
    // eslint-disable-next-line no-await-in-loop
    await walk(f);
  }

  // 汇总：判断整体是哪种页面、有没有可用的章节/任务点
  const kinds = report.frames.map((x) => x.kind);
  const has = (k) => kinds.includes(k);
  report.summary = {
    pageKind: has('mooc1-study') ? 'mooc1-study'
      : has('mooc2-chapter') ? 'mooc2-chapter'
      : has('mooc2-home') ? 'mooc2-home'
      : has('login') ? 'login'
      : has('media') ? 'media'
      : 'unknown',
    tocOld: report.frames.reduce((n, x) => n + (x.tocOld || 0), 0),
    attachCt: report.frames.reduce((n, x) => n + (x.attachCt || 0), 0),
    jobIcon: report.frames.reduce((n, x) => n + (x.jobIcon || 0), 0),
    taskItems: report.frames.reduce((n, x) => n + ((x.taskItems && x.taskItems.length) || 0), 0),
    videos: report.frames.reduce((n, x) => n + (x.videos || 0), 0),
    quizForms: report.frames.reduce((n, x) => n + (x.quizForms || 0), 0),
    chapterCandidates: report.frames.reduce((n, x) => n + ((x.chapterCandidates && x.chapterCandidates.length) || 0), 0),
    readableFrames: report.frames.filter((x) => x.kind !== 'unreadable' && x.kind !== 'unparsed').length,
  };
  return report;
}

/**
 * ============================================================================
 * 模拟点击导航（规避学习通风控）
 * ----------------------------------------------------------------------------
 * ★ 为什么不能直接 navigate：
 *   学习通对直接用 URL 跳转课程页有较强风控。实测表现（2026-10-27）：
 *     - 直接 navigate 到 stucoursemiddle → 落到课程页但 pageHeader=-1，
 *       点「章节」后整页重载、studentcourse iframe 始终不出现
 *     - 从课程列表**点击**进入 → 一切正常，点「章节」立即出现章节树
 *   所以页面之间的切换一律走模拟点击（CDP Input.dispatchMouseEvent），
 *   只有「首次打开学习通首页」允许 navigate。
 *
 * 安全边界：这些点击只是导航（进课程、切 tab），不触碰任何学习行为。
 * ==========================================================================*/

/**
 * 定位课程链接：优先按 courseId 精确匹配（最可靠），其次按课程名。
 * 只读，不点击。
 */
async function locateCourseLink(adapter, courseText, courseId) {
  const frames = await adapter.getFrameDocuments();
  const top = frames.find((f) => f.isTop);
  if (!top) return { ok: false, reason: 'no-top' };

  const expr = `(() => {
    var want = ${JSON.stringify(String(courseText || ''))};
    var cid = ${JSON.stringify(String(courseId || ''))};
    var as = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
    var pool = as.filter(function (a) {
      var h = a.getAttribute('href') || '';
      return /courseid=\\d+/i.test(h);
    });
    /* ★★ 2026-11-19（D-046，真机实证）：**同一 courseid 可能有多个 <a>**。
       实测失败的点击点 x=180（页面左侧「最近学习」缩略图），成功的是 x=740（课程网格里的大卡片）。
       点缩略图不跳转 → 三次重试都失败。所以这里收集**全部**候选，
       并用命中测试（elementFromPoint 是否落在该 <a> 内部）筛出真正可点的那个，
       多个可点时优先面积大的（主网格卡片）。 */
    var cands = [];
    if (cid) {
      cands = pool.filter(function (a) {
        var m = /courseid=(\\d+)/i.exec(a.getAttribute('href') || '');
        return m && m[1] === cid;
      });
    }
    if (!cands.length && want) {
      cands = pool.filter(function (a) {
        var t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
        return t.indexOf(want) >= 0;
      });
    }
    if (!cands.length) cands = pool.slice(0, 1);
    if (!cands.length) return JSON.stringify({ ok: false, reason: 'no-course-link', pool: pool.length });

    function insideLink(a, x, y) {
      try {
        var el = document.elementFromPoint(x, y);
        if (!el) return false;
        return el === a || (a.contains && a.contains(el));
      } catch (e) { return false; }
    }
    /* ★ D-048：坐标必须落在视口内（否则合成鼠标事件点不到） */
    function inViewport(x, y) {
      return x >= 0 && y >= 0 && x <= (window.innerWidth - 1) && y <= (window.innerHeight - 1);
    }
    /* 在一个矩形里找一个「命中点确实落在该 a 内」的坐标：先中心，再 3x3 网格 */
    function pickPoint(a) {
      var r = a.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      var cand = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5], [0.35, 0.35], [0.65, 0.65]];
      for (var i = 0; i < cand.length; i++) {
        var x = Math.round(r.x + r.width * cand[i][0]);
        var y = Math.round(r.y + r.height * cand[i][1]);
        if (!inViewport(x, y) || y < 2) continue;
        if (insideLink(a, x, y)) {
          return { x: x, y: y, w: Math.round(r.width), h: Math.round(r.height), r: r };
        }
      }
      return null;
    }
    var chosen = null, chosenA = null;
    var report = [];
    for (var k = 0; k < cands.length; k++) {
      var a2 = cands[k];
      var rr = a2.getBoundingClientRect();
      var p = pickPoint(a2);
      report.push({
        i: k, w: Math.round(rr.width), h: Math.round(rr.height),
        x: Math.round(rr.x), y: Math.round(rr.y),
        clickable: !!p, area: Math.round(rr.width * rr.height),
        visible: !!(rr.width > 0 && rr.height > 0),
      });
      if (p && (!chosen || (rr.width * rr.height) > chosen.area)) {
        chosen = {
          x: p.x, y: p.y, w: p.w, h: p.h,
          /* ★★ D-052：同时返回元素**左上角**。adapter.click 内部会自己加 w/2、h/2
             取中心，所以传给它的必须是左上角；而 x/y（中心）留给日志/判断用。 */
          left: Math.round(rr.x), top: Math.round(rr.y),
          area: Math.round(rr.width * rr.height),
        };
        chosenA = a2;
      }
    }
    if (!chosen) {
      return JSON.stringify({
        ok: false, reason: 'no-clickable-point',
        cands: report, hitHref: (cands[0].getAttribute('href') || '').slice(0, 160)
      });
    }
    var t = (chosenA.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
    var h = (chosenA.getAttribute('href') || '').slice(0, 200);
    return JSON.stringify({
      ok: true, text: t, href: h,
      x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h,
      left: chosen.left, top: chosen.top,
      inViewport: true, candCount: cands.length, cands: report,
    });
  })()`;

  try {
    const raw = await adapter.evalInFrame(top.frameId, expr);
    let r; try { r = JSON.parse(raw); } catch (_) { r = { ok: false, reason: 'bad-json' }; }
    return r;
  } catch (e) {
    return { ok: false, reason: 'eval: ' + String((e && e.message) || e).slice(0, 90) };
  }
}

/**
 * 用模拟点击进入某门课程（替代 navigate）。
 * @param {string} courseText 课程名关键词（如「化工热力学」）；留空则点第一门
 */
/**
 * 列出浏览器所有 target（模块级，不依赖 adapter 内部的 cdpHttp 闭包）。
 * ★ 实测：Chrome for Testing 158 上 `/json/list` 返回空，`/json` 正常。
 *   两个都试，取有数据的那个。
 */
async function listTargets(cfg) {
  const c = cfg || CONFIG;
  const port = resolveCdpPort(c);
  if (!port) return [];
  const base = 'http://' + (c.cdp.host || '127.0.0.1') + ':' + port;
  for (const p of ['/json', '/json/list']) {
    try {
      const res = await fetch(base + p, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* 试下一个 */ }
  }
  return [];
}

async function openCourseByClick(adapter, courseText, opts) {
  const o = opts || {};
  const maxWait = o.maxWaitMs || 30000;
  const cfg = o.cfg || CONFIG;
  const courseId = o.courseId || '';

  // 记录点击前已有的 target id，用来识别「新开的那个」
  const before = new Set();
  try {
    const list0 = await listTargets(cfg);
    (list0 || []).forEach((t) => { if (t.id) before.add(t.id); });
  } catch (_) { /* ignore */ }
  logger.log('PROBE', 'INFO', '点击前 target 数', { count: before.size });

  /* ★★ 2026-11-19（D-047，真机实证）：**课程列表是懒加载的，元素在 ≠ 可点**。
     实测：回到 /visit/interaction 后仅 7 秒就定位，结果 no-clickable-point
     （<a> 已在 DOM 里，但还没渲染/在视口外/被骨架屏盖着）。
     ⇒ 定位前先轮询等「至少有一个候选通过命中测试」，最多等 25 秒；
       等不到再走原有失败路径（保留诊断）。 */
  const waitClickable = async (maxMs) => {
    const deadline = Date.now() + (maxMs || 25000);
    let last = null;
    let tries = 0;
    while (Date.now() < deadline) {
      tries += 1;
      const t = await adapter.getFrameDocuments().catch(() => []);
      const tp = (t || []).find((f) => f.isTop);
      if (tp) {
        /* ★★ 2026-11-19（D-048，真机实证）：**滚动是异步的，滚完必须重新取坐标**。
           实测：scrollIntoView 之后立刻取 rect，拿到的 y=1171（视口只有 803），
           点在视口外 → 永远点不中。而我手动实验里「滚动 → 等一会 → 重取」就成功。
           所以这里：滚动 → 等 350ms → 再取；并要求坐标落在视口内、命中测试通过。 */
        try {
          await adapter.evalInFrame(tp.frameId, `(() => {
            var cid = ${JSON.stringify(String(courseId || ''))};
            var cands = Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(function (x) {
              var m = /courseid=(\\d+)/i.exec(x.getAttribute('href') || ''); return m && m[1] === cid;
            });
            var a = cands.sort(function (p, q) {
              var rp = p.getBoundingClientRect(), rq = q.getBoundingClientRect();
              return rq.width * rq.height - rp.width * rp.height;
            })[0];
            if (a) { try { a.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { try { a.scrollIntoView(); } catch (e2) {} } }
            return !!a;
          })()`);
        } catch (_) { /* ignore */ }
        await sleep(450);   /* 等滚动生效 */
      }
      last = await locateCourseLink(adapter, courseText, courseId);
      if (last && last.ok && last.inViewport !== false) {
        logger.log('PROBE', 'INFO', '课程卡片已可点', {
          tries, x: last.x, y: last.y, candCount: last.candCount || 0,
        });
        return last;
      }
      await sleep(800);
    }
    logger.log('PROBE', 'WARN', '等待课程卡片可点超时', {
      tries, reason: last && last.reason, cands: last && last.cands ? last.cands.slice(0, 6) : undefined,
    });
    return last;
  };

  const hit = await waitClickable(25000);
  if (!hit || !hit.ok) {
    return { ok: false, reason: '未找到课程链接: ' + ((hit && hit.reason) || 'unknown') };
  }
  logger.log('PROBE', 'INFO', '模拟点击进入课程（规避风控）', {
    text: hit.text, href: String(hit.href).slice(0, 90),
  });

  const frames = await adapter.getFrameDocuments();
  const top = frames.find((f) => f.isTop);

  /* ★ 实测（2026-10-27）：课程卡片是 <a target="_blank">，
     文字常常为空（封面图卡片），且需要先 scrollIntoView 才能点到。
     所以点击前先把卡片滚到视口中央，再取坐标。 */
  try {
    await adapter.evalInFrame(top.frameId, `(() => {
      var cid = ${JSON.stringify(String(courseId || ''))};
      var as = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
      var hit = null;
      if (cid) {
        hit = as.find(function (a) {
          var m = /courseid=(\\d+)/i.exec(a.getAttribute('href') || '');
          return m && m[1] === cid;
        }) || null;
      }
      if (hit) { try { hit.scrollIntoView({ block: 'center' }); } catch (e) {} }
      return 'scrolled';
    })()`);
    await sleep(600);
  } catch (_) { /* ignore */ }

  // 重新取一次坐标（滚动后位置变了）
  const hit2 = await locateCourseLink(adapter, courseText, courseId);

  /* ★★ 2026-11-19（D-045，真机复现）：**点一次就放弃太脆**。
     真机实测：回到课程列表 7s 后点卡片（坐标 740,401，elementFromPoint 命中 IMG）
     却没打开课程页；而同一坐标在「多等几秒 + 确认布局不再漂移」后点就成功。
     ⇒ 图片卡片懒加载会让 boundingRect 在加载过程中漂移，点到的位置可能已经不是卡片。
     修法（仍然只用真实鼠标事件，绝不退化成 element.click）：
       1) 点前等布局稳定：连续两次采样坐标一致才点
       2) 点后没开新页 → 重新定位（含 scrollIntoView）+ 再点，最多 3 次
       3) 3 次都失败才报错，并保留诊断快照 */
  let pt = (hit2 && hit2.ok) ? hit2 : hit;
  let lastQuick = null;
  let clicked = 0;
  /* ★★ D-052 已修根因（双重取中心），原来的 coordFix 自适应校正改为**仅兜底**：
     只有当实测偏差**不等于 (w/2,h/2)** 时才启用（说明另有未知偏移），
     正常情况下一律走「传左上角」的正确路径。 */
  let coordFix = { dx: 0, dy: 0 };
  /* ★ D-049：记住点击前的 URL，用于「同标签跳转」判定（必须看差异，不能只看像不像） */
  let beforeUrl = '';
  try { beforeUrl = String(await adapter.getCurrentUrl() || ''); } catch (_) { beforeUrl = ''; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    /* 1) 等布局稳定：坐标连续两次一致 */
    let stable = null;
    for (let s = 0; s < 6; s++) {
      const a = await locateCourseLink(adapter, courseText, courseId);
      if (!a || !a.ok) break;
      await sleep(400);
      const b = await locateCourseLink(adapter, courseText, courseId);
      if (b && b.ok && b.x === a.x && b.y === a.y) { stable = b; break; }
      stable = b && b.ok ? b : a;
    }
    pt = stable || pt;
    /* ★ D-052 兜底：应用兜底校正量（正常为 0，因为根因已由「传左上角」修掉） */
    if (coordFix.dx || coordFix.dy) {
      if (pt.left != null && pt.top != null) {
        pt = Object.assign({}, pt, { left: Math.max(0, Math.round(pt.left) - coordFix.dx), top: Math.max(0, Math.round(pt.top) - coordFix.dy) });
      } else {
        pt = Object.assign({}, pt, { x: Math.max(1, Math.round(pt.x) - coordFix.dx), y: Math.max(1, Math.round(pt.y) - coordFix.dy) });
      }
    }
    try {
      /* ★ D-049：点击前先激活 target。真机实证：同样坐标/同样事件序列，
         「新建 target」能打开课程页，而「attach 到已有 target」点了没反应。 */
      if (typeof adapter.bringToFront === 'function') {
        const bf = await adapter.bringToFront().catch(() => null);
        if (bf && bf.ok === false) logger.log('PROBE', 'WARN', 'bringToFront 失败', { reason: bf.reason });
      }
      /* ★★ D-051（诊断用，长期保留）：点击前在页面挂一次性点击探针，
         点完读取「页面到底有没有收到 click」。这是区分
         「CDP 事件没送达」与「页面收到但没跳转」的唯一可靠证据。 */
      try {
        await adapter.evalInFrame(top.frameId, `(() => {
          try {
            window.__cxClickProbe = { down: 0, up: 0, click: 0, linkClick: 0, at: Date.now(), ev: null };
            if (!window.__cxProbeBound) {
              window.__cxProbeBound = true;
              document.addEventListener('mousedown', function () { if (window.__cxClickProbe) window.__cxClickProbe.down++; }, true);
              document.addEventListener('mouseup', function () { if (window.__cxClickProbe) window.__cxClickProbe.up++; }, true);
              document.addEventListener('click', function (ev) {
                if (!window.__cxClickProbe) return;
                window.__cxClickProbe.click++;
                var n = ev.target;
                var inA = false;
                for (var i = 0; i < 6 && n; i++) { if (n.tagName === 'A') { inA = true; break; } n = n.parentElement; }
                if (inA) window.__cxClickProbe.linkClick++;
                /* ★ D-051：记录事件实际坐标与命中元素 —— 与「我们发出去的坐标」对比，
                   就能判断是不是坐标系错位（CSS zoom / 缩放 / 视口偏移）。 */
                window.__cxClickProbe.ev = {
                  cx: ev.clientX, cy: ev.clientY,
                  tgt: ev.target ? (ev.target.tagName + '.' + String(ev.target.className || '').split(' ')[0]) : null,
                  inA: inA,
                  dpr: window.devicePixelRatio,
                  vw: window.innerWidth, vh: window.innerHeight,
                  zoom: (function () { try { return getComputedStyle(document.body).zoom; } catch (e) { return null; } })(),
                  scrollX: window.scrollX, scrollY: window.scrollY,
                  vv: (window.visualViewport ? {
                    ox: Math.round(window.visualViewport.offsetLeft), oy: Math.round(window.visualViewport.offsetTop),
                    px: Math.round(window.visualViewport.pageLeft), py: Math.round(window.visualViewport.pageTop),
                    sx: Math.round(window.visualViewport.scale * 100) / 100,
                    w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height)
                  } : null),
                  screenX: window.screenX, screenY: window.screenY,
                  outerW: window.outerWidth, outerH: window.outerHeight
                };
              }, true);
            }
          } catch (e) {}
          return true;
        })()`);
      } catch (_) { /* ignore */ }

      /* ★★ D-052（根因修复）：adapter.click 内部会做 `x = rect.x + rect.w/2`，
         所以这里必须传**左上角** (left/top)，不能传中心 x/y —— 传中心会导致
         「再取一次中心」，偏移恰好等于 (w/2, h/2)。
         实测：卡片 240×130 → 发 180,401 实际点到 300,466，正是这个原因。 */
      const clickRect = (pt.left != null && pt.top != null)
        ? { x: pt.left, y: pt.top, w: pt.w, h: pt.h }
        : { x: pt.x, y: pt.y, w: pt.w, h: pt.h };   /* 兼容老调用（无 left/top） */
      await adapter.click(top.frameId, clickRect);
      logger.log('PROBE', 'INFO', '已用真实鼠标点击课程卡片', {
        attempt, x: pt.x, y: pt.y, w: pt.w, h: pt.h,
        candCount: pt.candCount || 0, cands: (pt.cands || []).slice(0, 4),
      });
    } catch (e) {
      logger.log('PROBE', 'WARN', '鼠标点击抛错', { attempt, err: String((e && e.message) || e).slice(0, 80) });
    }
    /* 2) 等新页出现（每轮最多 ~6s） */
    for (let w = 0; w < 5; w++) {
      await sleep(1200);
      const quickNow = await listTargets(cfg).catch(() => []);
      const hitNow = (quickNow || []).some((t) => t.type === 'page' &&
        /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/i.test(t.url || '') && !before.has(t.id));
      if (hitNow) { lastQuick = quickNow; break; }
      lastQuick = quickNow;
    }
    /* ★ D-051：把点击探针结果打出来（判断事件是否送达页面） */
    let probe = null;
    try {
      const pr = await adapter.evalInFrame(top.frameId, '(() => JSON.stringify(window.__cxClickProbe || null))()');
      try { probe = JSON.parse(pr); } catch (_) { probe = null; }
      logger.log('PROBE', 'INFO', '点击探针结果', { attempt, probe });
      /* 清掉，避免下一轮累加 */
      await adapter.evalInFrame(top.frameId, '(() => { window.__cxClickProbe = null; return true; })()');
    } catch (_) { /* ignore */ }
    /* ★ D-052 兜底：只有实测偏差**不是** (w/2,h/2) 时才用自适应校正
       （(w/2,h/2) 已由「传左上角」根治；若还偏，说明另有未知偏移源）。 */
    if (probe && probe.ev && typeof probe.ev.cx === 'number') {
      const sentCx = (pt.left != null) ? Math.round(pt.left + pt.w / 2) : Math.round(pt.x);
      const sentCy = (pt.top != null) ? Math.round(pt.top + pt.h / 2) : Math.round(pt.y);
      const dx = probe.ev.cx - sentCx;
      const dy = probe.ev.cy - sentCy;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        coordFix = { dx: coordFix.dx + dx, dy: coordFix.dy + dy };
        logger.log('PROBE', 'WARN', '点击坐标仍有额外偏移（非 w/2,h/2），已记录兜底校正', {
          attempt, sentCenter: { x: sentCx, y: sentCy }, received: { x: probe.ev.cx, y: probe.ev.cy },
          dx, dy, coordFix,
        });
      }
    }
    const opened = (lastQuick || []).some((t) => t.type === 'page' &&
      /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/i.test(t.url || '') && !before.has(t.id));
    if (opened) break;
    /* ★ D-049：也可能「同标签跳转」而不开新页 —— 直接看当前页 URL 是否已变成课程页。
       ★★ 注意（测试抓到的坑）：**必须比较点击前后的差异**。
          只看「当前 URL 像不像课程页」会误判 —— 页面本来就停在课程列表/学习页时
          也会命中，于是把「没点开」当成「点开了」（假成功，比失败更难查）。 */
    try {
      const curUrl = String(await adapter.getCurrentUrl() || '');
      const changed = curUrl && curUrl !== beforeUrl;
      if (changed && /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu|mycourse\/studentstudy/i.test(curUrl)) {
        logger.log('PROBE', 'INFO', '点击后本页已跳转到课程页（同标签）', { url: curUrl.slice(0, 110) });
        return { ok: true, text: hit && hit.text, url: curUrl, targetId: adapter.getTargetId ? adapter.getTargetId() : null, sameTab: true };
      }
    } catch (_) { /* ignore */ }
    if (attempt < 3) {
      logger.log('PROBE', 'WARN', '点击未打开课程页，重新定位后再试', { attempt });
      /* 重新滚到卡片，准备下一轮 */
      try {
        await adapter.evalInFrame(top.frameId, `(() => {
          var cid = ${JSON.stringify(String(courseId || ''))};
          var a = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
            .find(function (x) { var m = /courseid=(\\d+)/i.exec(x.getAttribute('href') || ''); return m && m[1] === cid; });
          if (a) { try { a.scrollIntoView({ block: 'center' }); } catch (e) {} }
          return !!a;
        })()`);
      } catch (_) { /* ignore */ }
      await sleep(1200);
    }
  }
  const quick = lastQuick || await listTargets(cfg);
  const hasCoursePage = (quick || []).some((t) => t.type === 'page' &&
    /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/i.test(t.url || '') && !before.has(t.id));
  if (!hasCoursePage) {
    logger.log('PROBE', 'WARN', '鼠标点击未打开课程页', {
      hint: '按主人规则不降级为 element.click()；已重试 ' + clicked + ' 次，下面留诊断快照',
      clickPoint: { x: pt.x, y: pt.y, w: pt.w, h: pt.h },
      candCount: pt.candCount || 0, cands: (pt.cands || []).slice(0, 6),
      hitText: (hit && hit.text) || '', hitHref: String((hit && hit.href) || '').slice(0, 120),
      hasCoursePage, attempts: clicked,
      pagesSeen: (quick || []).filter((t) => t.type === 'page').map((t) => String(t.url).slice(0, 90)).slice(0, 8),
    });
    /* 快照存证：把「点了哪里、页面上那一点是什么元素」记下来，便于事后对比 */
    try {
      const snap = await adapter.evalInFrame(top.frameId, `(() => {
        var cx = ${JSON.stringify(Number(pt.x || 0))}, cy = ${JSON.stringify(Number(pt.y || 0))};
        var el = document.elementFromPoint(cx, cy);
        return JSON.stringify({
          at: new Date().toISOString(),
          point: { x: cx, y: cy },
          topEl: el ? { tag: el.tagName, cls: String(el.className || '').slice(0, 60), text: (el.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 60) } : null,
          scrollY: window.scrollY, viewport: { w: innerWidth, h: innerHeight },
          url: location.href
        });
      })()`);
      logger.log('PROBE', 'WARN', '鼠标点击失败快照', { snapshot: String(snap).slice(0, 400) });
    } catch (e) {
      logger.log('PROBE', 'WARN', '快照失败', { err: String((e && e.message) || e).slice(0, 80) });
    }
    return { ok: false, reason: '鼠标点击未打开课程页（已按规则停止，不再用 JS click 兜底）' };
  }

  /* ★ 实测（2026-10-27）：点课程卡片会在**新标签页**打开课程，
     原列表页 URL 始终不变。所以不能等「当前页 URL 变化」，
     必须轮询 /json/list 找**新出现的**课程页 target。 */
  const deadline = Date.now() + maxWait;
  let lastSeen = '';
  while (Date.now() < deadline) {
    await sleep(1500);
    let list = [];
    try { list = await listTargets(cfg); } catch (_) { list = []; }
    const pages = list.filter((t) => t.type === 'page');
    lastSeen = pages.map((t) => (t.url || '').slice(0, 60)).join(' | ');

    /* ★ 实测：点课程卡片可能复用已有标签、也可能新开一个。
       所以不区分新旧，只要池子里存在课程页就附着过去；
       优先选「刚才没在的前台页」，否则取最后一个课程页。 */
    /* ★★ 2026-11-18（D-041，真机实证）：**只认新点开的课程入口页**。
       旧实现的正则同时匹配 `mycourse/studentstudy`，且 fresh 为空时 fallback 到
       `coursePages[last]` —— 实测池子里残留着两个旧的 mooc1/studentstudy 标签
       （chapterId=643076150 / 643076170），于是「进入课程」拿到了**旧标签页**：
       那个 URL 没有有效 enc → 落到「温馨提示」错误页 → 只有 1 个 frame、
       tocFound=false → 最终 UNRECOGNIZED_PAGE。

       实证（真实鼠标点击 740,401 点课程卡片）新 target 是：
         mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...&enc=<新生成>&t=<时间戳>
       ⇒ 只认这个形态，且必须是**点击后新出现的**（不在 before 里）。
         找不到就明确失败并留诊断，绝不 fallback 到残留页。 */
    const coursePages = pages.filter((t) =>
      /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu\b/i.test(t.url || '')
    );
    if (coursePages.length) {
      const fresh = coursePages.filter((t) => !before.has(t.id));
      if (!fresh.length) {
        /* 全是点击前就存在的页 —— 说明我们的点击没打开新的课程页。
           宁可报错，也不许把残留旧页当成「进入成功」（D-041 的核心）。 */
        logger.log('PROBE', 'WARN', '点击后只看到点击前已存在的课程页，判为未打开', {
          coursePages: coursePages.map((t) => String(t.url).slice(0, 90)),
          pagesSeen: lastSeen.slice(0, 300),
        });
        return { ok: false, reason: '点击后未出现新的课程页（只有点击前已存在的残留页）' };
      }
      const target = fresh[fresh.length - 1];
      await sleep(4000);
      logger.log('PROBE', 'INFO', '已进入课程页（模拟点击）', {
        url: String(target.url).slice(0, 110), isNew: true,
      });
      try { await adapter.attachTarget(target.id); } catch (e) {
        logger.log('PROBE', 'WARN', 'attachTarget 失败', { err: String((e && e.message) || e).slice(0, 90) });
      }
      return { ok: true, text: hit.text, url: String(target.url), targetId: target.id };
    }
  }
  logger.log('PROBE', 'WARN', '点击后未出现课程页', {
    beforeCount: before.size,
    pagesSeen: lastSeen.slice(0, 300),
  });
  return { ok: false, reason: '点击后未出现课程页（超时）' };
}

/**
 * 点开「章节」并等待章节 iframe 就绪（整合重试 + 重新附着）。
 *
 * 实测（2026-10-27）：点「章节」会让页面**整页跳转**到 pageHeader=1，
 * 旧 target 被替换、新 target 出现、iframe 随后才加载。
 * 所以这里做完整闭环：点 → 等新 target → 重新附着 → 等 iframe → 校验。
 */
async function openChapterAndWait(adapter, cfg, opts) {
  const o = opts || {};
  const maxRound = o.maxRound || 2;

  for (let round = 1; round <= maxRound; round++) {
    // 已经在章节页就不用再点
    if (await waitForChapterFrame(adapter, 3000)) return { ok: true, round };

    // 记录点击前 URL，用于判断是否发生跳转
    let urlBefore = '';
    try { urlBefore = await adapter.getCurrentUrl(); } catch (_) { urlBefore = ''; }

    logger.log('PROBE', 'INFO', `第 ${round} 轮：点「章节」tab`, { urlBefore: String(urlBefore).slice(0, 90) });
    const clicked = await openChapterTab(adapter);
    if (!clicked.ok) {
      logger.log('PROBE', 'WARN', '点章节失败', { reason: clicked.reason });
      continue;
    }

    /* ★ 实测：点「章节」会让页面**整页跳转**（URL 加 pageHeader=1）。
       判断是否成功的关键信号是 URL 变化，而不是固定 sleep。
       这里轮询 25 秒：每 2.5 秒看一次 URL + 是否有章节 iframe。 */
    const deadline = Date.now() + 25000;
    let urlChanged = false;
    while (Date.now() < deadline) {
      await sleep(2500);

      let urlNow = '';
      try { urlNow = await adapter.getCurrentUrl(); } catch (_) { urlNow = ''; }
      if (urlNow && urlNow !== urlBefore && /pageHeader=1/i.test(urlNow)) {
        if (!urlChanged) {
          urlChanged = true;
          logger.log('PROBE', 'INFO', '检测到 URL 跳转到 pageHeader=1', { url: urlNow.slice(0, 110) });
        }
      }

      if (await waitForChapterFrame(adapter, 2000)) return { ok: true, round };

      // URL 变了但当前 target 读不到，看看是不是换了新 target
      if (urlChanged) {
        const list = await listTargets(cfg).catch(() => []);
        const withHeader = list
          .filter((t) => t.type === 'page' && /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu/i.test(t.url || ''))
          .find((t) => /pageHeader=1/i.test(t.url || ''));
        if (withHeader) {
          logger.log('PROBE', 'INFO', '重新附着到 pageHeader=1 的 target');
          try { await adapter.attachTarget(withHeader.id); } catch (_) { /* ignore */ }
          await sleep(2000);
          if (await waitForChapterFrame(adapter, 12000)) return { ok: true, round };
        }
      }
    }
    logger.log('PROBE', 'WARN', `第 ${round} 轮未等到章节 iframe`, { urlChanged });
  }
  return { ok: false };
}

/**
 * 在章节树里点开指定小节（模拟点击，只读导航）。
 *
 * @param {object} adapter
 * @param {string} keyword 小节标题关键词（如 '1.1'）；留空则点第一节
 * @returns {Promise<{ok:boolean, text?:string, reason?:string}>}
 */
async function openSectionByClick(adapter, keyword) {
  const frames = await adapter.getFrameDocuments();
  const cf = frames.find((f) => /studentcourse/i.test(f.url || ''));
  if (!cf) return { ok: false, reason: '章节 iframe 不存在（先点「章节」tab）' };

  // 1) 在章节 iframe 内定位目标节点坐标
  const locate = `(() => {
    var want = ${JSON.stringify(String(keyword || ''))};
    var items = Array.prototype.slice.call(document.querySelectorAll('.chapter_item'));
    if (!items.length) return JSON.stringify({ ok: false, reason: 'no-items' });
    // 过滤掉「章头」行（.chapter_item 里也有章标题），只留有小节号的
    var secs = items.filter(function (el) {
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      return /^\\d+\\.\\d+/.test(t);
    });
    var pool = secs.length ? secs : items;
    /* ★ 2026-10-28 修 bug：原来用 indexOf(want) 做**子串**匹配，
       导致 want="1.6" 命中 "11.6 隐私权"（实测 --section=1.6 打开了 11.6）。
       改为四级匹配：完全相等 → 前缀 → 小节号锚定 → 兜底子串（要求前面非数字）。 */
    var hit = null;
    if (want) {
      var nm = function (el) { return String(el.innerText || '').replace(/\\s+/g, ' ').trim(); };
      hit = pool.find(function (el) { return nm(el) === want; });
      if (!hit) hit = pool.find(function (el) { return nm(el).indexOf(want + ' ') === 0; });
      if (!hit) {
        // 注意：本段在模板字符串内，反斜杠要双写
        var esc = want.split('').map(function (c) {
          return /[.*+?^\${}()|[\\]\\\\]/.test(c) ? '\\\\' + c : c;
        }).join('');
        var rex = new RegExp('^' + esc + '(?![0-9.])');
        hit = pool.find(function (el) { return rex.test(nm(el)); });
      }
      if (!hit) {
        hit = pool.find(function (el) {
          var s = nm(el);
          var i = s.indexOf(want);
          if (i < 0) return false;
          if (i > 0 && /[0-9]/.test(s.charAt(i - 1))) return false;
          return true;
        });
      }
    } else {
      hit = pool[0];
    }
    if (!hit) return JSON.stringify({ ok: false, reason: 'not-found', total: pool.length });
    var r = hit.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      text: (hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      total: pool.length,
    });
  })()`;

  let hit;
  try {
    const raw = await adapter.evalInFrameCross(cf.frameId, locate);
    if (!raw || !raw.ok) return { ok: false, reason: 'locate: ' + ((raw && raw.error) || 'failed') };
    hit = JSON.parse(raw.value);
  } catch (e) {
    return { ok: false, reason: 'eval: ' + String((e && e.message) || e).slice(0, 90) };
  }
  if (!hit || !hit.ok) return { ok: false, reason: '定位失败: ' + ((hit && hit.reason) || 'unknown') };

  /* 2) 点击：章节 iframe 是跨域的，坐标是 iframe 内的局部坐标，
        需要用 elementFromPoint 在该 iframe 的上下文里做 JS 点击
        （跨域 frame 内无法用顶层 CDP 鼠标事件精确命中）。 */
  const clickExpr = `(() => {
    var want = ${JSON.stringify(String(keyword || ''))};
    var items = Array.prototype.slice.call(document.querySelectorAll('.chapter_item'));
    var secs = items.filter(function (el) {
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      return /^\\d+\\.\\d+/.test(t);
    });
    var pool = secs.length ? secs : items;
    /* 与上面定位逻辑保持同一套匹配规则（见前一处注释），避免「定位到了 A、点击了 B」 */
    var hit = null;
    if (want) {
      var nm2 = function (el) { return String(el.innerText || '').replace(/\\s+/g, ' ').trim(); };
      hit = pool.find(function (el) { return nm2(el) === want; });
      if (!hit) hit = pool.find(function (el) { return nm2(el).indexOf(want + ' ') === 0; });
      if (!hit) {
        var esc2 = want.split('').map(function (c) {
          return /[.*+?^\${}()|[\\]\\\\]/.test(c) ? '\\\\' + c : c;
        }).join('');
        var rex2 = new RegExp('^' + esc2 + '(?![0-9.])');
        hit = pool.find(function (el) { return rex2.test(nm2(el)); });
      }
      if (!hit) {
        hit = pool.find(function (el) {
          var s = nm2(el);
          var i = s.indexOf(want);
          if (i < 0) return false;
          if (i > 0 && /[0-9]/.test(s.charAt(i - 1))) return false;
          return true;
        });
      }
    } else {
      hit = pool[0];
    }
    if (!hit) return JSON.stringify({ ok: false });
    var t = hit.querySelector('a') || hit;
    try { t.click(); } catch (e) { return JSON.stringify({ ok: false, err: String(e.message || e).slice(0, 60) }); }
    return JSON.stringify({ ok: true });
  })()`;
  try {
    const r = await adapter.evalInFrameCross(cf.frameId, clickExpr);
    if (!r || !r.ok) return { ok: false, reason: '点击失败' };
  } catch (e) {
    return { ok: false, reason: 'click: ' + String((e && e.message) || e).slice(0, 90) };
  }
  logger.log('PROBE', 'INFO', '已点开小节（模拟点击·只读导航）', { text: hit.text });
  await sleep(5000);
  return { ok: true, text: hit.text };
}

/**
 * 扫描当前页面里所有 frame 的任务点（只读）。
 * 会穿透跨域 iframe，返回每个任务点的类型/完成状态/来源。
 */
async function scanTaskPoints(adapter) {
  const out = {
    at: new Date().toISOString(),
    frames: [],
    tasks: [],
    summary: { total: 0, video: 0, audio: 0, document: 0, quiz: 0, unknown: 0, finished: 0 },
  };

  const SCAN = `(() => {
    var d = document;
    var txt = function (el) { return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim(); };
    var tasks = [];
    d.querySelectorAll('.ans-attach-ct').forEach(function (el) {
      var icon = el.querySelector('.ans-job-icon');
      var ifr = el.querySelector('iframe');
      var src = ifr ? (ifr.getAttribute('src') || '') : '';
      var label = icon ? (icon.getAttribute('aria-label') || '') : '';
      var kind = 'unknown';
      if (/\\/modules\\/audio\\//i.test(src) || (ifr && ifr.getAttribute('module') === 'insertaudio')) kind = 'audio';
      else if (/\\/modules\\/video\\//i.test(src)) kind = 'video';
      else if (/work|quiz|exam/i.test(src)) kind = 'quiz';
      else if (/pdf|doc|read|screen/i.test(src)) kind = 'document';
      else if (el.querySelector('video,audio')) kind = 'video';
      tasks.push({
        kind: kind,
        finished: el.classList.contains('ans-job-finished') || /已完成|complete/i.test(label),
        iconLabel: label.slice(0, 24),
        src: src.slice(0, 120),
        text: txt(el).slice(0, 60),
      });
    });
    return JSON.stringify({
      url: (location.href || '').slice(0, 130),
      attachCt: d.querySelectorAll('.ans-attach-ct').length,
      jobIcon: d.querySelectorAll('.ans-job-icon').length,
      video: d.querySelectorAll('video').length,
      videoQuiz: d.querySelectorAll('.ans-videoquiz').length,
      tasks: tasks,
      body: txt(d.body).slice(0, 260),
    });
  })()`;

  const frames = await adapter.getFrameDocuments();
  for (const f of frames) {
    try {
      const res = f.isTop
        ? { ok: true, value: await adapter.evalInFrame(f.frameId, SCAN) }
        : await adapter.evalInFrameCross(f.frameId, SCAN);
      if (!res || !res.ok || !res.value) continue;
      let o; try { o = JSON.parse(res.value); } catch (_) { continue; }
      out.frames.push({
        depth: f.depth, url: String(o.url || '').slice(0, 130),
        attachCt: o.attachCt || 0, jobIcon: o.jobIcon || 0,
        video: o.video || 0, videoQuiz: o.videoQuiz || 0,
      });
      (o.tasks || []).forEach((t) => out.tasks.push(Object.assign({ frameDepth: f.depth }, t)));
    } catch (_) { /* 跳过读不到的 frame */ }
  }

  out.summary.total = out.tasks.length;
  for (const t of out.tasks) {
    if (out.summary[t.kind] !== undefined) out.summary[t.kind] += 1;
    if (t.finished) out.summary.finished += 1;
  }
  return out;
}

/**
 * ============================================================================
 * 批量扫描全部课程（只读）
 * ----------------------------------------------------------------------------
 * 对账号下每门课执行：进课程 → 点章节 → 读章节树 → 汇总。
 *
 * ★ 风控与稳定性要求：
 *   1. 全程模拟点击，不直接 navigate 到课程页
 *   2. 每门课之间随机停顿（默认 4~9 秒），避免高频访问
 *   3. 每门课结束后关闭多余标签页，防止 target 越堆越多
 *
 * ★ 安全边界：只读。不进小节、不播放、不答题。
 * ==========================================================================*/

/** 找到课程列表页的 target（用于把操作焦点切回去）。 */
async function findListTarget(cfg) {
  let list = [];
  try { list = await listTargets(cfg); } catch (_) { return null; }
  return list.find((t) => t.type === 'page' && /visit\/interaction|mooc1\.chaoxing\.com\/visit/i.test(t.url || '')) || null;
}

/** 关闭除「保留列表」之外的课程页标签（只关我们自己开的课程页）。 */
async function closeExtraCourseTabs(cfg, keepTargetId) {
  let list = [];
  try { list = await listTargets(cfg); } catch (_) { return 0; }
  const port = resolveCdpPort(cfg);
  if (!port) return 0;
  let closed = 0;
  for (const t of list) {
    if (t.type !== 'page') continue;
    if (keepTargetId && t.id === keepTargetId) continue;
    // 只关课程页/学习页，绝不动列表页和登录页
    if (!/mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu|mycourse\/studentstudy|knowledge\/cards/i.test(t.url || '')) continue;
    try {
      await fetch('http://' + (cfg.cdp.host || '127.0.0.1') + ':' + port + '/json/close/' + t.id,
        { signal: AbortSignal.timeout(6000) });
      closed += 1;
    } catch (_) { /* ignore */ }
  }
  if (closed) logger.log('PROBE', 'INFO', '已关闭多余课程标签', { closed });
  return closed;
}

/** 从课程列表页读出去重后的课程清单（课程名 + 链接）。 */
async function readCourseList(adapter) {
  const frames = await adapter.getFrameDocuments();
  const top = frames.find((f) => f.isTop);
  if (!top) return [];
  const expr = `(() => {
    var out = [], seen = {};
    Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
      var h = a.getAttribute('href') || '';
      var m = /courseid=(\\d+)/i.exec(h);
      if (!m) return;
      var cid = m[1];
      if (seen[cid]) return;
      // 取最近的有意义的文字作为课程名
      var t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length < 2) {
        var box = a.closest('li,div');
        if (box) t = (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      }
      if (!t || t.length < 2) return;
      seen[cid] = 1;
      out.push({ courseId: cid, title: t.slice(0, 60), href: h.slice(0, 200) });
    });
    return JSON.stringify(out);
  })()`;
  try {
    const raw = await adapter.evalInFrame(top.frameId, expr);
    let arr; try { arr = JSON.parse(raw); } catch { arr = []; }
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

/**
 * 批量扫描全部课程（只读）—— 慢速分批模式。
 * ----------------------------------------------------------------------------
 * ★ 风控策略（主人 2026-10-27 定：方案 C「分批慢扫」）：
 *   1. 课程之间随机间隔 25~45 秒（接近真人翻课节奏）
 *   2. 每扫完 batchSize 门（默认 5）额外休息 60~120 秒
 *   3. 每门课结束关闭多余标签，避免 target 堆积
 *   4. 全程模拟点击，不直接 navigate 课程 URL
 *
 * ★ 安全边界：只读。不进小节、不播放、不答题。
 */
async function scanAllCourses(adapter, opts) {
  const o = opts || {};
  const cfg = o.cfg || CONFIG;
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 50));
  const gapMin = Number(o.gapMinMs) || 25000;
  const gapMax = Number(o.gapMaxMs) || 45000;
  const batchSize = Math.max(1, Number(o.batchSize) || 5);
  const batchRestMin = Number(o.batchRestMinMs) || 60000;
  const batchRestMax = Number(o.batchRestMaxMs) || 120000;

  const result = {
    at: new Date().toISOString(),
    total: 0,
    scanned: 0,
    ok: 0,
    failed: 0,
    batchSize,
    courses: [],
  };

  // 1) 回到课程列表页
  await adapter.navigate('https://mooc1.chaoxing.com/visit/interaction');
  await sleep(8000);

  // 2) 读课程清单
  const list = await readCourseList(adapter);
  result.total = list.length;
  logger.log('PROBE', 'INFO', '发现课程', { count: list.length, willScan: Math.min(limit, list.length) });

  const targets = list.slice(0, limit);
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const rec = {
      index: i + 1,
      courseId: c.courseId,
      title: c.title,
      ok: false,
      pageKind: '',
      chapterCount: 0,
      sectionCount: 0,
      chapters: [],
      note: '',
    };
    logger.log('PROBE', 'INFO', '扫描课程 ' + (i + 1) + '/' + targets.length, { title: c.title });

    try {
      /* 切回列表页 target（不要 navigate，避免冲掉标签池） */
      const listTarget = await findListTarget(cfg);
      if (!listTarget) {
        await adapter.navigate('https://mooc1.chaoxing.com/visit/interaction');
        await sleep(6000);
      } else {
        try { await adapter.attachTarget(listTarget.id); } catch (_) { /* ignore */ }
        await sleep(1500);
      }

      const opened = await openCourseByClick(adapter, c.title, {
        maxWaitMs: 25000, cfg, courseId: c.courseId,
      });
      if (!opened.ok) {
        rec.note = '进入失败: ' + opened.reason;
        result.failed += 1;
        result.courses.push(rec);
        result.scanned += 1;
        await closeExtraCourseTabs(cfg, listTarget ? listTarget.id : null);
        continue;
      }

      // ★ 进课程后先等页面稳定，再点章节（实测布局未稳时点不到）
      await sleep(5000);

      const chRes = await openChapterAndWait(adapter, cfg, { maxRound: 2 });
      if (!chRes.ok) {
        /* ★ 先判断是不是「任务型课程」（没有章节树，只有活动列表）。
           实测「典型建模技术」「优化理论与方法」属于这类，
           帧里是 stuActiveList，整页没有任何 chapter 元素。
           这不是失败，是课程结构不同，应记为 task-type 并算成功扫描。 */
        const tt = await detectTaskTypeCourse(adapter);
        if (tt.taskType) {
          rec.note = `无章节内容（${tt.kind || '任务型'}）`;
          rec.pageKind = 'no-content';
          rec.ok = true;
          result.ok += 1;
          logger.log('PROBE', 'INFO', '课程无章节内容，跳过章节树识别', {
            kind: tt.kind, url: String(tt.url || '').slice(0, 80), sample: tt.sample || '',
          });
          result.courses.push(rec);
          result.scanned += 1;
          await closeExtraCourseTabs(cfg, listTarget ? listTarget.id : null);
          continue;
        }
        const st = await probePageStructure(adapter, { maxDepth: 1, maxFrames: 3 });
        const topF = st.frames.find((x) => x.isTop);
        const hasTab = ((topF && topF.navTabs) || []).some((t) => t.text === '章节');
        if (!hasTab) {
          rec.note = '该课程无「章节」tab（直播/任务型）';
          rec.pageKind = 'no-chapter-tab';
          rec.ok = true;
          result.ok += 1;
        } else {
          rec.note = '章节 iframe 未加载';
          rec.pageKind = 'chapter-timeout';
          result.failed += 1;
        }
        result.courses.push(rec);
        result.scanned += 1;
        await closeExtraCourseTabs(cfg, listTarget ? listTarget.id : null);
        continue;
      }

      // 读章节树
      const struct = await probePageStructure(adapter, { maxDepth: 3, maxFrames: 12 });
      const chapterFrame = struct.frames.find((f) => (f.chapters && f.chapters.length));
      if (chapterFrame) {
        rec.chapters = chapterFrame.chapters.map((x) => ({
          head: String(x.head || '').slice(0, 50),
          itemCount: x.itemCount || 0,
        }));
        rec.chapterCount = chapterFrame.chapters.length;
        rec.sectionCount = chapterFrame.chapters.reduce((n, x) => n + (x.itemCount || 0), 0);
      }
      rec.pageKind = 'mooc2-home';
      rec.ok = rec.chapterCount > 0;
      if (rec.ok) result.ok += 1; else result.failed += 1;
      if (!rec.chapterCount) rec.note = '未识别到章节树';
    } catch (e) {
      rec.note = '异常: ' + String((e && e.message) || e).slice(0, 100);
      result.failed += 1;
    }

    result.scanned += 1;
    result.courses.push(rec);
    if (typeof o.onEach === 'function') { try { o.onEach(rec) } catch (_) { /* ignore */ } }

    // 清理标签
    await closeExtraCourseTabs(cfg, null);

    if (i < targets.length - 1) {
      /* 批次休息：每 batchSize 门额外停久一点 */
      const isBatchEnd = (i + 1) % batchSize === 0;
      let gap;
      if (isBatchEnd) {
        gap = batchRestMin + Math.floor(Math.random() * Math.max(1, batchRestMax - batchRestMin));
        logger.log('PROBE', 'INFO', `本批 ${batchSize} 门完成，休息 ${Math.round(gap / 1000)}s（防风控）`);
      } else {
        gap = gapMin + Math.floor(Math.random() * Math.max(1, gapMax - gapMin));
        logger.log('PROBE', 'INFO', `停顿 ${Math.round(gap / 1000)}s 后继续`);
      }
      await sleep(gap);
    }
  }

  return result;
}

/**
 * 课程识别报告（只读）
 * ----------------------------------------------------------------------------
 * 输出一门课程的完整结构：章节树 + 每节状态 + 任务点 + 测验线索。
 *
 * ★ 安全边界：全程只读。不播放、不点学习元素、不答题、不提交。
 *   唯一允许的点击是「章节」tab（纯导航，等同于用户翻页）。
 *
 * 实测数据来源：化工热力学（courseid=227957344），
 *   .chapter_unit=7（章）、.chapter_item=32（节）、总任务 36。
 * ==========================================================================*/
async function buildCourseReport(adapter, opts) {
  const o = opts || {};
  const report = {
    at: new Date().toISOString(),
    reason: '',
    courseUrl: '',
    pageKind: 'unknown',
    navTabs: [],
    chapters: [],
    chapterCount: 0,
    sectionCount: 0,
    taskSummary: { total: 0, attachCt: 0, jobIcon: 0, videos: 0, quizLike: 0 },
    frames: [],
  };

  // ── 第 1 步：先看当前页是什么 ──
  let struct = await probePageStructure(adapter, { maxDepth: 2, maxFrames: 8 });
  report.pageKind = struct.summary.pageKind;
  const topFrame = struct.frames.find((f) => f.isTop);
  if (topFrame) {
    report.courseUrl = topFrame.url || '';
    report.navTabs = (topFrame.navTabs || []).map((t) => t.text).filter(Boolean);
  }

  // ── 第 2 步：新版课程主页 → 点「章节」tab（唯一允许的点击） ──
  if (report.pageKind === 'mooc2-home') {
    logger.log('PROBE', 'INFO', '识别到新版课程主页，点开「章节」tab 继续（只读导航）');
    const r = await openChapterTab(adapter);
    if (!r.ok) {
      report.reason = '点「章节」失败: ' + (r.reason || 'unknown');
      return report;
    }
    /* ★ 点完「章节」会触发一次页面导航。实测有两种情况：
       a) 页面原地换 iframe → 直接等 studentcourse
       b) 整页重载（URL 的 pageHeader 变化）→ 重载后又回到「任务」tab，
          需要再点一次「章节」
       所以这里做成：等待 → 若超时则再点一次 → 再等。 */
    let ready = await waitForChapterFrame(adapter, 15000);
    if (!ready) {
      logger.log('PROBE', 'INFO', '首次等待超时，页面可能整页重载了，再点一次「章节」');
      const again = await openChapterTab(adapter);
      logger.log('PROBE', 'INFO', '补点「章节」结果', { ok: !!(again && again.ok) });
      ready = await waitForChapterFrame(adapter, 20000);
    }
    if (!ready) {
      report.reason = '点了「章节」但章节 iframe 未加载出来（可能需要人工点一次确认）';
      return report;
    }
    struct = await probePageStructure(adapter, { maxDepth: 4, maxFrames: 20 });
    report.pageKind = struct.summary.pageKind;
  }

  // ── 第 3 步：汇总裁剪 ──
  report.frames = struct.frames.map((f) => ({
    depth: f.depth,
    url: String(f.url || '').slice(0, 140),
    kind: f.kind,
    chapterCandidates: f.chapterCandidates || [],
  }));

  // 章节树（来自 studentcourse iframe）
  const chapterFrame = struct.frames.find((f) => (f.chapters && f.chapters.length));
  if (chapterFrame) {
    report.chapters = chapterFrame.chapters;
    report.chapterCount = chapterFrame.chapters.length;
    report.sectionCount = chapterFrame.chapters.reduce((n, c) => n + (c.itemCount || 0), 0);
    report.taskSummary.attachCt = chapterFrame.attachCt || 0;
    report.taskSummary.jobIcon = chapterFrame.jobIcon || 0;
    report.taskSummary.videos = chapterFrame.videos || 0;
  }

  const s = struct.summary || {};
  report.taskSummary.total = s.taskItems || 0;
  report.taskSummary.quizLike = s.quizForms || 0;
  if (!report.reason) {
    report.reason = report.chapterCount
      ? '已识别章节树（' + report.chapterCount + ' 章 / ' + report.sectionCount + ' 节）'
      : '未找到章节树（该课程可能是直播/纯任务型，无章节结构）';
  }
  return report;
}

/** 列出账号下的课程：用 CDP 打开首页，等 JS 渲染完再读 DOM。 */
async function runListCourses(overrides) {
  const cfg = mergeConfig(CONFIG, overrides || {});
  const adapter = createCdpAdapter(cfg);
  await adapter.ensureBrowser();
  await adapter.navigate('https://mooc1.chaoxing.com/visit/interaction');
  await sleep(6000);
  const frames = await adapter.getFrameDocuments();
  const found = [];
  const seen = new Set();
  const expr = [
    '(() => {',
    '  const out = [];',
    '  document.querySelectorAll("a[href]").forEach(function(a){',
    '    const h = a.getAttribute("href") || a.href || "";',
    '    if (!/courseid=\\d+/i.test(h)) return;',
    '    let t = "", el = a;',
    '    for (let k = 0; k < 6 && el; k++) {',
    '      const x = (el.innerText || "").replace(/\\s+/g, " ").trim();',
    '      if (x.length > 1 && x.length < 80) { t = x; break; }',
    '      el = el.parentElement;',
    '    }',
    '    out.push({ href: h, text: t.slice(0, 60) });',
    '  });',
    '  return out;',
    '})()',
  ].join('\n');
  for (const f of frames) {
    let list = [];
    try { list = await adapter.evalInFrame(f.frameId, expr); } catch (e) { list = []; }
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const m = /courseid=(\d+)/i.exec(it.href || '');
      if (!m) continue;
      const cid = m[1];
      if (seen.has(cid)) continue;
      seen.add(cid);
      const cl = /clazzid=(\d+)/i.exec(it.href || '');
      const en = /enc=([a-z0-9]{8,})/i.exec(it.href || '');
      found.push({ courseId: cid, clazzid: cl ? cl[1] : '', enc: en ? en[1] : '', title: it.text || '', href: it.href || '' });
    }
  }
  const diag = {};
  try {
    const top = frames.find(function (f) { return f.isTop; }) || frames[0];
    if (top) {
      diag.frames = frames.length;
      diag.title = await adapter.evalInFrame(top.frameId, 'document.title');
      diag.url = await adapter.getCurrentUrl();
      diag.htmlLen = await adapter.evalInFrame(top.frameId, 'document.documentElement.outerHTML.length');
      diag.linkCount = await adapter.evalInFrame(top.frameId, 'document.querySelectorAll("a").length');
      diag.bodyText = await adapter.evalInFrame(top.frameId, '(document.body ? document.body.innerText : "").slice(0, 600)');
      diag.sampleHrefs = await adapter.evalInFrame(top.frameId,
        'Array.prototype.slice.call(document.querySelectorAll("a[href]"),0,15).map(function(a){return (a.getAttribute("href")||"").slice(0,80)})');
    }
  } catch (e) { diag.err = String((e && e.message) || e); }
  return { ok: true, count: found.length, courses: found, diag: diag };
}

module.exports = {
  STRUCT_SCAN_EXPR,
  openChapterTab,
  waitForChapterFrame,
  detectTaskTypeCourse,
  probePageStructure,
  locateCourseLink,
  listTargets,
  openCourseByClick,
  openChapterAndWait,
  openSectionByClick,
  scanTaskPoints,
  findListTarget,
  closeExtraCourseTabs,
  readCourseList,
  scanAllCourses,
  buildCourseReport,
  runListCourses
};
