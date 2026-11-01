/* ============================================================================
 * engine/src/core/base.js — 内置依赖、分层中间件加载、错误类型、定时原语、常量
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

/* ============================================================================
 * 第 0 节 · 基础（零 npm 依赖，仅 Node 内置）
 * ==========================================================================*/
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ============================================================================
 * 分层：浏览器层 ↔ 业务层 的中间层
 * ============================================================================
 * 两个人在同一个文件上改代码，git 天天冲突，而且互相破坏假设。
 * 现在规定两层的沟通方式只有两个：
 *   1. adapter 实例的方法调用（契约见 engine/adapter-contract.js）
 *   2. 中间状态文件（engine/.state/*.json，读写在 engine/state-bus.js）
 *
 * 任何人都不许再去读对方的内部变量、也不许依赖对方日志的格式。
 * 契约被破坏时，启动自检会直接报 ADAPTER_CONTRACT_VIOLATION。
 * ==========================================================================*/
let CONTRACT = null;
let BUS = null;
/* 浏览器层健康心跳（探活 / 心跳落盘 / 崩溃记录），见 engine/browser-health.js。
   与 CONTRACT/BUS 一样允许缺失：加载失败只降级，不让引擎起不来。 */
let HEALTH = null;
/* 扫码登录（2026-10-30 重写）：只按「URL 是否离开登录域」判定，不再自己管
   二维码会话。见 engine/login-flow.js 顶部说明。 */
let LOGIN_FLOW = null;
try {
  CONTRACT = require('../../adapter-contract.js');
  BUS = require('../../state-bus.js');
  HEALTH = require('../../browser-health.js');
  LOGIN_FLOW = require('../../login-flow.js');
} catch (e) {
  /* 契约/总线文件缺失不能让引擎起不来，但要留下痕迹 */
  try { console.error('[warn] 分层中间件加载失败（功能降级）：' + String((e && e.message) || e)); } catch (_) {}
}
/** 安全地往事件流里写一条；BUS 不可用时就静默跳过 */
function busEmit(layer, kind, data) {
  try { if (BUS && BUS.emit) BUS.emit(layer, kind, data); } catch (_) {}
}

const VERSION = '1.0.0';

/** 致命停止异常：携带稳定错误码，run() 捕获后写入结果，绝不重试。 */
class FatalStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'FatalStop';
  }
}

/** 底层定时原语：仅适配器与 humanize 允许使用，业务代码禁止散落 sleep。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  fs,
  os,
  path,
  CONTRACT,
  BUS,
  HEALTH,
  LOGIN_FLOW,
  busEmit,
  VERSION,
  FatalStop,
  sleep,
  spawn
};
