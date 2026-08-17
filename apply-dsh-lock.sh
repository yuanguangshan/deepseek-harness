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

# ===== 2. 修复损坏的 session 文件（单帧→多帧） =====
echo ""
echo "🔍 检查损坏的 session 文件..."

node - << 'NODEEOF'
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const root = path.join(os.homedir(), '.dsh/sessions');
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

function listDir(dir) {
  try { return fs.readdirSync(dir).filter(n => { try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; } }); }
  catch { return []; }
}

function readFirstZstdLine(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const dec = zlib.zstdDecompressSync(buf);
    const nl = dec.indexOf(0x0a);
    if (nl === -1 || nl !== dec.length - 1) return null;
    return dec.subarray(0, nl).toString('utf-8');
  } catch { return null; }
}

function compressFrame(input) {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, CHECKSUM_OPTIONS, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

async function fixFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const dec = zlib.zstdDecompressSync(buf);
  const lines = dec.toString('utf-8').split('\n').filter(l => l.length > 0);

  const header = lines[0];
  const events = lines.slice(1);

  const headerFrame = await compressFrame(Buffer.from(header + '\n', 'utf-8'));
  const eventsContent = events.join('\n') + (events.length > 0 ? '\n' : '');
  const eventsFrame = await compressFrame(Buffer.from(eventsContent, 'utf-8'));

  const bakPath = filePath + '.bak-zstd-fix';
  if (!fs.existsSync(bakPath)) fs.copyFileSync(filePath, bakPath);

  fs.writeFileSync(filePath, Buffer.concat([headerFrame, eventsFrame]));
  return events.length;
}

(async () => {
  let fixed = 0;
  for (const project of listDir(root)) {
    const projPath = path.join(root, project);
    for (const session of listDir(projPath)) {
      const sessionFile = path.join(projPath, session, 'session.jsonl.zstd');
      if (!fs.existsSync(sessionFile)) continue;

      if (readFirstZstdLine(sessionFile) === null) {
        const n = await fixFile(sessionFile);
        console.log(`  ✅ 修复: ${session} (${n} events)`);
        fixed++;
      }
    }
  }
  if (fixed === 0) console.log("  ✅ 所有 session 文件正常");
  else console.log(`  共修复 ${fixed} 个文件`);
})();
NODEEOF

echo ""
echo "完成！如需重启 dsh web: ~/bin/dsh-web.sh restart"
echo "如需回滚锁补丁: cp '$BACKUP' '$TARGET'"
