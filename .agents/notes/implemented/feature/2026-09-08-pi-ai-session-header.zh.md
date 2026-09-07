# Agent Note: `llm-pi-ai` 路由的按会话 session 头

Status: implemented

English | [中文](2026-09-08-pi-ai-session-header.md)

## Problem

OpenCode Go 的 Console Go 网关自 2026-09-05 起拒绝不带 `x-opencode-session`
头的请求，返回 `400 MissingSessionID`。这个头是网关的**按会话路由键**：它需要
一个每次会话稳定的 id，好让同一会话持续落到同一个上游副本，从而保住 prompt
缓存的热度。

现有的配置面表达不了这件事。`headers` 只能填静态值，于是同一路由上的所有会话
共用一个 id。这能满足网关的"存在性检查"——固定值不会被拒——却正好废掉了这个头
存在的理由：单一固定值把所有会话塌缩进同一个路由桶，切换会话时仍在拿不相关的
前缀去打同一个副本。采用静态绕行方案的用户反馈的正是这个结果：变慢、更贵。
与此同时 `GenerateOptions.sessionId` 其实已经传进了每一次 `streamSimple` 调用，
只是没有落到任何头上；而仓库的 drift gate 把 pi-ai 的
`sendSessionAffinityHeaders` 与 `sessionAffinityFormat` 都列为 withhold，上游的
compat 开关也没法补上这个头。

## Decision

`PiAiProviderProfile` 新增 `sessionHeader?: string`。路由一旦配置，适配器就在
该路由的每个请求上把这个头打上**当前会话的 session id**，取值来自早已转发给
pi-ai 的同一个 `GenerateOptions.sessionId`。未配置的路由行为逐字节不变。

单一注入点（`packages/llm/llm-pi-ai/src/adapter.ts` 的 `requestHeaders`）上的
三条规则：

- **运行时值替换同名的静态 `headers` 项**，匹配时忽略大小写。固定值干不了按
  会话 id 的活，若让它合并或优先，就等于保留了这个字段要消除的那个 bug。同时
  配了两者的部署，拿到的是按会话的 id。
- **Harness attribution 仍然优先**。`user-agent` 保持保留名，因此该字段无法
  被用来冒充 harness。
- **没有 session id 就不发这个头**。`sessionId` 未设置的请求根本不带这个头名，
  而不是发一个空值或编造值。

该字段是**显式 opt-in 且与协议无关**的：它挂在请求头上，因此
`openai-completions`、`openai-responses`、`anthropic-messages` 路由一次覆盖，
无需逐协议适配。它刻意不对 provider id 或主机名做判断——哪个网关需要 session
头、叫什么名字，属于部署事实，应放在配置里，而不是塞进一串 harness 得逐个网关
去维护的硬编码路由名列表。

辅助调用天然被覆盖，因为它们本来就会话 id：会话标题
（`dsh-session-title-llm`）与压缩摘要（`dsh-compaction-basic`）都会设置
`sessionId`，于是同一轮里的 chat、标题、摘要请求向网关呈现同一个 id。模型发现
（discovery）不受影响——它列举的是草稿配置的模型，此时没有会话可言。

## Alternatives considered

- **对 id 以 `opencode` 开头、或 base URL 主机为 `opencode.ai` 的路由硬编码 `x-opencode-session`。** 零配置，也最快能解锁用户。作为最终形态被否：它把某一家厂商的契约写进 harness，自托管或经代理的 Console Go 部署会失效，而且把一个线上可见的行为藏在主机名匹配后面，配置面既展示不出也无法覆盖。该字段用一行配置达到同样的线上结果，源码里不留厂商名。
- **对所有 provider 请求无条件发送该头。** 否决：把 OpenCode 专属的头发给无关 provider 是泄漏，而且该网关的要求并非普适。尤其 discovery 探测没有会话可供标识。
- **采用上游 pi-ai 的 `sendSessionAffinityHeaders` / `sessionAffinityFormat`。** 作为前置条件否决：两者都被本包的 drift gate 列为 withhold，开关默认关闭，且其线上格式（`session_id`、`x-client-request-id`、`x-session-affinity`）并不包含 `x-opencode-session`。要用它得先有上游改动，救不了当前这个网关。
- **从 `session-<uuid>` 的会话 id 里剥出裸 UUID。** 否决：已在真实网关上验证，完整的 `session-<uuid>` 形状返回 `200`，所以做归一化只是为了解决一个网关并不存在的问题而增加代码。
- **扩展 `dsh-llm` 的 attribution 层，让所有适配器都带上它。** 暂缓：`dsh-llm-deepseek` 已经在发自己的 session 头，语义不同且另有决策归属；而本次这个网关的要求只出现在 pi-ai 路径上。若将来另有适配器需要，再单独决定是否上提为共享机制。

## Consequences

代价：多一个需要文档化的配置字段，且部署方必须为每个 OpenCode Go 路由加一行，
而不是白拿。同时配了 `sessionHeader` 与同名静态项的路由，静态项会被静默忽略——
这是有意为之，但属于值得在字段 JSDoc 里写明的一处配置意外。

收获：按会话路由在所有协议、所有辅助调用上都生效，源码里不留厂商名，也没有
逐协议的代码。采用该字段的路由上，"所有会话共用一个桶"这个静态头的失效模式
变得不可达。又因为取值来自会话日志本来就记录的 id，这个头可以从日志重建，
"模型可见 ⟺ 已记录"这条不变量得以保持。

## Testing

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` 里四条 wire 级用例对着 mock
server 断言该头：值被正确打上；它忽略大小写地替换同名静态项且其余项保留；请求
不带 session id 时该头完全不存在；未配置 `sessionHeader` 时静态项原样送达。
