# ygs/dsh-repl 启动失败：opencode 路由名被改短，适配器找不到

> 日期：2026-09-14 ｜ 性质：配置漂移导致的启动失败 ｜ 状态：**已修复并推送**
> 提交：`f46aaa7f2f` ｜ 分支：`master` → fork

## 一、现象

`ygs`（即 `alias dsh-repl`）一启动就退出：

```
$ ygs
初始化失败: no adapter registered for provider "opencode-go"
[ELIFECYCLE] Command failed with exit code 1.
```

**注意报错方向**：它说"没有为 `opencode-go` 注册适配器" —— 也就是
**REPL 认为 `opencode-go` 这个名字应该存在，但在配置里找不到**。
第一直觉容易误判成"opencode-go 这个供应商失效了"，实际恰恰相反。

## 二、根因：一个路由名被改短了，引用方没跟着改

`ygs` 的实现（`~/.zshrc:177`）：

```bash
ygs() {
  local dir="$PWD"
  cd /Users/ygs/ygs/deepseek-harness && pnpm repl -- --cwd "$dir" "$@"
}
alias dsh-repl="ygs"
```

`pnpm repl` → `apps/repl/src/bin.ts`，其模型注册表由**两个来源合并**
（`apps/repl/src/core.ts` 的 `mergeModelRegistries`）：

| 来源 | 文件 | 权威性 |
|---|---|---|
| `~/.dsh/settings.yaml` | `llm-pi-ai.providers` | **权威**（dsh web 同源）|
| `examples/jsonrpc-agent/interactive.cordis.yml` | `llm-pi-ai` 插件的 `providers` | 补充（仅补 settings 未覆盖的 route）|

而默认模型来自 `settings.yaml`：

```yaml
agent-default-model:
  model: deepseek-v4-flash
  provider: opencode-go        # ← 指向 opencode-go
```

**但 TUI 的 cordis 配置里，这个 route 叫 `opencode`**：

| 文件 | route 名 |
|---|---|
| `~/.dsh/settings.yaml` | `opencode-go` |
| `examples/jsonrpc-agent/interactive.cordis.yml` | **`opencode`** ← 少了 `-go` |

于是 REPL 拿 `opencode-go` 去问注册表要适配器 → **没有这个名字** → `NO_ADAPTER`。

**引入问题的提交**：`90e71d9afd chore(config): interactive.cordis.yml 切换 cc-switch 本地代理为主路由`
—— 那次把 `opencode-go` 改成了 `opencode`（同时拆出 `opencode-go-completions`），
但 `~/.dsh/settings.yaml` 里的 `agent-default-model.provider` 没同步改。

> **为什么不早点暴露**：因为 `settings.yaml` 是**用户目录**下的文件，不在版本控制里。
> 改配置的人和用配置的人（web / TUI / vision patch）各改各的，没有一致性校验。

## 三、为什么改 cordis 而不改 settings

两条路都能让名字对上，但**必须选 cordis 侧** —— 因为 `opencode-go` 这个名字有多个消费方：

| 消费方 | 引用 | 影响 |
|---|---|---|
| `~/.dsh/settings.yaml` | `agent-default-model.provider: opencode-go` | dsh web 模型选择器 |
| **3080 正在运行的 dsh web** | 同上 | 改了直接打挂线上 web |
| **vision patch** | `ygsdoc/dsh-vision-patch/cordis.patch.yml:32` `- provider: opencode-go` | 识图功能 |
| vision patch baseURL | `https://opencode.ai/zen/go/v1/responses` | 同上 |

而 TUI 的 `interactive.cordis.yml` 是 **TUI 独占**的，
且 `apps/repl/src/*.ts` 里**没有任何硬编码的 `opencode` 字面量**（已 grep 确认）。

**结论：改 TUI 侧，改动面最小。**

## 四、修复

`examples/jsonrpc-agent/interactive.cordis.yml`：

```diff
-      opencode:
+      opencode-go:
         displayName: opencode go (direct)
+        # 路由名必须是 opencode-go（不是 opencode）：~/.dsh/settings.yaml 的
+        # agent-default-model.provider 与 vision patch 都按 opencode-go 引用，
+        # 改短名会让 REPL 启动时报 no adapter registered for provider "opencode-go"。
```

**加注释是刻意的** —— 这个坑已经踩过一次，注释能防第二次。

顺带（同一文件的工作区既有改动，一并提交）：

- tencent route 新增 `deepseek-v4.1-flash`
- tencent route 新增 `tencent-free`（wb-proxy 虚拟自动路由，不声明会被 pi-ai 以 `UNKNOWN_MODEL` 拒掉）
- 注释 36 → 37 个

## 五、验证方法：变量对比法

不靠猜，**只改一个变量看行为是否翻转**：

| 实验 | 配置 | 结果 |
|---|---|---|
| ① 原配置 | `provider: opencode-go`（cordis 里是 `opencode`）| ❌ `no adapter registered` 立即退出 |
| ② 临时改 settings | `provider: opencode` | ✅ 正常进入 TUI（超时才被杀）|
| ③ **最终修复** | cordis route 名改回 `opencode-go` | ✅ 正常进入 TUI |

②证明了"名字不匹配"是唯一变量；③证明修复方向正确。

修复后实际启动输出：

```
ygs · opencode-go / deepseek-v4-flash · /new 新会话
```

状态栏正确显示 `opencode-go / deepseek-v4-flash`。

**提交前额外校验**：

```bash
node -e "const yaml=require('yaml');
  const d=yaml.parse(require('fs').readFileSync('examples/jsonrpc-agent/interactive.cordis.yml','utf8'));
  const llm=d.find(x=>x.id==='llm-pi-ai');
  console.log(Object.keys(llm.config.providers));"
# → [ 'ccswitch', 'opencode-go', 'tencent' ]   ✅
```

（解析时会有 `!!js` 标签的 warning，**属预期** —— REPL 用自定义 `cordisSchema` 处理这些标签。）

## 六、推送时踩的两个坑

两个都是**非交互式 shell 环境不完整**导致的，和文件名无关：

**坑 1：`timeout: command not found`**

我下意识用 `timeout 120 git push` —— GNU 命令，**macOS 没有**。

**坑 2：pre-push 钩子 `pnpm: command not found`**

```
┃  typecheck ❯
sh: pnpm: command not found
exit status 127
✗ typecheck (0.07 seconds)
error: failed to push some refs
```

lefthook 的 `typecheck` 钩子依赖 `pnpm`，而该执行环境的 PATH 里没有。
补上 PATH 后重推，typecheck 38 秒通过：

```bash
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"
git push fork master
# → df97ffb45c..f46aaa7f2f  master -> master
```

> **同类根因已出现三次**（本书同名问题）：
> ① 中文 `pbcopy` 静默失败（缺 `LANG`）
> ② ima API 凭证读不到（缺 `IMA_OPENAPI_*`）
> ③ pre-push 钩子失败（缺 `pnpm` PATH）
>
> **共同点**：这些变量都定义在 `~/.zshrc`，而**非交互式 shell 不加载 `.zshrc`**。
> 已通过 `~/.zshenv`（zsh 唯一无条件加载的文件）补了 locale；PATH 类变量视需要再补。

## 七、验收记录

- `ygs` 正常进入 TUI，状态栏 `opencode-go / deepseek-v4-flash` ✓
- YAML 语法校验通过，`opencode-go` route 存在，tencent 38 个模型 ✓
- 提交前敏感信息扫描：diff 内**无密钥**（只有 `apiKeyEnv: XXX` 变量名）✓
- `git ls-remote fork refs/heads/master` == 本地 HEAD `f46aaa7f2f` ✓
- 3080 运行的 dsh web **未受影响**（它跑的是另一个 checkout：`deepseek-harness-dev`）✓

## 八、经验教训

1. **报错里的名字要顺着读，不要逆着猜。**
   `no adapter registered for provider "opencode-go"` 的意思是
   "**配置里缺 `opencode-go`**"，不是"`opencode-go` 这个供应商坏了"。

2. **改名时要搜全部消费方。**
   路由名/环境变量/配置键这类"字符串契约"，散落在
   `settings.yaml`（不在版本控制）、cordis 配置、patch 文件、脚本里，
   **改一处必须全局 grep 一遍**。

3. **跨文件的字符串契约值得加注释。**
   `opencode-go` 这个名字下次还可能被"顺手改短"，
   在定义处写明"为什么不能改"，成本最低。

4. **修配置要先问"谁还在依赖它"。**
   改 settings 是最直觉的，但会连带打挂 web 和识图 ——
   先 `git grep` + 查运行中进程，再决定改哪一侧。

5. **`ygs` 依赖 `settings.yaml`，而该文件不在 Git 里。**
   两套配置（用户目录 + 仓库）之间的引用关系**没有任何自动校验**。
   后续可考虑：启动时若 `agent-default-model.provider` 在注册表中不存在，
   打印一条更明确的错误（列出可用 route），而不是只抛 `NO_ADAPTER`。
