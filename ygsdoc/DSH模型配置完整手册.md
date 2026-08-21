# DeepSeek Harness 模型配置完整手册

> 沉淀：2026-08-19 · 广山哥专用 · 照抄不踩坑
> 适用：`@deepseek-ai/dsh-llm-pi-ai`（pi-ai 适配器）+ `dsh-llm-deepseek`
> 目标：以后新增/切换模型，按此手册一步到位，不再反复试错。

---

## 0. 一句话结论

DSH 的模型不是「填个 key 和 URL 就能跑」，而是 **「路由（provider key）→ 协议（api）→ 端点（baseURL）→ 模型清单（models）→ 凭证（apiKeyEnv）→ 默认模型（agent-default-model）」六件套必须对齐**，少一件或错一件就 400/401/UNKNOWN_MODEL/TRANSPORT。

---

## 1. 配置分几层、在哪几个文件

| 层 | 文件 | 作用 | 谁写入 |
|---|---|---|---|
| **Composition Base** | `cordis.yml` / `cordis.patch.yml`（随 profile） | 插件的初始 `providers: {}`，出厂默认。当前官方 composition 是 **dormant 空路由**，把决定权完全交给用户层 | 开发者/打包时 |
| **User Layer** | `~/.dsh/settings.yaml` 的 `llm-pi-ai:` 段 | **唯一应该手工改的地方**。与 Base 按 provider key 逐 key 合并，无需重启编译，重启进程即生效 | 你 |
| **Credentials** | `~/.dsh/.credentials.yaml` + 根 `.env` | 存真实 Key。`settings.yaml` 里只写 `apiKeyEnv: xxx` 引用名，不写明文 | 你 |
| **Vision 专用** | `~/.dsh/profiles/web/cordis.patch.yml` 的 `vision-router` 段 | 识图链路（`providers`/`httpProviders`/`wrappedProviders`），与 `llm-pi-ai` 完全独立 | 你 |

**合并规则（必知）：**
- `providers` 是 **dict**（`key = 路由名`），不是 array。旧的 `[{provider: "xxx"}]` 写法已废弃，一写就 `providers is now a dict` 报错。
- User Layer 与 Base **按 key 合并**，可新增路由、可覆盖单字段、可改 baseURL；但**不能删除 Base 已有的 key/字段**（无 delete 语义），`reasoningEfforts` 的某个 level 一旦在 Base 声明，User 层去不掉，只能覆盖。
- `models` 一旦声明就是 **Replace（替换整份 Catalog）**，不是 Append。只写一个 id，Catalog 里其他 30 多个模型就全丢了。

---

## 2. `llm-pi-ai` 单个 provider 的完整字段

以 `~/.dsh/settings.yaml` 为例：

```yaml
llm-pi-ai:
  providers:
    <routeKey>:          # ← 就是 provider 名，也是选模型时的 provider 字段
      displayName: xxx   # 可选，UI 显示名，默认 = routeKey
      api: openai-completions  # 协议，见 §3
      baseURL: https://.../v1  # 端点
      apiKeyEnv: OPENCODE_GO_API_KEY  # 凭证引用名（见 §6）
      models:            # 模型清单，见 §4
        - id: deepseek-v4-flash
          name: DeepSeek V4 Flash
          contextWindow: 1000000
          maxTokens: 384000
          input: [text]  # 或 [text, image]（视觉模型）
          reasoningEfforts: { off: null, high: high } # 可选
          compat: { thinkingFormat: deepseek }        # 可选
      modelOverrides:    # 另一种写法，见 §4
        deepseek-v4-pro:
          reasoningEfforts: { off: null, high: high }
      compat: { thinkingFormat: deepseek } # 路由级默认
      defaultContextWindow: 262144   # 兜底，未在 models/catalog 中声明尺寸的模型用它
      defaultMaxTokens: 32768
      defaultInput: [text]           # 兜底 modalities
      headers: { }                   # 额外请求头（别把 Authorization 放这）
      reasoning: high                # 路由级默认推理档位
      streamIdleTimeoutMs: 300000    # 流空闲超时，默认 5min
      timeoutMs: 60000
      retryPolicy: { mode: normal, maxRetries: 3 }
```

> 全部可配字段：`apiKeyEnv, displayName, api, baseURL, models, modelOverrides, compat, defaultContextWindow, defaultMaxTokens, defaultInput, headers, reasoning, thinkingBudgets, cacheRetention, transport, timeoutMs, websocketConnectTimeoutMs, streamIdleTimeoutMs, retryPolicy` — 详见 `packages/llm/llm-pi-ai/README.md`。

---

## 3. `api` 协议选型（最常错）

`api` 决定走哪条 wire 协议。pi-ai 内部每种协议对 endpoint、鉴权、模型发现的实现都不同。

| 值 | 含义 | 何时用 |
|---|---|---|
| `openai-completions` | OpenAI Chat Completions (`/chat/completions` + SSE) | **默认首选**。opencode 网关、DeepSeek 官方、绝大多数 OpenAI 兼容网关都走它 |
| `openai-responses` | OpenAI Responses (`/responses`) | 仅当上游**明确支持** Responses 时才用。opencode-go **不支持** |
| `anthropic-messages` | Anthropic Messages | 仅 Anthropic 原生或明确兼容的网关 |
| 其他（`google-generative-ai` 等） | 见 `supportedProtocols()` | 私有网关一般不用 |

**血泪教训：**
- `mimo-v2.5` 在 `opencode-go` 上配 `api: openai-responses` → 上游直接 `400 / Error from provider (Console Go): Upstream ...`。**根因：opencode-go 不实现 `/responses`**（官网已确认）。修复：改回 `openai-completions`。
- 私有网关 URL（如 `https://proxy.example.com:8443`）无法让 pi-ai 自动猜对 `compat.thinkingFormat`，必须显式配 `compat.thinkingFormat`。

**规则：**
- Catalog 路由（pi-ai 已内置的 provider，如 `deepseek`/`openai`/`anthropic`）可省略 `api`，沿用 Catalog 协议。
- **手写路由**（pi-ai 没内置的 key，如 `xiaomi`/`meta`/`acme-gateway`）**必须**显式声明 `api` + `baseURL` + 非空 `models`，否则 `assertServiceable` 直接 `settings-rejected`。

---

## 4. `models` vs `modelOverrides`（第二大坑）

| 写法 | 语义 | 适用场景 |
|---|---|---|
| `models: [{id, ...}]` | **替换**整份 Catalog。该路由最终只认你列出的这些模型，漏写的就没了 | 手写路由（必须）；或想把 Catalog 精简到 1-2 个模型 |
| `modelOverrides: { <catalogId>: {…} }` | **原地 patch** Catalog 中某一个模型，其余 30+ 模型原样保留 | 只改 1 个模型的 `reasoningEfforts`/`contextWindow` 等，不想重列全表 |
| 两个都不写 | 直接透传 Catalog 全量 | 纯透传官方路由 |

**禁止组合：**
- `models` 与 `modelOverrides` **不能同存**于同一路由
- `modelOverrides` 的 key 必须是 Catalog 中已存在的 id，否则 `settings-rejected`
- `modelOverrides` 在手写路由上无意义（手写路由没有 Catalog 可 patch）

**示例：**
```yaml
# ✅ 只改一个模型，保留其他 37 个
deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  modelOverrides:
    deepseek-v4-pro:
      reasoningEfforts: { off: null, high: high }

# ✅ 手写网关：必须全量声明
xiaomi:
  api: openai-completions
  baseURL: https://opencode.ai/zen/go/v1
  apiKeyEnv: OPENCODE_GO_API_KEY
  models:
    - id: mimo-v2.5
      name: MiMo V2.5
      contextWindow: 1000000
      maxTokens: 384000
      input: [text]
```

---

## 5. 为什么 `xiaomi` / `meta` 要拆独立 provider

当前 `~/.dsh/settings.yaml` 现状（2026-08-19）：

```yaml
opencode-go: { api: openai-completions, baseURL: https://opencode.ai/zen/go/v1, models: [deepseek-v4-flash, deepseek-v4-pro] }
xiaomi:      { api: openai-completions, baseURL: https://opencode.ai/zen/go/v1, models: [mimo-v2.5] }
meta:        { api: openai-completions, baseURL: https://opencode.ai/zen/go/v1, models: [muse-spark-1.2-contributor] }
weclaw:      { api: openai-completions, baseURL: https://wx.want.biz/v1, models: [几十个聚合模型] }
```

**拆分原因：**
1. `opencode-go` 原本混配 `deepseek-v4-flash` + `mimo-v2.5`，但 `mimo` 的协议/兼容性与 DeepSeek 不同，混在一个路由里要么全用 `openai-responses`（mimo 不支持→400），要么全用 `openai-completions`（当时误配成 responses）。拆成 `xiaomi` 后各走各的 `api`，互不干扰。
2. `meta:muse-spark` 单独路由是为了隔离「缺 `finish_reason`」补丁的影响面，且避免 `models` 替换时误删 `opencode-go` 的 DeepSeek 模型。
3. `weclaw` 是另一个网关（`wx.want.biz`），与 `opencode.ai` 物理隔离，必须独立路由。

> 结论：**不同模型家族 / 不同网关 / 不同协议，一律拆独立 provider key**，别为省几行 YAML 把不兼容的模型塞同一路由。

---

## 6. 凭证 `apiKeyEnv`（第三大坑）

```yaml
# settings.yaml 只写引用名
apiKeyEnv: OPENCODE_GO_API_KEY

# 真实值在 ~/.dsh/.credentials.yaml 或根 .env
OPENCODE_GO_API_KEY: sk-xxxx
WECLAW_API_KEY: weclaw@ygs
ARK_API_KEY: xxx
SENSENOVA_API_KEY: xxx
```

**规则：**
- `apiKeyEnv` 写的是**环境变量名**，不是 key 明文。
- 同一路由下所有模型共用一个凭证。
- `apiKeyEnv` 省略 → 走 pi-ai 的 **ambient 发现**（读进程环境变量如 `AZURE_OPENAI_API_KEY` / `AWS_PROFILE` 等）。这对 `deepseek` 等官方路由有效，对私有网关通常意味着**无鉴权→401**。
- `apiKeyEnv` 写了但解析为空 → `MISSING_CREDENTIAL`（fail-loud，不会静默 fallback 到别的 key，防止用错 key）。
- `apiKeyEnv` 指向的值含不可做 HTTP header 的字符 → `INVALID_CREDENTIAL`（在 `fetch` 之前就拦住，避免 `TypeError: ByteString` 这种看不懂的报错）。
- **不要**把 `Authorization: Bearer xxx` 写进 `headers` 字段 — `headers` 的内容会原样出现在 `describe()` 脱敏视图里，等于明文泄露。永远走 `apiKeyEnv`。

**当前凭证映射：**

| provider | apiKeyEnv | 实际指向 |
|---|---|---|
| `opencode-go` / `xiaomi` / `meta` | `OPENCODE_GO_API_KEY` | `sk-...`（opencode 套餐总 key） |
| `weclaw` | `WECLAW_API_KEY` | `weclaw@ygs` |
| `sensenova`（识图） | `SENSENOVA_API_KEY` | 存于根 `.env` |

---

## 7. `agent-default-model`（默认模型）

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: meta-vision   # 或 opencode-go / xiaomi / meta / weclaw，必须是 llm-pi-ai 中已声明的 routeKey
  model: muse-spark-1.2-contributor  # 必须是该 provider.models 中存在的 id，大小写敏感
```

**坑：**
- `provider` 写错 → 启动即 `UNKNOWN_PROVIDER`
- `model` 写错 → 请求前 `UNKNOWN_MODEL`（fail-loud，不会静默回退）
- 改完 `settings.yaml` 后，**重启** `dsh-web` / `dsh-repl` 才生效（`dsh-web restart` 或 `~/bin/dsh-web.sh restart`）

---

## 8. 推理模型 `reasoningEfforts` 与 `compat`

仅对 `openai-completions` 协议有效。

```yaml
models:
  - id: acme-think
    reasoningEfforts:
      off: null      # 声明 off 且空值 → 选中 off 时不发 reasoning 参数（显式关闭思考）
      high: high     # key=可选项名, value=线上拼写
      max: ultra     # 可重命名，适配网关方言
    compat:
      thinkingFormat: deepseek  # deepseek / openai / zai 等，纠正 URL 猜错的方言
      supportsReasoningEffort: true
```

- `reasoningEfforts: false` → 声明该模型**不支持推理**（剥掉 Catalog 里的推理能力）
- 省略 `reasoningEfforts` → 沿用 Catalog；手写模型省略则为**无推理**
- `compat.thinkingFormat` 接受除 `chat-template` 两个变体外的所有 pi-ai 格式
- 路由级 `compat` 会覆盖该路由下所有 `openai-completions` 模型的对应字段

---

## 9. 验证是否生效（必做）

```sh
# 1. 看当前生效的 settings
cat ~/.dsh/settings.yaml

# 2. 看凭证是否就位（只看 key 名，不打印明文）
cat ~/.dsh/.credentials.yaml | sed 's/:.*/: ***/'
cat .env | grep -E 'API_KEY|WECLAW'

# 3. 重启生效
dsh-web restart          # 或 ~/bin/dsh-web.sh restart
# TUI: 退出重进

# 4. 发一句真实对话验证（选对应 provider/model）
# Web UI 模型选择器应出现新 provider/model；或
pnpm dsh --profile web "hello"   # 走 web profile 的默认模型
```

---

## 10. 常见报错速查表

| 报错原文 | 根因 | 修复 |
|---|---|---|
| `no adapter registered for provider "xxx"`（换哪个 provider 都炸） | `settings.yaml` 存在 YAML 语法错误（如 `size:88` 缺空格），整份文件解析失败 → llm-pi-ai User Layer 全部丢失 → 所有路由 dormant。报错点在 TUI 初始化，离案发段很远 | 先跑 `node -e "require('yaml').parse(require('fs').readFileSync('$HOME/.dsh/settings.yaml','utf8'))"` 定位语法行，修复后重启 TUI。详见《开发大坑_settings.yaml一个空格炸全部模型路由_2026-08-21.md》 |
| `OpenAI API error (400) / Error from provider (Console Go): Upstream ...` | `api: openai-responses` 但上游（opencode-go）不支持 `/responses` | 改 `api: openai-completions`（mimo 已踩） |
| `llm-pi-ai: providers is now a dict keyed by provider route, not an array` | `providers` 写成 `[{provider: xxx}]` 旧 array 形态 | 改为 `providers: { xxx: { ... } }` dict |
| `settings-rejected` + `provider "xxx" has an empty baseURL/displayName` | 手写路由缺 `baseURL` / 空字符串 | 补 `baseURL: https://.../v1` |
| `UNKNOWN_MODEL` | `agent-default-model.model` 不在该 provider 的 `models` 清单里；或 `models` 替换后漏写 | 补全 `models` 或改 `agent-default-model` |
| `MISSING_CREDENTIAL` | `apiKeyEnv` 指向的变量在 credentials/env 中为空 | 在 `~/.dsh/.credentials.yaml` 或 `.env` 补 key |
| `INVALID_CREDENTIAL` | key 含换行/不可做 header 的字符 | 检查 key 是否复制时多带空格/换行，trim 后重存 |
| `Stream ended without finish_reason` → `TRANSPORT` → 频繁断连 | 上游 SSE 流缺 `finish_reason` + `data: [DONE]`（muse-spark 经 opencode 转发时必现） | 已打补丁 `pi-ai/dist/api/openai-completions.js:437`（见 `Muse-Spark补丁说明.md`），重装 dsh 后需重打 |
| `DISCOVERY_FAILED` / `DISCOVERY_UNSUPPORTED` | 模型发现仅支持 `openai-completions`/`openai-responses`，Azure/Codex 等不支持 | 手写 `models` 清单，不依赖自动发现 |
| `provider "xxx" sets "provider", which moved to the providers dict key` | 在 profile 内又写 `provider: xxx` 字段 | 删掉，key 本身就是 provider 名 |
| `maxRetries or maxRetryDelayMs were removed` | 旧重试字段已废弃 | 改 `retryPolicy: {mode, maxRetries, backoff}` |
| `defaultInput must name at least one modality` | `defaultInput: []` 空数组 | 至少 `[text]` |
| 图片发出去后 `unknown variant image_url` | 用纯文本模型（如 `deepseek-v4-flash`）直接发 `image_url` | 走 `vision-router` 的 `sensenova` 视觉链路，别让文本模型直连图片 |

---

## 11. 历史踩坑时间线（复盘）

| 时间 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 2026-08-17 | `mimo-v2.5` 在 `opencode-go` 上 400 | `opencode-go` 的 `api: openai-responses`，但 mimo 不支持 Responses | 新建独立 `xiaomi` provider，`api: openai-completions`，隔离 DeepSeek 与 MiMo |
| 2026-08-19 | `muse-spark-1.2` 一会就断 | opencode 网关转发的 SSE 缺 `finish_reason`，pi-ai 抛 `TRANSPORT` | 补丁 `openai-completions.js:437`：`blocks.length>0` 时按 `stop` 正常结束 |
| 2026-08-17 | `dsh-web` 命令不生效 | `~/.zshrc` 的 `alias dsh-web` 劫持 PATH | 删除 alias，统一走 `~/bin/dsh-web.sh` |
| 2026-08-17 | 识图不走 sensenova | `deepseek-v4-flash` 是纯文本，`wrappedProviders` 误用为识图 | 明确两条路径：默认不选孪生条目→自动切 sensenova；见 `DSH识图模型配置使用说明.md` |

---

## 12. 新增一个模型的 Checklist（直接照抄）

**场景：新增 `foo-bar` 模型，经由 `https://gateway.example/v1`，走 OpenAI 兼容协议**

```yaml
# 1. 先确认网关支持的协议（问网关文档，默认先试 openai-completions）
# 2. 在 ~/.dsh/settings.yaml 追加：
llm-pi-ai:
  providers:
    foo:                          # ← 新路由名，任意合法非空字符串，建议与厂商同名
      api: openai-completions     # ← 手写路由必须显式声明
      baseURL: https://gateway.example/v1
      apiKeyEnv: FOO_API_KEY      # ← 去 credentials.yaml 配真实 key
      displayName: Foo Gateway
      models:
        - id: foo-bar
          name: Foo Bar
          contextWindow: 131072
          maxTokens: 16384
          input: [text]           # 视觉模型改 [text, image]
      # 可选：推理/兼容性
      # compat: { thinkingFormat: deepseek }
      # defaultContextWindow: 131072

# 3. 在 ~/.dsh/.credentials.yaml 追加：
FOO_API_KEY: sk-xxx

# 4. 如需设为默认：
agent-default-model:
  provider: foo
  model: foo-bar

# 5. 重启验证：
# dsh-web restart && cat ~/.dsh/settings.yaml
```

**如果是 Catalog 已有 provider 的新模型（如 DeepSeek 上新 `deepseek-v4-pro`）：**
```yaml
opencode-go:
  api: openai-completions
  baseURL: https://opencode.ai/zen/go/v1
  apiKeyEnv: OPENCODE_GO_API_KEY
  models:
    - id: deepseek-v4-flash
      contextWindow: 1000000
      maxTokens: 384000
      input: [text]
    - id: deepseek-v4-pro        # ← 新增这一条，记得把旧的也保留（Replace 语义）
      contextWindow: 1000000
      maxTokens: 384000
      input: [text]
```
或更省事（保留 Catalog 全量，只改一个）：
```yaml
deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  modelOverrides:
    deepseek-v4-pro:
      contextWindow: 1000000
```

---

## 13. 与识图（vision-router）的边界

- `llm-pi-ai` 管 **文字对话** 的模型路由。
- `vision-router`（`cordis.patch.yml`）管 **图片** 的路由（`providers` 决定整轮切哪个视觉模型，`httpProviders` 决定 `vision_describe` 工具的 fallback 链）。
- 两者**不要混**：别指望 `deepseek-v4-flash` 直连 `image_url`，它一定报 `unknown variant image_url`。图片轮会自动切 `sensenova-6.8-flash-lite`，文字轮保持 `opencode-go/deepseek-v4-flash`。

详见 `DSH识图模型配置使用说明.md`。

---

## 14. 维护约定

- 以后每次新增模型，**先读本手册 §12 Checklist**，再改 `settings.yaml`。
- 改完必做 `cat ~/.dsh/settings.yaml` + `dsh-web restart` + 真实对话验证。
- 补丁类改动（如 `muse-spark` 的 `openai-completions.js`）重装 dsh 后需重打，见 `Muse-Spark补丁说明.md` §回滚/重打。
- 本手册与 `packages/llm/llm-pi-ai/README.md`（权威）保持一致，冲突时以 README 的 Config 定义为准。

---

*— 完 —*
