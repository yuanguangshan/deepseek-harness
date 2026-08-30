# Agent Note: REPL TUI 死代码删除与宽度度量统一

Status: implemented

English | [中文](2026-08-30-repl-tui-dead-code-width-unification.md)

## Problem

REPL 的 TUI 辅助模块里堆积着重复且失效的度量/渲染逻辑（`apps/repl/src`）：

- `core.ts` 导出的 `formatStatsLine` 和 `packStatFields` 把统计渲染成拼接行，但没有任何调用方——所有消费方都直接渲染 `formatStatsFields` 的字段。它还导出 `visibleTextWidth`，一个手写的可见宽度计数器，与 pi-tui 已提供、TUI 其他组件已在用的 `visibleWidth` 平行存在，两套宽度真相可能在 CJK/emoji 字形上分歧。
- `whale-banner.ts` 携带 `renderWhaleBanner` 和 `whaleDot`——自工作鲸迁到状态行后就没有调用方的启动横幅代码；在分区模式的覆盖统计里它们既无调用也无覆盖。
- 值得保留的行为内联在约 2000 行的 `tui-repl.ts` 里：鲸鱼游动状态机、宠物心情衰减、问候语（七份拷贝）、命令列表（手工维护、已经漂移——`reload`、`weixin`、`wx` 有处理器但没有补全项），而 `dev.ts` 对每个文件事件都重启、没有防抖。

## Decision

删除：`core.ts` 移除 `formatStatsLine`、`packStatFields`、`visibleTextWidth`；`whale-banner.ts` 移除 `renderWhaleBanner`、`whaleDot`。`status-bar.ts` 与 `whale-banner.ts` 的所有字符串度量统一使用 pi-tui 的 `visibleWidth`，让它成为 REPL 唯一的宽度权威。

抽取，每个都是带独立测试的纯模块函数：`stepWhaleSwim`（whale-banner.ts）推进游动一拍——边缘钳制、圈数记账、实况思考复述、台词轮换；`stepPetMood`（pet.ts）按序施加心情衰减与打盹判定，单步即可落入 `sleeping`；空闲问候收敛为单一 `IDLE_STATUS_TEXT` 常量并由 `showIdleStatus()` 渲染；`allCommands` 从 `commandCompletions` + 服务端命令列表 + 既有子命令短语推导，去重并按长度排序。`dev.ts` 改用单个 `fs.watch(srcDir, { recursive: true })`，过滤 `.ts` 并做 400 ms 防抖。

## Alternatives considered

- 保留 `visibleTextWidth` 并让 pi-tui 别名到它。否决：编辑器与浮层已经对齐 pi-tui 的计数器；保留第二套实现会重新打开字形宽度分歧。
- 通过扫描 submit 处理器的 switch 推导 `allCommands`。否决：补全表已经是「什么能补全」的事实来源；推导只需补上服务端命令与子命令短语。
- 用启动快照测试覆盖 `renderWhaleBanner` 而不是删除。否决：鲸鱼在所有路径都经 `renderWhaleHalfBlock` 渲染；第二套渲染器需要自己的黄金文件才能保持诚实。

## Consequences

- `history.ts`、`run.ts`、`status-bar.ts`、`whale-banner.ts` 在聚焦套件中达到 100% 语句/分支/函数/行覆盖；纯函数抽取让动画规则无需终端即可断言。
- `formatStatsFields` 获得直接测试（计数、时长、缓存/Token、ctx 钳制、注入样式），不再经由被删的行渲染器间接覆盖。
- 新命令必须加入 `commandCompletions`（或子命令列表），而不是第二个数组；推导出的 `allCommands` 不会再与补全漂移。

## Related

shell-out 通道的收敛记录在[子进程运行器 note](../architecture/2026-08-30-repl-subprocess-shell-out-runner.zh.md)。
