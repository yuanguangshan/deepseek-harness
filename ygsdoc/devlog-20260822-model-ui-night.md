# 模型选择器重塑之夜

> 2026-08-22 凌晨，九次提交，六项改动，三个工程原则。

## 引子

2026 年 8 月 22 日凌晨零点二十二分到一点二十二分，六十一分钟里完成了九次 commit。两个前端包、一个 REPL 运行时、一份配置文件、一套部署 patch 包。表面看是 UI 微调：选择器居中、宽度收窄、长名截断。但起点是一场静默失败，过程撞上 CSS 声明优先级的反直觉陷阱和包含块对固定定位的吞噬，终点是一份从失配废纸重生为幂等快照的 patch 包。

本文记录"做了什么"之外的两层："为什么这样做"和"踩了什么坑"。

---

## 一、起点：空选择器

### 接入 Ox Alpha Free

第一个任务是往 `interactive.cordis.yml` 加入 OpenCode 网关的 `ox-alpha-free` 模型——免费、1M 上下文窗口、支持图像。注册方式：先声明路由 `opencode-go-completions`，再添加模型条目。

编辑 YAML 配置文件是常规操作。但合并时，`xiaomi:` 这个路由声明头被意外覆盖了。三行不起眼的 YAML key 起到结构分隔作用：告诉解析器接下来的模型属于 xiaomi 路由而非 opencode-go-completions。少了这个头，后续条目全部坍塌到同一个映射里。

这里有一个关键背景。`loadModelsFromConfig` 的错误处理是：

```typescript
catch (error) {
  return []
}
```

YAML 解析失败时抛异常不抛，日志不打，静默返回空数组。这个设计在大多数场景下合理——模型列表解析不应阻断 REPL 启动。但副作用是：配置文件出了语法错误时，用户看到的不是报错，而是**空空如也的模型选择器**。

### 排查链

用户第一反应合理："`/reload` 是不是没刷新 selector？"排查分三步。

**第一步验证 `/reload`。** 源码里它调用 `restartRuntime()` → `loadModels()` + `newSession()`。逻辑正确——问题不在重载机制。

**第二步 dump modelList。** 运行时诊断输出：`count: 0`，路由分布只有 `['meta']`。`loadModelsFromConfig` 被调用了但返回空列表。

**第三步看 YAML 文件。** `git diff` 还原编辑差异，发现 xiaomi 路由头消失。手动解析收到 `YAMLException: bad indentation of a mapping entry`——正是 catch 块吞掉的那个错误。

压缩成一句话：**配置文件语法坏了，错误处理把它变成了沉默。**

仓库 `AGENTS.md` 明确写着：*"Misconfiguration fails loud at load when self-contained; never silently skip a missing referent."* `loadModelsFromConfig` 的 catch 块违反了这条。修复不是改 catch（那是后续改进），而是恢复 YAML 内容。但这次经历确立了方向：配置解析失败时至少打印一行诊断，让排查不再依赖逆向工程。

### /reload 的冤案

这个冤案值得记录。`/reload` 被短暂怀疑时，实际揭示了"故障现象 → 原因假设 → 假设验证"排查方法论的运作。源码证明重载逻辑正确，问题在被重载的数据源。最终排查方向的正确转换发现了静默失败这个更根本的问题——一个正确的重载函数配上吞错误的解析函数，组合行为比两者都坏更隐蔽，让排查者在错误方向上浪费时间。

---

## 二、把界面还给人类

配置修好后选择器恢复功能，但暴露出可读性问题。

### TUI 的长名截断

原来 `ModelPicker` 每行标签是 `choice.id`——`provider:modelId` 格式。对大多数模型还行，但 `opencode-go-completions:ox-alpha-free` 有二十二个字符。TUI 列表默认宽度截断后变成 `opencode-go-completions:ox-a`，最有辨识度的后缀消失了。

改法：`toSelectItem()` 的 label 从 `choice.id` 改为 `choice.name`（如 "Ox Alpha Free"），路由 ID 降级到 description。主标签读人话，详情行提供精确身份。

同步更新了测试。之前有个过期断言：`merges models across routes, responses route wins on duplicate id` 期望四个模型。但上游提交 `b04f4c3627` 已改为"不同路由同名模型各自保留"——deepseek-v4-flash 在 responses 和 completions 两个路由下是两个独立选项。测试预期数从四改为五，断言语义对齐当前行为。

### Web 端的复合名拆分

Web 端更极端。Vision Router 注册的模型 ID 是三层结构：`vision-http/sensenova/sensenova-6.8-flash-lite`。菜单已按 provider 分组，组标题已显示厂商名，模型行里的前缀纯属冗余噪声。

引入 `splitModelName` 按最后一个 `/` 拆分：最后段做主标签（`sensenova-6.8-flash-lite`），前缀降为小字 caption（11px、tertiary 色调）。视觉层级：可读短名在前，路由噪声在后，最多两行不撑高菜单。

触发按钮也只显示短名，但 `title` 属性和 `aria-label` 保留完整全名——无障碍工具不会丢失精确身份信息。这个细节容易遗漏：可读性和机器可识别性不是二选一，而是层级化的共存。

---

## 三、移动端三回合

### 第一回合：宽度收窄

初始 `max-width: min(420px, 50vw, calc(100vw - 32px))`——桌面没问题，手机上菜单贴右展开，遮住了左侧内容。尝试收窄到屏幕一半。

### 第二回合：min-width 的逆袭

改了 max-width，手机上依然很宽。debug 发现真正的元凶：`min-width: min(240px, calc(100vw - 32px))`。

CSS 级联规则里，当 `min-width > max-width` 时，`min-width` 优先。手机屏 390px 时：max-width 算出来 195px（50vw），min-width 算出来 240px（min(240, 358)）。240 覆盖了 195，菜单固定 240px——改 max-width 根本压不住它。

这是个经典的 CSS 声明优先级陷阱。w3c 规范明确写了：当 min-value 大于 max-value 时，min-value 胜出。但日常开发中很少碰到这两个值冲突的情况，所以容易忘记这条规则。修复：在手机断点里同时设 width 和 min-width 到 160px。

### 第三回合：从右上角到屏幕中央

收窄后用户反馈："左边还是看不到"——问题不是宽度，而是**位置**。菜单用 `position: absolute; right: 0; bottom: calc(100% + 8px)` 锚在 composer 尾部向左上方展开。手机上 composer 尾部偏右，菜单自然偏左。

解决：手机断点下改为 `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%)`——视口正中央弹窗。

这里有一个前置检查：`position: fixed` 在 CSS 里相对于视口定位，但**如果任何祖先有 `transform`、`filter`、`perspective`、`contain: paint` 或 `will-change` 属性，fixed 会退化为相对该祖先定位**（creating a containing block）。仓库的 `ConversationRoot` 里有一段注释精确地提到了这点：

> "Flex, NOT absolute+transform: a transform would make this box the containing block for position: fixed descendants (pickers/modals), shrinking them."

也就是说，composer 容器刻意避免了 transform（用 flex 代替），确保下游的 picker 和 modal 不被 containment 吞掉。grep 验证了祖先链上没有 transform（已有的 transform 都在叶子装饰元素上：chevron 旋转、tooltip 居中、hero glow），`fixed` 安全可用。

最终宽度定在 `min(280px, calc(100vw - 48px))`——手机屏居中后两侧留白对称，280px 里"sensenova-6.8-flash-lite"这样的短名刚好够放下不触发省略号。

---

## 四、/get_opencode_models：一次克制的功能设计

用户提了一个简单需求：加个命令获取 OpenCode 网关的最新模型列表。

### 架构选择

仓库里已经有一条通路：SDK server → `models-endpoint` RPC → 拉远程端点的模型列表。但这条路需要在 `jsonrpc-agent` 的 `applyRuntime` 里装配确认 `llm-pi-ai` 服务可达，属于架构级改动。

用户要的是轻量查询，不是新能力。于是选了最短路径：TUI 直接 `fetch` 网关的 `GET /models` 端点。API Key 从 `process.env.OPENCODE_GO_API_KEY` 读取（launch-tui.sh 已 source .env）。结果格式化输出到 transcript，不涉及 SDK、不做配置写回。

实现上，核心函数 `fetchGatewayModels` 接受注入的 `fetchImpl`（方便测试 mock）和 `declaredIds`（已配置模型 ID 集合）。每个模型标注 `configured: true/false`，未配置的排前面，附带 `owned_by` 信息。输出分组显示：绿色 ● 已配置 / 黄色 ○ 未配置。

### 一个类型小坑

测试时撞上 `exactOptionalPropertyTypes: true`——TypeScript 严格模式下，`apiKey?: string` 不接受 `process.env.OPENCODE_GO_API_KEY` 的 `string | undefined` 类型，因为"可选"不等于"可以是 undefined"。修复：签名改为 `apiKey?: string | undefined`，显式声明接受 undefined。

### 与 Web 端的分工

Web 端其实已有更强版本：设置页的 ModelListEditor 有"获取可用模型"按钮，走 `api.llm.discoverModels` RPC，拉回候选模型后自动勾选未配置的，用户确认即可写入 settings.yaml。

两端分工明确：Web 是管理型（发现 + 采纳 + 写回），TUI 是查询型（快速瞄一眼上游有什么）。不重复建设，不互相替代。

---

## 五、Patch 包重建

### 旧 patch 的失配

仓库 `ygsdoc/dsh-model-tps-patch/` 下保存着一份部署 patch 包——当 dsh 升级覆盖源码时，一键重新应用定制改动。旧版覆盖四项改动：输入框占位符显示模型名、TPS 徽标、菜单宽度上限、z-index 提升。

尝试在当前 master 上验证：`git apply --check` 失败（文件已存在/上下文冲突），`git apply --reverse --check` 也失败（后续提交改了相同 CSS 区域）。patch 正反向都不能应用——它成了一张废纸。

### 基线考古

重建 patch 需要确定基线——即"定制之前，源码长什么样"。通过 `git log --oneline` 逐文件追溯：

- InputBar 的占位符+TPS 功能对应提交 `409006882b`
- apiproxy 的 modelSelection 投影对应提交 `ebc896fc41`
- 后者比前者更早

但 `409006882b^..HEAD` 的 diff 里不包含 apiproxy 文件——说明投影功能在占位符提交之前就已落地。真正的系列起点是 `ebc896fc41`，基线取其父提交 `ebc896fc41^`。

### 生成与验证

```bash
git diff ebc896fc41^..HEAD -- <10个文件>
```

生成 508 行新 patch（原 405 行，新增 ModelSelect.tsx 复合名拆分、宽度调整、手机居中共三处改动）。10 个文件（原 9 个增加 ModelSelect.tsx）。

幂等验证：`git apply --reverse --check` 在当前 HEAD 上通过——说明 apply 脚本的"已在位，跳过"分支在含全部定制的树上能正确工作。升级后的机器如果已含定制（master 含这些提交），脚本会自动跳过；如果不含（旧版 dsh），脚本会应用 patch 并重建产物。

apply 脚本的注释从"四项改动"更新为"六项改动"，行数和文件数同步修正。基线锚点标注在脚本头部，方便未来每次定制进 master 后重新生成。

---

## 六、这一夜的意义

### 界面的第一读者是人

`opencode-go-completions:ox-alpha-free` 是给机器解析的路由键位，不是给人读的标签。`vision-http/sensenova/sensenova-6.8-flash-lite` 是给编排系统用的资源标识，不是给选择模型的人看的菜单项。当 UI 直接照搬后端数据结构作为显示文本时，机器效率优先于人类认知——这在内部工具里可以忍，在面向用户的界面上不行。

拆分复合名不是装饰，是对"信息层级"的重新排序：谁先被看到（短名），谁留在需要时才查（前缀），谁存给机器用（tooltip 和 aria）。

### 错误必须响亮

`loadModelsFromConfig` 的 catch 块是一个好意图的坏实践："解析失败不应阻断启动"。但它把诊断信号一并吞掉了。用户看到的空选择器没有任何错误提示，排查完全依赖逆向推理。

更好的做法是：解析失败时返回空列表的同时打印一行诊断日志——哪一行出了什么错。这样排查从"半小时逆向"缩短到"一眼看 log"。这条改进不在本次提交范围内，但已在 `a617e7b4d1` 的 postmortem 里记录为后续事项。

### 定制必须自带恢复路径

没有 patch 包的定制是不可持续的。每次 dsh 升级覆盖源码，手工重做一遍改动既不现实也不可靠。`model-tps-sidebar-z` patch 包用 `git apply` + 三态幂等逻辑（正向应用 / 反向验证跳过 / 冲突报错）保证了定制的可恢复性。

但它必须跟随 master 演进重新生成。旧 patch 因后续提交修改了相同文件而双向失配，沦为废纸。这次重建用 `ebc896fc41^` 作为基线锚点——这是所有定制提交的共同祖先之前——保证新 patch 从一个干净的起点覆盖全部改动。

每次有新定制进 master，都应该重新跑一次 `git diff <baseline>..HEAD` 重生成 patch。这应该是 `apply-model-tps.sh` 脚本头部标注的 SOP。

---

## 附录：提交清单

| 提交 | 时间 | 说明 |
|------|------|------|
| `c65b34cf78` | 08-21 23:51 | 菜单宽度上限 min(420px, 50vw, 100vw-32px) + z-index 20→100 |
| `7daadacdf4` | 08-22 00:21 | 加入 ox-alpha-free 模型 + 配置文档 + YAML 排障指南 |
| `a617e7b4d1` | 08-22 00:25 | settings.yaml YAML 坑 postmortem + TUI patch kit |
| `ec5578d6ec` | 08-22 00:26 | 恢复被误删的 xiaomi 路由头（空选择器根因修复） |
| `8a686c7468` | 08-22 00:35 | ModelPicker label 用模型名替代路由限定 ID |
| `5db504a2ff` | 08-22 00:54 | /get\_opencode\_models 命令 + 复合名拆分显示 |
| `505a764e14` | 08-22 01:04 | 手机端菜单宽度收窄（min-width 优先级修复） |
| `bf05cc27de` | 08-22 01:12 | 手机端菜单视口居中（position: fixed 弹窗） |
| `b6f7bb05c5` | 08-22 01:22 | patch 包重建（ebc896fc41^ 基线，10 文件 508 行，幂等验证通过） |
