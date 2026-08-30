# Agent Note: dsh-web 插件部署流程教训

Status: implemented

[English](2026-08-18-dsh-web-plugin-deployment-lesson.md) | 中文

## 问题

修改了源码中的 locale 文件（状态栏文字精简、Session log 按钮优化），重新 bundle 后，dsh web 界面没有变化。改动在运行时不可见，也没有任何报错提示原因。

## 决策

根本原因：`dsh web` 命令使用的是**全局安装的包**，不是当前源码目录——两者是独立副本，改源码永远到不了被服务的 UI：

```
全局安装位置：/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
源码位置：    /Users/ygs/ygs/deepseek-harness/packages/
```

修改源码后的正确部署流程：

1. 重新构建受影响的包：

```bash
cd /Users/ygs/ygs/deepseek-harness

# 重新构建 ui-conversation（状态栏文字）
pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle

# 重新构建 session-log-export（下载按钮）
pnpm --filter @deepseek-ai/dsh-session-log-export bundle
```

2. 把构建产物同步到全局安装位置：

```bash
# 同步 ui-conversation
cp packages/client/ui-conversation/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js

# 同步 session-log-export
cp packages/session-query/session-log-export/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/lib/client.js
```

3. 重启 dsh web：

```bash
pkill -9 -f "dsh"
cd /Users/ygs/ygs/deepseek-harness && nohup dsh web --host 127.0.0.1 --port 3080 --trusted-host dsh.want.biz > /tmp/dsh-web.log 2>&1 &
```

过程中的关键发现：

| 发现 | 说明 |
|------|------|
| dsh 命令路径 | `/opt/homebrew/bin/dsh` → 使用 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` |
| 插件加载位置 | 全局安装的 `node_modules/`，不是源码目录 |
| 插件 revision | 基于文件内容 hash，修改后会自动变化 |
| 验证方法 | `curl http://127.0.0.1:3080/plugins/<id>/client.js` 检查内容 |

## 备选方案

- **从源码目录跑 `dsh web`，免去同步** — 对本部署不适用：被服务的实例必须保留 `/opt/homebrew` 的全局安装 profile，同步步骤是该布局的代价。
- **把全局 node_modules 条目软链回源码 `lib/`** — 否决：这会把全局安装耦合到工作树最后一次构建的结果上，且包改名时静默失效；显式复制让被部署状态可检查。

## 后果

源码改动现在经固定的三步流程（重建、同步、重启）到达被服务的 UI，且可以用 `curl` 对照插件 revision 验证。这条流程交付的 UI 修复：状态栏文字精简（`工具调用` → `tools`、`首 token 平均` → `首tok`、`缓存命中` → `缓存`、`输入/输出` → `↓/↑`）、Session log 按钮只留下载图标、补上缺失的 `deepseek-harness-book` 工作区。需要常备的路径映射：

| 源码包 | 全局安装位置 |
|--------|-------------|
| `packages/client/ui-conversation/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/` |
| `packages/session-query/session-log-export/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/` |
