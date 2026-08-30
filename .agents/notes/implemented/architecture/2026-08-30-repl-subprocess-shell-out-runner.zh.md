# Agent Note: REPL 子进程 shell-out 运行器与 worker 文件化

Status: implemented

English | [中文](2026-08-30-repl-subprocess-shell-out-runner.md)

## Problem

REPL 的两个辅助模块（`text2card.ts`、`weixin.ts`）各自手搓 `spawn` 管道：超时处理各写一套、stdout 收集不完整、没有流式回调——重复、细节不一致、且无测试。另外 `tts.ts` 把 Edge-TTS worker 当成 148 行的字符串模板，靠行手术拼进生成的 Python：worker 对编辑器、类型检查、lint 全部不可见，其线上行为只靠真实端点兜底。

## Decision

`apps/repl/src/run.ts` 收敛出唯一运行器 `runCommand(bin, args, { onStdoutLine?, timeoutMs?, cwd? })`，契约显式：

- 永不 reject。spawn 失败解析为 `{ code: -1, stdout, stderr: error.message }`；正常退出的子进程解析真实退出码（被信号杀死时为 `-1`），且始终返回完整 stdout 与 stderr。
- `onStdoutLine` 在子进程运行期间对每条完整 stdout 行（已 trim）触发；空行不转发；未换行的最后一行在 close 时补发。
- `timeoutMs` 到点对子进程 SIGKILL；调用仍然 resolve，不会悬挂。

`text2card.ts`（生成 → rclone R2 → 微信推送）与 `weixin.ts`（`runSend` → Python 发送脚本，30 秒期限）现在是运行器之上的薄参数/环境拼装；`run.ts` 及其契约由单元测试钉住（`run.spec.ts`：流式转发、空行跳过、未终止尾行、非零退出、有无超时窗的 spawn 失败、cwd）。

TTS worker 原样迁移为 `apps/repl/tts-worker.cjs`——普通 CommonJS 文件（`generateSecMsGecToken`、`xmlEscape`、`buildSsml` 及 WSS 朗读循环）。`tts.ts` 以 `[TTS_WORKER_FILE, voice, …]` 拉起，不再在运行期拼源码。线上契约——stdin 文本 → stdout `OK <path>` + `SIZE <n>`，失败时 stderr `ERR <msg>` 且退出码 1，Sec-MS-GEC 令牌与 `speech.config`+SSML 分帧，close code 1006 重试一次——由 `tts-worker.spec.ts` 钉住（对令牌/SSML 构造器的单元测试，外加一条经 `runCommand` 的入口冒烟）。

## Alternatives considered

- `execFile` + promisification。否决：无法向状态行做行级流式，也无法在期限到点强杀；两个辅助模块都需要在子进程运行期间展示进度。
- 保留各模块自己的 spawn 代码。否决：两套实现对超时与尾行处理已经分歧；第三个消费方（TTS worker 冒烟路径）会继承这种分歧。
- worker 继续用内联模板。否决：`.cjs` 资产可获得语法检查、lint、require 式单元测试与可读 diff；模板的唯一优势是单文件交付，而包结构从未要求这一点。

## Consequences

- shell-out 行为有了唯一属主；尾行补发或超时语义的修复落一次即对 text2card、weixin 及未来辅助模块生效。
- 运行器的空行与 `-1` 约定有测试背书，调用方可以依赖。
- `tts-worker.cjs` 作为包文件发布；打包变更必须让它与 `src/tts.ts` 同在（它经 `new URL('../tts-worker.cjs', import.meta.url)` 解析）。
- worker 与退役的内联模板保持相同外部协议，迁移无需端点或调用方变更。

## Related

同批次的宽度/死代码清理：[TUI 统一 note](../simplification/2026-08-30-repl-tui-dead-code-width-unification.zh.md)。
