# Agent Note: REPL 会话治理与复制套件

Status: implemented

[English](2026-02-20-repl-session-governance-copy-suite.md) | 中文

## 问题

生产力套件已覆盖历史读取与搜索，但日常闭环仍有缺口：复制上一条回复要在终端里手动选文本；看不到工作区未暂存的 diff，也无法在一个回合内撤销误改；磁盘图片只能来自剪贴板；上下文压力只有用户主动记得跑 `/context` 才可见；删除废弃会话要自己去磁盘上找目录；标题无论自动起得多好都会被继续改写；而且没有命令能在怪罪模型之前回答"这台机器的环境是否齐全"。

## 决策

对 `apps/repl/src/` 新增七个纯函数、可单测的模块，全部接入 `tui-repl.ts`，另加一个新会话包：

- `/copy` + `Ctrl+Y`（`clipboard-copy.ts`）复制上一条助手回复——有 fenced 代码块时取第一个（退化双围栏的正文原样取用），否则全文——经 shell-out runner（优先 `pbcopy`，OSC 52 兜底），复用终端剪贴板 runner 契约。
- `/diff` 与 `/revert`（`git-ops.ts`）在 REPL cwd 经可注入 git runner 执行 `git diff --no-color` 与 `git checkout -- .`；退出码 ≤1 视为有差异的正常返回，其余报 `git 退出码 N` 并附 stderr。`/revert` 由 `ConfirmDialog` 确认后丢弃全部未暂存改动。
- `/doctor`（`doctor.ts`）探测 PATH 上的 runtime、`git`、`rg`、`zstd`，以及 `DEEPSEEK_API_KEY`/网关键等环境，打印 `ok/warn/fail` 表。平台判断与 PATH 解析均可注入以便测试。
- 磁盘图片附件（`atfile.ts` 的 `extractImageMentions`）从提交的 prompt 中解析 `@path/to.png` 与 `@"带空格 路径.png"`，展开 `~`、相对路径按 REPL cwd 解析、读字节、走既有 `session/attach` RPC 上传，引用随下一条消息发送；非图片与不存在的路径保持字面文本。
- 上下文压力（`core.ts` 的 `contextPressure`）把 chars/4 估算转成 75% 黄 / 85% 红的状态栏警示，危急时给一次性 `/compact` 提示，切换会话后重置。
- `/resume` 删除：会话选择器接受可选删除处理器；删除键（`\x1b[3~`/Ctrl+D）弹出 `ConfirmDialog` 后移除编码后的会话目录（`history.ts` 的 `deleteSessionDir`，已不存在记 `missing`），不影响同级目录。
- `/rename`（新包 `packages/session/command-title`）注册一个全局命令，委托 `ctx.sessionTitle.rename()`；空输入返回用法，领域校验错误转为用法错误，其余意外失败原样传播。交互示例组合在 title 服务之后挂载该插件。

## 已考虑的替代方案

- `/copy` 只走 OSC 52。否决：iTerm2 的 OSC 52 需要按会话手动开启，而 macOS 安装面上 `pbcopy` 恒在；既有回退链已经编码了这一顺序。
- `/revert` 用 `git stash` 语义。否决：stash 让改动仍可找回，却会悄悄打乱用户想清理的工作区；键入确认加 `checkout -- .` 与提示所说完全一致。
- 会话删除用单独的 `/rm <n>` 命令。否决：选择器已在屏幕上完整枚举会话；就地删除避免了两步的编号往返。
- REPL 侧固定标题（把标题存进 REPL 状态、屏蔽自动结果）。否决：标题存于会话日志、归 runtime 所有；客户端固定会与读取同一会话的其他客户端分叉。

## 后果

- 常用清理动词——复制、diff、还原、删除、改名——各占一条命令，无需离开键盘或手动 shell 出去。
- 图片附件现在覆盖所有来源（剪贴板、磁盘路径、带空格的引号路径），统一走同一条 `session/attach` 通道，准入与限额保持在一处。
- 上下文警示转为常驻：状态栏先于 `/context` 说话，危急提示每会话只触发一次，不逐回合打扰。
- `dsh-commands` 的示例新增 session-title 依赖；cordis.yml 中的裸插件必须留在解析器清单里，由 `verify-cordis-config` 强制。

## 相关

`/copy` 复用的 runner 契约：[REPL 子进程 shell-out runner 笔记](../architecture/2026-08-30-repl-subprocess-shell-out-runner.zh.md)。本批次扩展的前序生产力批次：[REPL 生产力命令套件笔记](2026-09-01-repl-productivity-command-suite.zh.md)。
