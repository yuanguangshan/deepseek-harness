# Agent Note: Repl memory and usage packages

Status: implemented

[English](2026-08-16-repl-memory-usage-packages.md) | 中文

## Problem

dsh-repl TUI 把两个可复用能力打包成了本地模块：`apps/repl/src/memory.ts`（五轨长期记忆）和 `apps/repl/src/usage.ts`（opencode go + DeepSeek 余额配额）。它们的逻辑刻意保持纯函数——依赖可注入、不 import pi-tui、单测每文件 100%——但放在 `apps/repl` 里，任何其他前端或 agent 运行时都无法触达。TUI 采用 note（[2026-08-14](../architecture/2026-08-14-repl-adoption-and-reducer.zh.md)）纳管了应用并抽取了会话 reducer；memory 和 usage 存储仍留在应用本地，复用意味着复制文件，从而分叉行为和覆盖率。

## Decision

把两个模块抽取到新的 `packages/companion/` 分组，作为独立的纯逻辑库：

- `@deepseek-ai/dsh-memory`（`packages/companion/memory/`）——`MemoryStore`、五轨布局、条目盖章、`renderMemorySnapshot` prompt 注入块。
- `@deepseek-ai/dsh-usage`（`packages/companion/usage/`）——ZCode 配置解析、两个配额端点、段渲染、`formatUsageStatus`。

两个包运行时无 harness 依赖（仅 Node 内置）；各带一个理由充分的空 `./invariant` 伴生文件，测试随源码迁移。TUI 现在 import 两个包，本地副本已删除，因此只有单一事实来源。`packages/companion/` 是未来更多 TUI 抽取（pet、tts、history）在超出应用范围后的归宿。

`.agents/skills` 目录新增 `dsh-memory` 和 `dsh-usage` 技能：为在本仓库工作的 agent 提供使用指引，指向包 API 和存储布局。

第三个包 `@deepseek-ai/dsh-tool-companion`（`packages/companion/tool-companion/`）基于这两个库注册面向模型的 `memory` 和 `usage_status` 工具。它是函数插件（`name`/`inject`/`Config`/`apply`，无 default），两个可选配置键（`memoryDir`、`zcodeConfigPath`）回退到库默认及其环境变量覆盖。工具把宿主侧状态保留在磁盘上，与 TUI 完全一致；会话日志通过 `tool/call` 和 `tool/result` 重建每次调用的输入输出。该包挂载在 `acp-agent` 和 `jsonrpc-agent` 两个示例里，并列入 tool-catalog 启动清单，因此其 schema 会出现在生成的目录中。

## Verification

迁移后的单测套件让两个包保持每文件 100% 覆盖率。REPL 通过项目引用和 tsconfig `paths` facade 编译通过。技能目录能发现两个新名字（通过会话目录刷新验证）。工具包在 `cordis.yml` 组合测试里通过真实 Loader 启动（配置键被证明能重定向记忆与配额路径），在 fiber 释放时注销两个工具（HMR-safety），并保持 `src/` 每文件 100% 覆盖率；`memory`/`usage_status` schema 由目录生成器收割进 `docs/tool-catalog.md`。

## Consequences

- REPL 与任何其他消费者共享同一份 memory/usage 实现；修复或新功能只需落地一次。
- 两个包必须满足包级门（每文件 100% 覆盖率、导出 JSDoc、invariant 伴生、带 Known Limitations 的 README），这些是 `apps/repl` 源码豁免的。
- 未来更多 TUI 抽取（pet、tts、history）有了归属分组和既定包形态。
- 面向模型的工具暴露了不在会话日志里的宿主侧状态（记忆文件、配额端点）；`tool/call`/`tool/result` 仍是可重建的记录，README 记录了这个边界。

## Alternatives considered

- **保留在 `apps/repl`** —— 拒绝：复用需要复制，从而分叉行为和覆盖率。
- **合并成一个包** —— 拒绝：memory 与 usage 没有共享面；独立包保持各自的不变式和测试范围独立。
- **放进 `packages/util/`** —— 拒绝：util 定位是小型零依赖工具；这两个是带各自存储与端点契约的产品能力。
