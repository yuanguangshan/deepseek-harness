# 两套 TUI 实现对比：dsh-repl（自研） vs dsh-TUI（第三方插件）

> 分析时间：2026-08-16
> 对比对象：
> - 你们自己的 repl TUI：`@deepseek-ai/dsh-repl`（`/Users/ygs/ygs/deepseek-harness/apps/repl`）
> - 第三方 dsh-TUI：`@deepseek-harness-tui/dsh-tui`（`~/.dsh/profiles/dsh-tui`）

## 一、一句话定位

| | 你们自己的 repl | 第三方 dsh-TUI |
|---|---|---|
| 包名/定位 | `@deepseek-ai/dsh-repl`，**独立 TUI 二进制程序** | `@deepseek-harness-tui/dsh-tui`，**Cordis 插件**（挂在 profile bundle） |
| 载体 | 独立 `apps/repl/lib/bin.js` 可执行文件 | 装配进 `dsh-tui` profile，随 `dsh --profile dsh-tui` 启动 |
| 代码规模 | 11 个 .ts，约 3900 行 | `lib/types` 3.7MB / 210 个模块 |

## 二、实现原理对比（核心差异）

### 1. 运行时模型（最大区别）

**你们 repl：外挂子进程架构**
- 通过 `HarnessClient` **spawn 独立 jsonrpc-agent 子进程**（`packages/examples/jsonrpc-demo/lib/bin.js`），用 JSON-RPC over stdio 通信。
- 客户端驱动：UI 进程与 agent 运行时（子进程）分开、独立。
- `core.ts` 用 `DSH_REPL_RUNTIME` / `DSH_REPL_CONFIG` 指向子进程入口和 cordis 配置；未装到 agent 时降级到 monorepo 内建 jsonrpc-demo。

**dsh-TUI：内嵌 Cordis host 插件**
- `plugin.js` 的 `apply(ctx, config)`，装配在同一个 Cordis host 进程内（`dsh-tui` profile，bundle = `dsh-base` + `dsh-tui`）。
- 通过 `Agent.followup` 直接调用运行中的 agent 能力，不另起子进程，与官方 web 用同一套 host 机制。
- 因此强制要求 TTY（`plugin.js` 顶部直接抛 `requires an interactive terminal`）。

> 一句话：repl = 独立程序 + 子进程 agent；dsh-tui = host 进程内的渲染插件 + 同进程 agent。

### 2. 渲染引擎

**你们 repl：命令式 widget（`@earendil-works/pi-tui`）**
- `Container` / `Text` / `Editor` / `ScrollView` / `SelectList` 等命令式对象，`new Text(...)`、`transcript.addChild(...)`、`tui.requestRender()` 手动改界面。
- 靠 addChild/removeChild + requestRender 增量刷新；状态行/宠物动画用 `setInterval` tick。
- 依赖极简：pi-tui + js-yaml 两个运行依赖。

**dsh-TUI：React + reconciler（Ink 风格声明式渲染）**
- 完整 React 组件树（`react-reconciler` + `ink/*` reconcile 模块），`useState`/`useEffect`。
- 有 `components/`（Markdown、StreamingMarkdown、MessageList、PromptInput、ModelPicker、ResumePicker、RewindPicker…）和 `screens/Chat.js`。
- 依赖极多（react、react-reconciler、marked、highlight.js、cli-boxes、chalk、figures…几十个），peer 依赖 `@deepseek-ai/cordis`。

### 3. 会话 / 恢复 / 交互机制

| | repl | dsh-TUI |
|---|---|---|
| 会话恢复 | `--resume [id]`；`--web-sessions` 可切 shared `~/.dsh/sessions` | `/resume` 打开 ResumePicker 会话选择器，`~/.dsh-cc/resume.txt` 持久化 |
| 时间回溯 | 无 | 双击 Esc → RewindPicker 回退/fork 历史 |
| 命令补全 | AtFileProvider 自建 @file + 命令补全 | CommandSuggestions / FileSuggestions，消息任意位置补全 + @file 图片块 |

## 三、功能对表

| 功能 | 你们 repl | dsh-TUI |
|---|---|---|
| 流式 Markdown | 有 | 有（StreamingMarkdown） |
| 工具卡 / 思考展开 | 有（ctrl+o） | 有（ToolUseLoader / ThinkingToggle） |
| 真实终端 (shell) | 无 | 内置（dsh-terminal/bash 系列） |
| /pet 小鲸娘养成 | 有（pet.ts，状态行 🐳） | 仅启动像素鲸鱼，无养成系统 |
| /tts 语音朗读 | 有（tts.ts，Edge TTS） | 无 |
| /memory 长期记忆 | 有（MemoryStore + git branch） | 有（/memory） |
| /goal 目标 | 有 | 有（GoalTodoPanel） |
| 用量/配额 (opencode-go) | 有（dsh-usage） | 无（改 /status、/cost） |
| 模型切换 | /model 文件选择器 | ModelPicker + /preset + 模型路由 |
| /theme、/lang | 无 | 有 |
| /update、/doctor、/permissions、/agents、/mcp、/hooks、/config | 无 | 有（生态端口） |
| 启动动画 | 像素鲸鱼（半块渲染，已移植） | 像素鲸鱼（同源） |
| 依赖/体量 | 轻（~3900 行 TS，2 依赖） | 重（210+ 模块，几十依赖） |

## 四、关键取舍总结

**你们 repl 的优势（轻、内聚、个性化）：**
- 极轻量：2 个运行时依赖，tsc+tsdown 一把梭，好维护。
- 深度嵌入你们的东西：/pet、/tts、/memory、/goal、用量面板都是为你们自己写的，import 直接复用 `@deepseek-ai/dsh-usage`/`dsh-memory`。
- `--web-sessions` 与 dsh web 共享同一会话根。

**dsh-TUI 的优势（全、生态、精致）：**
- React 声明式渲染更易维护复杂 UI；组件丰富（流式 Markdown、高亮、表格、终端）。
- 真实内置终端、preset/主题/多语言/更新器/权限等官方生态端口齐全。
- 时间回溯 rewind、自动更新等更成熟。
- 但依赖 cordis host、强制 TTY、体积大，且是给官方生态做的通用品，没有宠物/朗读/用量定制。

**一句话结论**：你们的 repl 是为你们深度定制的精简前端；dsh-TUI 是官方生态的通用重型前端。两者渲染范式不同（命令式 widget vs React 声明式）、运行时不同（子进程 vs host 插件）。你们已能用很小代价把 dsh-TUI 的像素鲸鱼（乃至更多视图）搬进 repl——因为渲染只是字符串层面，真正的差异在功能深度和体积。

---

## 五、补记：如何看待「轻量 vs 重依赖」（2026-08-16）

结论：的确是我们轻、对方重，但「轻」要辩证看。

| | 我们 repl | dsh-TUI |
|---|---|---|
| 运行时依赖 | 2 个（pi-tui + js-yaml） | 几十个（react/reconciler/marked/highlight.js…） |
| peer 依赖 | 无 | @deepseek-ai/cordis + dsh-invariants（强绑官方 host） |
| 代码规模 | ~3900 行 TS | 210+ 模块，3.7MB |

关键点：

- **「轻」是真的，但保有两面**：我们依赖面小、可移植、好维护、好改，这对「为自己深定制的个人工具」是巨大优势；但轻 = 外部依赖轻，内在复杂度（tui-repl.ts 单文件 1500+ 行）其实压在自己逻辑里，得自己扛维护。
- **对方重依赖不是堆垃圾，是用依赖换通用能力**：React 声明式、流式 Markdown 高亮、内置终端、preset/主题/多语言/更新器/mcp/rewind，这些若自建成本是你的 N 倍。他们选重依赖 = 适合「通用产品」路线。
- **两边的生态是一回事**：他们的 /preset /theme /update /doctor /mcp /rewind 来自官方插件端口；我们的 /pet /tts /memory /用量面板是自己写的。都在端「各自生态」，方向不同而已。
- **该「偷」的是思路，不是依赖**：想要 rewind、模型预置、精致终端渲染时，优先「引一个小依赖/自实现」，别整套端过来。例：鲸鱼只用了几十行 + 一个渲染函数就拿到对方效果——这就是轻量路线的胜利。

**最终立场**：对我们这种「为自己深定制」的场景，轻量路线是更优解。保持轻，缺什么按「小依赖 + 自实现」补齐，别为功能齐全去背一堆重量依赖。
