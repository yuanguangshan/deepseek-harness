

这份开发日志结构非常清晰、文风生动（侦探破案隐喻贯穿始终），且**技术复盘极其扎实**。

它不仅完整记录了逆向与代理构建的全过程，还清晰呈现了多个关键的工程洞察（如凭据体系分层、Node 运行时注入、流式强制聚合等）。

---

### 核心脉络与技术拓扑总结

```
[客户端 (weclaw / curl / OpenAI SDK)]
         │ (支持流式 & 非流式 POST /v1/chat/completions)
         ▼
[wb-proxy (127.0.0.1:8487)]
   ├── Token 管理: 读取本地 JWT，基于 mtime 自动热加载
   ├── 协议转换: 强制对上游 stream:true，遇非流式请求在内存中聚合 SSE chunk
   └── 运维指令: `wb-proxy token` 通过 NODE_OPTIONS 注入内置 CLI 一键捕获
         │ (Bearer eyJ... RS256 JWT, TTL=60天)
         ▼
[腾讯上游 (copilot.tencent.com/v2/chat/completions)]
```

---

### 针对文档中「九、遗留悬案（v2 方向）」的工程落地建议

如果您正计划把 `v2` 提上日程，以下是几个可直接落地的思路与代码参考：

#### 1. 破解 `refreshToken` 实现全自动续期
* **抓取思路**：目前 hook 仅抓取了出站 Header，只需在 hook 脚本中劫持 `req.write` / `req.end` 捕获 POST body：
  ```javascript
  // wb-hook-v2.js 片段
  const origWrite = https.request;
  // 劫持 request payload，当 url 包含 /v2/plugin/auth/token/refresh 时记录 body 中的 refreshToken
  ```
* **代理端接入**：在 `wb-proxy` 内部起一个定时器（如每 7 天）或在收到 `401` 时，直接用捕获到的 `refreshToken` 请求 `POST copilot.tencent.com/v2/plugin/auth/token/refresh`，拿到新 JWT 写入文件，实现彻底零人工干预。

#### 2. `/v1/models` 动态化与免费模型自动标记
日志中提到已发现 `GET https://copilot.tencent.com/v3/config` 也使用同一 JWT 鉴权：
* **实现**：`wb-proxy` 启动时及每隔 24 小时后台请求一次 `/v3/config`。
* **解析**：遍历返回的 model 配置数组，过滤出 `credits === 0` 或 `credits === 'x0.00'` 的模型，自动标记 `free: true` 并动态暴露给客户端。

#### 3. 应对 429 的「免费模型自动轮换/Fallback」机制
鉴于免费模型（如 `hy3`、`hunyuan-chat`）存在单模型单日配额限制：
* 可在 proxy 增加配置/请求头扩展，例如支持虚拟模型名 `free-auto`；
* 当 `free-auto` 命中上游 `429` 且返回 `"超出频率限制"` 时，代理内部自动降级尝试候补列表（`['hy3', 'hunyuan-chat', 'hy4-preview']`），对上层调用方完全透明。

---

如果需要将上述任何一个 v2 特性写成具体的 Node.js 实现代码，或需要将此文档整理为正式的技术分享/开源 README，请随时告诉我！
