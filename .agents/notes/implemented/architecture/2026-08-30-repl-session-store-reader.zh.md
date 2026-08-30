# Agent Note: REPL 会话存储读取层收敛到规范 zstd 扫描器

Status: implemented

English | [中文](2026-08-30-repl-session-store-reader.md)

## Problem

`apps/repl/src/history.ts` 为读取持久化会话日志自带了一份 zstd 帧扫描器，与 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `scanZstdFrames` 重复。两套扫描器可能对「什么是合法帧」产生分歧——同一份损坏或撕裂的日志，REPL 与持久化包会读出不同结果。与此同时，该模块的同步全库扫描（`listAllSessions` 遍历全部工作区、逐会话 `readdir`）阻塞 TUI 事件循环，而 `findTitle` 对遇到的每一帧都不计预算地解码。

整体导入规范的 `src/format.ts` 不可行：它把编码器与 `cordis` 导出在同一路径，而 REPL 的独立构建不能引入 cordis。本地镜像（`encodeSessionId`、`projectKey`）因此必要却无人校验——规范格式一变，会话存储就会静默裂成两种不兼容的目录布局。

## Decision

`history.ts` 从 `@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts` 导入 `scanZstdFrames`——该模块不依赖 cordis，构建保持干净——并删除自带扫描器。帧扫描权威从此唯一。

`encodeSegment`/`projectKey` 镜像保留在本地，并由一个漂移守卫测试钉住：测试侧导入规范 `format.ts`（仅测试导入，绝不进入运行时 bundle），断言两份镜像在段编码（`a/b`、emoji、`.`、`..`、`x~y`、空格）与项目键（路径含 `~`、`//`、`/:`）上一致。

列举改为异步且有界：`listSessionsIn`/`listAllSessions`/`listSessions` 对目录读取使用 await，`yieldToEventLoop()`（`setImmediate` promise）分隔各工作区扫描以保持 TUI 响应；`tui-repl` 的 resume 选择器在序列号守卫之后执行扫描并显示「扫描历史会话…」状态行——空结果与取消都回落到空闲提示。`findTitle` 在解码前先判 `consumed >= budget` 并跳过后续帧，大日志无法迫使无界解压；解码失败路径停止扫描而不是抛出。

## Alternatives considered

- 直接导入规范 `format.ts` 并接受 cordis 边缘。否决：REPL bundle 是独立 TUI；为两个字符串函数引入整套插件运行时是错误的依赖方向。
- 像编码器一样把 `scanZstdFrames` 也拷贝进 history.ts。否决：扫描器是扫描行为的权威（哪些帧存在、帧止于何处）；分歧的拷贝会让同一份文件读出不同结果，而不只是新名字的编码不同。
- 按事件请求惰性逐帧解码。暂缓：`readSessionEvents` 只在显式 resume/inspect 路径调用；标题扫描已有预算上限，逐帧缓存是在没有可测量收益的地方增加状态。

## Consequences

- 损坏/撕裂日志在 REPL 与持久化包中扫描结果一致；容错读取行为（跳过坏行、解码失败即停）建立在唯一扫描器之上。
- 镜像无法再静默漂移：规范编码器变更时漂移守卫测试会失败，并指出具体分歧的段或键。
- 大存储下 resume 不再冻结 UI；选择器的二次打开不会与更早的在途扫描竞速（序列号守卫）。
- `scanZstdFrames` 对损坏 magic 抛错仍是其契约的一部分；不允许抛出的调用方自行包裹（`readSessionEvents` 刻意重抛——容错语义住在 UI 边界）。

## Related

运行器/worker 收敛：[子进程运行器 note](./2026-08-30-repl-subprocess-shell-out-runner.zh.md)；TUI 清理：[统一 note](../simplification/2026-08-30-repl-tui-dead-code-width-unification.zh.md)。
