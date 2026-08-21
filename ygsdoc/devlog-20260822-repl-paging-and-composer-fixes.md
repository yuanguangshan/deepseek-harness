# 开发日记 2026-08-22：REPL 翻页、Web 选择器修复、TPS 徽章重写

## 一天的起点

一条反馈："终端中不能向上翻页看以前的内容"——dsh-repl 在 iTerm2 里用的是 pi-tui 的备用屏幕（alt screen），iTerm2 的原生回滚区在备用屏幕里不存在，所以触控板、滚动条、Cmd+↑、Shift+PgUp 全部指向一片空白。问题不是"没做好翻页"，而是"翻页的物理载体不在那里"。

用户提出了一个具体诉求：用 `[` 和 `]` 二键翻页，冲突就用 Ctrl+[]。

## 第一件事：REPL 翻页

### 架构考古

先搞清楚 apps/repl 的渲染管线：pi-tui 0.84.1 的 `TuiAltScreen` 在构造时注册 `handleViewportInput` 作为输入监听器，它在焦点组件（Editor）之前运行——PageUp/PageDown/Home/End 全被它吃掉。`matchesKey` 同时支持 legacy `\x1b[5~` 和 kitty 编码形式。

但 REPL 有自己的输入监听器在 `TuiAltScreen` 之后注册。它里头有一段 kitty 序列的吞噬逻辑：

```ts
const kitty = /^\x1b\[(\d+);([\d:;]*)u$/.exec(data)
if (kitty && !isCtrl) return { consume: true }  // 吞掉
```

这段代码把所有非 Ctrl 的 CSI-u 序列都吞掉了——包括 shift+pageUp 的 `\x1b[5$`（xterm legacy 形式不受影响），但 kitty 编码下的修饰导航键（如 `\x1b[21;2u`）就全部哑火了。

### 合成实验台

为了让猜想落地，我用 mock terminal 搭了一套合成 e2e：手动构造 `TuiAltScreen`，喂入真实的转义序列，测量 `scrollTop` 的变化。结果：

| 序列 | 结果 |
|---|---|
| `\x1b[5~` (PageUp) | ✅ 279→259 |
| `\x1b[<64;10;5M` (wheel up SGR) | ✅ 259→253 |
| `\x1b[H` (Home) | ✅ 0 |
| `\x1b[F` (End) | ✅ 277 |
| `\x1b[21;2u` (shift+pgup kitty) | ❌ 无变化 |
| `\x1b[5$` (shift+pgup xterm) | ❌ 无变化 |

**转折**：第一次跑的时候所有值都不变——因为 `p()` 函数把标签字符串（"PageUp legacy [5~"）当成序列喂给了 `handleTerminalInput`！调试了半天才发现是测试桩的 bug，不是产品 bug。这个教训值得记录：**合成测试的输入源必须和真实路径完全一致，标签和数据不能混在一起。**

### 方案取舍

用户要求 `[`/`]` 翻页。但这两个键在 Editor 里是普通打字字符。`Ctrl+[` 在 ASCII 里就是 Esc（0x1b）——已经被"中断回合"占用了，物理上无法复用。`Ctrl+]` 是 Editor 的 jump-forward（0x1d），冲突可接受但不对称。

最终选择：**空草稿门控**——`[`/`]` 只在 `editor.getText() === ''` 时才翻页，草稿有任何内容就恢复普通打字。这是最顺手的折中：阅读时输入框通常是空的，开始打字后翻页键自动变回括号。把判断逻辑抽成纯函数 `bracketScrollAction(data, editorEmpty)`，有完整的单元测试覆盖。

### kitty 吞键修复

同步修复了那个 CSI-u 吞噬逻辑：只吞掉释放事件（`:N` event-type subparam）和无修饰码点按键（`CSI NN u` / `CSI NN;1u`），其余带真实修饰键的序列全部放行。这样 shift+pageUp、alt+[] 等在支持 kitty 协议的终端上都能正确传递。

### 用户追问

"MacBook Air 没有 Page Up/Down 怎么办？"

回答：Fn+↑/↓ = PageUp/PageDown，Fn+←/→ = Home/End，macOS 系统级映射，iTerm2 直接支持。另外触控板滚动在 mouse reporting 开启时也能用（前提是 iTerm2 没开"Disable session-initiated xterm mouse reporting"）。

## 第二件事：Web 模型选择框弹不出来

### 用户反馈

"dsh web 模型选择框弹不出来了，改坏了。"

### 排查

`git status` 显示我今天只动了 apps/repl——Web 端没有任何本地改动。昨晚（8月22日凌晨）有一整轮"模型选择器重塑"提交（居中、收窄、宽度封顶、抬到侧栏之上），三个 commit 全是 CSS-only。最可疑。

三个 commit 改的都是 `ModelSelect.module.css`。其中一个（bf05cc27de）把手机端菜单从绝对定位改成了 `position: fixed` 视口居中：

```css
@container (max-width: 480px) {
  .menu {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
}
```

注释写着："Fixed resolves against the viewport; no ancestor on this path creates a containing block。"

### 根因

这句话是错的。

InputBar 的 `.row` 声明了 `container-type: inline-size`。CSS Containment 规范规定：`container-type: inline-size` 会附带 **layout containment**，而 layout containment 会让该元素成为所有后代（包括 `position: fixed`）的**包含块**。

所以 `@container (max-width: 480px)` 查询的不是视口宽度，而是 `.row`（工具行）的宽度。在半屏窗口（MacBook Air 常见使用场景）下 `.row` ≤ 480px，规则命中，菜单变成 fixed 定位——但包含块是那个 36px 高的工具行。结果：菜单居中在工具行上，塌成一个与触发器同宽的 ~10px 空壳。

这不是手机专属问题：只要窗口宽度 ≤480px（半屏），就会触发。

### 修复

直接删掉那个 `@container` 块，回到绝对定位弹出卡（`right: 0; bottom: calc(100% + 8px)`）。基础规则已经用 `calc(100vw - 32px)` 封顶了宽度，在任何宽度下都不会越界。加了注释禁止再犯。

## 第三件事：TPS 徽章取值错误

### 用户反馈

"tps 的字段值你取错了，没用实时的，用了平均值，几乎不动。"

### 根因

原来的实现：
```ts
tps = sessionStats.decodeTokens / (sessionStats.decodeMs / 1_000)
```

`sessionStats` 的 `decodeTokens` 和 `decodeMs` 是**整段日志的累计和**，且只在步骤收口时更新。商值是"生涯平均"——随着历史增长越来越平，几乎不动。

### 用户提醒

"你读一下我原来 tps 优化的 patch，有一版这个值是对的，应该是有现成字段可取的，不是自己算吧。"

这个提醒至关重要。查看 `turn-metrics.ts` 发现 `assistantStepReading(node)` 直接从每个 assistant 节点的 timing + usage 中提取该步自己的 `decodeMs` 和 `outputTokens`——这就是"现成字段"。取最新一个 assistant 节点的值，一次读取，无需维护采样对、无需 useState/useEffect、无需 reset 逻辑。

```ts
const tps = useSession((s) => {
  for (let i = s.nodes.length - 1; i >= 0; i -= 1) {
    const node = s.nodes[i]
    if (node === undefined || node.kind !== 'assistant') continue
    const reading = assistantStepReading(node)
    if (reading.decodeMs !== null && reading.decodeMs > 0 && reading.outputTokens !== null) {
      return formatTokensPerSecond(reading.outputTokens / (reading.decodeMs / 1_000))
    }
    return undefined
  }
  return undefined
})
```

测试用例验证：两个 step，最新的 425 tok/s 必须胜出（旧的 150 tok/s 不能回退），空节点或 figureless 节点不显示。

### 坑

最初实现用"双 effect + ref"方案（采样对 delta），挂载时两个 effect 按声明序执行：采样 effect 先播种 `prev={425,1000}`，sessionId 重置 effect 紧接着清空——种子被自己人踩掉。这个 bug 在 React 18 才暴露（StrictMode double-invoke 场景下更容易触发）。切换到 per-step-field 之后，整个 useState/useRef/useEffect 链全删了——这就是"现成字段"的力量。

## 顺手修的小事

### 上下文面板收窄

ContextMeter 的弹出面板原来 264px 宽，绝对定位在圆环右上方。在窄窗口下左边缘溢出视口。改成 `min(224px, calc(100vw - 32px))` + `flex-wrap`，确认不再裁切。

### 按钮换位

上下文用量圆环移到模型选择按钮左边（"上下文在左、模型在右"），一个 JSX 行交换。

## Patch 套件重打

patch 套件从 6 项 10 文件升级为 7 项 11 文件。apply 脚本的说明文字同步更新（TPS 从"读投影累计值"改为"读最新步自身速率"，手机 fixed 居中改为"容器包含块陷阱警告"）。

## 提交与推送

```
d9f54d2207 feat(repl): page the transcript with [ and ] while the draft is empty
7e032524c5 fix(ui-model-selection): keep the model menu an absolute flyout at every width
d7ec36af71 fix(ui-conversation): newest-step tps badge and context/model seat order
35616ff70e docs(ygsdoc): regenerate the model-tps patch kit over the expanded customization range
112e3e87bb fix(ui-conversation): narrow the context panel so its left edge stays visible
```

全部推送到 `fork/master`，pre-push typecheck 通过。

## 方法论收获

1. **读代码 > 猜行为**：container-type 会创建包含块这件事，不读 css-contain-3 规范根本猜不到。昨晚的注释"没有祖先会产生 containing block"就是猜的产物。
2. **现成字段 > 自己算**：用户一句"不是自己算吧"点醒了我——assistantStepReading 已经提取了每步的 decodeMs/outputTokens，比手搓 delta 采样干净一个数量级。既消除了挂载时 effect 顺序的坑，又让测试简单到不需要 mock 状态机。
3. **合成测试的输入源必须真实**：mock terminal 越贴近真实路径越好，标签和数据不能混用。
4. **CSS containment 是静默陷阱**：container-type inline-size 带来的 layout containment 对 fixed 定位的影响是跨规范的，测试很容易遗漏（因为 @container 只在特定宽度下命中）。注释和代码审查是最后一道防线。
5. **pnpm exec 的临时文件策略**：pnpm 在仓库根写 `_tmp_*` 文件，session workspace 外的写入被沙箱拦截。绕过方案是直接调用 `node_modules/.bin/` 下的二进制。
