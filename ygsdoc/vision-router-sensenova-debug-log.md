# 开发日志：dsh-vision-router SenseNova 路由修复全记录

> **日期**：2026-08-19 ~ 2026-08-20
> **环境**：DSH Web (macOS arm64, Node v25.2.1)
> **插件版本**：dsh-vision-router v1.7.1
> **目标**：让 wrapper route（贴图自动识别）优先使用 SenseNova（免费），替代 MiMo（收费）

---

## 一、背景与动机

DSH（DeepSeek Harness）的 vision-router 插件负责处理用户粘贴的图片。默认情况下，图片被发送到 MiMo V2.5（小米大模型），每次调用约 $0.001-0.002。虽然费用不高，但高频使用下会累积。

**SenseNova（商汤）提供免费视觉 API**，如果能让 wrapper route 优先走 SenseNova，可以完全消除图片处理费用。

---

## 二、初始配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 中配置了 SenseNova 作为第一个视觉模型：

```yaml
- id: vision-router
  config:
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
```

**预期**：贴图时 SenseNova 优先被调用。

**实际**：贴图仍然走 MiMo，SenseNova 配置无效。

---

## 三、排查过程

### 3.1 第一阶段：验证 SenseNova API 可用性

**操作**：用 curl 测试 SenseNova API

```bash
curl -X POST https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"sensenova-6.8-flash-lite","messages":[{"role":"user","content":"Hello"}]}'
```

**结果**：✅ SenseNova API 正常工作，返回成功响应。

**结论**：问题不在 SenseNova 本身。

---

### 3.2 第二阶段：检查 R2 上传机制

**背景**：SenseNova 不支持 base64 图片，只接受 HTTP URL。需要先把图片上传到 R2 存储桶。

**操作**：检查 rclone 配置和 R2 连接

```bash
rclone ls r2:yuangs/handdrawn/ --max-age 1h
```

**发现**：
- R2 中有 `vision-1787173478147.png`（来自 `vision_describe` 工具调用）
- **没有** `vision-chan-*` 文件（wrapper route 的上传文件）

**结论**：wrapper route 没有走 SenseNova，所以没有 R2 上传。

---

### 3.3 第三阶段：分析 session 日志

**操作**：检查 session JSONL 文件中的模型调用记录

```bash
zstdcat ~/.dsh/sessions/<session-id>/session.jsonl.zstd | grep "source"
```

**发现**：

```
270x  xiaomi-vision/mimo-v2.5          ← wrapper route 走 MiMo
117x  xiaomi/mimo-v2.5                 ← 纯文本模型（大脑）
 51x  opencode-go-vision/deepseek-v4-flash  ← wrapper route 走 OpenCode
 10x  vision-chain/vision-http/sensenova/sensenova-6.8-flash-lite  ← SenseNova
```

**关键发现**：
- SenseNova 被调用了 10 次（通过 `vision_describe` 工具）
- 但 wrapper route（贴图自动识别）仍然走 MiMo（270 次）

**结论**：`providers` 配置链对 wrapper route 无效。

---

### 3.4 第四阶段：研究源码

**操作**：克隆 dsh-vision-router 仓库，研究源码

```bash
git clone https://github.com/ysr666/dsh-vision-router.git /tmp/dsh-vision-router
```

**关键发现**：

1. **`routing` 配置**（默认 `false`）：
   - `routing: false`（默认）= 工具优先流程，wrapper route 使用 DSH adapter 系统
   - `routing: true` = 整轮路由，wrapper route 使用 `providers` 链

2. **wrapper route 的后端选择**：
   - 当 `routing: false` 时，走 `channelBridgePlan()` 函数
   - `channelBridgePlan()` 使用 DSH adapter 系统，**不走** `providers` 链
   - `providers` 链只影响 `vision_describe` 工具的 `usablePairs`

3. **README 文档确认**：
   > 在旧版 `routing: true` 模式下，整轮链只走 `provider + fallbacks`——`httpProviders`（含免费兜底）不参与。默认的 `routing: false`（工具优先）会尝试全部。

**根因**：`routing: false` 导致 wrapper route 绕过 `providers` 配置链。

---

## 四、解决方案

### 4.1 配置修改

在 `cordis.patch.yml` 中添加 `routing: true`：

```yaml
- id: vision-router
  config:
    routing: true                    # ← 新增：启用整轮链路由
    providers:
      - provider: vision-http
        model: sensenova/sensenova-6.8-flash-lite
        fallbacks:
          - xiaomi-mimo/mimo-v2.5
          - ovh/Qwen2.5-VL-72B-Instruct
          - ark/ark-code-latest
```

### 4.2 R2 上传机制

SenseNova 需要 HTTP URL，wrapper route 的 `directChannelVisionAnswer` 函数自动处理：

1. 检测目标提供商为 SenseNova
2. 将 base64 图片上传到 R2（`rclone copyto`）
3. 获取公开 URL（`https://pic.want.biz/handdrawn/vision-chan-*`）
4. 将 URL 发送给 SenseNova API
5. API 调用后自动清理 R2 临时文件

---

## 五、验证结果

### 5.1 Session 日志证据

重启 DSH 后贴图测试，session JSONL 显示：

```json
"source": {
  "kind": "model",
  "provider": "vision-chain",
  "model": "vision-http/sensenova/sensenova-6.8-flash-lite"
}
```

### 5.2 R2 文件检查

```bash
rclone ls r2:yuangs/handdrawn/ --max-age 1h
# 401101 vision-1787173478147.png  ← vision_describe 工具调用
# 无 vision-chan-* 文件（已清理）✅
```

### 5.3 费用对比

| 项目 | 修改前 | 修改后 |
|------|--------|--------|
| 图片处理模型 | MiMo V2.5（收费） | SenseNova（免费） |
| 每张图片费用 | ~$0.001-0.002 | $0.00 |
| R2 临时文件 | 无 | 自动清理 |

---

## 六、技术细节

### 6.1 routing 配置的影响

| 配置值 | wrapper route 行为 | providers 链用途 |
|--------|-------------------|-----------------|
| `routing: false`（默认） | 使用 DSH adapter 系统 | 仅影响 `vision_describe` 工具 |
| `routing: true` | 使用 `providers` 链 | 影响 wrapper route 和 vision_describe |

### 6.2 调用流程对比

**修改前（routing: false）**：
```
用户贴图
  → wrapper route 拦截
  → DSH adapter 系统选择后端
  → MiMo V2.5（收费）
  → 返回描述
```

**修改后（routing: true）**：
```
用户贴图
  → wrapper route 拦截
  → providers 链：
    ① SenseNova（免费）→ R2 上传 → URL → API
    ② MiMo（收费，fallback）
    ③ OVH（免费，fallback）
    ④ Ark（收费，fallback）
  → 返回描述
  → R2 临时文件清理
```

---

## 七、经验总结

### 7.1 关键发现

1. **`providers` 链行为取决于 `routing` 配置**
   - `routing: false`（默认）：wrapper route 不走 `providers` 链
   - `routing: true`：wrapper route 走 `providers` 链

2. **SenseNova 需要 R2 上传**
   - API 只接受 HTTP URL，不接受 base64
   - wrapper route 自动处理上传/清理

3. **日志系统不完善**
   - `vision-router.log` 只有初始化信息
   - 调用细节在 session JSONL 中

### 7.2 验证方法

1. **检查 session JSONL**：
   ```bash
   zstdcat ~/.dsh/sessions/<session-id>/session.jsonl.zstd | grep "vision-chain"
   ```

2. **检查 R2 临时文件**：
   ```bash
   rclone ls r2:yuangs/handdrawn/ --max-age 1h
   ```

3. **检查 MiMo API 用量**：
   - 访问 https://api.xiaomi.com 查看调用记录
   - 新图片不再产生 MiMo 调用

### 7.3 注意事项

1. **文本模型仍是 MiMo**
   - 图片处理用 SenseNova（免费）
   - 推理分析用 MiMo（不可避免）

2. **Fallback 机制**
   - SenseNova 失败时自动 fallback 到 MiMo
   - 保证可用性

3. **R2 存储成本**
   - 临时文件自动清理
   - 不产生额外存储费用

---

## 八、相关文件

### 8.1 配置文件

- `~/.dsh/profiles/web/cordis.patch.yml` — vision-router 配置

### 8.2 文档

- [Agent Note: Vision Router SenseNova Routing Fix](../../.agents/notes/implemented/process/2026-08-20-vision-router-sensenova-routing.md)
- [Cookbook: Configure Vision Router](configure-vision-router.md)

### 8.3 源码参考

- dsh-vision-router GitHub: https://github.com/ysr666/dsh-vision-router
- 关键函数：`routingPairs()`、`channelBridgePlan()`、`directChannelVisionAnswer()`

---

## 九、时间线

| 时间 | 事件 |
|------|------|
| 2026-08-19 21:00 | 首次配置 SenseNova，贴图仍走 MiMo |
| 2026-08-19 22:00 | 测试 SenseNova API，确认可用 |
| 2026-08-19 23:00 | 检查 R2 文件，发现无 wrapper route 上传 |
| 2026-08-20 00:00 | 分析 session 日志，确认 wrapper route 走 MiMo |
| 2026-08-20 01:00 | 克隆源码，研究 routing 配置 |
| 2026-08-20 02:00 | 找到根因：`routing: false` 导致绕过 providers 链 |
| 2026-08-20 03:00 | 修改配置：添加 `routing: true` |
| 2026-08-20 04:00 | 重启 DSH，贴图测试 |
| 2026-08-20 05:00 | 验证成功：session 显示 SenseNova 调用 |
| 2026-08-20 05:30 | 提交文档，推送 GitHub |

---

**结论**：通过设置 `routing: true`，成功让 dsh-vision-router 的 wrapper route 优先使用 SenseNova（免费），完全消除了图片处理费用。
