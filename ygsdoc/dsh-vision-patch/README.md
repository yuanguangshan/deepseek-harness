# dsh-vision-router SenseNova/Muse Spark 补丁

## 基线版本
- **dsh-vision-router**: 1.6.2
- **备份文件**: `index.js.v1.6.2.patched`（已打补丁的完整 index.js）

## 补丁内容（3 处插入）

### 插入 1：声明 r2UploadedFiles（~行 5422）
位置：`for (const provider of httpFallbacks)` 之前
```js
const r2UploadedFiles = []
```

### 插入 2：SenseNova R2 上传 + Muse Spark Responses API（~行 5455）
位置：`openAIBlocks.push({ type: 'text', text: block.text })` 闭合 `}` 之后，`// Direct HTTP providers must receive` 之前
- SenseNova：检测 provider.name/model 含 `sensenova`，将 base64 图片上传 R2 后替换为 URL
- Muse Spark：检测 provider.name/model 含 `muse spark`，用 Responses API 格式调用

### 插入 3：R2 清理（~行 5612）
位置：HTTP fallback 循环结束后，`// Structured failure` 之前
```js
for (const fn of r2UploadedFiles) {
  try {
    const { execSync: es } = await import('node:child_process')
    es(`rclone delete r2:yuangs/handdrawn/${fn}`, { stdio: 'pipe' })
  } catch {}
}
```

## 升级 dsh-vision-router 后重新打补丁

1. 对比新版 index.js 与 `index.js.v1.6.2.patched`，确认 3 处插入点的上下文是否仍匹配
2. 若上下文匹配 → 直接复制 3 段代码到新 index.js 对应位置
3. 若上下文变化 → 手动调整插入位置（搜索 `isSenseNova` / `isMuseSpark` / `r2UploadedFiles` 关键词定位）

## 依赖
- `rclone`（需配置 r2 remote，指向 `r2:yuangs/handdrawn/`）
- SenseNova provider 需在 DSH settings.yaml 的 vision 模型列表中配置
- Muse Spark provider 需配置 `apiKeyEnv` 和可选 `baseURL`

---

## 两组 Patch 总结（2026-08-23）

### model-tps patch（dsh-model-tps-patch/）
- **状态**：已作为 19 个正式 commit 合入 deepseek-harness 仓库 HEAD
- **不需要再打**：源码已在仓库里，升级 DSH 后只要仓库 fork 保留这些 commit 即可
- **什么时候要更新**：上游大版本升级、仓库基线被 reset/rebase 时，需从新基线重新 `git diff` 导出
- **部署方式**：仓库 commit → `npm run build:lib:host` + `pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle` + `pnpm --filter @deepseek-ai/dsh-client-ui-model-selection bundle` → 复制 `packages/client/*/lib/client.js` 到 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/lib/`
- **注意**：npm 全局安装的包（rc.2 等）不包含这些改动，必须从仓库 build 后手动部署

### vision patch（dsh-vision-patch/）
- **状态**：手动打到 `~/.dsh/profiles/web/node_modules/dsh-vision-router/index.js`
- **每次升级 dsh-vision-router 都要重新打**：`dsh plugin add` 会覆盖 node_modules
- **什么时候要更新**：dsh-vision-router 代码结构变化时（行号偏移、上下文不匹配）
- **备份**：`index.js.v1.6.2.patched` 是当前已打补丁的完整文件，升级时对比用

### pnpm 滚动依赖陷阱（教训）
- **问题**：`dsh-genui` 和 `dsh-at-file` 两个依赖锁定了 GitHub `main` 分支的 tarball（`archive/refs/heads/main.tar.gz`），而 pnpm lockfile 锁了 sha512 校验和。main 分支一更新，校验和就对不上 → `ERR_PNPM_TARBALL_INTEGRITY` → 安装失败
- **表现**：任何 `pnpm add/install` 都会触发，因为 pnpm 会重新解析所有依赖
- **临时方案**：`pnpm install --update-checksums` 刷新校验和（但对某些 git tarball 可能不生效）
- **根治方案**：把这两个依赖从「main 滚动 tarball」改为固定 tag URL（如 `refs/tags/v0.9.6.tar.gz`），校验和永久稳定
- **风险**：`pnpm install` 失败时会把 node_modules 里的包挪进 `.ignored`，导致 DSH 起不来。恢复方式：把 `.ignored` 里的包移回原位，或手动从 npm 下载补装
