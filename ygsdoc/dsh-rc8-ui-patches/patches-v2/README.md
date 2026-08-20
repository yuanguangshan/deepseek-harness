# dsh web UI 四项优化补丁

对 DeepSeek Harness (dsh) 0.1.0-rc.8 web 界面的四项定制优化，通过 patch 文件持久化，`pnpm install` 后一键恢复。

## 快速应用

```bash
bash apply.sh
```

## 四项优化

| # | 目标包 | 补丁文件 | 效果 |
|---|---|---|---|
| 1 | `@captain1275/dsh-live-stats` | `@captain1275__dsh-live-stats.patch` | TPS 显示整数化 + 移到输入框同行右侧 |
| 2 | `@captain1275/dsh-client-ui-skin-aurora` | `@captain1275__dsh-client-ui-skin-aurora.patch` | 手机端侧栏常显，不自动收起 |
| 3 | `@captain1275/dsh-web-ui-all` | `@captain1275__dsh-web-ui-all.patch` | session log 文字隐藏 + 模型名显示在输入框占位符 + 模型菜单缩窄 |
| 4 | `@captain1275/dsh-client-ui-web-ui-settings` | `@captain1275__dsh-client-ui-web-ui-settings@0.2.8.patch` | 修复 `settings.plugin.item` keyed slot 缺少 `key` 的报错 |

## 文件说明

```
patches-v2/
├── README.md                          ← 本文件
├── apply.sh                           ← 一键应用脚本
├── @captain1275__dsh-live-stats.patch
├── @captain1275__dsh-client-ui-skin-aurora.patch
├── @captain1275__dsh-web-ui-all.patch
└── @captain1275__dsh-client-ui-web-ui-settings@0.2.8.patch
```

## 原理

- dsh 的 web profile（`~/.dsh/profiles/web`）用 pnpm 管理依赖
- 每次 `pnpm install` 会重新生成 `node_modules`，覆盖手动修改
- 这些 patch 文件通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 机制或手动 `patch -p0` 应用
- `apply.sh` 检测文件是否已打过补丁（grep `patched`），避免重复应用

## 注意事项

- **第 4 个补丁**（web-ui-settings）需要同时在 `pnpm-workspace.yaml` 的 `patchedDependencies` 中登记，否则 `pnpm install` 会覆盖
- **浏览器缓存**：应用补丁后需硬刷新（`Cmd+Shift+R`）才能看到效果
- **升级 dsh 后**：需重新检查补丁兼容性，可能需要更新 patch 文件
