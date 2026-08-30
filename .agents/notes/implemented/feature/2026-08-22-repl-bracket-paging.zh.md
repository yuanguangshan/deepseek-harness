# Agent Note: REPL 在空草稿下用 [ 和 ] 翻阅 transcript

Status: implemented

[English](2026-08-22-repl-bracket-paging.md) | 中文

## 问题

REPL 渲染在 pi-tui 的备用屏（`TuiAltScreen`）中，终端原生回滚不存在：iTerm2 触控板手势、滚动条、Cmd+↑、Shift+PageUp 背后都没有内容可滚。库已经把 PageUp/PageDown/Home/End/Ctrl+Shift+↑↓ 接到焦点编辑器看到输入之前的主 ScrollView，但 MacBook Air 没有 PageUp/PageDown 键，而且这个绑定无从发现——用户的反馈是"没法往回翻历史"。

追踪输入路径时又发现两个事实：

1. 应用级输入监听器会吞掉一切它不认识为 Ctrl+字母 的 kitty 协议 CSI-u 序列（`ESC[NN;<mods>u`），包括 pi-tui 的 `matchesKey` 能解析的带修饰键导航键（如 xterm shift+PageUp `\x1b[5$`、kitty 小键盘编码 `\x1b[57421u`）。
2. `Ctrl+[` 无法作为翻页回退：它就是 Escape（0x1b），已绑定 turn 中断。

## 决策

编辑器草稿为空时，纯 `[` / `]` 上下翻页，实现为 `core.ts` 中的纯函数 `bracketScrollAction(data, editorEmpty)`；TUI 胶水层把结果映射为一页滚动（`terminal.rows - PAGE_SCROLL_OVERLAP_LINES`，与 pi-tui 自身的 4 行翻页重叠一致）。空输入框表达阅读意图；一旦有文字，按键恢复字面插入——这是文本输入的内建冲突回退。单字符匹配天然无视 bracketed paste 块。

kitty 吞噬分支现在只消费 key-release 事件与无修饰键的 codepoint 按下（`CSI NN u` / `CSI NN;1…u`，即原守卫针对的 IME 噪声）；带真实修饰键的序列向下穿透，上游滚动/导航绑定保持可达。欢迎横幅写明翻页键。

`Ctrl+[` 因与 Escape 物理不可区分而被否决；`Ctrl+]` 保留给编辑器的向前跳转绑定。

## 验证

`tests/core.spec.ts` 固定门控行为：`[`/`]` 仅在草稿为空时翻页，非单字符序列（粘贴）永不翻页。覆盖真实分发链路的合成 harness 确认 `[` 经 `handleTerminalInput` 滚动一页、`]` 返回、非空草稿下 `[` 原样进入编辑器。包 vitest 套件绿（110 个测试）；`tsc -b` 干净；`lib/bin.js` 经 tsdown 重建。

## 备选方案

Ctrl 系翻页败于 `Ctrl+[`=Escape。常开的 `[`/`]` 会吃掉字面 "[…]" 消息的首个括号。主屏渲染（`TuiMainScreen`）能恢复原生回滚，但其契约刻意缺少本 REPL 赖以构建的视口布局（钉住的状态栏、ScrollView 区域）。

## 后果

没有 PageUp/PageDown 的 MacBook 类键盘可以用 `[` / `]` 翻阅 transcript，欢迎横幅也写明了这两个键。带真实修饰键的 kitty 序列重新到达 pi-tui 的滚动与导航绑定；只有原守卫针对的 IME 噪声按下仍被消费。以 `[` 开头的消息需要先有非空草稿——即文档化的冲突回退——`tests/core.spec.ts` 同时固定了空草稿门控与粘贴免疫。
