# Agent Note：REPL 生产力命令套件与 session/attach 图片 RPC

状态：implemented

[English](2026-09-01-repl-productivity-command-suite.md) | 中文

## 问题

TUI 已覆盖模型切换、会话恢复、记忆、朗读与微信推送，但日常高频能力缺位：压缩前看不出上下文里什么占大头；只有每回合成本行、没有会话级汇总；看不到 runtime 可见的技能；协议本来就上报后台代理事件却无处展示；提示词片段无法复用；跨会话找不到"哪次聊过某句话"；图片输入除 URL 外无路可走；用户切走后长回合结束没有任何信号。另外 `session/prompt` 虽接受 `image` 内容块，SDK 客户端却无法存储图片字节、拿不到块所需的 `ImageAttachmentRef`——只有 Web GUI 能附图。

## 决策

`apps/repl/src/` 下八个纯函数模块，各自带单元测试，统一接入 `tui-repl.ts`：

- `/context`（`context-estimate.ts`）把会话事件按用户文本、系统注入、助手文本、工具负载、其余分桶，按 chars/4 粗估（明确标注为估算；真正的分词归 runtime），并附 `/compact` 提示。
- `/cost`（`session-cost.ts`）用共享的 `DEEPSEEK_CNY_PER_MTOK` 列表价折算会话 token 桶。
- `/skills`（`skills-list.ts`）扫描项目 `.dsh/skills`、`.agents/skills` 及用户主目录对应目录，容忍缺失目录与解析失败的 `SKILL.md`；靠前的根遮蔽后面的同名技能。
- `/agents`（`agents-panel.ts`）把已订阅的 `subagent.started`/`subagent.finished` 通知折叠为运行记录——不改协议；先收 finish 也能渲染。
- `/macro`（`macro.ts`）把提示词宏存进记忆目录下的一个 JSON 文件（`~/.dsh-repl/memory/macros.json`）；提交的 `/名称` 展开一层（防自引用），附加输入拼在文本后。
- `/search` + `Ctrl+R`（`fuzzy-search.ts`）扫描最近 25 个会话的用户/助手消息行，装进有上限的过滤选择器；选中即恢复该会话。子序列打分（连续命中与词首加分）导出给需要排序的调用方。
- 回合完成通知（`notify.ts`）：回合 ≥30 秒结束时弹 macOS 通知（`DSH_REPL_NOTIFY=off` 关闭，`DSH_REPL_NOTIFY_WX=1` 额外经既有通道推微信）。
- `Ctrl+V`（`clipboard-image.ts`）用 JXA 脚本抓取剪贴板 PNG：目标路径经环境变量传入（不做 shell 路径拼转义），脚本只输出一个机器可判定的结果。

图片链路以新增的 `session/attach` RPC 收口：`@deepseek-ai/dsh-sdk-protocol` 定义 wire 类型（`SessionAttachParams`/`SessionAttachResult`，base64 + 媒体类型 → `ImageAttachmentRef`）；服务端处理器对可选的 `attachments` 服务做结构探测并委托 `saveImages`（准入与限额仍归 attachment 域；服务未装配时明确报错而不是丢图）；客户端新增 `HarnessClient.attachImages`。REPL 把剪贴板字节上传到这里，让返回的引用作为 `image` 块、排在文本之前，随下一条 `session/prompt` 发送。

`/compact`、`/goal`、`/export` 无需开发——runtime 早已注册，`client.command` 直接透传。

## 已考虑的替代方案

- REPL 侧按 attachment store 的磁盘布局自造 `ImageAttachmentRef`。否决：引用归 attachment 服务所有，准入、限额、尺寸检查是它的职责；绕过会产生后续被提供方拒绝的持久历史。
- 不加 RPC，只把文件路径交给模型。否决：路径不是内容块；有视觉能力的代理消费 `image` 块，传路径会静默退化为纯文本。
- 只按会话（标题/目录）做模糊搜索。否决：真实诉求是找到"哪次对话说过某句话"；消息行搜索加一键恢复才是答案，选择器的子串过滤也保证交互跟手。
- 给 `/compact`、`/goal`、`/export` 本地重写渲染。核实后否决：runtime 已拥有三者，重复实现会造成目标/导出语义分叉。

## 后果

- 上下文、成本、技能、代理、宏、搜索都能不离开键盘得到答案；除唯一刻意新增的 `session/attach` 外，没有新增协议面。
- `session/attach` 使 SDK 客户端成为一等图片发送方；任何客户端（不止 REPL）都能复现 Web GUI 的附图流程。
- `run.ts` 新增 `env` 选项（子进程环境覆盖）——剪贴板 JXA 以此传入目标路径；对既有调用方默认行为不变。
- 通知开关是环境变量而非配置文件，与 REPL 既有的 TTS、微信开关方式一致。

## 相关

本批扩展的 runner 契约：[REPL 子进程 shell-out runner 笔记](2026-08-30-repl-subprocess-shell-out-runner.zh.md)。
