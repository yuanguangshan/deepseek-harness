# dsh-vision-router SenseNova/Muse Spark patch

English | [中文](README.zh.md)

## Baseline version
- **dsh-vision-router**: 1.6.2
- **Backup file**: `index.js.v1.6.2.patched` (the complete patched index.js)

## Patch content (3 insertions)

### Insertion 1: declare r2UploadedFiles (~line 5422)
Position: before `for (const provider of httpFallbacks)`
```js
const r2UploadedFiles = []
```

### Insertion 2: SenseNova R2 upload + Muse Spark Responses API (~line 5455)
Position: after the closing `}` of `openAIBlocks.push({ type: 'text', text: block.text })`, before `// Direct HTTP providers must receive`
- SenseNova: when provider.name/model contains `sensenova`, upload base64 images to R2 and replace them with URLs
- Muse Spark: when provider.name/model contains `muse spark`, call through the Responses API format

### Insertion 3: R2 cleanup (~line 5612)
Position: after the HTTP fallback loop ends, before `// Structured failure`
```js
for (const fn of r2UploadedFiles) {
  try {
    const { execSync: es } = await import('node:child_process')
    es(`rclone delete r2:yuangs/handdrawn/${fn}`, { stdio: 'pipe' })
  } catch {}
}
```

## Re-patching after upgrading dsh-vision-router

1. Diff the new index.js against `index.js.v1.6.2.patched` and confirm the context of the 3 insertion points still matches
2. If the context matches → copy the 3 snippets into the new index.js at the corresponding positions
3. If the context changed → adjust the insertion positions manually (locate by searching for the `isSenseNova` / `isMuseSpark` / `r2UploadedFiles` keywords)

## Dependencies
- `rclone` (with an r2 remote configured, pointing at `r2:yuangs/handdrawn/`)
- The SenseNova provider must be configured in the vision model list of DSH settings.yaml
- The Muse Spark provider needs `apiKeyEnv` and an optional `baseURL`

---

## Summary of the two patch sets (2026-08-23)

### model-tps patch (dsh-model-tps-patch/)
- **Status**: merged into the deepseek-harness repository HEAD as 19 official commits
- **No longer needs patching**: the source is in the repository; after upgrading DSH the changes survive as long as the repository fork keeps these commits
- **When to update**: on an upstream major upgrade, or when the repository baseline is reset/rebased, re-export with `git diff` from the new baseline
- **Deployment**: repository commit → `npm run build:lib:host` + `pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle` + `pnpm --filter @deepseek-ai/dsh-client-ui-model-selection bundle` → copy `packages/client/*/lib/client.js` into `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/lib/`
- **Note**: npm-globally-installed packages (rc.2 etc.) do not include these changes; you must build from the repository and deploy manually

### vision patch (dsh-vision-patch/)
- **Status**: manually patched into `~/.dsh/profiles/web/node_modules/dsh-vision-router/index.js`
- **Must be re-applied on every dsh-vision-router upgrade**: `dsh plugin add` overwrites node_modules
- **When to update**: whenever the dsh-vision-router code structure changes (line shifts, context mismatches)
- **Backup**: `index.js.v1.6.2.patched` is the complete current patched file, kept for upgrade comparison

### pnpm rolling-dependency trap (lesson)
- **Problem**: the `dsh-genui` and `dsh-at-file` dependencies pinned GitHub `main`-branch tarballs (`archive/refs/heads/main.tar.gz`), while the pnpm lockfile pins sha512 checksums. Once main moves, the checksum no longer matches → `ERR_PNPM_TARBALL_INTEGRITY` → install failure
- **Symptom**: any `pnpm add/install` triggers it, because pnpm re-resolves every dependency
- **Workaround**: `pnpm install --update-checksums` refreshes the checksums (but may not work for some git tarballs)
- **Real fix**: switch both dependencies from the rolling `main` tarball to fixed tag URLs (e.g. `refs/tags/v0.9.6.tar.gz`) so the checksums stay stable forever
- **Risk**: a failed `pnpm install` moves packages from node_modules into `.ignored`, which keeps DSH from starting. Recovery: move the packages in `.ignored` back, or reinstall them manually from npm
