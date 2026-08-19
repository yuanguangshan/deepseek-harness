# DeepSeek Harness 项目架构与亮点深度分析

## 一、项目定位

dsh (DeepSeek Harness) 是 DeepSeek AI 开源的 agent harness（智能体运行框架），核心信条是"一切皆插件"（everything is a plugin）。它没有传统意义上"需要去 patch 的特权核心"——模型适配器、工具注册表、持久化、会话日志、甚至 agent 主循环全部以插件形态存在，每一部分都可以从配置中替换。

底层由 vendored 的 Cordis（v4.0.1，自带 vendoring 同步机制）驱动。当前处于 developer preview 阶段，明确承诺"会有破坏性变更"，因此代码库里的设计决策是"先打对地基、再谈兼容"。

## 二、总体规模

- 约 219 个 npm 包，全部 @deepseek-ai/dsh-<pkg> 命名，pnpm workspace 托管
- 约 56.7 万行 TypeScript + 640 个测试/spec
- Node ^22.19 || >=24，ESM-only，strict + noImplicitAny
- 结构：packages/（本体）、vendor/（vendored Cordis）、native/（Landlock 原生插件）、python/（维护 Python 包及 SDK）、examples/+apps/（可运行的 cordis.yml 叶子与 CLI/Web）

## 三、核心架构

### 1. 插件系统：Cordis 五个概念
Plugin（Service 对象）→ Context（ctx.<key> 服务仓库，按 key 而非实现 import）→ inject 声明依赖（表达加载顺序而非手写启动）→ Typed Events（declaration merging + emit/waterfall/parallel/serial 四种分发）→ Registrations are reversible effects（ctx.effect() 保证重载/卸载按序回滚）。

### 2. 启动组装：Profiles & Bundles
多层 patch 组装插件树。Profile 命名组合，Bundle 是"配置行+代码"的补丁层。层次：各 bundle → profile 的 cordis.patch.yml → home 级 → --patch overlay。dsh-base 是每 profile 的第一层；dsh-web-app 加 Web；dsh-headless 零服务器单次运行。

### 3. 三大事件域
- Session events：追加到日志的持久事实（跨重启存活）
- Agent events（agent/*）：携带存活 Agent 的实时事件，观察/拦截进行中的工作
- Capability events：把策略/适配器挂到 seam（fs/*、tools/*、telemetry/*）

### 4. Turn / Step 流
step=一次模型请求+其工具调用；turn=零或多个 step。单一 inbox 进驱动；agent/pre-step 决定模型看到什么。

### 5. 会话日志（事件溯源）
Session 是追加式 typed SessionEvent 日志，模型历史由 deriveMessages() 派生而非单独存储。硬性不变式："模型可见 ⟺ 已记录"——任何到达模型的东西都能从日志重构。

### 6. 能力接缝（Capability Seams）
seam = Service Definition + Service Provider + Consumer 三件套。"换一个 Provider 就改变整个产品"。如 ctx.fs 有 local/sandbox/e2b 三个 Provider，切换即把 Bash、PTY、LSP 一起搬到远程沙箱。

### 7. 工具执行管线
tools/pre-execute（allow/deny/ask）→ 单调整 guard（只能拒绝、不能反悔）→ tools/execute（around dispatch：超时/重试/指标）→ tools/post-execute（接受/替换/阻塞）→ finalizeContent → tools/result（不可变权威结果）。全程 lossless-JSON 物化 + 深度冻结。

## 四、执行类能力亮点

### Web / Client 架构
- 严格两侧分离：packages/host/*（Node 执行端）+ packages/client/*（浏览器端），一个 RPC 协议粘合
- Client 插件图由 dsh-client-modules 驱动：扫描声明 dsh.client 的 Loader entry，组成 WebBootGraph 注入 window.__DSH_BOOT__；浏览器端按需 fetch /plugins/<id>/client.js bundle
- "四象限" RPC 模型（ClientRequest/ServerResponse/ServerRequest/ClientResponse，用品牌化 rpcId 关联）：上行 POST /api/<method>，每事件流配同源 WebSocket 下行。AbstractApiClient 承载全部协议不变式，子类只提供 doFetch 传输切面
- 刻意不是 JSON-RPC 2.0：GUI 网关改用 zod 校验、签名派生的 RpcMethodMap + RpcErrorDetailsMap。SDK 层（packages/sdk）则是另一套标准 JSON-RPC 2.0 stdio 层（TS client + Python SDK twin）

### LSP 接缝
ctx.lsp（Service Definition+registry）/ lsp-stdio（源）/ tool-lsp（Consumer）。模型面对的表面是恰好四个封闭语义查询——goToDefinition|findReferences|goToImplementation|hover，刻意无协议逃生口。加操作是编译期强制、跨 seam/provider/tool 的一致变更。

### Terminal / PTY
ctx.terminals 是 PTY 后端注册表，授权基于精确拥有者 Agent（按身份比较而非名字猜测拒绝外来者）。TerminalWaitReason（静默/超时）与 TerminalSessionStatus（真实 shell 退出）解耦；持久化不重复 PTY 事件流——模型输入与有界返回值沿既有 tool/call 与 task-result 路径走，PTY 原始字节保持进程本地，会话跨 reload 存活。

### 沙箱（sandboxing）
ctx.sandbox.confine(argv, policy) 包装同世界 argv，而不是起容器/microVM。三类模式 read-only/workspace-write/danger-full-access。执行强制力是一个"被报告的事实"——SandboxEnforcement 区分 full/partial。底下是 native/landlock-run（约 300 行 C11 static-musl launcher，直接操作 Landlock 内核 UAPI）。seam 失败即关闭：confined 模式永不静默无沙箱透传。

### MCP + Hooks
- MCP：dsh-mcp-client 每服务器一个实例，支持 stdio/streamable-http 双传输，listTools() 后把外部工具注册到 ctx.tools（mcp__<server>__<raw> 规范名）
- Hooks（Claude Code/Codex 桥）：把外部 hooks.json 翻译到原生 typed Cordis 拦截表面（agent/pre-step、tools/pre-execute、tools/post-execute）。原生 PreToolUse/PostToolUse → PreToolDecision.deny/ask，串行执行 + most-restrictive fold

### Shell / Subprocess / Code-Runtime
三层叠加 seam，都体现"显式 > 隐式"：
- ctx.shell（bash 执行器）显式 resolve() request→spec 拆分
- ctx.subprocess 拥有完全显式的 spawn spec（无默认值），治理的 DSH_* 环境命名空间，隐私凭据 scrub
- ctx.codeRuntime 把一段模型写的程序当一个被注入 host 函数的 async 函数体跑（lossless-JSON 边界），正交失败分类法（exception/timeout/abort/worker-exit/invalid-output/output-limit）

### Typert（类型图代码生成）
@Remote('create') 标注的方法被从 TS 编译器 ts.Program 做严格静态分析，生成 Host 端 zod codec + Client 端 declaration merges。添加一个 remote 方法是一处改动：wire 载荷从方法签名派生，Agent/Session 等 Host 对象变成 lookup 解析的 wire id。一句话：它消灭了多数 RPC 系统手写的 DTO/runtime 校验层，让 TS 签名成为线路两端的单一事实来源。

## 五、数据层亮点

- 持久化 seam：SessionPersistence + JSONL/SQLite 可互换后端，共享 runPersistenceContract 一致性套件。崩溃恢复不截断：冷加载遇孤儿 turn/start 插入合成 turn/end {reason:'interrupted'} 平衡
- 单一最大设计：SurfaceOp { op:'replace' } 模型——分离"模型看到的 surface"与"事件日志（ground truth）"，让 compaction、工具结果裁剪、投影读模型、live 查询折叠、崩溃恢复 resume 共享一个永不重写的追加日志
- Projection Cache 冷读阶梯：缓存行 + 持久化尾部重放 + 注册表恢复 + 细粒度回写，列表读取零 I/O
- 会话查询：SQLite FTS5 全文检索，把调用方文本当数据引用（防注入），live-preferred + 光标分页

## 六、编排层亮点

- Continuable subagent 的 Activation 模型：可持续 child = 一个持久 Session + 至多一个进程内 Activation；Agent inbox 是唯一 FIFO 队列；follow-up 路由纯粹是 Activation 驻留状态函数（running->enqueue, waiting->wake, none->cold-resume）；Activation 从不持久化、从日志重派生
- Workflow：agent 跑一段模型写的 JS 编排脚本扇出子代理，node:worker_threads 一个 worker/run，pipeline()/parallel(barrier) 语义 + WorkflowError.fatal 失败纪律；Ralph 循环变成普通插件覆于其上
- LLM seam：StreamChunk 是封闭判别联合；严格 adapter 契约；block assembler 单一共享实现、宽容 delta-only 协议
- goal：事件溯源的同会话完成目标，goal/change 事件带全后置快照 + revisioned tombstone，GoalRef 作为 compare-and-set 栅栏
- 压缩（compaction）：BasicCompactionEngine 用一次直接 ctx.llm.stream() 调用重放对话前缀（复用 provider 热 KV cache，purpose:'compaction'），compaction/start...end 作持久锁

## 七、工程严谨性（隐性亮点）

1. 运行时不变式 companion：每包拥有 ./invariant，ctx.invariants 汇集 owner-local 检查
2. 测试分层：unit → test:coverage（per-file 100%）→ 真实 API e2e → keyless 可回放快照 → Web 浏览器快照（Linux 必过 PR gate）
3. 文档即门禁：ts type-equiv 代码块必须与源码逐字匹配、wordcount budgets、死链检查、跨语言配对 i18n 全自动化
4. Agent Notes 决策记录：非平凡改动必带 Note（proposed->implemented->rejected+archived）
5. 构建分离：Host/Client 双隔离 TS aggregate；api/remotes 唯一拆分面
6. 品牌化 ID（Branded<B>）；冗余纪律（duplication/knip/publint/workspace constraints）

## 关于本 GUI
本 GUI 正跑在 dsh 之上：apps/web 是 Web bundle，经 Connection /api JSON-RPC 与 Host 通信，__DSH_BOOT__ 为 Client 入口图，浏览器端 Host 方法经 ctx.remote.<ns>/agentCtx.remote.<ns> 暴露。"模型可见 ⟺ 已记录"保证了 UI 状态都能从 session log 重放。

## 一句话总结
DeepSeek Harness 的真正骨架不是"huge 单体 agent"，而是一套把"事件溯源日志 + 能力接缝 + typed 组合式插件"三者咬合成单一事实来源的框架，再用严格的类型/测试/文档门禁防止其腐化。

- 架构上：无特权核心、一切可替换（seam 三件套）；模型历史从追加式 SessionEvent 日志派生
- 最惊艳的两处设计：(1) 数据层的 SurfaceOp {op:'replace'} 把"模型看到的面"与"日志真相"分离；(2) 编排层的 Continuable subagent Activation 模型
- 工程纪律：per-file 100% 覆盖率门禁、keyless 可回放快照、"验证世界而非自报"的 e2e、ts type-equiv 文档逐字同步、每包 ./invariant 运行时不变式、Agent Notes 决策记录、Host/Client 双隔离构建
