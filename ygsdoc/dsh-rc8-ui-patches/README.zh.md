# dsh rc.8 三项 UI 优化补丁备份

[English](README.md) | 中文

> 升级到 `0.1.0-rc.8` 后被覆盖的三个界面优化，已做成可一键重打的补丁

## 包含内容

```
dsh-rc8-ui-patches/
├── restore-patches.sh              # one-command restore script (explained in its header comments)
├── patches/
│   ├── @captain1275__dsh-live-stats.patch              # TPS moved onto the input-box master row
│   ├── @captain1275__dsh-client-ui-skin-aurora.patch   # remove sidebar localStorage persistence
│   └── @captain1275__dsh-web-ui-all.patch              # hide session log + mobile sidebar CSS
├── plugins/
│   ├── hide-session-log.plugin.mjs
│   ├── mobile-sidebar-always-visible.plugin.mjs
│   └── mobile-rail-fab.plugin.mjs
├── cordis.patch.yml.bak            # snapshot of the cordis.patch.yml at that time
└── README.md                       # this file
```

## 三项优化

1. **TPS 显示到输入框 master 同行右侧**（`TPS: 234 tok/s` 整数）
2. **去掉输入框上方的 session log**
3. **手机左侧菜单常显**（不再 <1024 自动收起）

## 恢复方法

```bash
# run once after every dsh npm i -g upgrade
bash ~/.dsh/profiles/web/restore-patches.sh
# or
bash ygsdoc/dsh-rc8-ui-patches/restore-patches.sh
```

脚本会：校验补丁 → `pnpm install` 重打 → 重打全局 `SIDEBAR_AUTO_COLLAPSE` → 重启 web

## 差异对照（我们改的 vs 你修的）

| 谁 | 做了什么 |
|---|---|
| 我们 | 3 个 pnpm 补丁 + 3 个本地插件 + cordis.patch.yml 注册 + 全局 layout 直改 |
| 你 | 为 hide/mobile 插件补 `typeof document` 守卫 + `pnpm install` 补齐 `dsh-sdk-protocol` |

守卫已合入当前插件，`pnpm-workspace.yaml` 已登记，`patches/` 已持久化。
