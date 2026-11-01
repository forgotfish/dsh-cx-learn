#!/usr/bin/env node
/* ============================================================================
 * mock-course/server.cjs — 本机假课程站（按 FNOS 实测 DOM 复刻）
 * ============================================================================
 * 目的：不登录、不碰真实课程，在本机用**真实浏览器**跑通「登录之后的整条链路」：
 *   读目录 → 判定已完成 → 跳过 → 播放 → 随堂题盲试 → 切下一节
 *
 * 复刻依据（2026-10-30 20:2x 只读 CDP 探针实测，见 docs/DOM-STRUCTURE.md）：
 *   目录：.posCatalog_select × N，小节 id="cur<chapterId>"，完成度用
 *         input.jobUnfinishCount（0/缺失=完成）与 .icon_Completed
 *   章内子任务：<ul class="prev_ul"><li title="视频"><li title="章节测验">
 *   任务点：.ans-attach-ct[.ans-job-finished] > .ans-job-icon[aria-label=任务点已完成]
 *   播放器：独立 iframe /ananas/modules/video/index.html
 *   随堂题：.ans-videoquiz + .tkItem_title + li.ans-videoquiz-opt + #videoquiz-submit
 *
 * ★ 视频不用真 mp4：把 <video> 元素的 duration/currentTime/paused/readyState/buffered
 *   用 Object.defineProperty 伪装成「已在播放」，并定时推进 currentTime。
 *   这样无需任何媒体文件，也能让引擎读到与真站一致的字段。
 *
 * 用法：node scripts/mock-course/server.cjs [port]
 * ==========================================================================*/
'use strict';

const http = require('node:http');

const PORT = Number(process.argv[2] || 8123);

/* 课程结构：1.1/1.2 整节完成，1.3 视频完成但章节测验没做，1.4 未看，1.5 未看 */
const SECTIONS = [
  { id: '100001', title: '1.1 第四次工业革命', header: false, fullDone: true, videoDone: true },
  { id: '100002', title: '1.2 中国与四次工业革命', header: false, fullDone: true, videoDone: true },
  { id: '100003', title: '1.3 工程形态', header: false, fullDone: false, videoDone: true },
  { id: '100004', title: '1.4 作为科学的工程', header: false, fullDone: false, videoDone: false, withQuiz: true },
  { id: '100005', title: '1.5 新时代工程的定义', header: false, fullDone: false, videoDone: false }
];
const HEADER = { id: '', title: '1 新时代的工程', header: true };

function catalogHtml(currentId) {
  const rows = [];
  rows.push(`<div class="posCatalog_select firstLayer" id="100000">
    <span class="posCatalog_title posCatalog_rotate titleIcon" title="${HEADER.title}">
      <em class="posCatalog_sbar">1</em> ${HEADER.title}
    </span>
  </div>`);
  for (const s of SECTIONS) {
    const isCur = s.id === currentId;
    const cls = 'posCatalog_select' + (isCur ? ' posCatalog_active' : '');
    const icon = s.fullDone ? '<span class="icon_Completed prevTips"><span class="prevHoverTips">Completed</span></span>' : '';
    const uf = s.fullDone ? '' : `<input type="hidden" class="jobUnfinishCount" value="${s.videoDone ? 1 : 2}">`;
    rows.push(`<div class="${cls}" id="cur${s.id}">
      <span class="posCatalog_name" title="${s.title}" onclick="getTeacherAjax('900001','900002','${s.id}');">
        <em class="posCatalog_sbar">${s.title.split(' ')[0]}</em> ${s.title.replace(/^\S+\s/, '')}
      </span>
      ${icon}${uf}
    </div>`);
  }
  return rows.join('\n');
}

/* ---------- 顶层学习页 ---------- */
function studyPage(currentId, withQuizTab) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>学习页(mock)</title>
<style>body{font-family:sans-serif;margin:0}#catalog{width:320px;float:left}.posCatalog_select{padding:6px 8px;border-bottom:1px solid #eee}
.posCatalog_active{background:#eef}.icon_Completed{color:green}iframe{width:640px;height:420px;border:1px solid #ccc}
.prev_ul li{display:inline-block;padding:4px 8px;cursor:pointer;border:1px solid #ccc;margin-right:4px}
.prev_ul li.active{background:#eef}</style>
</head><body>
<div id="catalog">
${catalogHtml(currentId)}
<ul class="prev_ul clearfix">
  <li class="active" title="视频"><span class="spanText">视频</span></li>
  <li title="章节测验"><span class="spanText">章节测验</span></li>
</ul>
</div>
<iframe id="cards" src="/mooc-ans/knowledge/cards?knowledgeid=${currentId}"></iframe>
<script>
document.querySelectorAll('.posCatalog_name').forEach(function (el) {
  el.addEventListener('click', function () {
    var box = el.closest('.posCatalog_select');
    var id = (box.id || '').replace(/^cur/, '');
    if (!id) return;
    location.href = '/mycourse/studentstudy?chapterId=' + id;
  });
});
/* 点「章节测验」标签 → 内容区换成 .TiMu 作业页（真站就是这个行为）。
   只在 quizTab=1 时启用，避免影响主链路测试。 */
if (${withQuizTab ? 'true' : 'false'}) {
  var tabs = document.querySelectorAll('.prev_ul li');
  var timu = tabs[1];
  if (timu) timu.addEventListener('click', function () {
    tabs[0].classList.remove('active');
    timu.classList.add('active');
    document.getElementById('cards').src = '/mooc-ans/knowledge/timu?knowledgeid=${currentId}';
  });
}
</script>
</body></html>`;
}

/* ---------- knowledge/cards ---------- */
function cardsPage(knowledgeId) {
  const sec = SECTIONS.find((s) => s.id === knowledgeId) || {};
  const finished = sec.videoDone || sec.fullDone;
  const cls = 'ans-attach-ct videoContainer' + (finished ? ' ans-job-finished' : '');
  const label = finished ? '任务点已完成' : '任务点未完成';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="${cls}" id="attach1">
  <div class="ans-job-icon ans-job-video ${finished ? 'ans-job-icon-clear' : ''}" aria-label="${label}" role="option"><i></i></div>
  <iframe id="video" src="/ananas/modules/video/index.html?knowledgeid=${knowledgeId}"></iframe>
</div>
</body></html>`;
}

/* ---------- 播放器（伪装 video 字段，无需真实媒体） ---------- */
function videoPage(knowledgeId) {
  const sec = SECTIONS.find((s) => s.id === knowledgeId) || {};
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#111;color:#fff;font-family:sans-serif}
#v{width:640px;height:360px;background:#000;display:block}
.vjs-big-play-button{position:absolute;top:150px;left:280px;width:80px;height:60px;background:#000a;color:#fff;
 border-radius:8px;line-height:60px;text-align:center;cursor:pointer}
.ans-videoquiz{display:none;position:absolute;top:40px;left:60px;width:520px;background:#fff;color:#222;padding:12px;border-radius:8px}
.ans-videoquiz.on{display:block}
li.ans-videoquiz-opt{cursor:pointer;list-style:none;padding:4px 0}
#videoquiz-continue{display:none}
</style></head><body>
<video id="v"></video>
<div class="vjs-big-play-button" id="play">播放</div>

<div class="ans-videoquiz" id="vq">
  <div class="tkItem_title">判断题：计算机和网络代表了电气时代的生活</div>
  <ul class="tkItem_ul">
    <li class="ans-videoquiz-opt"><label><input type="radio" name="ans-videoquiz-opt" value="">A、对</label></li>
    <li class="ans-videoquiz-opt"><label><input type="radio" name="ans-videoquiz-opt" value="">B、错</label></li>
  </ul>
  <div class="tkTopic_oper">
    <a id="videoquiz-submit">提交</a>
    <a id="videoquiz-continue">继续</a>
    <span id="spanHas" style="display:none">回答正确</span>
    <span id="spanNot" style="display:none">回答错误</span>
  </div>
</div>

<script>
/* ---- 伪装播放器：引擎读的是 duration/currentTime/paused/ended/readyState/... ---- */
var state = { dur: 350, cur: Number(sessionStorage.getItem('cur') || 0), paused: true, ended: false };
var v = document.getElementById('v');
function def(name, get) { Object.defineProperty(v, name, { configurable: true, get: get }); }
def('duration', function () { return state.dur; });
def('currentTime', function () { return state.cur; });
def('paused', function () { return state.paused; });
def('ended', function () { return state.ended; });
def('readyState', function () { return 4; });
def('networkState', function () { return 1; });
def('muted', function () { return true; });
def('error', function () { return null; });
def('currentSrc', function () { return 'mock://video/' + ${JSON.stringify(knowledgeId)}; });
def('buffered', function () { return { length: 1, start: function () { return 0; }, end: function () { return state.dur; } }; });
v.play = function () { state.paused = false; return Promise.resolve(); };
v.pause = function () { state.paused = true; };

/* ---- 随堂题 ---- */
var quizShown = false;
var quizAnswered = false;
var vq = document.getElementById('vq');
var allowQuiz = ${sec.withQuiz ? 'true' : 'false'};

function maybeShowQuiz() {
  if (!allowQuiz || quizShown || quizAnswered) return;
  if (state.cur >= 5) {
    quizShown = true;
    state.paused = true;
    vq.classList.add('on');
  }
}
document.getElementById('videoquiz-submit').addEventListener('click', function () {
  /* 盲试：第一次（A 对）判错，第二次（B 错）判对 —— 复刻真站行为 */
  var picked = document.querySelector('input[name="ans-videoquiz-opt"]:checked');
  var idx = picked ? Array.prototype.indexOf.call(document.querySelectorAll('input[name="ans-videoquiz-opt"]'), picked) : 0;
  if (idx === 1) {
    document.getElementById('spanHas').style.display = '';
    document.getElementById('videoquiz-continue').style.display = '';
    quizAnswered = true;
    setTimeout(function () { vq.classList.remove('on'); quizShown = false; state.paused = false; }, 300);
  } else {
    document.getElementById('spanNot').style.display = '';
    setTimeout(function () { document.getElementById('spanNot').style.display = 'none'; }, 800);
  }
});
document.getElementById('videoquiz-continue').addEventListener('click', function () {
  vq.classList.remove('on'); quizShown = false; quizAnswered = true; state.paused = false;
});

/* ---- 点播放开始走时间轴 ----
   真站上引擎是给「播放按钮」的坐标发真实鼠标事件，那个坐标可能落在 <video> 上
   （真播放器整块区域都可点）。所以这里让 video 本体和按钮都能触发播放。 */
function startPlay() { state.paused = false; }
document.getElementById('play').addEventListener('click', startPlay);
v.addEventListener('click', startPlay);
document.addEventListener('click', function (e) {
  /* 落到播放器区域内的任何点击都当成「点播放」 */
  var r = v.getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) startPlay();
});
setInterval(function () {
  if (state.paused) return;
  state.cur = Math.min(state.dur, state.cur + 20);
  sessionStorage.setItem('cur', String(state.cur));
  if (state.cur >= state.dur) state.ended = true;
  maybeShowQuiz();
}, 400);

/* ★ 自动开播：真实内核启动时带了 --autoplay-policy=no-user-gesture-required，
   真站上视频进入可播放状态就会自己走。本机假站如果等鼠标点击，
   验证的就变成「坐标点击有没有落对」而不是状态机本身 —— 那不是这次要测的东西。 */
setTimeout(startPlay, 1200);
</script>
</body></html>`;
}

/* ---------- 课程列表（run() 需要「点进课程」时的落地页） ---------- */
function courseList() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>课程(mock)</title></head><body>
<a href="/mycourse/studentstudy?chapterId=100003" data-courseid="900001">工程伦理</a>
</body></html>`;
}

/* ---------- 章节测验（.TiMu 题块，计成绩，绝不能被点） ---------- */
function timuPage(knowledgeId) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="TiMu newTiMu" id="q1">
  <div class="Zy_TItle"><span>1. 章节测验题（计成绩）</span></div>
  <ul>
    <li class="font-cxsecret before-after"><span class="num_option" data="A">A</span><label class="fl before">A</label><span>选项一</span></li>
    <li class="font-cxsecret before-after"><span class="num_option" data="B">B</span><label class="fl before">B</label><span>选项二</span></li>
  </ul>
</div>
<div class="TiMu newTiMu" id="q2">
  <div class="Zy_TItle"><span>2. 章节测验题（计成绩）</span></div>
  <ul>
    <li class="font-cxsecret before-after"><span class="num_option" data="A">A</span><label class="fl before">A</label><span>选项三</span></li>
    <li class="font-cxsecret before-after"><span class="num_option" data="B">B</span><label class="fl before">B</label><span>选项四</span></li>
  </ul>
</div>
<a class="btnSubmit workBtnIndex" href="javascript:;">提交</a>
<script>window.__cxTimuLoaded = ${JSON.stringify(knowledgeId)};</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = url.pathname;
  let body = '';
  if (p === '/visit/interaction') body = courseList();
  else if (p === '/mycourse/studentstudy') body = studyPage(url.searchParams.get('chapterId') || SECTIONS[0].id, url.searchParams.get('quizTab') === '1');
  else if (p === '/mooc-ans/knowledge/cards') body = cardsPage(url.searchParams.get('knowledgeid') || SECTIONS[0].id);
  else if (p === '/ananas/modules/video/index.html') body = videoPage(url.searchParams.get('knowledgeid') || SECTIONS[0].id);
  else if (p === '/mooc-ans/knowledge/timu') body = timuPage(url.searchParams.get('knowledgeid') || SECTIONS[0].id);
  else if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  else { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock] http://127.0.0.1:' + PORT + '/mycourse/studentstudy?chapterId=100003');
});
module.exports = server;
