# Agent Note: Composer 占位符显示当前模型名

Status: implemented

[English](2026-08-21-model-name-placeholder.md) | 中文

## 问题

Composer 文本框的占位符无视会话正在面向哪个模型，恒定显示 "Message the agent"（英文）/ "给智能体发消息"（中文）。在多模型之间切换的用户（如 deepseek-v4-flash、ox-alpha-free、mimo-v2.5）在输入区得不到当前路由的任何视觉确认——只有输入框上方的 ModelSelect 触发器显示选择。在多模型工作流中，这让"下一个 prompt 由哪个模型处理"变得含糊。

## 决策

新增会话投影键 `modelSelection`，承载会话下一次请求将使用的 provider/model 路由，从持久的 `request/context` 事件记录折叠而来（与 agent loop 在路由或容量变化时记录的是同一事实）。该键注册在 `apiproxy` 中，与现有 `sessionListMetadata`、`imageLimits` 单元并列；消费者是 `ui-conversation` 的 `InputBar`，经标准 `useProjection` hook 读取。

**宿主侧（apiproxy）：**
- `ModelSelectionRoute` 类型（`{ provider, model }`）加入 `api/sessions.ts`，并入 `SessionProjectionMap` 与 `SessionProjectionStateMap`（在首个 `request/context` 记录前可空）。
- `modelSelectionProjectionSchema`（zod，可空）加入 `api/sessions.schema.ts`。
- 在 `api-proxy.ts` 注册：任何请求前状态为 `null`；`apply` 从每个 `request/context` 事件捕获 `event.data.{ provider, model }`；`wire.view` 直接返回状态（无请求记录时为 `null`）。`stateVersion: 1`。

**客户端侧（ui-conversation）：**
- `locales.ts`：新键 `'placeholder.model': '给 {model} 发消息'` / `'Message {model}'`。
- `InputBar.tsx`：`useProjection('modelSelection', sel => sel?.model)` 解析模型名；投影存在时默认占位符分支使用 `t('placeholder.model', { model })`，缺席时（新会话或无投影能力）回退 `t('placeholder.default')`。

**数据流：** `selectModel` RPC → 下一轮循环 → 追加 `request/context` 事件（检测到路由变化）→ 投影折叠推新值 → 客户端帧 → InputBar 重渲染。`selectModel` 与下一次 `request/context` 之间的间隔是一个 loop step；ModelSelect 触发器经自己的 RPC store 立即显示新选择。

## 备选方案

**经投影 live-view 读取 selectionFor 内存态。** 否决：`imageLimits` 用这个模式只因为它是启动常量（被认可的例外）。模型选择会话中途变化；live-view 会破坏折叠的观察纯性与持久化缓存约定。

**在 selectModel 成功时追加合成事件。** 否决：为类似 `request/context` 的记录引入第二个写入者，搅乱 agent loop 自身的先 diff 后追加逻辑与会话日志不变式，却没有清晰的所有权边界。

**跨包共享 store（ui-conversation 读 ui-model-selection 的 store）。** 被客户端 AGENTS.md 的跨包导入禁令否决。投影通道是这类宿主实时派生数据的认可路径。

## 测试

- `input-bar.client.spec.tsx`：三个新用例——投影存在时显示模型名、缺席时通用回退、plan 模式占位符仍优先于模型名。80 个测试全部通过。
- `typecheck` 通过（宿主 + 客户端两面）。
- `api-proxy-projections.spec.ts` 有 8 个既有失败（无关的 `test/last-user` 键）；本次改动无回归。

## 后果

Composer 占位符会说出下一个 prompt 将到达的模型，输入框上方的 ModelSelect 触发器不再独自承担这个事实。`modelSelection` 投影键对任何未来需要会话路由的客户端可用；新会话与没有该投影的宿主仍得到通用占位符。`api-proxy-projections.spec.ts` 的 8 个既有失败保持原样并被追踪。
