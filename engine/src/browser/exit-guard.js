/* ============================================================================
 * engine/src/browser/exit-guard.js — 进程退出守卫：任何退出路径都收掉浏览器，避免占着调试端口
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

/* ============================================================================
 * 进程退出守卫：任何退出路径（正常/异常/SIGTERM/SIGINT）都要收掉浏览器，
 * 否则 headless Chrome 会一直占着 9223 端口和 profile 目录（"占着茅坑"）。
 * ==========================================================================*/
let _guardInstalled = false;
let _activeAdapter = null;
/** 由登录/看课流程登记当前 adapter，供退出守卫在进程结束时收掉浏览器。 */
function setActiveAdapter(a) { _activeAdapter = a; }
function installExitGuard() {
  if (_guardInstalled) return;
  _guardInstalled = true;
  const bye = (code) => {
    try {
      if (_activeAdapter) {
        /* ★ 2026-10-31（B-精简）：SIGTERM 必须分两种情况。
           用户点「停止」= 只停这一轮，会话还开着 → 必须 **detach**。
           原来无条件 shutdown，于是「停止」会把内核关掉、登录态一起丢，
           下一门课又得重扫 —— 与「会话期间不死」直接矛盾。
           没有 CX_KEEP_BROWSER 时才走 shutdown（一次性登录的老语义）。 */
        const keep = String(process.env.CX_KEEP_BROWSER || '') === '1';
        const useDetach = keep && typeof _activeAdapter.detach === 'function';
        const fn = useDetach ? _activeAdapter.detach : _activeAdapter.shutdown;
        if (typeof fn === 'function') {
          /* 不等 HTTP 往返完成：进程即将退出，detach/shutdown 内部都有超时保护。
             显式 .call 绑定，避免解构后 this 丢失。 */
          Promise.resolve(fn.call(_activeAdapter)).catch(() => {});
        }
      }
    } catch (_) { /* ignore */ }
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGTERM', () => bye(143));
  process.on('SIGINT', () => bye(130));
}

module.exports = {
  _guardInstalled,
  _activeAdapter,
  setActiveAdapter,
  installExitGuard
};
