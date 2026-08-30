# Agent Note: 把 TUI REPL 以 TypeScript 纳入仓库质量门

Status: implemented

[English](2026-08-14-repl-adoption-and-reducer.md) | 中文

## 问题

TUI REPL 此前以散落的 `.mjs`/`.js` 文件存在于 `apps/repl/`，游离于仓库所有质量门之外：oxlint 的全局 `ignorePatterns` 在 override 生效前就丢弃了 `**/*.js` 与 `**/*.mjs`，override 无法再把它们纳入；没有任何 tsconfig program 引用它；覆盖率门只度量 `packages/*/*/src/**`；也没有任何 transcript 验收。结果是一个可自由腐烂的平行面——声明却未使用的 `@deepseek-ai/dsh-app-boot` 依赖、submit 路径中不可达的 `busy` 分支、按 delta 全量重解析的 O(n²) Markdown、以及两套不一致的运行时重启机制（`/model` 在同一子进程上二次 initialize；`/reload` 整个子进程拆掉重启）。这也悄悄绕过了[删除 `dsh-tui` 包的决定](../simplification/2026-08-04-remove-tui-package.zh.md)，该决定要求未来的终端前端必须具备真实的包边界、组装好的生命周期与 transcript 验收。

## 决定

把 REPL 转为 TypeScript 置于 `apps/repl/src/`，接入 host 质量门，并在同一变更里修复上述三个缺陷。

- **TypeScript 布局** 镜像 `apps/cli`：薄入口 `src/bin.ts`（`/* v8 ignore file */`）派发到 `src/tui-repl.ts`（终端胶水：pi-tui 组件、订阅循环、输入处理）、`src/core.ts`（纯逻辑）、`src/dev.ts`（文件监听开发模式），以及新增的 `src/session-reducer.ts`。`apps/repl/tsconfig.json` 继承 base，`tsconfig.host.json` 增加 test include glob 与 `{ "path": "./apps/repl" }` reference。死依赖 `@deepseek-ai/dsh-app-boot` 与行式版 `repl.mjs` 一并删除。
- **无需改配置即纳入门控。** 源码成为 `apps/repl/src/**` 下的 `.ts` 后，oxlint 现有的 `apps/*/src/**/*.{ts,tsx}` override glob 自动覆盖它——无需编辑 `.oxlintrc.json`。覆盖率门把 `apps/repl/src/**/*.ts` 加入 `include`；`bin.ts`、`tui-repl.ts`、`dev.ts`（raw alt-screen 终端 I/O、组件胶水、进程 spawn）作为不可断言的胶水排除，`core.ts` 与 `session-reducer.ts` 留在 per-file 100% 门下。`knip.json` 注册一个 workspace entry。
- **抽取 session-event reducer。** 事件 → UI 的映射（assistant 文本累积、思考行、工具卡片、stats、异常 turn/end、流式 flush 节奏）是唯一可断言的行为，也是唯一能脱离 PTY 达到 100% 覆盖的单元。`src/session-reducer.ts` 是纯函数 `reduceSessionEvent(state, event, stats) → ReplEffect[]`；`tui-repl.ts` 把 effect 应用到组件上。动机是可测性与 keyless snapshot，而非复用——行式 REPL 已删除，此 reducer 只有一个消费者。
- **修复流式 Markdown 的 O(n²)。** pi-tui 的 `Markdown` 只暴露 `setText`（无增量 API），故 TUI 缓冲 text delta，至多每 `STREAM_FLUSH_MS` 事件时间重渲染一次，并在每个终止转换（`assistant/message`、`turn/end`、工具调用后的新 assistant 块）时 flush。节奏决策由 reducer 依据事件 `time` 做出，渲染由 TUI 负责。终止转换总会 flush，因此最终文本完整，不依赖定时器。
- **移除不可达的 `busy` 分支。** submit 路径里"busy 时斜杠命令仍可执行"的注释只是愿景：回合进行时编辑器设置 `disableSubmit`，pi-tui 的 Enter 处理在该标志下直接返回、不调 `onSubmit`，因此回合中任何输入都进不来 submit。`disableSubmit` 是唯一的 busy 门，死分支删除。
- **统一运行时重启。** `/model` 与 `/reload` 都走同一个 `restartRuntime({ provider, model, announce })`：拆掉并重启子进程、bump `runtimeEpoch`。`/reload` 本就必须重启进程——它在 spawn 时加载配置，轻量的 `initialize()` 路径读不到配置文件变更——统一后消除了 `/model` 对 initialize 幂等性的依赖与两套机制的不对称。

## 备选方案

**保留散落 `.mjs`/`.js`，只让 oxlint 覆盖它们。** 拒绝。oxlint 的 `ignorePatterns` 在 override 之前生效（schema 确认其对齐 ESLint-v8 语义），override 无法重新纳入被全局忽略的 `.mjs`/`.js`；在 `ignorePatterns` 里取反在仓库内无先例且脆弱。转为 `.ts` 才是其余受门控源码已采取的一致路径。

**用 `checkJs` 代替转换。** 拒绝。仓库内无任何 program 设 `allowJs`/`checkJs`，base 编译选项是 TS 优先（`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`），且 `.js` 既不被 lint 也不被插桩。`.js` 应用会停留在半门控状态。

**用 PTY 驱动的 snapshot 代替纯 reducer。** 拒绝。TUI 使用 raw alternate-screen 终端，其渲染输出依赖宽度与 ANSI；确定性 snapshot 需要假终端与固定宽度，而仓库内无此适配器。仓库惯例是纯逻辑抽取加 vitest，而非 PTY 测试架；reducer 加一个 keyless 真实 wire snapshot（`HarnessClient` 指向脚本化的 `fake-runtime`）即可在不依赖 PTY 的前提下覆盖可断言行为。

## 后果

REPL 现在与其他受门控 app 一样受 typecheck、lint、per-file 覆盖率门与 knip 约束,并带有一个驱动真实 JSON-RPC wire 路径的 keyless transcript snapshot。由于工作区约束把每个 `apps/` 包都视为 release member,`@deepseek-ai/dsh-repl` 现在具备真正的可发布包边界——`bin`(`dsh-repl`)由 `apps/repl/tsdown.config.ts` 从 `lib/types/bin.js` 打包得到——终端前端不再缺少删除 `dsh-tui` 决定所要求的包边界。三个缺陷已闭合:流式渲染成本降到每个合并窗口一次重解析,busy 门内部自洽,一套重启机制同时服务模型切换与重载。代价是 `/model` 上有可感知的子进程重启(此前经二次 initialize 近乎瞬时),手动偶发切换可承受,本说明记录此取舍。终端胶水保持 coverage-excluded,因为它是真正不可单测的部分--与排除 `packages/client/*` UI 源码的判断相同--而纯 core 与 reducer 是受门控的核心。
