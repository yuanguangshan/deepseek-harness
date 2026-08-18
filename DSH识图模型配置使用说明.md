# DSH Web 识图模型配置使用说明

> 适用：DeepSeek Harness (DSH) Web，配合 `dsh-vision-router` 插件
> 更新：2026-08-17

## 一、目标配置（一句话）

- **文字对话轮** → `opencode-go / deepseek-v4-flash`（纯文本，1M 上下文，便宜）
- **图片识别（识图轮 / vision 工具）** → `sensenova-6.8-flash-lite`（视觉模型，免费）

即：**文字走 opencode，图片走 sensenova。**

---

## 二、为什么这样分工

各模型能力实测如下：

| 模型 | 走哪个接入 | 图像输入 | 用途 |
|---|---|---|---|
| `deepseek-v4-flash` | opencode-go / sensenova | ❌ 纯文本 | 文字对话轮 |
| `sensenova-6.8-flash-lite` | sensenova（Vision HTTP） | ✅ 视觉 | 识图（免费） |
| `sensenova-6.7-flash-lite` | sensenova | ✅ 视觉 | 识图（备用） |
| `ark-code-latest` | Volcengine Ark | ✅ 视觉 | 识图兜底 |
| `Qwen2.5-VL-72B-Instruct` | OVH（匿名） | ✅ 视觉 | 识图末位兜底 |

关键事实：**deepseek-v4-flash 无论走 opencode-go 还是 sensenova，都是纯文本模型**，实测其对 OpenAI 的 `image_url` 请求直接报 `unknown variant image_url`，因此不能真正识图。识图必须由 sensenova 系视觉模型承担。

---

## 三、配置文件位置与结构

配置文件：`~/.dsh/profiles/web/cordis.patch.yml`

### providers：整轮自动识图时切换到哪个模型（第一项优先）

```yaml
providers:
  - provider: vision-http
    model: sensenova/sensenova-6.8-flash-lite
    fallbacks:
      - ark/ark-code-latest
      - ovh/Qwen2.5-VL-72B-Instruct
```

> 作用：当图片进入会话后，那一轮会整轮切到 visual chain 的第一项（sensenova）看图。
> 模型 id 格式是 `httpProvider名称/模型名`，必须与下方 `httpProviders` 里的 `name`+`model` 完全对应，否则命中不了。

### httpProviders：vision_describe 等视觉工具内部的识别链（按顺序尝试）

```yaml
httpProviders:
  - name: sensenova
    baseURL: https://token.sensenova.cn/v1
    model: sensenova-6.8-flash-lite
    apiKeyEnv: SENSENOVA_API_KEY
    maxTokens: 16384
  - name: ark
    baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
    model: ark-code-latest
    apiKeyEnv: ARK_API_KEY
    maxTokens: 16384
  - name: ovh
    baseURL: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
    model: Qwen2.5-VL-72B-Instruct
    apiKeyEnv: ''
    maxTokens: 16384
```

### wrappedProviders：把纯文本路由登记为"自动识图"孪生条目（可选）

```yaml
wrappedProviders:
  - provider: opencode-go
    models:
      - deepseek-v4-flash
```

> 与官方预置的 `deepseek-official` 平级。作用是让 `opencode-go` 的 deepseek-v4-flash
> 也出现在模型选择器里（显示为"opencode-go + 自动识图"），带图上下文用它不报错。
> 需要重启 DSH 才生效。

文字轮默认模型在 `~/.dsh/settings.yaml`：

```yaml
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-flash
```

---

## 四、两条识图路径，别搞混

### 路径一（推荐，默认生效）：不选孪生条目

会话文字轮保持 `opencode-go / deepseek-v4-flash`：

| 场景 | 走谁 |
|---|---|
| 文字对话轮 | deepseek-v4-flash（opencode-go） |
| 收到图片的那一轮 | 自动整轮切到 sensenova-6.8 看图 |
| 对话中调 vision_describe 等视觉工具 | 走 sensenova |

**这才是"文字走 opencode、图片走 sensenova"的效果，且不用手动操作。**

### 路径二：手动选了"opencode-go + 自动识图"孪生条目

| 场景 | 走谁 |
|---|---|
| 文字对话轮 | 委托给 deepseek-v4-flash 原样处理 |
| 收到图片那一轮 | 图片被改写成文本提示，**不会走 sensenova**（deepseek 纯文本喂不进像素）|

> ⚠️ 路径二**不是**"文字 opencode、图片 sensenova"。它只是为了"文本模型想在图片上下文里不报错"的凑合用法。真正看图仍需模型主动调 vision 工具。
> **除非你明确想要手动选模型，否则保持路径一即可。**

---

## 五、验证配置是否生效

1. 运行中的 DSH 进程（监听 3080）会加载 `~/.dsh/profiles/web/cordis.patch.yml`。
2. 用 `lsof -p <PID>` 看进程打开的 cordis.patch.yml inode 是否等于磁盘当前文件 inode —— 一致则说明加载的是最新配置。
3. 重启后检查模型选择器是否出现"opencode-go + 自动识图"（证明 wrappedProviders 生效）。

---

## 六、常见问题

- **改了配置不生效？** vision-router 启动时读配置，改完要**重启 DSH Web**。重启后去模型选择器/插件配置卡片确认。
- **deepseek-v4-flash 能不能识图？** 不能，纯文本。别指望它直接看图。
- **识别结果不准/超时？** 确认 `SENSENOVA_API_KEY` 在根 `.env` 里；检查 httpProviders 顺序是否 sensenova 最前；`maxTokens` 不足时识别长图会截断，可调大。
- **want.biz 与 sensenova 的区别？** `~/.dsh/settings.yaml` 里的 weclaw provider 指向 `https://wx.want.biz/v1`（另一个聚合网关）；识图用的 sensenova 是 `https://token.sensenova.cn/v1`，两者不同。
