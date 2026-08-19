# Muse Spark 1.2「一会就断」修复补丁说明

## 问题根因

`muse-spark-1.2` 通过 opencode 网关（`https://opencode.ai/zen/go/v1`）转发时，
**流式 SSE 响应缺少标准的终止帧**（全程 `finish_reason:null`，末尾没有 `data: [DONE]`）。

pi-ai 的 OpenAI-completions 流式解析器在流自然结束时检测不到 `finish_reason`，
抛出 `"Stream ended without finish_reason"`；dsh 的 `llm-pi-ai` 适配器
（`packages/llm/llm-pi-ai/src/stream.ts:52`）将该错误归类为 `TRANSPORT`，
于是 dsh-repl 每次生成完成后立刻断连，表现为「一会就断」。

> 该缺陷为 opencode 网关对非原生 OpenAI 模型「转换流」时的上游 bug
> （opencode 仓库在册 issue #40171、PR #40210），**不是 Muse Spark 模型本身的问题**，
> 也不是接口（completions vs responses）选错 —— response 接口同样受影响。

## 补丁内容

**文件**：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`（第 437 行）

**改动**：让「流已自然结束但缺 `finish_reason`」且**已收集到正文**（`blocks.length > 0`）时，
按正常完成（`stopReason: "stop"`）处理，而不是抛错。

```diff
-            if (!hasFinishReason) {
+            if (!hasFinishReason && blocks.length === 0) {
                 throw new Error("Stream ended without finish_reason");
             }
```

**安全性**：只有「缺终止帧」这一种异常情况被放行；真正无内容的空响应
（`blocks.length === 0`）仍然抛错。正常模型（有 `finish_reason`）完全不受影响。

## 验证结果

用 `dsh-muse-verify.mjs` 直接驱动 pi-ai 流式（真实走补丁逻辑）：

| 模型 | 结果 |
|------|------|
| `muse-spark-1.2`（缺终止帧） | ✅ PASS — clean stop（不再抛 TRANSPORT） |
| `deepseek-v4-flash`（正常模型） | ✅ PASS — clean stop（不受影响） |

## 如何生效

补丁打在全局 dsh 的 pi-ai 编译产物上。**重启 dsh-repl 即生效**（Node 每次启动重新加载模块）。
当前暂无 dsh-repl 在运行，下次启动自动加载新补丁。

## 如何回滚

```sh
# 恢复备份（文件名含时间戳）
cp /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js.bak-muse-* \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
```

## ⚠️ 持久化提醒（重要）

补丁打在全局 npm 安装的 dsh 包内。若以后执行过 **`npm update -g` 或重装 dsh**，
该 pi-ai 文件会被覆盖、补丁丢失。届时需按上述步骤**重新应用补丁**（改动仅一行，见上）。

等 opencode 网关上游发版修复后（见 PR #40210），可移除本补丁。
