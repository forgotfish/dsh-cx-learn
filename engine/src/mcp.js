/* ============================================================================
 * engine/src/mcp.js — MCP stdio server（零依赖）+ CLI 参数解析
 * ----------------------------------------------------------------------------
 * 由 engine/chaoxing-autolearn.js 按职责拆出（scripts/split-engine.cjs）。
 * 拆分只做搬运，逻辑与原文件等价；要改行为在本文件内改，并补对应测试。
 * ==========================================================================*/
'use strict';

const { VERSION } = require('./core/base.js');
const { CONFIG } = require('./core/config.js');
const { logger } = require('./core/logging.js');
const { run } = require('./learn/run.js');
const { runLogin } = require('./login/index.js');

/* ============================================================================
 * 第 8 节 · DSH 导出 / CLI / MCP stdio 工具注册
 * ----------------------------------------------------------------------------
 * (a) 后台任务：`node chaoxing-autolearn.js --mode=continue_chapters --max-sections=10`
 * (b) 模块：   const { run } = require('./chaoxing-autolearn.js'); await run({...})
 * (c) DSH 工具：`node chaoxing-autolearn.js --serve-mcp` 启动零依赖 MCP stdio server；
 *     经 DSH 官方 mcp-bundle 机制注册后，Agent 以 mcp__cx__cx_learn 调用（见文末指南 A）。
 * ==========================================================================*/
function serveMcp() {
  logger.setConsole((line) => console.error(line)); // stdout 专供 JSON-RPC 协议
  logger.configure(CONFIG.log);
  logger.info('MCP', 'cx-auto-learn MCP stdio server 启动，工具名: ' + CONFIG.mcp.toolName, { version: VERSION });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleMcpLine(line).catch((e) => logger.error('MCP', '处理失败: ' + e.message));
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function handleMcpLine(line) {
    let msg; try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: CONFIG.mcp.serverName, version: VERSION }
      });
    } else if (/^notifications\//.test(msg.method || '')) {
      /* 通知无需应答 */
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [{
          name: CONFIG.mcp.toolName,
          title: '学习通视频学习推进',
          description: '驱动 DSH 侧 Chromium（CDP）自动完成学习通课程视频：P0 恢复播放/关弹窗、P2 弹题作答、P1 切节、P3 跳过已完成、P4 章节模式与上限。返回结构化结果。检测到人脸/验证码立即停止。',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['current_chapter', 'continue_chapters'], description: 'P4 模式' },
              maxSections: { type: 'integer', minimum: 1, description: '最多完整看完多少节' },
              courseUrl: { type: 'string', description: '课程学习页 URL；缺省沿用浏览器当前页' }
            }
          }
        }, {
          name: 'cx_login',
          title: '学习通扫码登录（无头）',
          description: '打开登录页二维码并周期截图（复用 profile 登录态，已有登录态直接返回）。用户在手机学习通 App 扫截图里的码即可；超时自动刷新二维码。不接触账密、不自动填表。',
          inputSchema: {
            type: 'object',
            properties: {
              timeoutSec: { type: 'integer', minimum: 30, description: '扫码等待窗口秒数，默认 300' }
            }
          }
        }]
      });
    } else if (msg.method === 'tools/call') {
      const a = (msg.params && msg.params.arguments) || {};
      if (msg.params && msg.params.name === 'cx_login') {
        try {
          const ov = a.timeoutSec ? { login: { timeoutMs: Number(a.timeoutSec) * 1000 } } : {};
          const r = await runLogin(ov);
          reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(r) }] });
        } catch (e) {
          reply(msg.id, { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true });
        }
        return;
      }
      const overrides = {};
      if (a.mode) overrides.mode = String(a.mode);
      if (a.maxSections) overrides.maxSections = Number(a.maxSections);
      if (a.courseUrl) overrides.course = { url: String(a.courseUrl) };
      try {
        const r = await run(overrides);
        reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(r) }] });
      } catch (e) {
        reply(msg.id, { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true });
      }
    } else if (msg.id !== undefined) {
      reply(msg.id, { error: { code: -32601, message: 'method not found: ' + msg.method } });
    }
  }
  function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
}

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] === undefined ? true : m[2];
  }
  return o;
}


module.exports = {
  serveMcp,
  parseArgs
};
