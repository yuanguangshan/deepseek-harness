#!/bin/bash
# apply-dsh-lock.sh — 自动给 dsh 加跨进程 session 文件锁 + 修复损坏文件
# 解决 TUI (--web-sessions) 与 dsh web 同时运行时的 seq 冲突
#
# 用法: bash apply-dsh-lock.sh
# 每次 dsh 更新后运行一次，或在 launch-tui.sh 中自动调用
#
# 功能:
# 1. 在 session-persistence-jsonl 的 appendLines 中注入 shlock 文件锁
# 2. 自动修复单帧 zstd 损坏的 session 文件（恢复为 dsh 要求的多帧格式）

set -euo pipefail

# ===== 1. 自动定位目标文件 =====
TARGET=$(find /opt/homebrew/lib/node_modules -name "index.js" -path "*dsh-session-persistence-jsonl*lib*" 2>/dev/null | head -1)

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "❌ 找不到 dsh-session-persistence-jsonl/lib/index.js"
  exit 1
fi
BACKUP="${TARGET}.bak-orig"

echo "📄 目标文件: $TARGET"

# 检查是否已应用
if grep -q "__SESSION_LOCK_APPLIED__" "$TARGET" 2>/dev/null; then
  echo "✅ 跨进程锁已安装"
else
  # 备份原始文件
  if [ ! -f "$BACKUP" ]; then
    cp "$TARGET" "$BACKUP"
    echo "📦 已备份原始文件: $BACKUP"
  fi

  # 使用 Node.js 注入锁逻辑
  node - "$TARGET" << 'NODEEOF'
const fs = require('fs');
const target = process.argv[1];
let content = fs.readFileSync(target, 'utf-8');
let modified = false;

// 1. 添加 child_process 和 unlinkSync 导入
if (!content.includes('child_process')) {
    content = content.replace(
        'import { randomBytes } from "node:crypto";',
        'import { randomBytes } from "node:crypto";\nimport { execSync } from "node:child_process";\nimport { unlinkSync } from "node:fs";'
    );
    modified = true;
    console.log("  ✓ 添加了 child_process 导入");
}

// 2. 在 appendLines 开头注入锁逻辑
const marker = "/* __SESSION_LOCK_APPLIED__ */";
const lockCode = `
\t\t${marker}
\t\t// --- Cross-process file lock via shlock ---
\t\tconst lockDir = join(this.root, ".locks");
\t\tawait mkdir(lockDir, { recursive: true }).catch(() => {});
\t\tconst lockPath = join(lockDir, \`\${meta.id}.lock\`);
\t\tlet lockAcquired = false;
\t\tconst acquireLock = () => {
\t\t\ttry {
\t\t\t\texecSync(\`shlock -p \${process.pid} -f "\${lockPath}"\`, { timeout: 10000, stdio: 'pipe' });
\t\t\t\tlockAcquired = true;
\t\t\t} catch { /* retry below */ }
\t\t};
\t\tconst releaseLock = () => {
\t\t\tif (lockAcquired) {
\t\t\t\ttry { unlinkSync(lockPath); } catch {}
\t\t\t\tlockAcquired = false;
\t\t\t}
\t\t};
\t\t// Wait for lock with exponential backoff (max ~5s)
\t\tlet retries = 0;
\t\twhile (!lockAcquired && retries < 50) {
\t\t\tacquireLock();
\t\t\tif (!lockAcquired) {
\t\t\t\tawait scheduler.wait(Math.min(100 * (retries + 1), 2000));
\t\t\t\tretries++;
\t\t\t}
\t\t}
\t\tif (!lockAcquired) {
\t\t\tthrow new Error(\`Failed to acquire session lock for "\${meta.id}" after \${retries} retries\`);
\t\t}
\t\t// --- End lock acquire ---`;

const oldSig = '\tasync appendLines(meta, events) {\n\t\tconst content = await this.encodeEventBatch(events);';
const newSig = '\tasync appendLines(meta, events) {' + lockCode + '\n\t\tconst content = await this.encodeEventBatch(events);';

if (!content.includes(marker) && content.includes(oldSig)) {
    content = content.replace(oldSig, newSig);
    modified = true;
    console.log("  ✓ 注入了锁获取逻辑");
}

// 3. 在 finally 块中注入锁释放
const oldFinally = '\t\t} finally {\n\t\t\tawait closeAppendHandle();\n\t\t}\n\t}';
const newFinally = '\t\t} finally {\n\t\t\tawait closeAppendHandle();\n\t\t\treleaseLock();\n\t\t}\n\t}';

if (content.includes(oldFinally) && content.split('async appendLines')[1].split('releaseLock').length < 3) {
    content = content.replace(oldFinally, newFinally);
    modified = true;
    console.log("  ✓ 注入了锁释放逻辑");
}

if (modified) {
    fs.writeFileSync(target, content);
    console.log("✅ 补丁已应用");
} else {
    console.log("⏭  补丁已存在或无需修改");
}
NODEEOF
fi

# ===== 2. 体检 session 文件（只读，不自动改写） =====
# 注意：旧版这里用 zlib.zstdDecompressSync(buf) 解压"整个文件"来"修复"，
# 但 Node 的 zstdDecompressSync 对多帧拼接文件只解第一帧 —— 一旦误触发
# 会把帧 1 之后的所有事件全部丢掉（曾造成 repl-552c4200 丢 15408..26585）。
# 现改为只读体检 + 明确命令人工执行，绝不自动重写。
echo ""
echo "🔍 体检 session 文件（只读）..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPAIR="$SCRIPT_DIR/repair-session-gap.mjs"
if [ -f "$REPAIR" ]; then
  node "$REPAIR" scan "$HOME/.dsh/sessions" || true
  echo ""
  echo "如上述有损坏文件，用 commit 5668c5e033 之后的加固工具修复："
  echo "  node $REPAIR fix <session.jsonl.zstd> [--prefix <完整备份>]"
  echo "  node $REPAIR rebuild <session.jsonl.zstd>   # tail 内部也不连续时使用（去重+排序+连续校验）"
  echo "（修复前会自动备份 .bak-repair-<ts> / .bak-rebuild-<ts>，写回前强制校验 seq 连续）"
else
  echo "⚠️  未找到 $REPAIR，跳过体检"
fi

echo ""
echo "完成！如需重启 dsh web: ~/bin/dsh-web.sh restart"
echo "如需回滚锁补丁: cp '$BACKUP' '$TARGET'"
