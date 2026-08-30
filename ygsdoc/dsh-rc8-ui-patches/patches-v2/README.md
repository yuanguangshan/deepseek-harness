# dsh web UI four-optimization patch set

English | [中文](README.zh.md)

Four custom optimizations for the DeepSeek Harness (dsh) 0.1.0-rc.8 web UI, persisted as patch files and restored with one command after `pnpm install`.

## Quick apply

```bash
bash apply.sh
```

## The four optimizations

| # | Target package | Patch file | Effect |
|---|---|---|---|
| 1 | `@captain1275/dsh-live-stats` | `@captain1275__dsh-live-stats.patch` | Integer TPS display, moved to the right of the same row as the input box |
| 2 | `@captain1275/dsh-client-ui-skin-aurora` | `@captain1275__dsh-client-ui-skin-aurora.patch` | Sidebar stays visible on mobile, no auto-collapse |
| 3 | `@captain1275/dsh-web-ui-all` | `@captain1275__dsh-web-ui-all.patch` | Hide session-log text + model name in the input placeholder + narrower model menu |
| 4 | `@captain1275/dsh-client-ui-web-ui-settings` | `@captain1275__dsh-client-ui-web-ui-settings@0.2.8.patch` | Fix the `settings.plugin.item` keyed-slot error about a missing `key` |

## Files

```
patches-v2/
├── README.md                          ← this file
├── apply.sh                           ← one-command apply script
├── @captain1275__dsh-live-stats.patch
├── @captain1275__dsh-client-ui-skin-aurora.patch
├── @captain1275__dsh-web-ui-all.patch
└── @captain1275__dsh-client-ui-web-ui-settings@0.2.8.patch
```

## How it works

- The dsh web profile (`~/.dsh/profiles/web`) manages dependencies with pnpm
- Every `pnpm install` regenerates `node_modules`, wiping manual edits
- These patch files apply through the `patchedDependencies` mechanism of `pnpm-workspace.yaml`, or manually via `patch -p0`
- `apply.sh` checks whether a file is already patched (grep `patched`) to avoid double application

## Differences from the old patches/ directory

| | `patches/` (old) | `patches-v2/` (this directory) |
|---|---|---|
| 4 `.patch` files | ✅ | ✅ (identical content) |
| `apply.sh` one-command script | ❌ | ✅ |
| `README.md` documentation | ❌ | ✅ |
| Referenced by `restore-patches.sh` | ✅ | ❌ |
| Referenced by `pnpm-workspace.yaml` | ✅ | ❌ |

## apply.sh vs restore-patches.sh

| | `apply.sh` (this directory) | `restore-patches.sh` (old) |
|---|---|---|
| Lines | 85 | 139 |
| Patches only | ✅ applies the 4 patches only | ❌ does much more |
| pnpm install | ❌ does not run | ✅ runs pnpm install |
| pnpm-workspace update | ❌ untouched | ✅ checks patchedDependencies |
| Mobile sidebar DOM manipulation | ❌ | ✅ has observeFrameCollapse logic |
| Global preset file direct edits | ❌ | ✅ edits dsh-client-ui-agent-preset |
| Plugin file copying | ❌ | ✅ copies 3 local plugins |
| Verification/diagnostics output | ✅ simple | ✅ detailed |

**Summary**: `apply.sh` = the lightweight version, patches only, good for quick recovery; `restore-patches.sh` = the full version, with the pnpm flow + plugins + presets + diagnostics. The two do not conflict.

## Notes

- **Patch 4** (web-ui-settings) must also be registered in `patchedDependencies` in `pnpm-workspace.yaml`, or `pnpm install` overwrites it
- **Browser cache**: after applying, hard-refresh (`Cmd+Shift+R`) to see the effect
- **After upgrading dsh**: re-check patch compatibility; the patch files may need updating
