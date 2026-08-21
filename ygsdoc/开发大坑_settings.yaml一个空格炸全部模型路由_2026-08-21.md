# 开发大坑_settings.yaml一个空格炸全部模型路由_2026-08-21

> 现象：`ygs` / `ygsw` 启动 dsh-repl 直接报 `初始化失败: no adapter registered for provider "xiaomi"`
> 根因：手改 `~/.dsh/settings.yaml` 时写出非法 YAML（`size:88` 冒号后缺空格）
> 关联手册：《DSH模型配置完整手册.md》§10 速查表已收录此条

---

## 现象

```
$ ygs
初始化失败: no adapter registered for provider "xiaomi"
[ELIFECYCLE] Command failed with exit code 1.
```

去掉 `DSH_REPL_PROVIDER` 环境变量用默认值复现，报的是 `no adapter registered for provider "opencode-go"` —— **换哪个 provider 都炸**。这是第一条重要线索：问题不在某个具体路由。

## 根因链（一个字符 → 全局爆炸）

```yaml
# ~/.dsh/settings.yaml 第 131 行（损坏态）
pet:
  right: 294
  size:88      # ← 冒号后缺空格 + 行尾有空格 = 非法 YAML
```

完整因果链：

```
size:88（YAML 语法错误）
  → 整个 settings.yaml 解析失败（不是只有 pet 段失效！）
  → llm-pi-ai 的 User Layer（providers 四条路由）全部读不到
  → profiles() 为空 → 插件进入 dormant 态，一个 adapter 都不注册
  → TUI 初始化 initialize({provider}) → NO_ADAPTER
```

**为什么 web 没炸而 TUI 炸了**：dsh web 进程是在损坏发生前启动的，内存里持有旧配置；TUI 是新起进程，重新读盘才踩雷。两边表现不一致极大增加了排查迷惑性。

## 排查过程（为什么绕了远路）

按顺序排除了所有「看起来像」的原因，全部正常：

| 检查项 | 结果 |
|---|---|
| `~/.zshrc` 的 `DSH_REPL_PROVIDER=xiaomi` | ✅ 只是取值来源，不是问题 |
| pi-ai 包安装状态 | ✅ 在 `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai`（pnpm per-package 路径，查根 node_modules 会误判为未安装）|
| patch hash | ✅ 在位 |
| cordis.yml 的 llm-pi-ai 声明 | ✅ 正常 |
| settings.yaml 的 providers 配置 | ✅ 内容完全正确（但整份文件解析不了）|

**决定性一步**：不再看 TUI 报错，直接用插件自己的 Config schema 去 parse settings.yaml：

```bash
node --import tsx/esm -e "
const {parse} = require('yaml');
try { parse(require('fs').readFileSync('$HOME/.dsh/settings.yaml','utf8')); console.log('YAML OK'); }
catch(e){ console.log('YAML BROKEN:', e.message); }
"
# → YAMLParseError: Implicit keys need to be on a single line at line 131 ... size:88
```

一击命中。教训：**报错点离案发现场隔了十万八千里**，TUI 只会吐出最后一级的 `NO_ADAPTER`，上游的 YAML 解析失败被静默吞掉（只打印 message 不打印堆栈和原因）。

## 修复

```bash
# 把 size:88 改成 size: 88（冒号后加空格、去行尾空格），然后验证：
node -e "require('yaml').parse(require('fs').readFileSync('$HOME/.dsh/settings.yaml','utf8')); console.log('YAML OK')"
# 重启 TUI 即恢复
```

## 三条教训

1. **settings.yaml 是全局单点**：任何一段的语法错误炸的是整个文件，llm-pi-ai / pet / locale / ui-theme 一荣俱荣一损俱损。手改后必须先跑上面那行 YAML 校验。
2. **「换一个输入也炸」是关键信号**：xiaomi 炸、opencode-go 也炸，说明问题在公共层（settings 解析），不在单个路由。遇到 NO_ADAPTER 先怀疑公共层，别顺着报错的 provider 名钻牛角尖。
3. **TUI 的错误处理只吐 message 不吐 cause**：`初始化失败:` 后面没有堆栈没有根因。下次遇到初始化失败，第一反应应该是绕过 TUI 直接测底层（schema parse / 配置读取），而不是反复重启 TUI。

## 附：本次顺带确认的事实

- pnpm workspace 的包安装在 `packages/<group>/<pkg>/node_modules/` 下，不在根 `node_modules/`——查安装状态别查错地方。
- dsh-repl 默认装配是 `examples/jsonrpc-agent/interactive.cordis.yml`（`DSH_REPL_CONFIG` 可覆盖），其中 llm-pi-ai 显式声明的 opencode-go 路由是 Base 层；`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.*` 是 User 层，两者按 key 合并。
- 鲸鱼娘（dsh-pet）的显隐/位置/尺寸持久化在 settings.yaml 顶层 `pet:` 段 + `~/.dsh/pet.json` 两处；手改尺寸时两处都要改，且**千万别把 YAML 改坏**（本案例即手改 pet.size 引发）。
