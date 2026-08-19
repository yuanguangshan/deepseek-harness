# Agent Note: 容忍流式响应缺 finish_reason 就结束

Status: implemented

[English](2026-08-19-pi-ai-stream-missing-finish-reason.md) | 中文

## 问题

`@earendil-works/pi-ai` 的 OpenAI-completions 流式适配器在提供方流式输出到自然结束、却没有携带终止性 `finish_reason`（或 `[DONE]` 哨兵帧）时，抛出 `Stream ended without
finish_reason`。opencode 网关（`https://opencode.ai/zen/go/v1`，路由 `muse-spark-1.2` 模型）恰好发出这种流：每个 `delta` 帧都以 `finish_reason: null` 结尾，流以 `usage` 帧结束且没有终止标记。harness 的 `dsh-llm-pi-ai` 适配器（`packages/llm/llm-pi-ai/src/stream.ts`）把这段错误文案归类为 `TRANSPORT`，于是每次 Muse Spark 生成完成后，在 dsh-repl 里都表现为「生成片刻随即断连」。这是 opencode 网关把非 OpenAI 模型响应转换为 OpenAI SSE 流时的上游 bug（opencode issue #40171、修复 PR #40210）——不是模型本身的缺陷，因此换用其他线上协议（completions 还是 responses）都无法规避。

## 决策

为 pi-ai 的 completions 流打补丁：把「已收集到正文的自然断流」视为正常 `stop`。当适配器走到终止检查处，未见到 `finish_reason` 但内容块非空（`blocks.length > 0`）时，跳过 `Stream ended
without finish_reason` 的抛出，改为推送默认 `stopReason: "stop"` 的正常 `done` 事件。只有内容块为空的自然断流仍然抛出，保留对真正空响应的拦截。

补丁同时落在两处，以覆盖两种运行形态：

- **全局 dsh 安装**（`/opt/homebrew/.../pi-ai/dist/api/openai-completions.js`）：对正在运行的 dsh web / dsh-repl 做一行编辑。直接改这份编译产物不可持久——重装或 `npm update -g` 会覆盖——因此此处只在本说明及相关 README 级文字中记录；持久修复在 workspace 补丁。
- **本仓库**：使用 pnpm 官方补丁机制。依次执行 `pnpm patch @earendil-works/pi-ai` → 编辑 → `pnpm patch-commit`，产出
  `patches/@earendil-works__pi-ai.patch`，并在 `pnpm-workspace.yaml` 的 `patchedDependencies` 登记为 `@earendil-works/pi-ai@0.82.1`。`pnpm install` 会把补丁后的副本实体化到 `.pnpm/...@earendil-works+pi-ai@0.82.1_patch_hash=...`，`packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai` 即解析到它。

## 备选方案

**把模型切换到网关能干净终止的线上协议（responses）。** 不予采用：opencode 网关「SSE 生命周期不完整」的缺陷同时影响其 completions 与 responses 两种转换（用户在 `openai-responses` 下同样复现 `Stream ended without finish_reason`）；换协议不修复传输，只是让失败换个位置。

**只调高 idle/超时参数。** 不予采用：症状是缺少终止事件，不是空闲停顿；超时不会把一个「已完成又被截断」的流判为成功。

**只改全局安装文件。** 不予采用且易碎：编译产物不受版本控制，重装会静默还原。workspace 的 pnpm 补丁才是持久、可审阅的形式，同时也覆盖仓库源码开发。

## 影响

提供方流式自然结束且产出了内容时，现在在全局安装与仓库源码两端都被视为一次成功完成，因此 `muse-spark-1.2`（以及任何省略终止标记的网关）都能端到端跑通。对真正空响应的拦截依旧保留：自然断流且零内容块时仍暴露 `Stream ended without finish_reason` / `TRANSPORT`。待 opencode 网关发布其 SSE 生命周期修复后，本补丁即可移除、恢复冗余；在此之前，对全局 dsh 包执行 `npm update -g` 或重装后，需重新应用那行全局编辑（workspace 的 pnpm 补丁在重装后仍会保留）。

## Supersedes

部分取代 [2026-07-22-pi-ai-transport-truncation-classification](./2026-07-22-pi-ai-transport-truncation-classification.md) 的以下事实：缺终止帧的流不再一律归类为 `TRANSPORT` 错误，而是「有正文时视为正常完成、无正文时才归为 TRANSPORT」。两篇保持交叉链接并存。
