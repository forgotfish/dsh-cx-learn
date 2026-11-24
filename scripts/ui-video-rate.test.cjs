#!/usr/bin/env node
/* ============================================================================
 * ui-video-rate.test.cjs —— 设置页「播放倍速」是否真的接上了引擎（D-066 的 UI 缺口）
 *
 * 背景：引擎 0.3.0 就支持 video.playbackRate，但设置页一直没有入口 ——
 * 主人说过「默认 1 倍速，高倍速他们自己开」，UI 上没有开关，这句话就落不了地。
 *
 * 钉死：
 *   U1 默认 1（读不到配置不乱改页面）
 *   U2 选项集合克制（只到 2x）+ 风险提示
 *   U3 保存体带 video.playbackRate，且**展开合并**保留 video 其它字段
 *   U4 回填读 config.video.playbackRate
 *   U5 真实渲染：seed 注入 1.75 → 下拉当前值就是 1.75（证明回填与渲染都通）
 * ==========================================================================*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fails.push(name); console.log('  \u2717 ' + name + (extra === undefined ? '' : '  (' + extra + ')')); }
}

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

/* ---------- U1/U2 ---------- */
console.log('== U1. 默认 1 倍速 + 选项集合 + 风险提示 ==');
{
  ok(/const \[videoRate, setVideoRate\] = React\.useState\(1\)/.test(SRC), '★ 倍速状态默认 1');
  ok(/'data-cx-video-rate'/.test(SRC), '★ 有 data-cx-video-rate 控件');
  for (const v of ['1', '1.25', '1.5', '1.75', '2']) {
    ok(new RegExp("h\\('option', \\{ value: '" + v.replace('.', '\\.') + "' \\}").test(SRC), '  有 ' + v + 'x 档');
  }
  /* 只在下拉内部判断（U5 已经取出真实 option 集合；这里做源码层的粗查，
     限定在 data-cx-video-rate 附近的窗口内，避免误伤 maxSections 等其它控件） */
  {
    const at = SRC.indexOf("'data-cx-video-rate'");
    const win = at >= 0 ? SRC.slice(at, at + 900) : '';
    const vals = (win.match(/h\('option', \{ value: '([0-9.]+)'/g) || []).map((x) => Number((x.match(/'([0-9.]+)'/) || [])[1]));
    ok(vals.length > 0 && vals.every((v) => v <= 2),
      '★ UI 不提供 >2x（克制，避免被判学习异常）实际 ' + JSON.stringify(vals));
  }
  ok(/可能被判学习异常/.test(SRC), '★ 有风险提示文案');
  ok(/data-cx-video-rate-warn/.test(SRC), '★ 提示节点有测试钩子');
}

/* ---------- U3 ---------- */
console.log('== U3. 保存体：展开合并 video，避免冲掉 mute/progressDoneRatio ==');
{
  ok(/video: \{ \.\.\.\(\(st && st\.config && st\.config\.video\) \|\| \{\}\), playbackRate: Number\(videoRate\) \|\| 1 \}/.test(SRC),
    '★ ★ cfgBody 用展开语法合并 video');
  ok(/playbackRate: Number\(videoRate\) \|\| 1/.test(SRC), '★ 非法值回落 1');
  /* 反向：不许出现「只写 playbackRate 的裸对象」（会冲掉其它 video 字段） */
  ok(!/video: \{ playbackRate:/.test(SRC), '★ 没有把 video 写成裸对象（那会丢 mute/progressDoneRatio）');
}

/* ---------- U4 ---------- */
console.log('== U4. 回填读 config.video.playbackRate ==');
{
  ok(/setVideoRate\(Number\(s\.config && s\.config\.video && s\.config\.video\.playbackRate\) \|\| 1\)/.test(SRC),
    '★ 回填路径正确，缺省 1');
}

/* ---------- U5：真实渲染 ---------- */
console.log('== U5. 真实渲染：seed 注入 1.75 → 下拉值应为 1.75 ==');
{
  /* 复用 ui-render 的假 React/DOM 思路（按 useState 顺序 seed） */
  function makeReact(seed) {
    let i = 0;
    return {
      createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
      useState(init) {
        const at = i++;
        const has = seed && Object.prototype.hasOwnProperty.call(seed, at);
        return [has ? seed[at] : (typeof init === 'function' ? init() : init), () => {}];
      },
      useEffect() {},
      useCallback(fn) { return fn; },
      useRef(v) { return { current: v }; },
    };
  }
  function makeDocument() {
    const head = { children: [], appendChild(el) { head.children.push(el); } };
    return {
      head,
      createElement(tag) { return { tag, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, remove() {} }; },
    };
  }
  function loadPanel(seed) {
    const React = makeReact(seed);
    const registered = [];
    let factory = null;
    const sandbox = {
      console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
      navigator: { clipboard: null }, document: makeDocument(),
      CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
      fetch: async () => { throw new Error('no network'); },
      __ModuleLoader__: { load(spec) { if (spec && spec.id === 'dsh-cx-learn') factory = spec.factory; } },
    };
    sandbox.window = sandbox;
    sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__;
    vm.runInNewContext(SRC, sandbox, { filename: 'client.js' });
    if (typeof factory !== 'function') throw new Error('client.js 未注册 factory');
    const mod = factory((id) => { if (id === 'react') return React; throw new Error('unexpected require ' + id); });
    const slots = { inject(name, setup) { if (name === 'settings.section') setup(); }, register(meta, comp) { registered.push({ meta, component: comp }); } };
    mod.apply({ effect(fn) { return fn(); }, get(n) { return n === 'slots' ? slots : undefined; }, slots }, {});
    const entry = registered.find((r) => r.meta && r.meta.name === 'settings.section');
    if (!entry) throw new Error('未注册 settings.section');
    const el = entry.component();
    return el.type();
  }
  function walk(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
    fn(node);
    (node.children || []).forEach((c) => walk(c, fn));
  }
  function findEl(tree, pred) { let hit = null; walk(tree, (n) => { if (!hit && n.props && pred(n.props)) hit = n; }); return hit; }

  /* useState 索引 30 = videoRate */
  for (const rate of [1, 1.5, 1.75, 2]) {
    const tree = loadPanel({ 30: rate });
    const sel = findEl(tree, (p) => p['data-cx-video-rate'] !== undefined);
    ok(!!sel, '  渲染出倍速下拉（rate=' + rate + '）');
    ok(sel && String(sel.props.value) === String(rate),
      '★ ★ 下拉当前值 = ' + rate + '（实际 ' + (sel && sel.props.value) + '）');
    const optVals = [];
    walk(sel, (n) => { if (n.type === 'option' && n.props && n.props.value !== undefined) optVals.push(String(n.props.value)); });
    ok(optVals.join(',') === '1,1.25,1.5,1.75,2', '★ 选项集合稳定（实际 ' + optVals.join(',') + '）');
  }
}

console.log('');
if (fails.length) { console.log('== 失败 ' + fails.length + ' 项 =='); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
console.log('== 全部通过（' + pass + ' 项）==');
