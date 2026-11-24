# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.3] — 2026-11-24

### 修复（由新增的「教训静态检查」扫出来的 18 处潜伏缺陷）

复盘时把 `docs/LESSONS.md` 的教训落成 `scripts/lessons-check.cjs`，
**它第一次运行就抓到我自己探针里的 18 处转义缺陷** —— 全是「单反斜杠写在模板字面量里被吃掉」
导致正则语义丢失，肉眼与既有测试都没发现（4 个测试文件全绿）。

| 探针字符串里实际是 | 应为 | 后果 |
|---|---|---|
| `/(^|s)btnSave(s|$)/` | `/(^|\s)btnSave(\s|$)/` | 「保存按钮」按 class 判定失效（退化成匹配字母 s） |
| `/trues*ors*false|判断/i` | `/true\s*or\s*false|判断/i` | **判断题识别失效** → 判断题被当单选题处理 |
| `/^[A-H][、.．]s*/` | `/^[A-H][、.．]\s*/` | 选项前缀（`A、`）剥离不干净 |
| `/剩余s*[:：]?s*(d+)s*次/` | `/剩余\s*[:：]?\s*(\d+)\s*次/` | **「剩余 N 次」解析失效** → 随堂题剩余次数读不到 |
| 另有 13 处（`正确答案` 解析、章节标题、tocItem 的 `\d`/`\.` 等） | — | 同类语义丢失 |

- 修法：探针模板字面量内的正则转义**全部双写**（18 处），探针 `version` 12 → **14**。
- 全量 44 个测试文件仍 0 失败（说明这些缺陷是**测试覆盖不到**的路径，不是测试写错）。

### 新增（把教训变成能失败的检查）

`scripts/lessons-check.cjs`（4 组 / 10 项断言）：

| 检查 | 抓什么 |
|---|---|
| **L1** 探针源码内禁止孤立单反斜杠 | 上面的 18 处；必须**扫文件源码**而非字符串值（`\\s` 在字符串里就是 `\s`，无法区分） |
| **L2** 探针内容哈希锁（`engine/probe-version.lock.json`） | 改了探针行为却忘 bump `version` → 页面沿用旧探针、修复**静默不生效** |
| **L3** 变异条目自检 | `file`/`test` 不存在、`old` 锚点出现 0 次或 >1 次（>1 会打到错误位置，我因此浪费过数轮） |
| **L4** D 编号唯一 | 决策文档编号重复 |

已接入 `scripts/pre-push-check.cjs` 与 `.github/workflows/ci.yml`。

### 说明

- 全量 **44 个 `*.test.cjs` 全绿**，`--self-test` 通过，`lessons-check` 10/10。
- 配套文档：`docs/LESSONS.md`（97 提交 / 66 条决策的数据复盘：`fix : feat ≈ 2.1 : 1`、
  7 次「补批提交」、修复来源几乎全在真机与破坏测试）。

## [0.3.2] — 2026-11-24

### 新增（复测报告建议的两项遗留）

- **D-070 ① `targetKinds` 可配置**（复测建议 (4)）
  - `safety.targetKinds`，**默认 `['video','audio']` —— 刻意保持历史行为**（既有的
    `sectionVideosDone` 就是只认 video/audio）。接答题后可改成 `['video','quiz']`，
    连播/切节判据会自动跟随。
  - `judge.js` 新增 `DEFAULT_TARGET_KINDS` / `normalizeKinds()` / `isTargetKind()` /
    `areTargetTasksDone()`（复测者建议的统一出口）。
  - 非法值（`[]` / `null` / `''` / 非数组）一律回落默认；含垃圾项**不崩**，
    且绝不会因此误判「已完成」（`total===0` → `ok:false`）。
- **D-070 ② 本节卡片采集表落盘**（复测建议 (2) 后半段）
  - `state-bus.reportSection(entry)`：按 `chapterId` **upsert** 进 `learn.json` 的
    `sections[]`，最多保留 50 节，带 `collectedAt`。
  - `machine._persistSectionState()`：每记录一张卡就落一次，
    内容 `{chapterId, title, kind, total, cards:[{cardid,num,title,collected,media,finished,failed}]}`。
  - **跨运行只作提示**：切节判据仍以平台任务点为准（平台可能把进度退回）。
    已加测试钉死「历史 sections 不参与判定」。

### 修复（写测试时暴露）

- `_recordCurrentCard` 直接 `this._cardScan.get()` —— 若该方法先于
  `_ensureCardsScanned` 被调用（测试/未来重构），会 `TypeError` 并被兜底 `catch` **静默吞掉**，
  表现为「什么都没发生」，极难排查。已加防御性初始化。

### 新增测试

- `engine/d070-targetkinds-state.test.cjs`（33 项）：
  A1 默认行为不变 / A2 显式 `[video]` 忽略 audio / A3 `[video,quiz]` 预留 /
  A4 非法值回落且不误判 / A5 stale 不给结论 /
  B1 upsert 跨节共存 / B2 无 chapterId 不写不崩 / B3 50 节上限 /
  B4 落盘不影响判定 / B5 machine→state-bus 端到端串联。
- 变异测试扩到 **25 条**（M22–M25 专打本次），**25/25 全部被捕获**。

### 说明

- 全量 **44 个 `*.test.cjs` 全绿**，`--self-test` 通过。
- 复测者提的三个问题，本次全部落地：
  ① 采集超时 15s（v0.3.1 已有）② `targetKinds` 配置化（本版）③ `maxSections` 语义保持
  「真正播完的节数」（v0.3.1 的 `greenEarly` 修复后自然生效）。

## [0.3.1] — 2026-11-24

### 修复（复测报告 v0.2.8：多卡节漏刷 / 并集闸门 fail-open）

复测者连续跑 3h51m（1.1 → 1.7.1）后反馈：多卡切卡只在首节生效，1.3 多卡节
**pending 从 7 到 7、25 分钟一次没减**，后卡 6 个任务点一个没播。根因是三处 fail-open。

- **D-069 ① 并集闸门 fail-open（漏刷的核心）**
  - `_cardsUnionDone` 原先只遍历「扫到过的卡」——没扫到的卡根本不在表里，
    因此这个「并集」实际是「已扫卡的并集」，**天然返回不了 false**；
    且不校验 chapterId，1.3 拿上一节的 7/7 判定 true 直接放行。
  - 修：改为 **三态 + 绑 chapterId + 未采集即 fail-closed**：
    `multi` 时每张卡都必须「已采集且目标任务点全完成」；`pending`/`timeout` 一律返回 `false`
    （不是 `null` —— `null` 会被上层当成「无法判定 → 按旧逻辑切节」）。
- **D-069 ② 卡片采集改成显式三态，超时停机而不是静默降级**
  - 进节时一次性采集：`multi`（>1 张）/ `single`（1 张）/ `none`（无卡片条或探针缺失）。
  - 「读到成功但列表为空」判 `none`（确认无），只有**读取失败**才继续等 ——
    否则「已看完的小节」会被拖到超时停机。
  - 超过 `safety.cardDetectTimeoutMs`（默认 **15s**）→ **停机报错 `card_detect_timeout`**，
    附 li 数 / frame 数。刻意不降级成「当单卡继续」，那正是本次漏刷的形态。
- **D-069 ③ 切卡不再重复点击同一张卡**
  - 复测日志里同一张卡 952ms 内被切了两次（页面白重载一遍，起播多花 7.4 秒）。
  - 修：点完立刻进 `_cardAwait`，**等采集完成期间绝不重复点击**；同一张卡仍限 3 次上限。
- **D-069 ④ 平台提前标绿不再直接切节**（复测第 (5) 条）
  - 超星大约在 **86%** 就把任务点标绿。原实现 `doneNow.ok` 直接 `sectionsSkipped+1` 并切节，
    于是「连播 → 记账确认 → 并集闸门 → 计数」整段被跳过：每个视频后 10~14% 从未播放、
    `sectionsCompleted` 恒为 0（于是 `maxSections` 彻底失效）。
  - 修：用 `greenEarly` 区分「本次起播后被动标绿」（→ 继续播到判定线）与
    「进来时本来就绿」（→ 该跳就跳，不额外耗时）。

### 新增测试

- `engine/d069-union-gate.test.cjs`（22 项）：F1 清账 / F1b 单卡不介入 / F1c 确认无
  / F1d 限次 / F2 并集 fail-closed（含 pending、timeout、换节、未采集） / F3 不重复点击
  / F4 提前标绿不切节。
- 变异测试扩到 **21 条**（新增 M18–M21 专打 D-069），**21/21 全部被捕获**。
  其中 M14 首轮「漏测」查实是**变异脚本配置错**（test 目标指错文件），已修。

### 说明

- 全量 **43 个 `*.test.cjs` 全绿**，`--self-test` 通过。
- 新配置项 `safety.cardDetectTimeoutMs`（默认 15000）。

## [0.3.0] — 2026-11-23

> **工程基线版（独立版本线）**：`main` 继续修 bug（0.2.x），本线专做工程化改造。
> 起点对标四个参考库：ocsjs（发版流水线）、chaoxing/Samueli924（provider 插件化）、
> cxmooc-tools（单点维护的宿命）、SuperAutoStudy（架构表演的反面）。

### 修复

- **CI 从不跑测试（最严重）**：`.github/workflows/ci.yml` 原先只做 `node --check` + JSON 校验
  + `--self-test` + 密钥扫描，**38 个 `*.test.cjs` 一次都没在 CI 跑过**。等于测试只是本地习惯。
  已把「全量测试」与「版本一致性守卫」加入 CI。

### 新增

- `scripts/run-all-tests.cjs`：全量测试统一入口（CI / pre-push / 本地共用同一命令）。
  - 用**退出码**判定（不解析输出文本 —— 文本判定曾被「计失败」这类标签误伤）；
  - 子进程 `stdio:'inherit'`（管道捕获在 Windows 受限环境下会 EPERM）；
  - 失败也跑完全部再汇总。
- `scripts/pre-push-check.cjs`：push 前门禁 —— 全量测试 + `--self-test` + 版本一致性，
  任一失败拒绝 push（逃生口 `git push --no-verify`）。对标 ocsjs 的 `.husky/pre-push`。
- `scripts/install-hooks.cjs`：把门禁装进 `.git/hooks/pre-push`。
  **不引入 husky**——本项目「零 npm 依赖」是卖点，引 husky 会要求 contributors `npm install`。

- **题库/AI「传输通道」provider 注册表化（D-065）**：`machine.js::_aiTransport` 原来是写死的两个
  if 分支（宿主回调 / 直连 OpenAI 兼容），加供应商要改函数本体。现抽成
  `engine/src/core/ai-providers.js`：
  - `AnswerProvider` 基类（`available()` / `ask()` 必实现，`setFeedback()`/`close()` 可选空实现
    —— 比纯抽象类更好扩展，照 chaoxing 的 `Tiku` 设计）；
  - `PROVIDER_REGISTRY` 内置 `host`（宿主回调）/`direct`（直连），
    `registerProvider(name, factory)` 可加新题库/新模型通道，**核心一行不动**；
  - `createTransport()` 按 `cfg.ai.providers` → `cfg.ai.channel`（`session`=host 优先 /
    `direct`=直连优先）决定顺序，**按序回退**：某通道抛错或返回空文本 → 自动试下一个；
    全部失败才抛 `ALL_PROVIDERS_FAILED`（错误里带每个通道原因），无可用通道抛
    `NO_AVAILABLE_PROVIDER`（**绝不静默假装答了题**）；
  - 契约不变：`ai.js` 的 `decide/decideBatch` 完全不动，`(prompt,image) → {ok,text,model,by}`。
- 新增 `engine/ai-providers.test.cjs`（22 项）：注册表/顺序/available 过滤/回退链/全失败/无通道
  + 破坏场景（供应商构造抛错不影响其它、非字符串返回、`available=false` 不进链、图片 data URL 透传）。
- **真鼠标点不动时，用「页内 JS play()」兜底 + 可配倍速（D-066）**
  点播放按钮要过坐标/滚动/命中三道关（D-048~D-063 那一串）；而 play() 是方法调用，
  完全不吃坐标。故设计成 **B 档：真鼠标优先 → 失败才 JS 兜底**。
  - 新增探针 `__cx.playByObjectId(oid, rate)`：按 objectid 精确命中该 frame 内的 `<video>`，
    静音 →（rate≠1 时）设 `playbackRate` → `play()`；`play()` 的同步抛与 rejected Promise
    **都不向上放大**，真正是否起播仍由 `_verifyVideoStarted`（currentTime 前进）判定。
  - `playSectionVideo`：点击失败 → `_playByObjectId` 兜底；兜底成功也只算「调用成功」，
    仍要过验证；兜底也失败则 reason 标明 `+js-fallback-failed(...)`。
    **不回退去点别的播放器**（只针对同一个 objectid）。
  - 性质说明：这是属性/方法调用，与本仓库长期使用的 `muteIfPossible()`（`v.muted = true`）同性质，
    **不是合成点击**，也不伪造任何进度上报。
  - 倍速 `video.playbackRate`：**默认 1（不改页面）**；仅 ≠1 时写入，校验区间 0.25–4。
    高倍速有被平台判异常的风险，由使用者自行按需开启。
  - 前提：浏览器启动参数已含 `--autoplay-policy=no-user-gesture-required`（`args.js` 已在用），
    否则无手势的 `play()` 会被拒。
- 新增 `engine/playback-fallback.test.cjs`（29 项）：探针层（命中/无匹配/无 video/rate=1 不写/
  rate=1.5 写入/play 同步抛/rejected Promise 不冒泡/非法倍速被吞）+ 机器层（点击成功不走兜底/
  兜底成功需过验证/兜底失败带原因/调用成功≠真播/rate 传递/兜底返回非对象不崩）。
- **破坏测试（第二批）查出两处真洞并修复（D-067）**
  - **未加载视频时兜底失效**：`playByObjectId` 按 `currentSrc` 里的 32-hex 匹配 oid，
    但未加载的视频 `currentSrc` 是空串（`preload=none`）→ 必然 `no-such-video`，
    兜底在「最需要它的场景」反而不生效。修为：匹配失败且**该 frame 只有 1 个 `<video>`** 时认它。
    安全边界保留：多播放器且都匹配不上 → 仍明确失败（带 `videoCount`），**宁可不播也不误播**。
  - **卡片扫描未完成就放行切节**：`_cardsUnionDone` 只看已记录的卡；2 张卡只扫 1 张且已全绿时
    返回 true → 跳过未扫卡片直接切节。修为：记录 `_cardScanTotal`，扫描未完成返回 **false**
    （不是 null，否则被当作「无法判定→按旧逻辑切节」）；连续 >8 拍扫不到则记 failed 有界放弃，防卡死。
  - 新增 `engine/playback-chaos2.test.cjs`（11 项）；变异测试扩到 **14 条**（M13/M14），
    14/14 全部被捕获；探针 version 10 → 11。
- **破坏测试（第三批）再查三处问题并修复（D-068）**
  - **切节不清卡片账**：`_ensureCardsScanned` 里「无卡片条就 return」早于 secKey 判断，
    导致新节沿用上一节的 `_cardScan`；上节若有未完成卡，新节会被 `_cardsUnionDone=false`
    **永久卡住**。修为：secKey 判断前移，切节即清账。
  - **倍速路径偷调 play()**：`_applyPlaybackRate` 复用 `playByObjectId`（会再 play 一次），
    且多视频帧 oid 匹配不上时**静默丢倍速**。修为：探针拆出 `setRate()`（只设 `playbackRate`，
    不 play），失败打 warn 并带 reason/videoCount。
  - **同一张卡被连点**：卡片扫不到任务点时「每拍再点一次」，实测被连点 8 次（风控风险）。
    修为：按 cardid 限次，>3 次记 failed 并继续（实测降到 3 次）。
  - 新增 `engine/playback-chaos3.test.cjs`（19 项）；变异测试扩到 **17 条**，17/17 捕获
    （M17 首次漏测 → 补「同一张卡最多点 3 次」断言后才抓到）；探针 version 11 → 12。
### 说明

- 本地实测：**38 个测试文件 / 0 失败 / 358s**。
- 本线后续计划（未做）：发版一条命令（`scripts/release.cjs`）、题库/AI provider 注册表化、
  瘦身 `chaoxing-autolearn.v1.js`（413KB）、docs 索引页。详见
  `E:\01_Projects\_refs\_REPORT-dsh-cx-learn-vs-refs.md`。
## [0.2.8] — 2026-11-23

### 新增

- **一节多「知识卡片」支持（D-064，`knowledge/cards?...&num=0/1/…`）**
  复测者实测：一节可能有 1–4 张「知识卡片」（视频区/教学课件/教案/其他），
  原先只读当前挂载那张，导致「当前卡播完就切节」，其余卡的视频从未播放。
  - **探针**：新增 `cardsInfo()` 与 `resolve('cardsTab')`。切换条是外层 `studentstudy`
    文档里的 `ul.prev_ul > li[cardid][onclick=changeDisplayContent(seq,total,…)]`；
    它和「章内子任务」（1视频/2章节测验）**同名 ul.prev_ul 但不同实例**，
    所以只认「`onclick` 含 `changeDisplayContent` 且带 `cardid`」的 li，避免误点章节测验。
  - **引擎**：`_ensureCardsScanned` 逐卡激活（真鼠标点外层 li）→ 轮询「cards frame 里
    `.ans-attach-ct > 0`」（实测 155ms 换 frame、883ms 任务点可读；上限 5s，不用固定 sleep）。
    单卡节（`total<=1`，实测 6 节里 4 节）**优雅退化、不切卡**；播放中途不切卡；
    切卡失败只试一次并记 `failed`（不循环重试）。
  - **并集判定**：`_cardsUnionDone` —— 本节**所有卡片**的 media 任务点全部 finished 才允许切节；
    两处切节闸门（「视频任务已完成→切节」与 playedEnough 末尾）都加了拦截，
    还有卡未完成时按「等平台记账」处理（`WAIT_VIDEO_CONFIRM`，run.js 已豁免不会误判无进展）。
  - 已知：切卡后 **cards frame id 不变**，只有其**子 frame** 全死；本实现不缓存子 frameId，
    `gatherState` 每拍重新枚举 frame 树，天然规避。

### 修复（开发中自暴露）

- `PAGE_PROBE_SRC` 是模板字面量，其中**正则可写单反斜杠会被吃掉**（`\d`→`d`）导致探针语法错误。
  新代码统一双写（`\\d` / `\\s`）。`node --check` 查不出这类问题，只有真跑测试才会暴露。

### 新增测试

- `engine/cards-switch.test.cjs`（27 项）：选择器鉴别（不误点章节测验）/ 定位与越界 /
  单卡退化 / 双卡切到未扫卡 / 播放中不切 / 切卡失败只试一次不循环 / 并集判定 5 种情形。

### 说明

- 全量 **38 个 `*.test.cjs` 全绿**，`--self-test` 通过。
- **尚未真机验证**：本地账号无「多卡片（num>0）」章节，需复测者按其实测几何与时机确认。
## [0.2.7] — 2026-11-22

### 修复

- **D-061 补强：滚动落位是异步的，`behavior:'instant'` + 引擎侧 450ms 重查（D-063）**
  - 0.2.6 的 `scrollChainIntoView` 在 `scrollBy` 之后**立刻** `rectOf` 复测。若页面带
    `scroll-behavior:smooth`，滚动是**动画**，两次 pass 都在落位前量 → 仍会恒定
    `still-outside-viewport`。**这正是 D-048 记过的同一类病**（滚动异步，滚完不能立刻量），
    0.2.6 复发了。
  - 修①：页面侧改为 `topWin.scrollBy({left, top, behavior:'instant'})`（老内核回退数字形式）。
  - 修②：引擎侧 `clickFound` 在拿到 `hit-test-blocked` / `still-outside-viewport` 后
    **等 450ms 重查一次**再判失败/降级（只重查一次，不循环）——把 D-048 的「等一拍」放到
    真正能 `await` 的层。

### 新增

- `engine/scroll-chaos.test.cjs`（20 项**破坏性**测试）：smooth 动画未完成 / 顶层 scrollBy 抛错 /
  跨域取不到坐标 / 视口 0×0 / 容器滚不动 / 已居中 / 异步落位重查 / 持续出界有界失败。
  其中 smooth 场景若不用 `instant` 必红——这条当场抓出了 0.2.6 的缺陷。

### 说明

- 全量 **37 个 `*.test.cjs` 全绿**，`--self-test` 通过。
- 破坏测试同时抓到一处回归：改为对象形式 `scrollBy` 后旧 `probe-contract §4` 的 fake 只接数字参数，
  已同步修正（这正是破坏测试的价值）。
- **仍需复测者在真实环境确认**（本地账号无「长 iframe + 可滚动 PDF 前置」章节）。
## [0.2.6] — 2026-11-22

### 修复

- **「still-outside-viewport 恒失败」（D-061，复测反馈）**：当一节的靠前任务点是可滚动 PDF 阅读器时，
  后面的视频被压在下方；`knowledge/cards` iframe 高 3302 > 浏览器视口 802，它自身不滚、
  只能被外层 `studentstudy` 滚。旧实现只在元素自己那层文档 `scrollIntoView`（滚不动父级），
  且「把整个 iframe 元素滚进视口」也不保证 iframe **内部**目标可见 → 恒定出界 → 3 次失败后
  `UNRECOGNIZED_PAGE`。
  修：`scrollChainIntoView` 增加「用绝对坐标直接滚最外层文档」——`rectOf` 已累加整条 frameElement 链
  （含各层实时滚动），据此 `window.top.scrollBy` 把目标中心对到视口中心，迭代 2 次。
  不用滚轮/拖拽（指针落在可滚动子容器上会被吃掉）。探针 version 8→9。
- **失败日志吞掉 reason（D-062）**：`恢复播放失败（未找到播放控件）` 原来只打 `{layer: r.layer||0}`，
  失败分支没有 layer 字段恒输出 0，真正的 reason 被吞，外部无法定位。现在打印 `reason/note/rect`；
  同时 `clickFound` 对 `videoToggle` 失败会回传 `note`/`rect`。

### 新增

- `probe-contract.test.cjs` §4：滚动数学单测——模拟「iframe 高 3302 > 视口 802」，
  断言 `scrollBy` 位移≈1030、目标中心落到视口中心 401。

### 说明

- 全量 36 个 `*.test.cjs` 全绿。
- **尚未真机验证**：本次修复依据复测者的实测数据与原理解析，需对方在真实环境复测确认。
## [0.2.5] — 2026-11-21

### 修复

- **视频身份层根因（真探针契约测试暴露）**：
  - `videoState()` 从不返回 `objectid` → `_videoMatchesPending()` 永远匹配失败 →
    多视频节 `st.video` 恒选 progress 最大的（即已播完的 video1），走不到「点第 2 个」。
    修：`videoState()` 从 `currentSrc/src` 抽 32-hex 补 `objectid`。
  - `gatherState()` 从不赋值 `st.videos` → `_verifyVideoStarted` 兜底与 `_dumpStuckVideos`
    诊断读到的都是 `undefined`/`[]`。修：补 `st.videos = allVideos`。
- **起播验证核对 objectid（堵「播错视频静默通过」）**：`_verifyVideoStarted` 旧逻辑只要
  「该帧里有视频在动」就判成功，点了相邻/错的 iframe 也会通过。修：读该帧视频 objectid，
  与目标不符判 `wrong-video` 失败（空 src 的仍放行）。
- **内核崩溃恢复路径 ReferenceError**：`onUnexpectedClose` 里写成裸调用
  `.then(() => _onCdpLost(kind))`，而它是 adapter 方法 → 触发即
  `ReferenceError: _onCdpLost is not defined`，崩溃恢复完全失效。修：`this._onCdpLost(kind)`。

### 新增

- `engine/probe-contract.test.cjs`：在 vm 沙箱里执行**真实的** `PAGE_PROBE_SRC`/`videoState()`、
  走**真实的** `gatherState()`，断言真探针字段契约（objectid / st.videos / st.video 归属），
  并锁 `_verifyVideoStarted` 的 objectid 校验。
- `engine/cdp-recovery.test.cjs`：锁崩溃恢复路径不再裸调用 `_onCdpLost`。
- `scripts/release-guard.cjs` + `release-guard.test.cjs`：发布前校验
  `package.json.version == CHANGELOG 顶部`，堵元数据静默漂移（曾出现 0.2.0/v0.2.3/0.2.4 三处不一致）。
- `publish-public.cjs` 发布前先跑版本一致性守卫。

### 说明

- 全量 36 个 `*.test.cjs` 全绿，`--self-test` 通过。
- 真机已验证（2.2）：两个视频均真实起播；本版进一步修正「谁才是当前视频」的身份判定。

## [0.2.4] — 2026-11-21

### 修复

- **多视频节第 2 个视频「点了不起播」的真因（D-055，真机端到端复跑发现）**：
  D-054 的反查补齐已能定位第 2 个视频的子 iframe，但真机仍 `video_task_unreachable`。三层原因：
  - **跨帧滚动**：第 2 个视频在 `cards → video` 双层 iframe 且位于视口下方，`el.scrollIntoView()`
    只滚自己那层、滚不动父 frame → 命中测试失败。新增 `scrollChainIntoView`：沿 frame 链
    把每层 iframe 在父 frame 里滚进可视区后再取坐标。
  - **点错元素**：按 objectid 命中的是 `<video>`，但未起播时最上层是 `.vjs-big-play-button`
    → 改用 video 做命中测试必失败。改为：目标未起播且本播放器有可见大播放按钮时，点那个按钮。
  - **偷偷降级**：`clickFound` 在 `hit-test-blocked` 时降级 `el.click()`（违反红线且对 `<video>`
    无效）→ 现在对 `videoToggle` 一律不降级，点不中即失败透出。
  - 探针 `version` 7 → 8（强制页面重装新探针）。
  - 真机 A/B 验证：修复前 `paused=true t=0` 失败；修复后真鼠标点 → `dur=2764, rs=4, paused=false` 起播。
    附带：第 2 个视频真实时长 2764s（≈46 分钟）。

- **课程入口点击彻底打通（D-045~D-052，真机实测驱动，共 8 次提交）**：
  入口从「点卡片没反应 / 反复失败」修到「第 2 次点中」，最终定位到确定性根因：
  - **D-045 布局漂移**：图片卡片懒加载导致 `boundingRect` 在加载中漂移。改为点前等布局稳定
    （连续两次坐标一致）+ 点后最多 3 次真实鼠标重试。
  - **D-046 点错 `<a>`**：同一 courseid 有多个 `<a>`（侧栏缩略图 x=180 vs 主卡片 x=740），
    旧实现只取第一个。改为收集全部候选 + `elementFromPoint` 命中测试 + 优先面积大的。
  - **D-047 懒加载不可点**：元素在 DOM ≠ 可点（骨架屏）。改为定位前轮询等「至少一个候选可点」，最多 25s。
  - **D-048 滚动异步**：`scrollIntoView` 后立刻取 rect 拿到视口外坐标（y=1171 vs 视口 803）。
    改为滚动后等 450ms + 校验 `inViewport`。
  - **D-049 target 未激活 / 同标签跳转未识别**：新增 `bringToFront()`；同标签跳转必须比较
    点击前后 URL 差异（只看「像不像课程页」会误判，`regression-chaos` 抓到）。
  - **D-050 attach 后 target hidden**：`visibilityState=hidden` 会丢合成鼠标事件 →
    `Page.bringToFront` + `Emulation.setFocusEmulationEnabled` + 可见性日志。
  - **D-051 页面内点击探针 `__cxClickProbe`（长期保留）**：记录 mousedown/up/click 次数、
    实际 `clientX/Y`、命中元素、是否在 `<a>` 内、`visualViewport`/scroll/zoom。
    第一次把问题从「点了没反应」定位到「坐标错位」。配套自适应校正（D-052 后降为兜底）。
  - **D-052 真根因：双重取中心**：`locateCourseLink` 返回中心点，`cdp.js` 的 `click()` 内部
    又加一次 `w/2,h/2` → 中心被加两次，实际点 = 元素**右下角**（偏移恒为 `(w/2,h/2)`，
    与机器/分辨率无关）。修：`locateCourseLink` 额外返回 `left/top`，点击传左上角。
- **登录成功后反被判 stale（D-053）**：`spawnEngine` 的 exit 处理器对所有进程都墓碑化
  `browser.json`，而登录进程是短命进程、退出即 pid 死 → 每次登录成功都自毁。
  改为只有看课任务（`isWatchRun`）退出才墓碑化，登录/预检/自测一律不动 `browser.json`。
  ⚠️ `index.js` 属后端，需重启 DSH 生效。
- **多视频节第 2 个视频起播失败（D-054）**：真机 dump 证实每个视频在独立
  `ananas/modules/video` 子 iframe 里，`cards` frame 自身 `querySelectorAll('video')=0`，
  常规探针汇总得到空 `videos` → 挑不出候选。修：`_enrichVideosFromFrames` 按 pending 的
  objectid 逐个 video 子 iframe 读 `currentSrc` 抽 32-hex 比对补齐；进度基线与起播验证
  优先在该候选自己的 frame 内进行，读不到再回退全局汇总；验证窗口 4000→6000ms。
- **多视频节第 2 个视频「点了不起播」的真因（D-055）**：D-054 补齐后仍失败，三层原因：
  ① 第 2 个视频在 `cards→video` 双层 iframe 且位于视口下方，`el.scrollIntoView` 只滚自己那层、
  滚不动父 frame → 命中失败（新增 `scrollChainIntoView` 沿 frame 链滚进视口）；
  ② 按 objectid 命中 `<video>` 但未起播时最上层是 `.vjs-big-play-button` → 改点该按钮；
  ③ `clickFound` 在命中失败时降级 `el.click()`（违反红线且对 video 无效）→ videoToggle 不再降级。
  探针 version 7→8。真机 A/B：修复后真鼠标点 → `dur=2764 rs=4 paused=false` 起播。
- **多视频节「已起播、等平台记账」被误判为「无进展」而停机（D-056）**：第 2 个视频真起播后、
  服务端未记账时返回 `WAIT_VIDEO_CONFIRM`（progress:false），但 `run.js` 无进展判停只豁免
  `WAIT_LOAD`/`TASKPOINT_WAIT` → 9 轮后误报 `UNRECOGNIZED_PAGE`。修：当作有意等待（重置计数）+
  专用上限 `safety.maxVideoConfirmTicks`（默认 1200），超限以 `video_confirm_timeout` 停。
  真机：修复后 `running=True` 持续等待、不再误停。

### 新增

- `engine/multi-video-iframe.test.cjs`（28 项）：用真机 frame 结构复刻，锁定 D-054 反查补齐；
  §6/§7 锁 D-055（videoToggle 命中失败不调 jsClick、scrollChainIntoView、big-button 目标）；
  §8 锁 D-056（WAIT_VIDEO_CONFIRM 豁免 + maxVideoConfirmTicks）。
- `engine/regression-chaos.test.cjs`（35 项）：覆盖 D-039 三本账清零、`_verifyVideoStarted`
  传不存在 objectid、`_pickUnplayedVideo` 退化输入、`/json` 返回空、enc 分级源码断言等边角。

### 说明

- 全量 33 个 `*.test.cjs` 全绿，`--self-test` 通过。
- **待真机端到端**：D-054 的第 2 个视频真的起播（需等 834s 的第 1 个播完，~14 min）。
- **已知未修**：`/stop` 之后会话变 stale（D-053 只覆盖「登录进程退出」这条路径）。

## [0.2.3] — 2026-11-18

### 修复

- **一节多视频：第 2 个视频起不来导致 108 次空转**（D-039，Issue #1 复测反馈）：
  - 动作带目标：`videoToggle` 支持按 `objectid` 精确点播（以前固定点第一个 `<video>`）
  - 起播验证：点完轮询 4s，`paused===false` 或 `currentTime` 前进 >0.5s 才算成功
    （以前点完就 `return ok`，失败不可见）
  - 账本改按 `objectid`（以前按 `src`，MSE 空 src 时全塌缩成一个键）
  - 「尝试」与「成功」解耦：点击**之前**写 attempted；单候选试满 3 次即排除
  - 候选耗尽分两种收口：确实起播失败 → 停机 + 诊断快照；只是等平台记账 → 继续等
- **「答题」圆点假绿灯**（D-040）：以前只看 `ai.enabled`。`chapterQuiz=skip` 时引擎根本不碰
  章节测验、AI 一次都不会被调用，灯却还是绿的。改为 **AI 启用且章节测验策略不是 `skip`**
  才绿，否则灰（与 D-029「选课」假绿同类）。
- **课程入口三处真机 bug**（D-041/D-042/D-043/D-044，实测化工热力学）：
  - **D-041 进了残留旧页**：选页正则含 `mycourse/studentstudy`，且点击后无新页时
    fallback 到 `coursePages[last]` → 实测池里残留两个旧 `studentstudy`
    （`643076150`/`643076170`）被当成「进入成功」，进旧页 → 无有效 enc →「温馨提示」
    → 1 frame / `tocFound=false` → `UNRECOGNIZED_PAGE`。
    改为**只认 `mooc2-ans/mycourse/stu` 且必须是点击后新出现的**，否则明确失败 + `pagesSeen`。
  - **D-042 删掉 `element.click()` 兜底**：鼠标点不中时旧代码偷偷派发 JS `hit.click()`，走
    `<a target="_blank">` 默认链路，落地页与真实鼠标点击不同（假成功）。现在点不中即失败返回，
    并写下点击点 + 命中元素 + `scrollY` 快照。
  - **D-043 enc 分级处理**：带有效 `enc` 的 `studentstudy` 是可用的直接入口（几分钟后会失效成
    「enc校验失败」）。改为带 enc 先按直接入口用（不强剥、不 drilldown），仅失效才退回入口页链路。
    （最初写成一刀切「一律剥离」，导致 self-test 入口误判，已改回分级。）
  - **D-044 清理旧标签污染**：开跑前关闭本插件遗留的 `studentstudy` 标签，避免越跑越多并干扰选页。

### 新增

- 破坏性测试 `engine/entry-chaos.test.cjs`（11 项，起真 http server 模拟 `/json/list`）：
  只有残留旧页 → 必须失败不许附着；出现新课程页 → 成功且附着新页；命中被遮罩 →
  不 `element.click` 兜底直接失败；只出现老域新页 → 不认；完全没有课程页 → 失败。
- 破坏性测试 `engine/multi-video-chaos.test.cjs`（17 项）：专砸「起播失败」的各种形态，
  事故原样复现（点击成功但永不起播）现在 **3 拍收口**且每个候选只点一次，
  收口时落 `diagnostics/video_unstartable` 快照。

---

## [0.2.2] — 2026-11-18

> 承接 v0.2.1 之后的一轮真机排障：AI 会话通道（v2）在 DSH 0.2.2-rc.3 上连炸三处，
> 并确定「记分的题绝不猜」这条硬规则。

### 修复

- **AI 会话通道三处崩溃/失败**（D-034/035/036，实测本机 DSH 0.2.2-rc.3）：
  - `sc.state()` 探活会把 DSH host 打崩（异常以 unhandled rejection 逃逸 →
    `fatal load failure` → 桌面端重启）→ 改「TTL 30 分钟盲复用 + 出错重建」；
  - `prompt/wait` 未传 `AbortSignal`（该版本 API 签名是 `(request, signal)`，
    首行 `signal.throwIfAborted()`）→ 503 `LLM_ERROR` → 改传 `AbortController.signal`，
    abort 归一成 `LLM_TIMEOUT`；
  - `create()` 未校验 `sessionId`（会把 `undefined` 缓存下来）；并发两路会**开出两个会话窗口**
    → 补校验 + in-flight promise 去重。
- **记分的题不再盲猜**（D-037/D-038，主人指令）：章节测验/作业在三种情况下
  （没开 AI / AI 挂了 / 超时或空回复）**一个选项都不点**，留空给人工；
  只要有一题没答成，`submit` 档也**不交卷**（空着交卷同样扣分）。
  以前会「回退首选项」盲点第一个 —— 记分题上等于直接扣分。
  唯一例外：视频随堂题（不记分、不答会卡住播放）仍按 A→B→C 盲试。

### 新增

- `POST /api/cx-learn/ai-selftest`（D-033）：本机验证「AI 会话窗口通道」是否真的能创建会话并拿到回复。
  仅回环地址调用，且需 `ai.enabled=true`；返回 `steps[]` 逐步耗时便于排障。
- 破坏性测试：`scripts/ai-session-chaos.test.cjs`（15 项，把 sessionController 当不可信第三方砸）、
  `engine/ai-transport.test.cjs`（13 项，起真 HTTP server 验 503/非 JSON/连接拒绝等降级）、
  `engine/quiz-no-guess.test.cjs`（14 项，验「AI 不可用时零点击」）。

---

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








