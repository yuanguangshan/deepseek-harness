# Agent Note: dsh-web plugin deployment lesson

Status: implemented

English | [中文](2026-08-18-dsh-web-plugin-deployment-lesson.zh.md)

## Problem

Locale files in the source tree were edited (status-bar text trimmed, session-log button simplified) and the packages re-bundled, but the dsh web UI did not change. The edits were invisible at runtime, with no error pointing at why.

## Decision

Root cause: the `dsh web` command runs the **globally installed package**, not the source checkout — two independent copies, so editing the source never reaches the served UI:

```
全局安装位置：/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
源码位置：    /Users/ygs/ygs/deepseek-harness/packages/
```

The working deployment flow after any source edit:

1. Rebuild the affected packages:

```bash
cd /Users/ygs/ygs/deepseek-harness

# 重新构建 ui-conversation（状态栏文字）
pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle

# 重新构建 session-log-export（下载按钮）
pnpm --filter @deepseek-ai/dsh-session-log-export bundle
```

2. Sync the built bundles into the global install:

```bash
# 同步 ui-conversation
cp packages/client/ui-conversation/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js

# 同步 session-log-export
cp packages/session-query/session-log-export/lib/client.js \
   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/lib/client.js
```

3. Restart dsh web:

```bash
pkill -9 -f "dsh"
cd /Users/ygs/ygs/deepseek-harness && nohup dsh web --host 127.0.0.1 --port 3080 --trusted-host dsh.want.biz > /tmp/dsh-web.log 2>&1 &
```

Key facts established on the way:

| Finding | Detail |
|------|------|
| dsh command path | `/opt/homebrew/bin/dsh` → uses `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` |
| Plugin load location | the global install's `node_modules/`, not the source directory |
| Plugin revision | content-hash based, changes automatically after edits |
| How to verify | `curl http://127.0.0.1:3080/plugins/<id>/client.js` and inspect the content |

## Alternatives considered

- **Run `dsh web` from the source checkout so no sync is needed** — not applicable for this deployment: the served instance must keep the globally installed profile at `/opt/homebrew`, so the sync step is the price of that layout.
- **Symlink the global node_modules entries back to source `lib/`** — rejected: it couples the global install to whatever the working tree last built and breaks silently when a package is renamed; an explicit copy keeps the deployed state inspectable.

## Consequences

Source edits now reach the served UI through a fixed three-step ritual — rebuild, sync, restart — and the served bundle is verifiable with `curl` against the plugin revision. The UI fixes this flow delivered: status-bar text trimmed (`工具调用` → `tools`, `首 token 平均` → `首tok`, `缓存命中` → `缓存`, `输入/输出` → `↓/↑`), the session-log button reduced to a download icon, and the missing `deepseek-harness-book` workspace registered. The path mapping to keep at hand:

| Source package | Global install location |
|--------|-------------|
| `packages/client/ui-conversation/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/` |
| `packages/session-query/session-log-export/` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-log-export/` |
