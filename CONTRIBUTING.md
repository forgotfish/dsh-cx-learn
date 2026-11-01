# 贡献指南

感谢参与。项目不大，但有几条约定能让它保持可用。

## 开发环境

- Node.js >= 22
- 一个 Chrome / Chromium / Edge（本地跑真机测试用）
- 不需要安装任何 npm 依赖（引擎只用 Node 内置模块）

```bash
git clone https://github.com/forgotfish/dsh-cx-learn.git
cd cx-learn
node engine/chaoxing-autolearn.js --self-test
```

## 代码结构

```
index.js                宿主半端：进程管理、HTTP 接口、配置、会话生命周期
client.js               设置页 UI（React）
engine/chaoxing-autolearn.js   引擎入口：CLI 分发
engine/src/**           引擎实现（core / browser / learn / login）
cordis.patch.yml        bundle 挂载声明
```

## 约定

1. **引擎保持零 npm 依赖。** 只用 Node 内置模块；确实需要新依赖先讨论。
2. **不要硬编码环境路径。** 走环境变量或候选探测。
3. **选择器只能出现在 `engine/src/learn/selectors.js` 的 `SELECTORS` 表里。**
   探针代码从表读；`node scripts/check-selectors.cjs` 会拦住表外选择器。
4. **不要绕过人工验证。** 人脸 / 活体 / 验证码一律立即停止。
5. **不碰后端写接口。** 不调进度写接口、不伪造上报、章节测验只识别不点。
6. **新的可调参数集中到 `CONFIG`**（含所有随机延迟范围）。

## 提交前检查

```bash
node --check index.js
node --check client.js
node engine/chaoxing-autolearn.js --self-test
node scripts/host-smoke.test.cjs
node scripts/ui-render.test.cjs
node scripts/check-selectors.cjs
```

改了引擎判定逻辑，再跑：

```bash
node engine/judge.test.cjs
node engine/section-skip.test.cjs
node engine/guardrails.test.cjs
```

涉及真实页面的改动，尽量补充 `engine/src/learn/selectors.js` 的注释与 fixture 说明，
写清「哪一天、哪一页、实测到什么」。

## 提交信息

用祈使句写清楚做了什么：

```
fix: 切节后校验播放器是否真的换了内容
```

类型前缀：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`。

## 报告 bug

请附上：

- DSH 版本、Node 版本、操作系统
- 浏览器内核版本
- `/api/cx-learn/log` 的相关片段（注意先打码课程 ID / URL）

## 提问

开 issue 即可。涉及页面 DOM 结构的讨论最有价值——那部分最容易随平台改版失效。
