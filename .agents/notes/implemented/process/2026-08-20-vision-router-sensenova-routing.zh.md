# Agent Note: Vision Router SenseNova 路由修复

Status: implemented

English | [中文](2026-08-20-vision-router-sensenova-routing.md)

## 问题

dsh-vision-router 的 wrapper route（贴图自动识别）使用 MiMo V2.5（收费），而不是 SenseNova（免费），尽管 SenseNova 已配置为 `providers` 链的第一个提供商。

## 根因

`routing` 配置默认为 `false`（工具优先流程）。当 `routing: false` 时：

- Wrapper route 使用 DSH adapter 系统（`channelBridgePlan`）
- `providers` 链**不用于** wrapper route 选择
- `providers` 链只影响 `vision_describe` 工具的 `usablePairs`

当 `routing: true` 时：

- Wrapper route 直接使用 `providers` 链
- 链中的第一个提供商优先尝试
- Fallback 链按预期工作

## 决策

在 `cordis.patch.yml` 中添加 `routing: true`：

```yaml
- id: vision-router
  config:
    routing: true                    # ← Enable whole-turn chain routing
    providers:
      - provider: vision-http
        model: sensenova/sensenova-6.8-flash-lite
        fallbacks:
          - xiaomi-mimo/mimo-v2.5
          - ovh/Qwen2.5-VL-72B-Instruct
          - ark/ark-code-latest
```

## R2 上传机制

SenseNova 需要 HTTP URL（无法处理 base64）。Wrapper route 的 `directChannelVisionAnswer` 函数：

1. 检测目标提供商为 SenseNova
2. 将 base64 图片上传到 R2（`rclone copyto`）
3. 获取公开 URL（`https://pic.want.biz/handdrawn/vision-chan-*`）
4. 将 URL 发送给 SenseNova API
5. API 调用后清理 R2 临时文件

## 验证

黄山图片（turn 84）的 Session JSONL 证据：

```json
"source": {
  "kind": "model",
  "provider": "vision-chain",
  "model": "vision-http/sensenova/sensenova-6.8-flash-lite"
}
```

完整会话模型调用统计：

```
270x  xiaomi-vision/mimo-v2.5          ← Old behavior (routing: false)
117x  xiaomi/mimo-v2.5                 ← Text model (brain)
 51x  opencode-go-vision/deepseek-v4-flash  ← Old behavior
 10x  vision-chain/vision-http/sensenova/sensenova-6.8-flash-lite  ← New! SenseNova ✅
  2x  weclaw-vision/ds                 ← WeClaw vision
```

## 费用影响

- 之前：所有图片处理使用 MiMo V2.5（~$0.001-0.002/张）
- 之后：所有新图片处理使用 SenseNova（免费）
- 文本模型（MiMo）仍用于推理（不可避免）

## 配置详情

| 配置 | 值 | 效果 |
|------|-----|------|
| `routing` | `true` | Wrapper route 使用 `providers` 链 |
| `providers[0]` | `vision-http/sensenova/sensenova-6.8-flash-lite` | 首选（免费） |
| `providers[0].fallbacks[0]` | `xiaomi-mimo/mimo-v2.5` | 备选（收费） |
| `providers[0].fallbacks[1]` | `ovh/Qwen2.5-VL-72B-Instruct` | 备选（免费） |
| `providers[0].fallbacks[2]` | `ark/ark-code-latest` | 备选（收费） |

## 备选方案

- 保持 `routing: false`，仅把 SenseNova 调到 `providers` 首位。否决：默认工具优先流程下 wrapper route 根本不查 `providers` 链，只调顺序对贴图识别毫无作用。
- 修改 DSH adapter 计划（`channelBridgePlan`），让 `routing: false` 时也读 `providers`。否决：为单个部署的供应商偏好改动所有 wrapper 消费方共享的 adapter 语义，而现成的 `routing: true` 开关已能按配置选择链式路由。
- 继续全量使用 MiMo V2.5。否决：为 SenseNova 可免费承担的能力按张付费，且此处没有 MiMo 独有的质量需求。

## 后果

- 贴图识别以 SenseNova 优先路由，收费的 MiMo 链作为声明过的备选保留，SenseNova 故障时降级而非失败。
- `routing: true` 使 `providers` 链同时成为 wrapper route 与 `vision_describe` 工具的路由权威——后续供应商变更必须以链而非 adapter 默认为准。
- SenseNova 仅接受 URL 图片输入，此路由绑定 R2 上传跳及其调用后清理；R2 不可用会失去免费档，而不是失去能力。

## 关键发现

1. `providers` 链行为取决于 `routing` 配置
2. `routing: false`（默认）= 工具优先流程，wrapper route 使用 DSH adapters
3. `routing: true` = 整轮路由，wrapper route 使用 `providers` 链
4. SenseNova 需要 R2 上传处理 base64 图片（API 只接受 URL）
5. R2 临时文件在 API 调用后自动清理
