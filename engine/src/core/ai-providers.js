#!/usr/bin/env node
/* ============================================================================
 * ai-providers.js —— 答题「传输通道」的 provider 注册表 + 回退链（D-065）
 *
 * 为什么要这一层（对标 chaoxing/Samueli924 的 PROVIDER_REGISTRY）：
 *   原来 `machine.js::_aiTransport` 里写死两个 if 分支（宿主回调 / 直连 OpenAI 兼容），
 *   想再加一个题库或模型供应商就必须改这个函数本体 —— 加东西要动核心。
 *   这里改成「注册表 + 按顺序回退」：
 *     · 新增供应商 = registerProvider('名字', factory)，核心一行不动；
 *     · 某个供应商初始化/请求失败 → 自动回退下一个，不再整题失败；
 *     · 全部失败才抛错（由 ai.decide/decideBatch 统一判 AI_TRANSPORT_ERROR）。
 *
 * 刻意保留的边界（安全红线）：
 *   · 本层**只负责传输**：把 prompt 送出去、把文本拿回来。
 *     范围锁（哪些 kind 允许答题）、prompt 拼装、答案解析、审计，全部仍在 core/ai.js。
 *   · 本层不碰页面、不写进度、不伪造上报。
 *
 * 契约：
 *   provider = {
 *     name: string,
 *     available(): boolean,                      // 当前环境是否具备（有地址/有 key）
 *     ask({prompt, image, model, timeoutMs, maxTokens}): Promise<string>   // 失败请 throw
 *     setFeedback?(feedback): void,              // 可选钩子（默认空实现）
 *     close?(): void,
 *   }
 * ==========================================================================*/
'use strict';

/** 供应商基类：可选钩子给空实现，子类只需实现 available()/ask()。 */
class AnswerProvider {
  constructor(name) { this.name = String(name || this.constructor.name); }
  available() { return false; }
  /* eslint-disable-next-line no-unused-vars */
  async ask(_req) { throw new Error('AnswerProvider.ask 未实现: ' + this.name); }
  /* 可选钩子：把上一轮「答错了」的反馈交给支持的供应商（默认忽略） */
  /* eslint-disable-next-line no-unused-vars */
  setFeedback(_fb) { }
  close() { }
}

/* ---------------------------------------------------------------- 内置供应商 */

/** 宿主回调通道（DSH 插件 /api/cx-learn/llm-ask）—— 用宿主已配置的模型。 */
class HostCallbackProvider extends AnswerProvider {
  constructor(opts) {
    super('host');
    const o = opts || {};
    this.url = o.url || '';
    this.token = o.token || '';
    this.model = o.model || '';
    this.providerName = o.provider || 'host';
    this.fetchImpl = o.fetchImpl || hostFetch();
    this.timeoutMs = o.timeoutMs > 0 ? Number(o.timeoutMs) : 20000;
  }
  available() { return !!this.url; }
  async ask(req) {
    const r = req || {};
    const payload = { provider: this.providerName, model: r.model || this.model || '', prompt: String(r.prompt || '') };
    if (r.image) payload.image = 'data:image/png;base64,' + r.image;
    const res = await fetchWithTimeout(this.fetchImpl, this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cx-token': this.token || '',
      },
      body: JSON.stringify(payload),
    }, r.timeoutMs || this.timeoutMs);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await safeText(res)).slice(0, 120));
    const j = await res.json();
    if (!j || j.ok !== true) throw new Error(String((j && j.error) || '宿主答题回调失败'));
    return String(j.text || '');
  }
}

/** 直连 OpenAI 兼容接口（插件内置 key / 自建网关）。 */
class DirectProvider extends AnswerProvider {
  constructor(opts) {
    super('direct');
    const o = opts || {};
    this.base = o.base || '';
    this.key = o.key || '';
    this.model = o.model || '';
    this.fetchImpl = o.fetchImpl || hostFetch();
    this.timeoutMs = o.timeoutMs > 0 ? Number(o.timeoutMs) : 20000;
  }
  available() { return !!(this.base && this.key && this.model); }
  async ask(req) {
    const r = req || {};
    const url = String(this.base).replace(/\/+$/, '') + '/chat/completions';
    const content = r.image
      ? [{ type: 'text', text: String(r.prompt || '') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + r.image } }]
      : String(r.prompt || '');
    const res = await fetchWithTimeout(this.fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.key },
      body: JSON.stringify({
        model: r.model || this.model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: r.maxTokens > 0 ? Number(r.maxTokens) : 16,
      }),
    }, r.timeoutMs || this.timeoutMs);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await safeText(res)).slice(0, 120));
    const j = await res.json();
    return String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  }
}

/* ---------------------------------------------------------------- 注册表 */

/** 名字 → 工厂（(opts) => provider 实例） */
const PROVIDER_REGISTRY = Object.create(null);
PROVIDER_REGISTRY.host = (opts) => new HostCallbackProvider(opts);
PROVIDER_REGISTRY.direct = (opts) => new DirectProvider(opts);

/**
 * 注册/覆盖一个供应商工厂。
 * @param {string} name
 * @param {(opts:object)=>AnswerProvider} factory
 */
function registerProvider(name, factory) {
  const k = String(name || '').trim();
  if (!k) throw new Error('registerProvider: name 不能为空');
  if (typeof factory !== 'function') throw new Error('registerProvider: factory 必须是函数');
  PROVIDER_REGISTRY[k] = factory;
  return k;
}

/** 测试用：恢复内置注册表（不暴露给业务） */
function _resetProviders() {
  for (const k of Object.keys(PROVIDER_REGISTRY)) delete PROVIDER_REGISTRY[k];
  PROVIDER_REGISTRY.host = (opts) => new HostCallbackProvider(opts);
  PROVIDER_REGISTRY.direct = (opts) => new DirectProvider(opts);
}

function listProviders() {
  return Object.keys(PROVIDER_REGISTRY).sort();
}

/* ---------------------------------------------------------------- 通道选择 */

/**
 * 决定「按什么顺序尝试哪些通道」。
 * 优先级（保持旧行为：有宿主回调就先用它）：
 *   1. cfg.ai.providers（显式数组，最灵活）
 *   2. cfg.ai.channel === 'direct' → ['direct', 'host']；否则 ['host', 'direct']
 * 只返回**已注册**的名字；未注册的忽略并记录。
 */
function resolveOrder(cfgAi) {
  const ai = cfgAi || {};
  const known = (n) => Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, n);
  if (Array.isArray(ai.providers) && ai.providers.length) {
    const out = ai.providers.map((x) => String(x || '').trim()).filter((x) => x && known(x));
    if (out.length) return out;
  }
  const ch = String(ai.channel || '').trim();
  const base = ch === 'direct' ? ['direct', 'host'] : ['host', 'direct'];
  return base.filter(known);
}

/* ---------------------------------------------------------------- 工具 */

function hostFetch() {
  if (typeof fetch === 'function') return fetch;
  throw new Error('当前 Node 无全局 fetch（需要 Node >= 18）');
}

async function safeText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), wait);
  try {
    return await fetchImpl(url, Object.assign({}, init, { signal: ac.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 构造「带回退的 transport」——签名与旧 `_aiTransport` 返回值一致：
 *   transport({prompt, image}) → {ok:true, text, model, by}
 * 失败（全部通道都失败）抛错，交给 core/ai.js 记 AI_TRANSPORT_ERROR。
 *
 * @param {object} o { env, cfgAi, timeoutMs, maxTokens, fetchImpl }
 */
function createTransport(o) {
  const opts = o || {};
  const env = opts.env || process.env || {};
  const cfgAi = opts.cfgAi || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : (Number(cfgAi.timeoutMs) > 0 ? Number(cfgAi.timeoutMs) : 20000);
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 16;

  const providerOpts = {
    url: env.CX_LLM_ASK_URL || '',
    token: env.CX_LLM_ASK_TOKEN || '',
    base: env.CX_LLM_BASE || '',
    key: env.CX_LLM_KEY || '',
    model: env.CX_LLM_MODEL || cfgAi.model || '',
    provider: env.CX_LLM_PROVIDER || cfgAi.provider || 'host',
    timeoutMs,
    fetchImpl: opts.fetchImpl,
  };

  const order = resolveOrder(cfgAi);
  const instances = [];
  for (const name of order) {
    try {
      const inst = PROVIDER_REGISTRY[name](providerOpts);
      if (inst && typeof inst.ask === 'function' && inst.available()) instances.push(inst);
    } catch (_) { /* 单个供应商构造失败不影响其它 */ }
  }

  if (!instances.length) {
    /* 没有任何可用通道：返回一个「总是抛错」的 transport。
       调用方（machine.askAI）会先检查 env 决定是否调用，所以这里不该被日常触达；
       真被调用时抛错比静默成功更安全（不会假装答了题）。 */
    const err = new Error('NO_AVAILABLE_PROVIDER');
    err.code = 'NO_AVAILABLE_PROVIDER';
    return async () => { throw err; };
  }

  return async (req) => {
    const r = req || {};
    const errors = [];
    for (const p of instances) {
      try {
        const text = await p.ask({
          prompt: r.prompt, image: r.image || '', model: r.model || '', timeoutMs, maxTokens,
        });
        if (String(text || '').trim()) {
          return { ok: true, text: String(text), model: r.model || providerOpts.model, by: p.name };
        }
        errors.push(p.name + ': empty');
      } catch (e) {
        errors.push(p.name + ': ' + String((e && e.message) || e).slice(0, 100));
        /* 回退下一个通道 */
      }
    }
    const err = new Error('ALL_PROVIDERS_FAILED [' + errors.join(' | ') + ']');
    err.code = 'ALL_PROVIDERS_FAILED';
    throw err;
  };
}

module.exports = {
  AnswerProvider,
  HostCallbackProvider,
  DirectProvider,
  PROVIDER_REGISTRY,
  registerProvider,
  listProviders,
  resolveOrder,
  createTransport,
  _resetProviders,
};
