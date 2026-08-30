# dsh rc.8 three-optimization UI patch backup

English | [中文](README.zh.md)

> Three interface optimizations overwritten by the upgrade to `0.1.0-rc.8`, made into patches that can be re-applied with one command

## Contents

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

## The three optimizations

1. **TPS shown on the right of the input-box master row** (`TPS: 234 tok/s`, integer)
2. **Remove the session log above the input box**
3. **Mobile left menu always visible** (no auto-collapse under 1024)

## How to restore

```bash
# run once after every dsh npm i -g upgrade
bash ~/.dsh/profiles/web/restore-patches.sh
# or
bash ygsdoc/dsh-rc8-ui-patches/restore-patches.sh
```

The script: verifies the patches → re-applies them through `pnpm install` → re-applies the global `SIDEBAR_AUTO_COLLAPSE` → restarts web

## Who changed what (us vs you)

| Who | What was done |
|---|---|
| Us | 3 pnpm patches + 3 local plugins + cordis.patch.yml registration + direct global layout edits |
| You | Added `typeof document` guards for the hide/mobile plugins + `pnpm install` filled in `dsh-sdk-protocol` |

The guards are merged into the current plugins, `pnpm-workspace.yaml` is registered, and `patches/` is persisted.
