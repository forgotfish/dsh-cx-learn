/* ============================================================================
 * engine/src/learn/selectors.js — SELECTORS 候选注册表 + 页面探针脚本 + 注入表达式构造
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

/* ============================================================================
 * 第 5 节 · 页面状态探测模块 —— 分层选择器策略（语义 → 结构 → 通用兜底）
 * ----------------------------------------------------------------------------
 * 设计约束：不得硬编码单一脆弱 CSS 选择器作为唯一依赖。
 *   第一层 语义特征：按钮文本（继续学习/确定）、video.ended / progress、目录"已完成"文本；
 *   第二层 结构特征：目录候选节点集、可见弹窗遮罩内的 primary 按钮、当前高亮项兄弟节点；
 *   第三层 通用兜底：可见单选框取第一个、playIcon 类元素——命中时业务层输出 WARN。
 * SELECTORS 为候选注册表（每项含 layer 与 note，用于日志定位）；PAGE_PROBE_SRC 注入
 * 页面后暴露 window.__cx：probeAll() 逐帧返回全量状态，find()/jsClick() 在点击前实时
 * 解析元素（避免矩形过期）。iframe 递归遍历由 CDP frame 树 + 逐帧求值完成。
 * ==========================================================================*/
const SELECTORS = {
  version: 7,
  /* 目录节点候选（第二层结构特征）
     ★★★ 2026-10-30 实测：**同一个课程存在两套目录页**，两套都要能读：
       A) mooc2-ans/mycourse/studentcourse  → 新版 **.chapter_item**（85 个）
          章头 = 没有 id 的 .chapter_item；小节 = id="cur143114xxx"
       B) mooc1/mycourse/studentstudy       → 旧版 **.posCatalog_select**（85 个）
          章头 = .firstLayer（id 是纯数字）；小节 = #cur143114xxx + icon_Completed
          实测 20:30：这一页 .chapter_item = 0、.posCatalog_select = 85，
          .catalog_jindu = 0、input.jobUnfinishCount = 67
      ⇒ 「某个选择器返回 0」**只说明当前 page 不是那一版**，不代表另一个是错的。
        旧记忆把 .posCatalog_select 判成彻底过时，是只看了 studentcourse 一页得出的结论。
      详见 docs/DOM-STRUCTURE.md（含两页的实测 HTML）。 */
  tocItem: [
    { layer: 2, sel: '.chapter_item', note: '新版课程目录(.chapter_item)' },
    { layer: 2, sel: '.posCatalog_select', note: '旧版完整课程目录(.posCatalog_select)' },
    { layer: 2, sel: '.prev_ul li', note: '章内子任务列表(仅当无课程目录时)' },
    { layer: 2, sel: '.chapterText li, .cells li, .ncells li', note: '目录节点候选(模板A)' },
    { layer: 2, sel: 'ul[class*="catalog"] li, div[class*="chapter"] ul li', note: '目录节点候选(通用)' }
  ],
  /* 新版目录里**章头**的判据：没有 id（小节都有 id="curXXXX"）；
     另有 class 片段 firstLayer / chapter_Thats_bnt（章号节点） */
  tocHeaderClassNew: ['chapter_Thats_bnt', 'firstLayer'],
  /* 新版目录里**节的标题**元素 */
  tocNameSel: '.catalog_name, .posCatalog_name, .posCatalog_title',
  /* 学习通完整目录里「当前节」的标记
     ★ 实测坑：学习通所有节点的 id 都是 "cur143114xxx"，
       所以「id 以 cur 开头」不能作为当前节判据（会把 85 项全判成 current）。 */
  tocCurrentClass: ['posCatalog_active', 'current', 'active'],
  /* 学习通完整目录里「章头」的 class 片段（旧版） */
  tocChapterClass: ['firstLayer'],
  /* 学习通完成度：input.jobUnfinishCount 的 value = 该节剩余未完成任务数
     （0 = 已全部完成）。实测：旧版 studentstudy 页每节都有这个 input
     （已完成的小节没有，靠 icon_Completed 判），新版 studentcourse 页为 0 个。 */
  tocUnfinishCountSel: 'input.jobUnfinishCount',
  /* ★ 新版完成度：.catalog_jindu > .catalog_points_yi = 剩余未完成任务数。
     实测（studentcourse）：已完成的小节**完全没有** .catalog_jindu；
           未完成的才有，内部 .catalog_points_yi 文本是数字（如 "1"）。
     实测（studentstudy）：.catalog_jindu = 0，改用 input.jobUnfinishCount。
     ⚠️ 注意：这个「未完成数」是**整节**口径（含章节测验）。
        本项目只关心「视频是否看完」，所以真正判据用下面的
        jobFinishedClass / jobIconLabelDone（任务点级），不用这个。 */
  tocJinduSel: '.catalog_jindu',
  tocUnfinishedNumSel: '.catalog_points_yi',
  /* ★★★ 任务点级完成判据（本项目主用，A 方案）
     实测 studentstudy 页的 knowledge/cards iframe 里：
       <div class="ans-attach-ct videoContainer ans-job-finished" id="ext-gen1050">
         <div class="ans-job-icon ans-job-video ans-job-icon-clear"
              aria-label="任务点已完成" role="option">
         <iframe src="/ananas/modules/video/index.html">   ← 视频
       </div>
     判据（任一成立即视为该任务点完成）：
       · 容器有 class ans-job-finished
       · 图标 aria-label 含「已完成」或 class 含 ans-job-icon-done
     每节通常只有 1 个视频任务点（视频），另有 1 个章节测验任务点。 */
  jobAttachSel: '.ans-attach-ct',
  jobFinishedClass: 'ans-job-finished',
  jobIconSel: '.ans-job-icon',
  jobVideoClass: 'ans-job-video',
  jobIconLabelDone: ['任务点已完成', '已完成'],
  /* 章内子任务里的「章节测验」入口 —— ★ 2026-10-30 恢复：改选择器时误删，
     自测 7/7 立刻报 join of undefined。这是「章内子任务」层（.prev_ul li），
     和课程目录是两套结构，不能混。实测旧版页面：
       <ul class="prev_ul"> <li title="视频" ...>1视频</li> <li title="章节测验">2章节测验</li>
     注意 title 是「章节测验」，li 的可见文本是「2章节测验」——两者都要能命中。 */
  quizTabSel: '.prev_ul li',
  quizTabText: ['章节测验', '章测', '单元测验', '章节练习', '随堂测'],
  videoTabText: ['视频', '视频课', '课程视频'],
  /* 旧版完成标记 */
  doneText: ['已完成', '已完成学习'],
  doneClass: ['icon_Completed', 'bntDone', 'done', 'finish', 'finished', 'complete'],
  chapterHeaderClass: ['chapter', 'prev_chapter', 'chapterhead', 'firstLayer'],
  /* 可见弹层容器候选（第二层结构特征） */
  dialogContainer: [
    { layer: 2, sel: '.maskdiv', note: '防挂机弹窗容器(经典)' },
    { layer: 2, sel: '.layui-layer, .el-dialog__wrapper, .el-dialog', note: '通用弹层候选' },
    { layer: 2, sel: 'div[class*="dialog"][style*="block"], div[class*="mask"][style*="block"]', note: '遮罩候选(通用)' }
  ],
  /* 弹窗主按钮语义文本（第一层） */
  primaryBtnText: ['继续学习', '继续播放', '确定', '知道了', '我知道了', '继续'],
  /* 弹题选项候选（第二层；全部失效则页面侧降级为可见单选框=第三层）
     学习通作业页（章节测验）的真实结构：
       题块  .TiMu.newTiMu
       选项  li.font-cxsecret.before-after（每个 li 一个选项，内含 span.num_option[data="A"]）
       提交  A.btnSubmit.workBtnIndex（文本 "Submit"，英文！） / A.btnSave.workBtnIndex（"Save"）
     注意：li 里还嵌了一个 label.fl.before（只有字母），如果用 'label, li' 抓会重复 → 4 个选项变 8 个。 */
  quizOption: [
    { layer: 2, sel: 'li.font-cxsecret.before-after', note: '学习通作业选项' },
    { layer: 2, sel: '.popboxes .cleanclick', note: '弹题选项(经典)' },
    { layer: 2, sel: '.TiMu .cleanclick', note: '弹题选项(候选A)' },
    { layer: 2, sel: '[class*="pop"] label, [class*="dialog"] label', note: '弹题选项(通用label)' }
  ],
  /* 作业页题块（学习通） */
  quizQuestionSel: '.TiMu.newTiMu, .TiMu',
  /* 作业页选项字母来源（span.num_option 的 data 属性就是 A/B/C/D） */
  quizOptionLetterSel: 'span.num_option[data]',
  /* 提交按钮：class 优先（学习通是英文按钮，靠中文文本必然失配） */
  quizSubmitSel: ['.btnSubmit', '.btnSave', '.workBtnIndex'],
  /* 提交按钮文本（英文界面下全是英文） */
  quizSubmitText: ['提交', '确定', '交卷', 'Submit', 'Save', 'Confirm', 'OK'],
  /* 题块里的选项 li（一个 li = 一个选项；不能用 'label, li' 混抓，会重复一倍） */
  quizOptionClass: 'li.font-cxsecret.before-after',
  /* 经典弹题：可见单选框（页面侧第三层兜底） */
  quizRadioSel: 'input[type="radio"], input[type="checkbox"]',
  /* 题干标题（作业页） */
  quizTitleSel: '.Zy_TItle, .TiMu_bq',
  quizTitleFallbackSel: '.Zy_TItle',
  /* 弹题选项退化列表（页面侧第三层兜底） */
  quizOptionListSel: '.cleanclick, label, li',

  /* ── 视频控件与页面特征（L3：全部收进注册表，探针里不得再出现裸选择器）── */
  playBigSel: '.vjs-big-play-button',
  playIconSel: '.playIcon, [class*="playButton"], [class*="play-btn"]',
  /* 登录页判据之一：页面上有密码框 */
  passwordSel: 'input[type="password"]',
  /* 课程卡片「进入课程」链接的 onclick 特征 */
  teacherAjaxSel: '[onclick*="getTeacherAjax"]',
  /* 新版目录项的 class（判「章头 / 小节」时要精确比较 sel 来源） */
  tocItemNew: '.chapter_item',
  /* 旧版目录标题元素（tocNameSel 已含，拆出来给回退链路用） */
  tocNameOldSel: '.posCatalog_name, .posCatalog_title',
  /* 旧版「章头」标题：只有章头才有 .posCatalog_title（小节是 .posCatalog_name） */
  tocHeaderTitleOldSel: '.posCatalog_title',

  /* ── 随堂弹题（视频内嵌答题，ans-videoquiz）──
     超星视频播到某个时间点会弹出一道题强制暂停，答对点「继续」才恢复播放。
     实测 DOM（在 ananas/modules/video/index.html 内）：
       <div class="x-component ans-videoquiz">
         <div class="tkTopic_title">判断题</div>
         <div class="tkItem_title">2013年4月德国政府正式推出"工业4.0"</div>
         <ul class="tkItem_ul">
           <li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type=radio name="ans-videoquiz-opt" value=""><i></i></span>A、对</label></li>
           <li class="ans-videoquiz-opt">…B、错</li>
         </ul>
         <div class="tkTopic_oper">
           <a id="videoquiz-submit">提交</a>
           <a id="videoquiz-continue">继续</a>   ← 答对后出现，点它视频才继续
           <span id="spanHas">回答正确</span> / <span id="spanNot">回答错误</span>
       ★ 关键坑：这道题的 radio value 都是空字符串，真正的答案在 label 文本
       （"A、对" / "B、错"）。选项不是 A/B/C/D 字母，是按顺序的文本。
       ★ 更关键的坑：不答这道题，视频就永远卡在弹题点（主人报的"视频没看完"
       根因之一——引擎没识别随堂弹题，只会反复点播放按钮）。 */
  videoQuiz: {
    containerSel: '.ans-videoquiz',
    titleSel: '.tkItem_title',
    optionSel: 'li.ans-videoquiz-opt',
    submitSel: '#videoquiz-submit',
    continueSel: '#videoquiz-continue',
    correctSel: '#spanHas',
    wrongSel: '#spanNot',
    wrongBackSel: '#spanNotBack'
  }
};

/*
 * 页面侧探测代码（以字符串注入每个 frame 执行一次；幂等，重复注入直接跳过）。
 * 注意：运行于页面上下文，仅做只读探测与显式点击，绝不触碰任何上报接口。
 */
const PAGE_PROBE_SRC = `(function () {
  if (window.__cx && window.__cx.__v >= window.__CX_SEL.version) return 'already';
  var S = window.__CX_SEL, KWS = window.__CX_KWS, PAT = window.__CX_PATTERN;

  function norm(s) { return (s == null ? '' : String(s)).replace(/\\s+/g, ' ').trim(); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return false;
    var st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }
  /* 全局坐标：把 frame 内矩形换算到顶层视口（同源链路走 frameElement 偏移累加）。 */
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    var x = r.x, y = r.y, win = window;
    try {
      while (win && win !== win.top) {
        var fe = win.frameElement;
        if (!fe) return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), cross: true };
        var fr = fe.getBoundingClientRect();
        x += fr.x; y += fr.y;
        win = win.parent;
      }
    } catch (e) {
      return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), cross: true };
    }
    return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), cross: false };
  }

  /* 多个矩形的并集（DOMRect 数组）。 */
  function unionRectOf2(rects) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (!r) continue;
      any = true;
      if (r.left < x0) x0 = r.left;
      if (r.top < y0) y0 = r.top;
      if (r.right > x1) x1 = r.right;
      if (r.bottom > y1) y1 = r.bottom;
    }
    if (!any) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 多个元素的并集矩形（同一 frame 内的视口坐标）。 */
  function unionRectOf(els) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (!r || !(r.width > 0 && r.height > 0)) continue;
      any = true;
      if (r.left < x0) x0 = r.left;
      if (r.top < y0) y0 = r.top;
      if (r.right > x1) x1 = r.right;
      if (r.bottom > y1) y1 = r.bottom;
    }
    if (!any) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 元素在**顶层文档**里的矩形（CSS 像素）。
   *
   * 坐标系三层次（必须分清，实测踩过的坑）：
   *   ① frame 内视口坐标：getBoundingClientRect() 返回的就是这个
   *   ② 顶层视口坐标    ：沿 window.parent 链把每层 iframe 元素的
   *                      getBoundingClientRect() 逐层相加（每层都是活的，
   *                      父 frame 滚动时子 iframe 的位置随之变化，自动抵消）
   *   ③ 顶层文档坐标    ：② 再加顶层自身的 scrollX/scrollY
   *
   * Page.captureScreenshot 的 clip 用的是 ③（文档坐标），
   * 早前只用 ② 裁剪导致整块区域上下错位（截到的是上一题/下一题）。
   * 同源时 window.parent 链可走；跨源时 window.frameElement 为 null，
   * 此时返回 null，调用方退回「整页截图 + 无裁剪」的保守路径。
   */
  function docRectOf(el) {
    var r = el.getBoundingClientRect();
    var x = r.x, y = r.y, win = window;
    try {
      while (win && win !== win.top) {
        var fe = win.frameElement;
        if (!fe) return null; /* 跨域父级：无法换算 */
        var fr = fe.getBoundingClientRect();
        x += fr.x; y += fr.y;
        win = win.parent;
      }
      var tx = win.scrollX || 0, ty = win.scrollY || 0;
      return { x: Math.round(x + tx), y: Math.round(y + ty), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) {
      return null;
    }
  }

  /* ---- 坐标系说明（引擎侧实现，页面探针不做换算）----
   *
   * 设 frame 链为 F0(顶层) ← F1 ← … ← Fn(题目所在 frame)。
   *   R_i  = F_i 的 frameElement.getBoundingClientRect()（在 F_{i-1} 的**视口**坐标）
   *   s_i  = F_i 自身的 window.scrollX/scrollY
   * 则：
   *   T_n  = Σ_{i=1..n} ( R_i + s_{i-1} )     ← Fn 的文档原点，在顶层文档里的坐标
   *   元素在顶层文档里的坐标 = T_n + (元素在 Fn 视口里的坐标) + s_n
   *
   * 关键：中间层的滚动量必须逐层累加（早期版本只加顶层滚动，坐标整块错位）。
   * 换算需要逐 frame 求值（父 frame 的 scrollY 跨源时读不到），
   * 因此放在引擎（CDP 侧）做，页面探针只负责给出「frame 内视口坐标」。
   */

  function matchAny(text, arr) {
    if (!text) return null;
    for (var i = 0; i < arr.length; i++) { if (text.indexOf(arr[i]) >= 0) return arr[i]; }
    return null;
  }
  function hasClassLike(el, names) {
    if (!el || typeof el.className !== 'string') return null;
    var toks = el.className.split(/\\s+/);
    for (var i = 0; i < toks.length; i++) {
      for (var j = 0; j < names.length; j++) {
        if (toks[i] === names[j] || toks[i].indexOf(names[j]) === 0) return names[j];
      }
    }
    return null;
  }
  function findButtons(root) {
    var out = [];
    var els = root.querySelectorAll('button, a, .btn, [role="button"], input[type="button"], input[type="submit"], .layui-layer-btn a, .el-button, .dialog-footer button');
    for (var i = 0; i < els.length; i++) { if (visible(els[i])) out.push(els[i]); }
    return out;
  }

  /* ---- 视频状态（第一层语义：ended / progress）---- */
  function videoState() {
    var vs = document.querySelectorAll('video');
    var best = null, bestArea = 0;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i]; var r = v.getBoundingClientRect(); var a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    }
    if (!best) return { found: false };
    /* ★ 用 Number.isFinite 而不是「或 0」的写法：duration 在元数据未加载时是 NaN，
       而 Infinity 也会被当成有效值。参考 xuexitong-ai-assistant（Flyer2333）
       L2916 的写法：Number.isFinite(duration) && duration > 0 */
    var rawDur = best.duration, rawCur = best.currentTime;
    var dur = Number.isFinite(rawDur) ? rawDur : 0;
    var cur = Number.isFinite(rawCur) ? rawCur : 0;
    /* ★★★ 2026-10-29 修复死循环（3.3 ↔ 3.4 卡了 15 分钟）★★★
       原来这里：var prog = dur > 0 ? ... : (best.ended ? 100 : 0);
       坑：刚点进一个新节时，video 元素已存在但**元数据还没加载**（duration=0）。
       HTML5 规范里 duration=0 时 currentTime(0) >= duration(0) 成立 ⇒ ended=true，
       于是 prog 被算成 100 ⇒ 上层误判「这节播完了」⇒ 立刻切下一节 ⇒
       下一节同样没加载 ⇒ 又算 100 ⇒ 无限空转。
       实测：3.3/3.4 之间来回跳了 15 分钟，completed 计数虚增到 56。

       正确语义：拿不到 duration 就说明「还没开始播」，进度只能是 0。
       参考项目的判据（L2916）也是**无条件要求 duration > 0**，不给 ended 留旁路。 */
    var prog = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    /* ★ 补充缓冲/网络状态：判断「卡死」的关键。
       实测超星视频卡在某个进度点不动时：
         readyState=0（HAVE_NOTHING，元数据都没拿到）
         networkState=1（NETWORK_IDLE）
         buffered=[]（一字节都没缓冲）
       根因是超星的视频 CDN 链接带**时效签名**
       （…/sd.mp4?at_=1792944807646&ak_=…&ad_=…），过期后 CDN 直接 403。
       这时点播放按钮毫无作用，必须重新加载页面拿新签名。 */
    var buf = [], bufEnd = 0;
    try {
      for (var b = 0; b < best.buffered.length; b++) {
        buf.push(Math.round(best.buffered.start(b)) + '-' + Math.round(best.buffered.end(b)));
        if (best.buffered.end(b) > bufEnd) bufEnd = best.buffered.end(b);
      }
    } catch (e3) { /* ignore */ }
    var vErr = null;
    try { if (best.error) vErr = (best.error.code || '?') + ':' + (best.error.message || ''); } catch (e4) { /* ignore */ }
    return {
      /* ended 必须同时满足 duration>0：duration=0 时浏览器给的 ended=true 是假的
         （元数据没加载，0>=0 恒成立）。见上方 prog 计算的说明。 */
      found: true, paused: !!best.paused, ended: !!best.ended && dur > 0,
      currentTime: Math.round(cur * 10) / 10, duration: Math.round(dur * 10) / 10,
      progress: Math.round(prog * 10) / 10, muted: !!best.muted,
      readyState: best.readyState, networkState: best.networkState,
      buffered: buf, bufferedEnd: Math.round(bufEnd), error: vErr,
      src: String(best.currentSrc || best.src || '').slice(0, 200)
    };
  }

  /* ---- 弹窗/遮罩（第二层结构 + 第一层语义文本判定 kind）---- */
  var lastDialogs = [];
  function dialogScan() {
    var out = [], seen = {}, containers = [];
    for (var i = 0; i < S.dialogContainer.length; i++) {
      var nl = null;
      try { nl = document.querySelectorAll(S.dialogContainer[i].sel); } catch (e) { nl = null; }
      if (!nl) continue;
      for (var j = 0; j < nl.length; j++) {
        if (visible(nl[j])) containers.push({ el: nl[j], layer: S.dialogContainer[i].layer, note: S.dialogContainer[i].note });
      }
    }
    for (var k = 0; k < containers.length; k++) {
      var c = containers[k];
      var text = norm(c.el.innerText || c.el.textContent || '').slice(0, 160);
      if (seen[text]) continue;
      seen[text] = 1;
      var humanHit = matchAny(text, KWS);
      if (humanHit) { out.push({ kind: 'human', text: text, evidence: humanHit, layer: c.layer, note: c.note, btn: null }); continue; }
      var btns = findButtons(c.el), primary = null, primaryText = '';
      for (var b = 0; b < btns.length; b++) {
        var t = norm(btns[b].innerText || btns[b].value || '');
        if (matchAny(t, S.primaryBtnText)) { primary = btns[b]; primaryText = t; break; }
      }
      var kind = primary ? (matchAny(primaryText, ['继续学习', '继续播放', '继续']) ? 'anti-idle' : 'confirm') : 'unknown';
      out.push({ kind: kind, text: text, btnText: primaryText, layer: c.layer, note: c.note, btn: primary });
    }
    lastDialogs = out;
    return out.map(function (d) {
      return { kind: d.kind, text: d.text, btnText: d.btnText || '', evidence: d.evidence || null, layer: d.layer, note: d.note };
    });
  }

  /* ---- 弹题（P2）----
     学习通作业页（章节测验）不是「一题一弹窗」，而是一个页面里多道题：
       题块  .TiMu.newTiMu
       选项  li.font-cxsecret.before-after（每个 li 一个选项，内含 span.num_option[data="A"]）
       提交  A.btnSubmit.workBtnIndex（文本 "Submit"，英文！） / A.btnSave.workBtnIndex（"Save"）
     所以这里按「题块」解析，一次返回全部题目，引擎逐题作答。 */
  var lastQuiz = { optionEls: [], submitEl: null, layer: 0, note: '', blocks: [] };

  /* 从题块里取选项：优先 li.font-cxsecret.before-after（一个 li = 一个选项），
     字母来自 span.num_option[data]（A/B/C/D）。
     绝不能把 'label, li' 混着抓——li 里嵌着 label.fl.before，4 个选项会变成 8 个。 */
  function optionsInBlock(block) {
    var out = [];
    var lis = null;
    try { lis = block.querySelectorAll(S.quizOptionClass); } catch (e) { lis = null; }
    if (lis && lis.length) {
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        if (!visible(li)) continue;
        var letter = '';
        try {
          var numEl = li.querySelector(S.quizOptionLetterSel);
          if (numEl) letter = numEl.getAttribute('data') || '';
        } catch (e2) { /* ignore */ }
        /* 判断题的 data 属性是 "true"/"false"，不是 A/B —— 字母一律按位置重编，
           否则「只输出 A/B/C/D」的指令与选项字母对不上，模型会乱答。 */
        letter = String.fromCharCode(65 + out.length);
        var txt = norm(li.innerText || '');
        out.push({ i: out.length, letter: letter, rawLetter: letter, label: txt.slice(0, 100), el: li });
      }
      return out;
    }
    /* 退化路径：可见单选框（经典弹题） */
    var radios = block.querySelectorAll(S.quizRadioSel);
    var vis = [];
    for (var r = 0; r < radios.length; r++) { if (visible(radios[r])) vis.push(radios[r]); }
    for (var r2 = 0; r2 < vis.length; r2++) {
      var lab = vis[r2].closest ? vis[r2].closest('label') : null;
      var t2 = norm(lab ? lab.innerText : '') || ('选项' + (r2 + 1));
      out.push({ i: r2, letter: String.fromCharCode(65 + r2), label: t2.slice(0, 100), el: lab || vis[r2] });
    }
    return out;
  }

  /* 提交按钮：先按 class 找（学习通是英文 class，最稳），再按文本找（中文界面兜底）。 */
  function findSubmit() {
    for (var i = 0; i < S.quizSubmitSel.length; i++) {
      var els = null;
      try { els = document.querySelectorAll(S.quizSubmitSel[i]); } catch (e) { els = null; }
      if (!els) continue;
      for (var j = 0; j < els.length; j++) {
        if (!visible(els[j])) continue;
        var t = norm(els[j].innerText || els[j].value || '');
        if (!t) continue;
        return { el: els[j], text: t.slice(0, 30) };
      }
    }
    var btns = findButtons(document);
    for (var b = 0; b < btns.length; b++) {
      var t2 = norm(btns[b].innerText || btns[b].value || '');
      if (matchAny(t2, S.quizSubmitText)) return { el: btns[b], text: t2.slice(0, 30) };
    }
    return null;
  }

  function quizScan() {
    lastQuiz = { optionEls: [], submitEl: null, layer: 0, note: '', blocks: [] };

    /* —— 路径 A：作业页题块（学习通）—— */
    var qblocks = null;
    try { qblocks = document.querySelectorAll(S.quizQuestionSel); } catch (e) { qblocks = null; }
    if (qblocks && qblocks.length) {
      var blocks = [];
      for (var bi = 0; bi < qblocks.length; bi++) {
        var blk = qblocks[bi];
        if (!visible(blk)) continue;
        var opts = optionsInBlock(blk);
        if (!opts.length) continue;
        var titleEl = null;
        try { titleEl = blk.querySelector(S.quizTitleSel); } catch (e3) { titleEl = null; }
        var qtext = norm(titleEl ? titleEl.innerText : '') || norm(blk.innerText || '').slice(0, 200);
        blocks.push({
          i: blocks.length,
          qid: blk.id || ('q' + bi),
          question: qtext.slice(0, 300),
          /* 判断题题干里带 【True or False】，单选题带 【Single Choice】 */
          kind: /true\s*or\s*false|判断/i.test(qtext) ? 'judge' : 'single',
          options: opts.map(function (o) { return { i: o.i, letter: o.letter, label: o.label }; })        });
      }
      if (blocks.length) {
        lastQuiz.blocks = blocks;
        lastQuiz.layer = 2;
        lastQuiz.note = 'chaoxing-work-page';
        var q = {
          kind: 'chapter_work', present: true, parseable: true, blocks: blocks,
          options: blocks[0].options, question: blocks[0].question,
          layer: 2, note: 'chaoxing-work-page', submitText: '', blockCount: blocks.length
        };
        var sub = findSubmit();
        if (sub) { lastQuiz.submitEl = sub.el; q.submitText = sub.text; }
        return q;
      }
    }

    /* —— 路径 B：经典弹题（单题）—— */
    var wrap = null, layer = 0, note = '';
    for (var i = 0; i < S.quizOption.length && !wrap; i++) {
      var nl = null;
      try { nl = document.querySelectorAll(S.quizOption[i].sel); } catch (e) { nl = null; }
      if (!nl) continue;
      for (var j = 0; j < nl.length; j++) {
        if (visible(nl[j])) { wrap = nl[j]; layer = S.quizOption[i].layer; note = S.quizOption[i].note; break; }
      }
    }
    var opts2 = [], question = '';
    if (wrap) {
      var holder = wrap;
      while (holder && holder !== document.body && holder.parentElement && holder.querySelectorAll(S.quizOptionListSel).length <= 1) holder = holder.parentElement;
      if (holder && holder !== document.body) {
        var list = holder.querySelectorAll(S.quizOptionListSel);
        for (var k = 0; k < list.length; k++) {
          var t = norm(list[k].innerText || '');
          if (visible(list[k]) && t && t.length < 120) {
            opts2.push({ i: opts2.length, letter: String.fromCharCode(65 + opts2.length), label: t.slice(0, 80) });
            lastQuiz.optionEls.push(list[k]);
          }
        }
        question = norm(holder.innerText || '').slice(0, 100);
      }
    } else {
      var radios2 = document.querySelectorAll(S.quizRadioSel);
      var vis2 = [];
      for (var r3 = 0; r3 < radios2.length; r3++) { if (visible(radios2[r3])) vis2.push(radios2[r3]); }
      if (vis2.length >= 2) {
        layer = 3; note = 'generic-visible-radios';
        for (var r4 = 0; r4 < vis2.length; r4++) {
          var lab2 = vis2[r4].closest ? vis2[r4].closest('label') : null;
          var t3 = norm(lab2 ? lab2.innerText : '') || ('选项' + (r4 + 1));
          opts2.push({ i: r4, letter: String.fromCharCode(65 + r4), label: t3.slice(0, 80) });
          lastQuiz.optionEls.push(lab2 || vis2[r4]);
        }
      }
    }
    var q2 = { kind: 'popup_quiz', present: opts2.length > 0, parseable: opts2.length > 0, blocks: [], options: opts2, question: question, layer: layer, note: note, submitText: '' };
    if (opts2.length) {
      var sub2 = findSubmit();
      if (sub2) { lastQuiz.submitEl = sub2.el; q2.submitText = sub2.text; }
    }
    lastQuiz.layer = layer; lastQuiz.note = note;
    return q2;
  }

  /* ---- 章内「章节测验」入口（学习通 .prev_ul li）----
     课程页里「1视频 / 2章节测验」是章内子任务标签，点「章节测验」才会把题目
     加载到 popFrameId iframe（平时是 about:blank 空页）。 */
  var lastQuizTab = { el: null, index: -1, title: '' };
  var lastVideoTab = { el: null, index: -1, title: '' };
  function quizTabScan() {
    lastQuizTab = { el: null, index: -1, title: '' };
    lastVideoTab = { el: null, index: -1, title: '' };
    var nl = null;
    try { nl = document.querySelectorAll(S.quizTabSel); } catch (e) { nl = null; }
    if (!nl) return lastQuizTab;
    for (var i = 0; i < nl.length; i++) {
      var it = nl[i];
      var title = (it.getAttribute && it.getAttribute('title')) || '';
      var t = norm(title || it.innerText || '');
      if (!t) continue;
      if (matchAny(t, S.quizTabText)) {
        lastQuizTab = { el: it, index: i, title: t.slice(0, 40) };
        return lastQuizTab;
      }
      if (matchAny(t, S.videoTabText)) {
        lastVideoTab = { el: it, index: i, title: t.slice(0, 40) };
      }
    }
    return lastQuizTab;
  }

  /* ---- 随堂弹题（视频内嵌答题 ans-videoquiz）----
     超星视频播到某时间点会弹出一道题强制暂停（主人报"视频没看完"的根因之一：
     引擎没识别这道题，只会反复点播放按钮，视频就永远卡在弹题点）。
     结构：.ans-videoquiz 内含 .tkItem_title（题干）+ li.ans-videoquiz-opt（选项）
     + #videoquiz-submit（提交）+ #videoquiz-continue（答对后点它继续播放）。 */
  var lastVideoQuiz = { el: null, layer: 2, note: '' };
  function videoQuizScan() {
    lastVideoQuiz = { el: null, layer: 2, note: '' };
    var el = null;
    try { el = document.querySelector(S.videoQuiz.containerSel); } catch (e) { el = null; }
    if (!el) return { present: false };
    if (!visible(el)) return { present: false };
    var title = '';
    try {
      var te = el.querySelector(S.videoQuiz.titleSel);
      title = norm(te ? te.innerText : '');
    } catch (e2) { /* ignore */ }
    // 选项：li.ans-videoquiz-opt，文本形如 "A、对" / "B、错"（radio value 是空串，答案在文本）
    var options = [];
    try {
      var lis = el.querySelectorAll(S.videoQuiz.optionSel);
      for (var i = 0; i < lis.length; i++) {
        if (!visible(lis[i])) continue;
        var t = norm(lis[i].innerText || '');
        if (!t) continue;
        // 去掉 "A、" 之类的前缀，只留选项文本
        var cleaned = t.replace(/^[A-H][、.．]\s*/, '');
        options.push({ i: options.length, letter: String.fromCharCode(65 + options.length), label: cleaned || t });
      }
    } catch (e3) { /* ignore */ }
    // 提交/继续按钮状态
    var submit = null, cont = null, correct = false, wrong = false;
    try { submit = el.querySelector(S.videoQuiz.submitSel); } catch (e4) { /* ignore */ }
    try { cont = el.querySelector(S.videoQuiz.continueSel); } catch (e5) { /* ignore */ }
    try { var c = el.querySelector(S.videoQuiz.correctSel); correct = !!(c && visible(c)); } catch (e6) { /* ignore */ }
    try { var w = el.querySelector(S.videoQuiz.wrongSel); wrong = !!(w && visible(w)); } catch (e7) { /* ignore */ }
    /* ★★ 盲试所需的两项关键信息（2026-10-27 主人要求「答错换答案一直试到对」）：
       wrongBack : 答错且要求「回看 N 分钟」→ 不能盲试，必须停
       remaining : 面板文本里的「剩余 N 次」→ 剩余尝试次数，降到 0 就停

       ★ 2026-10-29 修正（对照 xuexitong-ai-assistant L4467-4469）：
       参考项目的注释写得很明确：
         "spanNotBackPoint is also used for ordinary failures with an editable form.
          Its ID alone does not mean the learner must return to an earlier video point."
       它不靠 ID 判断，而是**看文本**里有没有「回看 / 回到知识点 / 重新观看 / 返回观看」。
       我们原来只看 #spanNotBack 是否可见，会把「普通答错但仍可重答」误判成必须停，
       导致盲试过早放弃。现在改为：先看元素，再用文本确认。 */
    var wrongBack = false;
    var wrongBackText = '';
    try {
      var wb = el.querySelector(S.videoQuiz.wrongBackSel);
      if (wb && visible(wb)) {
        wrongBackText = norm(wb.innerText || wb.textContent || '').slice(0, 80);
        /* 只有文本明确要求回看/重看，才算「必须停」；空文本按 ID 语义处理（保守） */
        wrongBack = !wrongBackText || /回看|回到.*(?:知识点|视频)|重新观看|返回观看/.test(wrongBackText);
      }
    } catch (e8) { /* ignore */ }
    var remaining = null;
    var panelText = '';
    try {
      panelText = norm(el.innerText || '').slice(0, 160);
      var rm = panelText.match(/剩余\s*[:：]?\s*(\d+)\s*次/);
      if (rm) remaining = Number(rm[1]);
    } catch (e9) { /* ignore */ }
    /* 兜底：即使 #spanNotBack 没出现，面板文本里出现回看要求也要停 */
    if (!wrongBack && /回看|重新观看|返回观看/.test(panelText)) {
      wrongBack = true;
      wrongBackText = wrongBackText || panelText.slice(0, 80);
    }
    /* 反馈原文里能提取「正确答案：X」时一并带出，供盲试少走弯路 */
    var correctAnswer = '';
    try {
      var ca = panelText.match(/正确答案\s*[:：]\s*([A-T](?:[A-T\s,，、]*))/);
      if (ca) correctAnswer = ca[1].replace(/[\s,，、]/g, '');
      else {
        var cb = panelText.match(/正确答案\s*[:：]\s*(对|错|正确|错误)/);
        if (cb) correctAnswer = cb[1];
      }
    } catch (e10) { /* ignore */ }
    lastVideoQuiz = { el: el, layer: 2, note: 'video-quiz:' + title.slice(0, 30) };
    return {
      kind: 'video_embedded_quiz', present: true, title: title, options: options,
      submitVisible: !!(submit && visible(submit)),
      continueVisible: !!(cont && visible(cont)),
      correct: correct, wrong: wrong,
      wrongBack: wrongBack, wrongBackText: wrongBackText,
      correctAnswer: correctAnswer,
      remaining: remaining, panelText: panelText,
      note: lastVideoQuiz.note
    };
  }

  /* ---- 左侧目录（P1/P3/P4）----
     学习通有两套目录，必须优先抓「完整课程目录」.posCatalog_select：
       - 章头：.posCatalog_select.firstLayer，内含 span.posCatalog_title（可折叠）
       - 节  ：.posCatalog_select[id^=cur]，内含 span.posCatalog_name（标题）
               + input.jobUnfinishCount（value = 剩余未完成任务数，0 表示已完成）
     而 .prev_ul li 是「章内子任务」（1视频 / 2章节测验），只有当课程目录不存在时才用。 */
  var lastToc = { els: [], layer: 0, note: '' };
  function tocScan() {
    lastToc = { els: [], layer: 0, note: '' };
    var sel = null, layer = 0, note = '';
    for (var i = 0; i < S.tocItem.length; i++) {
      var nl = null;
      try { nl = document.querySelectorAll(S.tocItem[i].sel); } catch (e) { nl = null; }
      if (nl && nl.length >= 2) { sel = S.tocItem[i].sel; layer = S.tocItem[i].layer; note = S.tocItem[i].note; break; }
    }
    if (!sel) return { found: false, items: [], layer: 0, sel: '', note: '' };
    var nl2 = document.querySelectorAll(sel);
    var items = [];
    for (var j = 0; j < nl2.length; j++) {
      var it = nl2[j];
      /* 标题：新版在 .catalog_name，旧版在 .posCatalog_name / .posCatalog_title */
      var nameEl = it.querySelector ? (it.querySelector(S.tocNameSel) || it.querySelector(S.tocNameOldSel)) : null;
      var t = norm(nameEl ? (nameEl.innerText || nameEl.getAttribute('title') || '') : (it.innerText || ''));
      if (!t) continue;

      /* ===== 章头判定 =====
         新版：小节都有 id="curXXXXXX"，**章头没有 id** —— 这是最可靠的判据。
         旧版：firstLayer class 或 posCatalog_title。 */
      var hasId = false;
      try { hasId = !!String(it.id || ''); } catch (eH) { hasId = false; }
      var isHeader = (sel === S.tocItemNew && !hasId)
        || !!hasClassLike(it, S.tocHeaderClassNew)
        || !!hasClassLike(it, S.tocChapterClass)
        || !!hasClassLike(it, S.chapterHeaderClass)
        || !!it.querySelector(S.tocHeaderTitleOldSel)
        || /^第\s*[0-9一二三四五六七八九十百]+[章单元篇]\s*$/.test(t)
        /* 新版章头文本形如「1 新时代的工程」：纯数字 + 空格 + 标题，且无 id */
        || (sel === S.tocItemNew && !hasId && /^\d+\s+\S+/.test(t) && !/^\d+\.\d+/.test(t));

      /* ===== 完成度（A 方案：整节口径，仅作参考）=====
         新版：**已完成的小节完全没有 .catalog_jindu**；未完成的才有，
               内部 .catalog_points_yi 是剩余任务数，span 文本含 "unfinished"。
         旧版：input.jobUnfinishCount 的 value；或 icon_Completed / doneText。
         ⚠️ 这个 done 是「整节」口径（含章节测验）。业务层真正用它判「视频是否看完」
            时要配合任务点级判据（见 gatherState 的 jobDone）。 */
      var done = !!matchAny(t, S.doneText) || !!hasClassLike(it, S.doneClass);
      if (!done) {
        try {
          var doneKid = it.querySelector ? it.querySelector('.' + S.doneClass[0]) : null;
          if (doneKid) done = true;
        } catch (e3) { /* ignore */ }
      }
      var unfinish = -1;
      /* 新版：.catalog_jindu 存在 ⇒ 有未完成任务 */
      try {
        var jindu = it.querySelector ? it.querySelector(S.tocJinduSel) : null;
        if (jindu) {
          var numEl = jindu.querySelector(S.tocUnfinishedNumSel);
          var nv = numEl ? parseInt(String(numEl.innerText || '0'), 10) : NaN;
          unfinish = isNaN(nv) ? 1 : nv;
          if (unfinish > 0) done = false;   /* 有进度条 = 未完成，覆盖其它判据 */
        } else if (sel === S.tocItemNew && hasId && !isHeader) {
          /* 新版小节没有 .catalog_jindu ⇒ 整节已完成 */
          done = true;
          unfinish = 0;
        }
      } catch (eN) { /* ignore */ }
      /* 旧版：input.jobUnfinishCount */
      try {
        var uf = it.querySelector ? it.querySelector(S.tocUnfinishCountSel) : null;
        if (uf) {
          var v = parseInt(uf.value, 10);
          if (!isNaN(v)) { unfinish = v; if (v === 0) done = true; }
        }
      } catch (e2) { /* ignore */ }

      /* 当前节：只看 class。
         ★ 实测坑：学习通所有目录节点 id 都是 "cur143114xxx"，
           用 id 前缀判 current 会把 85 项全判成当前节 → 永远在第一章打转。 */
      var current = !!hasClassLike(it, S.tocCurrentClass);
      /* chapterId：新版目录项 id="cur143114596" ⇒ 去掉 cur 前缀 */
      var chapterId = '';
      try {
        var rawId = String(it.id || '');
        var mId = rawId.match(/^cur([0-9]+)$/);
        if (mId) chapterId = mId[1];
        else {
          /* 新版也可从 onclick="toOld('204169157','143114596','156594937',0)" 里取 */
          var ocAttr = it.getAttribute ? String(it.getAttribute('onclick') || '') : '';
          var mt = ocAttr.match(/toOld\('([0-9]+)','([0-9]+)','([0-9]+)'\)/);
          if (mt) chapterId = mt[2];
          else {
            var oc = it.querySelector ? it.querySelector(S.teacherAjaxSel) : null;
            if (oc) {
              var mo = String(oc.getAttribute('onclick') || '').match(/getTeacherAjax\('[^']*','[^']*','([0-9]+)'\)/);
              if (mo) chapterId = mo[1];
            }
          }
        }
      } catch (e5) { /* ignore */ }
      items.push({ i: items.length, title: t.slice(0, 60), done: done, current: current, chapterHeader: isHeader, clickable: true, unfinish: unfinish, chapterId: chapterId, taskTotal: (typeof taskTotal === 'number' ? taskTotal : -1) });
      lastToc.els.push(it);
    }
    lastToc.layer = layer; lastToc.note = note;
    return { found: items.length > 0, items: items, layer: layer, sel: sel, note: note };
  }

  /* ---- 人工验证特征（安全停止信号，绝不绕过）---- */
  function humanScan() {
    var text = norm(document.body ? document.body.innerText : '').slice(0, 4000);
    var hit = matchAny(text, KWS);
    return hit ? { detected: true, evidence: hit } : { detected: false, evidence: null };
  }

  /* ---- 登录态特征（前置检查用；脚本绝不自动登录）---- */
  function loginScan() {
    var pw = document.querySelector(S.passwordSel);
    var re = null;
    try { re = new RegExp(PAT); } catch (e) { re = null; }
    return { host: location.host, href: String(location.href).slice(0, 140), hasPwField: !!(pw && visible(pw)), hostHit: !!(re && re.test(location.host)) };
  }

  /* ---- 统一解析：kind → 元素（find / jsClick 复用；点击前实时解析防矩形过期）---- */
  function resolve(kind, arg) {
    if (kind === 'videoToggle') {
      var big = document.querySelector(S.playBigSel);
      if (big && visible(big)) return { el: big, layer: 1, note: 'vjs-big-play-button' };
      var v = document.querySelector('video');
      if (v && visible(v)) return { el: v, layer: 2, note: 'video-element' };
      var p = document.querySelector(S.playIconSel);
      if (p && visible(p)) return { el: p, layer: 3, note: 'play-icon-candidate(generic)' };
      return null;
    }
    if (kind === 'dialogPrimary') {
      if (!lastDialogs.length) dialogScan();
      for (var i = 0; i < lastDialogs.length; i++) {
        var d = lastDialogs[i];
        if ((d.kind === 'anti-idle' || d.kind === 'confirm') && d.btn) return { el: d.btn, layer: d.layer, note: d.note };
      }
      return null;
    }
    if (kind === 'quizOption') {
      if (!lastQuiz.optionEls.length) quizScan();
      var idx = (arg === null || arg === undefined) ? 0 : arg;
      var el = lastQuiz.optionEls[idx];
      return el ? { el: el, layer: lastQuiz.layer || 2, note: lastQuiz.note || '' } : null;
    }
    /* 作业页按题块取选项：arg = {b: 题块序号, o: 选项序号}
       （学习通一道题一个 .TiMu.newTiMu，选项是 li.font-cxsecret.before-after） */
    if (kind === 'quizBlockOption') {
      var a = arg || {};
      var bi = Number(a.b) || 0;
      var oi = Number(a.o) || 0;
      var blocks2 = [];
      var qb = null;
      try { qb = document.querySelectorAll(S.quizQuestionSel); } catch (e) { qb = null; }
      if (!qb) return null;
      for (var qbi = 0; qbi < qb.length; qbi++) {
        if (!visible(qb[qbi])) continue;
        var os = optionsInBlock(qb[qbi]);
        if (!os.length) continue;
        blocks2.push(os);
      }
      var opts3 = blocks2[bi];
      if (!opts3) return null;
      var el3 = opts3[oi];
      if (!el3) return null;
      return { el: el3.el, layer: 2, note: 'block' + bi + '-opt' + oi };
    }
    /* 作业页提交按钮 */
    if (kind === 'quizBlockSubmit') {
      var sub = findSubmit();
      if (!sub) return null;
      return { el: sub.el, layer: 2, note: 'work-submit:' + sub.text };
    }
    /* 作业提交确认框的「确定」按钮。
       超星 btnBlueSubmit() → validateTimeNew() → toadd() → workPop('Submit？','Submit','Cancel')
       会弹一个 #workpop 确认框；只有点了 #popok 才会 submitCheckTimes() → form1submit() 真提交。
       ★ 坑：这个弹窗是用 **top.workPop** 渲染的，所以它出现在**顶层 frame** 里，
         作业 frame（doHomeWorkNew）里虽然也有同名 #workpop，但那个永远 display:none。
         因此引擎必须到顶层 frame 去找这个确认框。 */
    if (kind === 'workConfirm') {
      var wp = document.getElementById('workpop');
      if (!wp || !visible(wp)) return null;
      var okb = document.getElementById('popok');
      if (!okb || !visible(okb)) return null;
      var pcontent = document.getElementById('popcontent');
      return {
        el: okb, layer: 2,
        note: 'workpop-confirm:' + norm(pcontent ? (pcontent.innerText || '') : '').slice(0, 60),
      };
    }
    /* 作业页题块矩形（截图用）：arg = {b: 题块序号}
       返回该题块在**本 frame 视口**里的并集矩形（题块 + 题干 + 全部选项），
       纯视口坐标，不做任何跨 frame 换算 —— 换算由引擎（CDP 侧）统一做，
       因为跨源时页面侧读不到父 frame 的滚动量。 */
    if (kind === 'quizBlockRect') {
      var a2 = arg || {};
      var bi2 = Number(a2.b) || 0;
      var seen = 0;
      var qb2 = null;
      try { qb2 = document.querySelectorAll(S.quizQuestionSel); } catch (e) { qb2 = null; }
      if (!qb2) return null;
      for (var qbi2 = 0; qbi2 < qb2.length; qbi2++) {
        if (!visible(qb2[qbi2])) continue;
        var os2 = optionsInBlock(qb2[qbi2]);
        if (!os2.length) continue;
        if (seen === bi2) {
          var blk2 = qb2[qbi2];
          var parts2 = [];
          var push2 = function (el) {
            if (!el) return;
            var rr = el.getBoundingClientRect();
            if (rr && rr.width > 0 && rr.height > 0) parts2.push(rr);
          };
          push2(blk2);
          push2(blk2.querySelector(S.quizTitleFallbackSel));
          push2(blk2.querySelector(S.quizTitleSel));
          for (var oi2 = 0; oi2 < os2.length; oi2++) push2(os2[oi2].el);
          var u2 = unionRectOf2(parts2);
          if (!u2) return null;
          u2.rectOnly = true;
          u2.note = 'block' + bi2;
          u2.blockIndex = bi2;
          return u2;
        }
        seen++;
      }
      return null;
    }
    /* 把第 b 个题块滚到本 frame 的可视区（frame 内滚动，用于截图定位） */
    if (kind === 'quizBlockScroll') {
      var a3 = arg || {};
      var bi3 = Number(a3.b) || 0;
      var seen3 = 0;
      var qb3 = null;
      try { qb3 = document.querySelectorAll(S.quizQuestionSel); } catch (e) { qb3 = null; }
      if (!qb3) return null;
      for (var qbi3 = 0; qbi3 < qb3.length; qbi3++) {
        if (!visible(qb3[qbi3])) continue;
        var os3 = optionsInBlock(qb3[qbi3]);
        if (!os3.length) continue;
        if (seen3 === bi3) {
          try { qb3[qbi3].scrollIntoView({ block: 'start' }); } catch (e4) { try { qb3[qbi3].scrollIntoView(); } catch (e5) {} }
          return { el: qb3[qbi3], layer: 2, note: 'block' + bi3 + '-scrolled' };
        }
        seen3++;
      }
      return null;
    }
    if (kind === 'quizSubmit') {
      if (!lastQuiz.submitEl) quizScan();
      return lastQuiz.submitEl ? { el: lastQuiz.submitEl, layer: lastQuiz.layer || 2, note: 'quiz-submit' } : null;
    }
    if (kind === 'videoTab') {
      if (!lastVideoTab.el) quizTabScan();
      if (!lastVideoTab.el) return null;
      var inner3 = lastVideoTab.el.querySelector('a, [onclick]') || lastVideoTab.el;
      return { el: inner3, layer: 2, note: 'video-tab:' + lastVideoTab.title };
    }
    if (kind === 'quizTab') {
      if (!lastQuizTab.el) quizTabScan();
      if (!lastQuizTab.el) return null;
      var inner2 = lastQuizTab.el.querySelector('a, [onclick]') || lastQuizTab.el;
      return { el: inner2, layer: 2, note: 'quiz-tab:' + lastQuizTab.title };
    }
    if (kind === 'tocItem') {
      if (!lastToc.els.length) tocScan();
      var el2 = null;
      /* ★ 2026-10-31 真机：目录项按 index 点会点错（3.4 点成了 3.3），
         结果播放器一直是上一节的 772 秒视频。带 chapterId 时按 id 精确匹配，
         匹配不到再退回 index。 */
      if (typeof arg === 'string' && arg) {
        for (var ti = 0; ti < lastToc.els.length; ti++) {
          var cand = lastToc.els[ti];
          var cid = '';
          try { cid = String(cand.id || '').replace(/^cur/, ''); } catch (e6) { cid = ''; }
          if (cid && cid === arg) { el2 = cand; break; }
        }
      }
      if (!el2) el2 = lastToc.els[arg];
      if (!el2) { tocScan(); el2 = lastToc.els[arg]; }
      if (!el2) return null;
      /* ★ 2026-10-31 真机（FNOS 3.4）：目录项在 y=801，视口高度约 800，
         点击坐标落在可视区外 → 点了等于没点，播放器一直是上一节。
         点之前先把它滚到视口中间。 */
      try { el2.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e7) { /* ignore */ }
      var inner = el2.querySelector('a, [onclick]') || el2;
      return { el: inner, layer: lastToc.layer || 2, note: lastToc.note || '' };
    }
    /* 随堂弹题：点第 arg 个选项（li.ans-videoquiz-opt 内的 label，点 label 触发 radio） */
    if (kind === 'videoQuizOption') {
      if (!lastVideoQuiz.el) videoQuizScan();
      if (!lastVideoQuiz.el) return null;
      var vqLis = null;
      try { vqLis = lastVideoQuiz.el.querySelectorAll(S.videoQuiz.optionSel); } catch (e) { vqLis = null; }
      if (!vqLis || !vqLis.length) return null;
      var vqIdx = (arg === null || arg === undefined) ? 0 : Number(arg);
      var vqEl = vqLis[vqIdx];
      if (!vqEl || !visible(vqEl)) return null;
      // 点 label（label 会触发内嵌 radio 的选中）
      var vqLabel = vqEl.querySelector('label') || vqEl;
      return { el: vqLabel, layer: 2, note: 'videoquiz-opt' + vqIdx };
    }
    /* 随堂弹题：提交 */
    if (kind === 'videoQuizSubmit') {
      if (!lastVideoQuiz.el) videoQuizScan();
      if (!lastVideoQuiz.el) return null;
      var vqs = lastVideoQuiz.el.querySelector(S.videoQuiz.submitSel);
      if (!vqs || !visible(vqs)) return null;
      return { el: vqs, layer: 2, note: 'videoquiz-submit' };
    }
    /* 随堂弹题：答对后点「继续」恢复播放 */
    if (kind === 'videoQuizContinue') {
      if (!lastVideoQuiz.el) videoQuizScan();
      if (!lastVideoQuiz.el) return null;
      var vqc = lastVideoQuiz.el.querySelector(S.videoQuiz.continueSel);
      if (!vqc || !visible(vqc)) return null;
      return { el: vqc, layer: 2, note: 'videoquiz-continue' };
    }
    return null;
  }

  window.__cx = {
    __v: S.version,
    probeAll: function () {
      /* ★ 2026-10-29：把任务点清单一起返回。
         参考 xuexitong-ai-assistant 的 pageInventory.markers：按 .ans-attach-ct
         逐个分类（video/audio/document/quiz/discussion）并各自记 finished，
         这样「视频这个任务点完成」就足以进下一节，不必等整节归零。
         之前引擎只统计数量、不落到判定里，遇到「视频已完成 + 测验未做」就无限空转。 */
      var tasks = [];
      try {
        var cts = document.querySelectorAll(S.jobAttachSel);
        for (var i = 0; i < cts.length; i++) {
          var el = cts[i];
          var icon = el.querySelector(S.jobIconSel);
          var ifr = el.querySelector('iframe');
          var src = ifr ? (ifr.getAttribute('src') || '') : '';
          var label = icon ? (icon.getAttribute('aria-label') || '') : '';
          var kind = 'unknown';
          var finishedByClass = el.classList.contains(S.jobFinishedClass);
          var finishedByLabel = false;
          for (var li = 0; li < S.jobIconLabelDone.length; li++) {
            if (label.indexOf(S.jobIconLabelDone[li]) >= 0) { finishedByLabel = true; break; }
          }
          if (/\\/modules\\/audio\\//i.test(src) || (ifr && ifr.getAttribute('module') === 'insertaudio')) kind = 'audio';
          else if (/\\/modules\\/video\\//i.test(src)) kind = 'video';
          else if (/work|quiz|exam/i.test(src)) kind = 'quiz';
          else if (/pdf|doc|read|screen/i.test(src)) kind = 'document';
          else if (ifr && /insertbbs/i.test(ifr.getAttribute('module') || '')) kind = 'discussion';
          else if (el.querySelector('video,audio') || el.classList.contains(S.jobVideoClass)) kind = 'video';
          tasks.push({
            kind: kind,
            finished: finishedByClass || finishedByLabel,
            label: label.slice(0, 24)
          });
        }
      } catch (e) { /* ignore */ }
      return {
        url: String(location.href).slice(0, 160),
        video: videoState(),
        dialogs: dialogScan(),
        quiz: quizScan(),
        videoQuiz: videoQuizScan(),
        quizTab: (function () { var q = quizTabScan(); return { present: !!q.el, title: q.title, index: q.index }; })(),
        toc: tocScan(),
        human: humanScan(),
        login: loginScan(),
        tasks: tasks
      };
    },
    videoState: videoState,
    find: function (kind, arg) {
      var r = resolve(kind, arg);
      if (!r) return { ok: false, reason: 'not-found' };
      /* 矩形类 kind（截图裁剪用）：直接返回坐标，不做可见性/元素校验 */
      if (r.rectOnly) return { ok: true, rect: r, note: r.note, blockIndex: r.blockIndex };
      if (!r.el || !visible(r.el)) return { ok: false, reason: 'not-found-or-hidden' };
      var rect = rectOf(r.el);
      if (rect.cross) return { ok: false, reason: 'cross-origin-rect', jsFallback: true };
      var vh = 100000, vw = 100000;
      try { vh = window.top.innerHeight || vh; vw = window.top.innerWidth || vw; } catch (e) { vh = window.innerHeight; vw = window.innerWidth; }

      /* ★ 2026-10-31：判断「在不在视口内」必须用**点击点（中心）**，而且用 >=。
         原来只看 rect.y > vh，3.4 在 y=801、视口 800 时 801 > 800 不成立（或差 1px），
         于是不滚，点落在窗外 —— 这就是「死活点不动」的直接原因。 */
      function pointOf(rc) { return { x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 }; }
      function outside(rc) {
        var p = pointOf(rc);
        return p.x < 2 || p.y < 2 || p.x >= vw - 2 || p.y >= vh - 2;
      }
      /* 命中检查：用元素自己 frame 的局部坐标做 elementFromPoint，
         防止点在遮罩/别的元素上（点了没反应）却以为成功了。 */
      function hitOk() {
        try {
          var lr = r.el.getBoundingClientRect();
          var cx = lr.left + lr.width / 2, cy = lr.top + lr.height / 2;
          if (cx < 0 || cy < 0) return false;
          var hit = document.elementFromPoint(cx, cy);
          return !!(hit && (hit === r.el || r.el.contains(hit)));
        } catch (e4) { return true; }
      }
      var scrolled = false;
      if (outside(rect)) {
        try { r.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e2) { try { r.el.scrollIntoView(); } catch (e3) {} }
        rect = rectOf(r.el);
        scrolled = true;
      }
      var hit = hitOk();
      if (!hit) {
        try { r.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e5) {}
        rect = rectOf(r.el);
        scrolled = true;
        hit = hitOk();
      }
      if (!hit) return { ok: false, reason: 'hit-test-blocked', note: r.note };
      if (outside(rect)) return { ok: false, reason: 'still-outside-viewport', note: r.note };
      return { ok: true, text: norm(r.el.innerText || r.el.value || '').slice(0, 60), rect: rect, layer: r.layer, note: r.note + (scrolled ? '+scrolled' : ''), scrolled: scrolled };
    },
    jsClick: function (kind, arg) {
      var r = resolve(kind, arg);
      if (!r || !r.el || !visible(r.el)) return { ok: false, reason: 'not-found-or-hidden' };
      r.el.click();
      return { ok: true, text: norm(r.el.innerText || r.el.value || '').slice(0, 60), layer: r.layer, note: r.note };
    }
  };
  return 'installed';
})();`;

/** 组装注入表达式：选择器注册表 + 风险关键词 + 登录域特征 + 页面探测代码 */
function installProbeExpression(cfg) {
  return 'window.__CX_SEL=' + JSON.stringify(SELECTORS) + ';' +
    'window.__CX_KWS=' + JSON.stringify(cfg.safety.fatalKeywords) + ';' +
    'window.__CX_PATTERN=' + JSON.stringify(cfg.safety.loginHostPattern) + ';' +
    PAGE_PROBE_SRC;
}


module.exports = {
  SELECTORS,
  PAGE_PROBE_SRC,
  installProbeExpression
};
