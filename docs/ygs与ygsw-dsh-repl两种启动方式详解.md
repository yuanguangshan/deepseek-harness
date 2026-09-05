# ygs 与 ygsw：DeepSeek Harness REPL 的两种启动方式详解

> 整理自 deepseek-harness 仓库实测代码链路（2026-08-27），两条链路均已逐行核实。

## TL;DR

| | **ygs** | **ygsw** |
|---|---|---|
| 本质 | `cd 仓库 && pnpm repl` → **tsx 直跑 TS 源码** | `launch-tui.sh` → **node 跑 tsdown 构建产物** |
| 附加动作 | 无 | 先确保 dsh web(3080) 活着，再带 `--web-sessions` 起 TUI |

一句话：**ygs 是开发模式（源码即所得），ygsw 是日常使用模式（构建产物 + web 共享会话）**。

---

## 一、ygs 的完整流程

```bash
# ~/.zshrc 第 177 行
alias ygs="cd /Users/ygs/ygs/deepseek-harness && pnpm repl"
```

执行链条：

1. **cd 到仓库根** `/Users/ygs/ygs/deepseek-harness`
2. **pnpm repl** 解析到根 `package.json` 的 scripts：
   ```json
   "repl": "node --import tsx/esm apps/repl/src/bin.ts"
   ```
3. `--import tsx/esm` 把 tsx 注册成常驻 ESM loader —— 之后每个 `import './tui-repl.ts'` 都是**即时转译、直接吃 `.ts` 源码**，完全绕过 lib/
4. 入口 `apps/repl/src/bin.ts`（55 行薄分发）：解析 `--resume` / `--cwd` / `--web-sessions`，交给 `runRepl()`（主体在 tui-repl.ts）

### 特征

- **源码即所得**：改 `src/*.ts` 甚至 `packages/sdk-*` 的 TS 源码，下次启动立刻生效，零构建
- 代价是冷启动要现转译一坨 TS（tui-repl.ts 86KB + core.ts + sdk-client 闭包），比跑 bundle 略慢
- 不带 `--web-sessions` → `DSH_SESSION_ROOT` 不设置 → `history.ts` 的 `sessionRoot()` 兜底返回 **`cwd/.sessions`**
  实测落在 `/Users/ygs/ygs/deepseek-harness/.sessions/--Users-ygs-ygs-deepseek-harness--`，和 dsh web 的会话**互不相通**
- 工作区就是仓库本身 → 典型的"开发 dsh 时用 dsh"场景

---

## 二、ygsw 的完整流程

```bash
# ~/.zshrc 第 180 行
alias ygsw='/Users/ygs/ygs/deepseek-harness/launch-tui.sh'
```

`launch-tui.sh`（172 行，`set -euo pipefail`）按序做五件事：

1. **加载凭证**（L30-39）：`set -a; source <repo>/.env; set +a` 导出 `OPENCODE_GO_API_KEY` 等；没加载到会打 WARNING 并落盘状态日志
2. **定目标工作区**（L46）：`PROJECT=${DSH_WEB_PROJECT:-/Users/ygs/Downloads/deepseek-harness-book-main}`。注释里记了历史坑：此变量若定义太晚，session 目录键会算成 `----`，resume 找不到最新会话会撞损坏文件
3. **ensure_web**（L49-99）：
   - `lsof` 探测 `DSH_WEB_PORT`(默认 3080)：在监听则跳过（幂等）
   - 未监听 → 统一委托守护脚本 `~/bin/dsh-web.sh start`（nohup 拉起、PID 写 `~/.dsh/run/dsh-web.pid`、日志 `~/.dsh/logs/dsh-web.log`）；守护脚本不在才回退裸 nohup 起 `node apps/cli/lib/bin.js web ... --trusted-host dsh.want.biz`
   - 轮询最长 25s 等端口就绪，结果追加写 `/tmp/launch-web-status.txt`
   - 特例：`DSH_SKIP_ENSURE_WEB=1` 整段跳过 —— 给 `dsh-web switch-to-tui` 用
4. **session 协调**（L101-158）：PROJECT 路径转会话键 → 扫共享根对应项目目录取最近修改者（排除 `-tui-copy`/`.bak`）。2026-08-18 起 Copy-on-Write coordinator 已停用（其 zstd frame 边界误判造成过 seq gap），新行为直接用原会话，并发安全靠官方 persistence 的 O_EXCL 锁；挂 `trap EXIT` 做 legacy 合并（现为 no-op）—— 这也是脚本末尾不能用 `exec` 的原因
5. **启动 TUI**（L161-169）：
   ```bash
   cd "$PROJECT"
   node "$REPL_ROOT/apps/repl/lib/bin.js" --web-sessions [--resume "$TUI_SESSION_ID"]
   ```

### 特征

- `lib/bin.js` 是 **tsdown 单文件 ESM bundle**：entry 指向先由 `tsc -b` 产出的 `lib/types/bin.js`；`deps.alwaysBundle: [/@deepseek-ai\//]` 把 sdk-client 等私有闭包全部内联，只外置 pi-tui/js-yaml（为了能发独立 npm 包）
- **改 src 必须重建**才能生效：`pnpm run build`，或 `pnpm --filter @deepseek-ai/dsh-repl exec tsdown --config apps/repl/tsdown.config.ts`
- `--web-sessions`（bin.ts L45-49）：**无条件**把 `DSH_SESSION_ROOT` 强制为 `~/.dsh/sessions`，压过任何环境值 → TUI 和 web 读写同一份 session log
- 工作区是书项目而非仓库

---

## 三、逐维对照表

| 维度 | ygs | ygsw |
|---|---|---|
| 代码形态 | TS 源码，tsx 运行时转译 | tsdown 预构建单文件 bundle |
| 改源码后 | **立即生效** | 必须 `pnpm run build`，否则旧代码 |
| 冷启动 | 慢（现转译） | 快（纯 JS 直接跑） |
| 工作区 cwd | deepseek-harness 仓库 | Downloads/deepseek-harness-book-main（`DSH_WEB_PROJECT` 可覆盖） |
| 会话根 | `<cwd>/.sessions`（repo 私有） | `~/.dsh/sessions`（与 web **共享**） |
| dsh web 3080 | 不管 | 幂等确保存活（经 `~/bin/dsh-web.sh` 守护） |
| 凭证来源 | 交互 shell 环境 | 额外 `source <repo>/.env` |
| resume | 依赖 REPL 默认恢复逻辑 | 显式 `--resume <最新id>` |
| 模型配置 | ✅ 都继承 zshrc 的 `DSH_REPL_PROVIDER=opencode-go / MODEL=ox-alpha-free` | ✅ |
| 生态关联 | 独立 | 与 `dsh-web` 一套打通（switch-to-tui/tui-start 也调本脚本） |

---

## 四、脚本位置清单

### ygs 链路（3 个文件）

| 角色 | 路径 |
|---|---|
| alias 定义 | `~/.zshrc:177` |
| npm scripts | `<repo>/package.json`（monorepo 根） |
| 真正入口（TS 源码） | `<repo>/apps/repl/src/bin.ts` → 同目录 `tui-repl.ts` |

### ygsw 链路（4 个关键文件）

| 角色 | 路径 |
|---|---|
| alias 定义 | `~/.zshrc:180` |
| 主脚本 | `<repo>/launch-tui.sh` |
| web 守护脚本 | `~/bin/dsh-web.sh`（入口命令 `~/bin/dsh-web`） |
| TUI 构建产物 | `<repo>/apps/repl/lib/bin.js` ← 由 `apps/repl/tsdown.config.ts` 打包 |

launch-tui.sh 还引用：`<repo>/.env`（凭证）、`<repo>/session-coordinator.cjs`（legacy 协调器，已停用）、落盘文件 `/tmp/launch-web-status.txt`、`/tmp/launch-web.pid`、`~/.dsh/run/dsh-web.pid`、`~/.dsh/logs/dsh-web.log`

---

## 五、怎么选

- **改 repl/web/sdk 源码、联调** → 用 `ygs`（改动频繁可用 `dsh-repl-dev` = watch 模式，同样 tsx 直跑 + 源码变更自动重启）
- **日常使用 / 要配 web GUI 看 TUI 会话** → 用 `ygsw`，一条命令同时保住 3080 web + 共享会话根，TUI 和浏览器里看到的是同一份日志
- **唯一易踩的坑**：改完源码直接敲 `ygsw` 会发现改动"没生效"——它跑的是 `lib/bin.js` 旧产物；此时要么 rebuild，要么先用 `ygs` 验证
