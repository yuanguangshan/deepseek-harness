# Agent Note: Web 主题的用户背景图片

Status: implemented

[English](2026-09-17-web-theme-background-image.md) | 中文

## Problem

`ui-theme` 设置界面原本只有两个轴：明/暗/跟随系统调色板，以及会话正文字号。想要自定义背景的用户没有受支持的路径——`--dsw-*` 调色板是颜色的唯一权威，主题只能注册别名 token 覆盖，没有任何界面让用户附加图片。布局还用不透明填充绘制各列（框架用 `--dsw-alias-bg-base`，侧边栏用 `--dsw-specific-sidebar-fill`），因此放在应用背后的图片在不改动这些表面的情况下根本不可见。

## Decision

一个可选的背景图片，由 `dsh-client-ui-theme` 端到端拥有：

- **持久状态。** `ui-theme` 设置命名空间新增 `backgroundImage`（`data:image/…` URL，空字符串表示没有）、`backgroundOpacity`（0–100 整数）与 `backgroundBlur`（0–24 px 整数），各自带 schema 默认值。`ThemeSnapshot` 以冻结的 `background` 对象携带它们，`ThemeRuntime` 只暴露 `setBackgroundImage`、`setBackgroundOpacity` 与 `setBackgroundBlur` 三个写入入口；`adopt()` 比较并采用全部五个持久字段。写入沿用既有的 [Host 支撑的偏好边界](../../bug-fix/2026-08-06-host-backed-web-preferences.md)。
- **有界摄入。** 设置行把用户选中的 `File` 交给注入面，后者调用 `client/wallpaper.ts` 中的 `encodeWallpaperFile`：拒绝超过 20 MB 或 `createImageBitmap` 无法解码的源文件，把较长边缩放到至多 2560 px，绘制到 canvas，并以 0.85 质量编码为 WebP；引擎返回非 WebP data URL 时回退为 JPEG。因此持久值始终是重新编码后的图片，而不是原始文件，也不存在独立的资源存储或 HTTP 路由。拒绝以 `'too-large'` 或 `'unsupported'` 返回，由该行以本地化文案呈现；编码位于组件之外，表现层保持纯净。
- **投影。** ui-layout 的 `ThemePresenter` 在 body 上写 `--dsh-wallpaper-image`（`url("…")`）、`--dsh-wallpaper-opacity`（0–1）与 `--dsh-wallpaper-blur`（`Npx`），并切换 `data-dsh-wallpaper`；没有图片时四者全部移除，因此清除图片不会留下残留图层。
- **绘制。** `wallpaper.css` 在 `z-index: -1` 处以固定的 `body[data-dsh-wallpaper]::before` 绘制——位于流内背景之下、body 背景传播到的画布之上——使用呈现器写入的变量，并向视口外扩展两倍模糊半径，使模糊边缘不会露出画布。同一张样式表把 `--dsh-app-background` 与 `--dsh-app-sidebar-background` 重绑为 `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 的半透明 `color-mix` 色调。所有铺满整列的表面都以这两个间接变量读取，并以不透明 token 作为回退——ui-layout 的框架与侧边栏轨道、ui-sidebar 根节点、ui-conversation 根节点（含 composer 席位的渐变遮罩）——而卡片、代码块与面板保持自身实色填充，依旧可读。因此所有颜色决策都留在 ui-theme，任何功能包都不会去命中别的包的类名。
- **界面。** 第三行「通用」设置行（`id: 'wallpaper'`，order 12）提供选择/更换、移除、预览与两个滑块；文案位于两种语言的 `settings.theme` 字典中，插件前引导有意不内嵌图片，使 index 响应保持精简。

## Alternatives considered

- **存图片 URL 而不是字节。** 否决：需求是选择本地文件，外部 URL 会引入网络、CSP 与持久性失败模式，持久设置文档不应承担这些。
- **把原始文件持久化为附件并经 Host 路由提供。** 本次否决：这会增加一条路由、一套清理逻辑以及 settings 到资源的引用，而「编码后有界的 data URL」已把文档控制在几百 KB 量级。内联存储的限制已记录在包 README 中。
- **在壁纸属性下把 `--dsw-alias-bg-base` 变为半透明。** 否决：body 背景会传播到画布，半透明基色会一并改变弹性滚动区域以及所有读取该别名的表面，包括代码块与消息卡片。专用的一对间接变量把重绑限定在铺满整列的表面上。
- **只给会话列应用壁纸。** 按既定范围否决：图片覆盖整个应用，侧边栏保留自己的色调以保持各列可区分。
- **在 React 组件内完成图片编码。** 否决：canvas 操作是浏览器能力而非表现层职责，且组件在不拥有编码错误的情况下无法给出带类型的拒绝原因。

## Consequences

- 主题设置文档现在携带图片负载；每次设置写入都会重序列化整份文档，因此大壁纸会让无关写入略微变重。缩放与重新编码对这一成本设了上界。
- 非 loopback 页面与其他 `ui-theme` 值一样把图片保留在进程内，清除后不会留下待回收的文件。
- `ThemeSnapshot` 新增了必填的 `background` 成员，因此每个构造快照字面量的消费方都必须提供它；Gui 测试套件与终端 fixture 已在同一变更中更新。
- 未来若引入独立的资源存储，可以在不改动运行时 API 的前提下替换 data URL：`setBackgroundImage` 已接受任意 `data:image/…` 字符串。

## Testing

`wallpaper.client.spec.ts` 覆盖字节上限、缩放几何、单像素下限、JPEG 回退与无法解码的拒绝；`wallpaper-row.client.spec.tsx` 覆盖选择/移除/滑块手势、拒绝文案与空选择；`theme.client.spec.ts` 与 `host.client.spec.ts` 覆盖新增 setter、其边界、采用逻辑与 Host schema；`theme-presenter.client.spec.ts` 覆盖变量发布、撤回与 dispose。`pnpm run test:gui` 在这些包上通过；`ui-settings-sysadmin` 中两个既有样式表约定失败与 `ui-model-selection` 中一个失败与本变更无关，且在变更前即为红色。
