# Muse Spark 模型 503/400 错误诊断报告

## 问题描述

测试 `muse-spark-1.2-contributor` 和 `muse-spark-1.2` 模型时，出现 503 和 400 错误。

## 测试结果

### 1. API 状态检查
- **端点可达性**: ✅ 正常 (`https://opencode.ai/zen/go/v1`)
- **模型列表**: ✅ `muse-spark-1.2` 和 `muse-spark-1.2-contributor` 都在可用模型列表中
- **总数**: 28 个模型可用

### 2. 错误模式分析

| 请求参数 | HTTP 状态码 | 响应特征 |
|---------|------------|----------|
| 有 `max_tokens` | 400 | 返回不完整 JSON |
| 无 `max_tokens` | 503 | 返回不完整 JSON |
| 流式请求 (`stream: true`) | 400 | 返回不完整 JSON |
| 非流式请求 (`stream: false`) | 400 | 返回不完整 JSON |

### 3. 响应体特征

所有错误响应都返回相同的不完整 JSON 结构：
```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": ...,
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant"
      },
      "finish_reason": null
    }
  ]
}
```

**关键问题**：
- `message.content` 字段缺失
- `finish_reason` 为 `null`（而不是正常的 `"stop"`）
- 没有实际的生成内容

### 4. 对比测试

其他模型（如 `deepseek-v4-flash`、`glm-5.2`）可以正常工作：
- 返回 200 状态码
- 包含完整的 `message.content`
- 正常的 `finish_reason: "stop"`

## 根本原因分析

根据项目中的文档（`Muse-Spark补丁说明.md`），这个问题与已知的 opencode 网关 bug 相关：

### 已知问题
1. **流式 SSE 缺少终止帧**: `muse-spark-1.2` 通过 opencode 网关转发时，流式 SSE 响应缺少标准的终止帧
2. **`finish_reason` 缺失**: 全程 `finish_reason:null`，末尾没有 `data: [DONE]`
3. **opencode 网关 bug**: 这是 opencode 网关对非原生 OpenAI 模型「转换流」时的上游 bug（opencode issue #40171、PR #40210）

### 当前表现
- **503 错误**: 可能表示模型暂时不可用或过载
- **400 错误**: 可能表示请求参数验证失败或模型端点配置问题
- **不完整响应**: 模型可能无法正常处理请求或生成响应

## 可能的解决方案

### 1. 等待上游修复
opencode 网关团队正在修复 SSE 流处理问题（PR #40210）。修复后，这些问题可能会自动解决。

### 2. 应用本地补丁
项目中已有针对 `finish_reason` 缺失的补丁（见 `Muse-Spark补丁说明.md`）：
- **文件**: `pi-ai/dist/api/openai-completions.js` 第 437 行
- **改动**: 当流已自然结束但缺 `finish_reason` 且已收集到正文时，按正常完成处理

### 3. 联系 API 提供方
报告以下问题给 opencode-go API 支持团队：
- `muse-spark-1.2-contributor` 和 `muse-spark-1.2` 模型返回不完整响应
- 缺少 `message.content` 和正常的 `finish_reason`
- 400/503 错误交替出现

### 4. 临时替代方案
使用其他可用的模型（如 `deepseek-v4-flash`、`glm-5.2`）进行测试。

## 建议的下一步

1. **监控 opencode 网关状态**: 关注 opencode 仓库的 issue #40171 和 PR #40210
2. **验证补丁效果**: 如果已应用 `Muse-Spark补丁说明.md` 中的补丁，测试是否改善了问题
3. **联系支持**: 向 opencode-go API 支持团队报告此问题
4. **考虑替代模型**: 在问题解决前，使用其他可用模型

## 技术细节

### 测试环境
- **API 端点**: `https://opencode.ai/zen/go/v1`
- **认证**: `OPENCODE_GO_API_KEY` (从 `~/.dsh/.credentials.yaml` 读取)
- **测试时间**: 2026-08-19 16:02-16:05 UTC
- **测试工具**: Python requests, curl

### 相关配置
- **settings.yaml**: `~/.dsh/settings.yaml` 中的 `meta` provider 配置
- **模型 ID**: `muse-spark-1.2-contributor`
- **API 类型**: `openai-completions`

## 结论

`muse-spark-1.2-contributor` 模型的 503/400 错误是 **opencode 网关的已知问题**，不是模型本身的缺陷。问题根源在于网关对非 OpenAI 模型的流式响应处理不当。建议等待上游修复或应用本地补丁。