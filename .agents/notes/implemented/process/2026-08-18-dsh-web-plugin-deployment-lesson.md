# 开发教训：dsh-web 插件部署流程

> **日期**：2026-08-18
> **类型**：经验教训
> **教训**：源码修改不会自动生效，需要手动同步到全局安装位置

---

## 问题描述

修改了源码中的 locale 文件（状态栏文字精简、Session log 按钮优化），重新 bundle 后，dsh web 界面没有变化。

## 根本原因

`dsh web` 命令使用的是**全局安装的包**，不是当前源码目录：

```
全局安装位置：/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
源码位置：    /Users/ygs/ygs/deepseek-harness/packages/
```

这两个是**独立的副本**，修改源码不会影响全局安装的包。

## 正确流程

修改源码后，必须执行以下步骤：

### 1. 重新构建受影响的包

```bash
cd /Users/ygs/ygs/deepseek-harness

# 重新构建 ui-conversation（状态栏文字）
pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle

# 重新构建 session-log-export（下载按钮）
pnpm --filter @deepseek-ai/dsh-session-log-export bundle
```

### 2. 同步到全局安装位置

```bash
# 同步 ui-conversation
cp packages/client/ui-conversation/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js

# 同步 session-log-export
cp packages/session-query/session-log-export/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/lib/client.js
```

### 3. 重启 dsh web

```bash
pkill -9 -f "dsh"
cd /Users/ygs/ygs/deepseek-harness && nohup dsh web --host 127.0.0.1 --port 3080 --trusted-host dsh.want.biz > /tmp/dsh-web.log 2>&1 &
```

---

## 关键发现

| 发现 | 说明 |
|------|------|
| dsh 命令路径 | `/opt/homebrew/bin/dsh` → 使用 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` |
| 插件加载位置 | 全局安装的 `node_modules/`，不是源码目录 |
| 插件 revision | 基于文件内容 hash，修改后会自动变化 |
| 验证方法 | `curl http://127.0.0.1:3080/plugins/<id>/client.js` 检查内容 |

---

## 避免下次踩坑

1. **改源码前先确认**：当前修改的是哪个位置的包
2. **构建后必须同步**：bundle 只更新源码目录，不更新全局安装
3. **验证生效**：重启后用 curl 检查插件内容是否变化
4. **记录路径映射**：源码包 → 全局安装包的对应关系

---

## 相关路径映射

| 源码包 | 全局安装位置 |
|--------|-------------|
| `packages/client/ui-conversation/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/` |
| `packages/session-query/session-log-export/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/` |

---

## 修复的 UI 问题

1. **状态栏文字精简**：`工具调用` → `tools`，`首 token 平均` → `首tok`，`缓存命中` → `缓存`，`输入/输出` → `↓/↑`
2. **Session log 按钮**：去掉文字，只留下载图标
3. **工作区配置**：添加缺失的 `deepseek-harness-book` 工作区
