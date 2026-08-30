# Agent Note: Composer 模型席位——包含块困住的菜单与整段平均 tps

Status: implemented

[English](2026-08-22-composer-model-seat-menu-and-tps.md) | 中文

## 问题

Composer 的模型席位出现两个回归：

1. 点击模型 chip 弹出的不是菜单，而是一个与触发器同宽、约 10px 高的矩形。Commit bf05cc27de 在 `@container (max-width: 480px)` 下把手机宽度菜单改到 `position: fixed` 居中，并断言"这条路径上没有祖先创建包含块"。这个前提错两次：ModelSelect 规则的最近查询容器是 InputBar 的 `.row`（它为 PermissionSelect 的匿名查询声明了 `container-type: inline-size`），而按 css-contain-3，inline-size 容器携带 layout containment——正是这一行成为任何 fixed 后代的包含块。居中对话框相对工具行盒子求解并塌陷；由于半贴桌面窗口的 `.row` 也可能 ≤480px，这个陷阱并非手机独有。
2. "实时" tps 徽标从 `sessionStats` 投影计算 `decodeTokens / decodeMs`。这些数字是整个日志在 step 完成时折叠的总和，商因此是一个几乎不动的整段平均值。

## 决策

菜单在任意宽度下回到绝对定位的 flyout（相对 `.root` 的 `right: 0; bottom: calc(100% + 8px)`）。基础规则已经用 `calc(100vw - 32px)` 限制卡片宽度、右缘距视口约 16-24px，因此从 320px 手机起都能放下，无需任何 fixed 定位。`.menu` 上的注释记录了这个包含块陷阱，让 fixed 居中的想法彻底死去。

徽标直接从现成的每 step 字段读取最新 assistant 节点自身的速率——turn-metrics.ts 的 `assistantStepReading(node)` 暴露每个 step 的 `decodeMs` 与 provider `outputTokens`，与 StatsLine 和 turn footer 折叠的是同一批读数。一个 `useSession` 选择器从后往前遍历节点，用该 step 的输出 token 除以 decode 秒数；最新 step 缺两个数字时不渲染，而不是显示陈旧读数。客户端不存在任何采样记账。按产品偏好，ContextMeter 与模型席位在尾部组中互换了位置（context 在模型左边）。

## 验证

`input-bar.client.spec.tsx` 把 assistant 节点 fixture 喂进 bench 快照：两个完成的 step 从最新 step 渲染 `425 tok/s`，较旧 step 的 150 tok/s 不得胜出；空日志不渲染；最新 step 缺计时/用量时隐藏徽标而非显示陈旧数字。套件绿（82），包级清扫除三个基线上就存在的 StatsLine 失败外全绿。两个包都重新构建（`tsc -b`、tsdown），并验证了所服务的 `/plugins/*/client.js` bundle 与磁盘字节一致。

## 备选方案

Portal-to-body 能让 `fixed` 真正相对视口求解，但会把菜单挪出 `rootRef`，迫使 outside-click 与 focus-leave 关闭逻辑多穿一层 ref，却没有 UX 收益。在被劫持的包含块内居中也被否决：行高只有 40px，卡片会横跨屏幕边缘。

## 后果

模型菜单在任意宽度下行为一致——没有包含块陷阱，也没有手机专属特例——且陷阱记录在 `.menu` 上，fixed 居中无法悄悄回归。tps 徽标现在追踪最新完成的 step 而非整段平均，与 turn footer 显示一致。按产品偏好，ContextMeter 位于尾部组中模型席位左侧，`input-bar.client.spec.tsx` 固定了最新 step 读数与空日志/无计时两个回退。
