# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] — 2026-11-18

### 新增

- **直播回放任务点**（D-026/D-027）：识别 `modules/live` 任务点，在新标签页驱动超星播放器；
  完成度只认服务端 `percentValue ≥ 90%`（播放器自己 30s 一次的心跳按墙钟累计），
  不看本地 `currentTime`（headless 下 HLS/MSE 不解码，本地进度恒 0）。
  播放器标签页**复用同一个 target**，轮询期间不再来回切 target（D-027 实测：会堆出 8+ 个
  播放器、单渲染进程 793MB、`Runtime.evaluate` 集体超时）。
- **AI 作答 v2**（D-019/D-021）：模型跑在可见的 DSH 会话窗口里（`channel=session`），
  engine 拼批量 JSON → 宿主 `/llm-ask` → `sessionController.create/prompt/wait`；
  `batchSize` 默认 10，每次运行新建会话。**视频随堂题永不使用 AI**（`AI_SCOPE.videoQuiz=false`）。
- **设置页 5 个标签**（D-022）：内核 → 登录 → 选课 → 答题 → 开始，胶囊标签带状态圆点。
- **章节测验四档**（D-020）：`skip` / `none` / `save`（默认，只存草稿）/ `submit`。
- **多视频任务点连播**：`pendingSectionVideos()` 给出本节未完成的 video/audio，
  `multiVideo && pending>0` 时禁止切节，改为继续播下一个。
- **破坏性测试工具** `scripts/chaos-api.mjs`（31 项，自动备份/还原状态目录）。

### 变更

- **章节测验语义放开**（D-020）：从「只识别、连标签都不点」改为「可作答，默认只保存草稿、
  绝不交卷」。交卷必须显式把 `chapterQuiz` 设为 `submit`。
- `quizMode=skip` 被 `chapterQuiz` 四档取代；`skipChapterQuiz` 旧字段仅作兼容。
- 设置页「内核」圆点语义修正（D-025）：文件缺失才红，内核在跑才绿，只是没启动为灰
  （以前 `alive:false` 一律报红）。

### 修复

- **「开始」标签在登录阶段就变绿**（D-024 根治）：`spawnEngine` 原来对所有 spawn
  （登录/预检/读课程/自测）都登记 `child`，于是登录被算成「看课任务在跑」。
  改为只有 `isWatchRun(args)` 才登记，并给 `login()` / `start()` / `stop()` 补对等守卫。
- **「选课」圆点在未登录时也绿**（D-029）：原来只看配置里有没有课程 URL。
- `state.json` 内容为 `null` 时 `/status` 直接 500（D-030）：`readJson` 只接受对象。
- **残留 pid 误判「正在运行」**（D-031）：pid 活着不算数，还要求 `browser.json.ownerPid`
  与之一致且心跳在 3 分钟内；否则按未在跑处理并写日志。
- 会话闲置超时结束后谎报「上次扫码流程被中断」（D-032）：改为按 `session.json.reason` 给真实文案。
- 切节后 `knowledge/cards` iframe 未就绪被误判 `UNRECOGNIZED_PAGE`（D-028）：
  `WAIT_LOAD` 中途主动重载当前节；「有意的等待」不再计入无进展。
- 真机首跑三处入口失败（D-027）：页签文案是「目录」不是「章节」；目录可能是旧版内联
  `.posCatalog_select`（无 `mooc2-ans` iframe）；URL 已带 `chapterId` 时跳过点小节。

### 新增（历史未发布项）

- 选择器注册表收口（D-017）：探针里不再有裸选择器，新增 `scripts/check-selectors.cjs` 静态闸门。
- `POST /api/cx-learn/ask`：AI 答题的**占位接口**（D-015）。契约已固定，
  当前固定返回 `200 {ok:false, code:"AI_ANSWER_DISABLED"}`，不调模型、不答题；
  以后实现只改 `index.js` 的 `askReserved()`。

### 变更

- **设置页分两块**（D-016）：「浏览器环境」（状态 / 内核 / 登录会话）与
  「课程业务」（登录 / 课程设置 / 运行控制 / 题目队列 / 日志）。
  `结束会话` 归到浏览器层；`读取我的课程` 与 `保存配置` 合并进课程设置卡。
- **删除 AI 答题链路**（D-014，SPEC §3.2 N2）：去掉模型目录、答题回调、
  模型探活与 `quizModel` 配置；设置页不再有模型下拉、模型测试与「答题方式」。
  题目只识别、只进人工审阅队列，不请求模型、不选选项、不提交。

### 移除

- `GET /api/cx-learn/models`、`POST /api/cx-learn/models/health`、
  `POST /api/cx-learn/ask-test`
- `/status` 响应里的 `quizModels` / `builtinModels` / `quizModelActive` /
  `quizModelLabel` / `zhipuReady` / `llmReady`

### 修复

- 登录成功后会话被误判为内核死亡、profile 被删（`openSession` 用默认值覆盖了已写入的端口）。
- 会话看护在端口未知时直接判死；现在先补 `browser.json`，且内核死亡不再删 profile。
- 看课期间 `/login-state` 恒为 `waiting`；现在只看登录子进程。
- `/stop` 之后 `stopReason` 恒为 null；现在写 `stopped_by_user`，并把引擎 `learn.json` 合并进宿主状态。
- 视频「播放结束但超星未确认」时无限重进；新增 `safety.videoNotConfirmedMax`（默认 3）保护性停止。
- `status()` 在「插件重启后 `child` 为 `null`、但 `state.json` 里的 pid 仍活着」时
  会抛 `TypeError` → 接口 500；现在 pid 字段安全降级为 `null`，接口保持 200。

## [0.2.0] — 2026-10-25

### 新增

- **全局安装**：插件实体可装在共享 `node_modules`，所有用户 profile 共享一份代码，  
  各自的配置 / 日志 / 登录态 / 浏览器 profile 仍然独立。
- **浏览器内核与插件解耦**：内核移到独立共享目录，设置页可选择不同内核  
  （共享内核 / 系统内核 / 自定义路径），换机器只需把内核放进去。
- **答题模型来源打通**：模型下拉同时呈现
  - 用户在 DSH 里已配置的模型（通过 `ctx.llm` 读取，含各服务商插件提供的模型）
  - 插件内置的智谱 GLM 系列
- `/api/cx-learn/ask-test`：用指定模型答一道题，快速验证模型是否可用。
- `/api/cx-learn/models/health`：批量模型探活，列出可用模型与各自报错。
- `/api/cx-learn/models`、`/api/cx-learn/browsers`：独立查询模型与内核清单。

### 变更

- 答题方式从三选（关闭 / AI / 人工）改为**两选**（AI 答题 / 人工答题）。
- 浏览器内核目录改为多候选探测，不再绑定单一部署路径。
- 登录二维码目录改为按用户隔离（`CX_LOGIN_SHOT_DIR`），多用户不再互相覆盖。

### 修复

- 插件位于 `node_modules` 下时，引擎因父目录 `"type": "module"` 无法以 CommonJS  
  加载；改为在 `engine/` 子目录单独声明 `"type": "commonjs"`。

## [0.1.0] — 2026-10-21

### 新增

- 首个可用版本：CDP 驱动的学习通课程推进引擎。
- P0 播放态检测与防挂机弹窗恢复 / P1 自动切节 / P2 弹题作答 /  
  P3 跳过已完成 / P4 章节模式与节数上限。
- 扫码登录（二维码截图，不接触账密）。
- 结构化日志、优雅停止、拟人化延迟。
- 零 npm 依赖的 MCP stdio server（`cx_learn` / `cx_login`）。
- DSH 插件形态：设置页 UI、进程生命周期管理、HTTP 接口。
