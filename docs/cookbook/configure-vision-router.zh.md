# 配置 Vision Router：SenseNova 免费视觉链

[English](configure-vision-router.md) | 中文

本文档说明如何配置 dsh-vision-router 插件，使 wrapper route（贴图自动识别）优先使用 SenseNova（免费），而不是默认的 MiMo（收费）。

## 问题背景

dsh-vision-router 的 wrapper route 负责处理用户粘贴的图片。默认情况下，它使用 DSH adapter 系统选择视觉模型，绕过 `providers` 配置链。

## 解决方案

在 `cordis.patch.yml` 中设置 `routing: true`，使 wrapper route 使用 `providers` 配置链。

### 配置步骤

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加或修改 vision-router 配置：

```yaml
- id: vision-router
  config:
    routing: true                    # Key: enable whole-turn chain routing
    providers:
      - provider: vision-http
        model: sensenova/sensenova-6.8-flash-lite
        fallbacks:
          - xiaomi-mimo/mimo-v2.5
          - ovh/Qwen2.5-VL-72B-Instruct
          - ark/ark-code-latest
    httpProviders:
      - name: sensenova
        baseURL: https://token.sensenova.cn/v1
        model: sensenova-6.8-flash-lite
        apiKeyEnv: SENSENOVA_API_KEY
        maxTokens: 16384
      - name: xiaomi-mimo
        baseURL: https://api.xiaomi.com/v1
        model: mimo-v2.5
        apiKeyEnv: MIMO_API_KEY
      - name: ovh
        baseURL: https://api.ovhcloud.com/v1
        model: Qwen2.5-VL-72B-Instruct
        apiKeyEnv: OVH_API_KEY
      - name: ark
        baseURL: https://api.ark.cn/v1
        model: ark-code-latest
        apiKeyEnv: ARK_API_KEY
```

### 配置说明

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `routing` | `true` | 启用整轮链路由，wrapper route 使用 `providers` 链 |
| `providers[0]` | `vision-http/sensenova/sensenova-6.8-flash-lite` | 首选视觉模型（免费） |
| `providers[0].fallbacks` | MiMo → OVH → Ark | 备选模型链 |

### R2 上传机制

SenseNova 只接受 HTTP URL，不接受 base64 图片。Wrapper route 会自动：

1. 检测目标提供商为 SenseNova
2. 将 base64 图片上传到 R2 存储桶
3. 获取公开 URL（`https://pic.want.biz/handdrawn/vision-chan-*`）
4. 将 URL 发送给 SenseNova API
5. API 调用后自动清理 R2 临时文件

### 环境变量

确保以下环境变量已设置：

```bash
export SENSENOVA_API_KEY="your-sensenova-api-key"
export MIMO_API_KEY="your-mimo-api-key"
export OVH_API_KEY="your-ovh-api-key"
export ARK_API_KEY="your-ark-api-key"
```

或在 `~/.dsh/.credentials.yaml` 中配置。

## 验证配置

### 1. 重启 DSH Web

```bash
/web-restart
```

### 2. 测试图片识别

在聊天界面粘贴一张图片，询问"详细描述图片"。

### 3. 检查 Session 日志

查看 session JSONL 文件，确认视觉模型调用：

```bash
zstdcat ~/.dsh/sessions/<session-id>/session.jsonl.zstd | grep "vision-chain"
```

应看到类似输出：

```json
"source": {
  "kind": "model",
  "provider": "vision-chain",
  "model": "vision-http/sensenova/sensenova-6.8-flash-lite"
}
```

### 4. 检查 R2 临时文件

```bash
rclone ls r2:yuangs/handdrawn/ --max-age 1h
```

调用完成后，`vision-chan-*` 临时文件应已自动清理。

## 费用对比

| 模型 | 费用 | 说明 |
|------|------|------|
| SenseNova | 免费 | 首选视觉模型 |
| MiMo V2.5 | ~$0.001/张 | 备选视觉模型 |
| OVH Qwen2.5-VL | 免费 | 备选视觉模型 |
| Ark | ~$0.001/张 | 备选视觉模型 |

## 故障排除

### SenseNova 不可用

如果 SenseNova API 调用失败，会自动 fallback 到 MiMo：

1. 检查 `SENNOVA_API_KEY` 是否正确设置
2. 检查网络连接
3. 查看 DSH 日志：`~/.dsh/logs/vision-router/vision-router.log`

### 图片未被识别

确保：

1. `routing: true` 已设置
2. 当前会话使用的是「+ 自动识图」模型组
3. 图片格式受支持（PNG、JPEG、WebP、GIF）

### R2 上传失败

检查：

1. rclone 配置正确（`r2:yuangs/handdrawn/`）
2. R2 凭据有效
3. 网络连接正常

## 相关文档

- [dsh-vision-router GitHub](https://github.com/ysr666/dsh-vision-router)
- [Agent Note: Vision Router SenseNova Routing Fix](../../.agents/notes/implemented/process/2026-08-20-vision-router-sensenova-routing.zh.md)
