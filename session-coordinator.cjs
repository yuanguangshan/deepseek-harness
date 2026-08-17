#!/usr/bin/env node
/**
 * session-coordinator.js — TUI Session 协调器
 *
 * 解决 TUI (--web-sessions) 与 dsh web 共享 session 根目录时的并发冲突问题。
 *
 * 策略: Copy-on-Write + 退出时合并
 * 1. TUI 启动时：复制原 session 为副本，TUI 使用副本
 * 2. TUI 运行时：所有写入都写到副本
 * 3. TUI 退出时：检测原 session 最新 seq，合并副本，删除副本
 *
 * 用法:
 *   node session-coordinator.js copy <原session-id>    # 创建副本
 *   node session-coordinator.js merge <原session-id>    # 合并并清理
 *   node session-coordinator.js status <原session-id>   # 查看状态
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

// ===== 配置 =====
const DSH_SESSION_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const TUI_SUFFIX = '-tui-copy';

// ===== 工具函数 =====

/**
 * 扫描 zstd 多帧文件，返回每帧的字节范围
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  const ZSTD_MAGIC = 0xFD2FB528;

  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;

    // 简单找下一个 magic
    let next = offset + 4;
    while (next < buffer.length - 3) {
      if (buffer.readUInt32LE(next) === ZSTD_MAGIC) break;
      next++;
    }
    if (next >= buffer.length - 3) next = buffer.length;

    frames.push({ start: offset, end: next });
    offset = next;
  }
  return frames;
}

/**
 * 解压单帧
 */
function decompressFrame(buffer, frame) {
  return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}

/**
 * 压缩为单帧
 */
function compressFrame(input) {
  return new Promise((resolve, reject) => {
    const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
    zlib.zstdCompress(input, CHECKSUM_OPTIONS, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

/**
 * 查找 session 所在的项目目录
 */
function findSessionDir(sessionId) {
  const projects = fs.readdirSync(DSH_SESSION_ROOT);
  for (const project of projects) {
    const sessionDir = path.join(DSH_SESSION_ROOT, project, sessionId);
    if (fs.existsSync(sessionDir)) {
      return { project, sessionDir };
    }
  }
  return null;
}

/**
 * 查找 session 文件
 */
function findSessionFile(sessionId) {
  const found = findSessionDir(sessionId);
  if (!found) return null;
  const file = path.join(found.sessionDir, 'session.jsonl.zstd');
  return fs.existsSync(file) ? file : null;
}

/**
 * 获取 session 的最后一个 seq
 */
function getLastSeq(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return -1;

  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) return -1;

  // 解压最后一帧，找最后一个事件的 seq
  const lastFrame = frames[frames.length - 1];
  const lastContent = decompressFrame(buf, lastFrame);
  const lines = lastContent.toString('utf-8').split('\n').filter(l => l.length > 0);

  // 找最后一个有效的 JSON 事件
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (typeof event.seq === 'number') return event.seq;
    } catch {}
  }

  return -1;
}

/**
 * 获取 session 的所有事件
 */
function getAllEvents(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return [];

  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const events = [];

  for (let i = 0; i < frames.length; i++) {
    const content = decompressFrame(buf, frames[i]);
    const lines = content.toString('utf-8').split('\n').filter(l => l.length > 0);

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  }

  return events;
}

/**
 * 从文件中获取原始 zstd 帧（保持原始压缩格式）
 */
function getRawFrames(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return [];

  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);

  return frames.map(f => buf.subarray(f.start, f.end));
}

// ===== 命令实现 =====

/**
 * copy: 创建 session 副本
 */
async function copySession(sourceId) {
  console.log(`📋 创建 session 副本: ${sourceId}`);

  // 检查原 session
  const sourceFile = findSessionFile(sourceId);
  if (!sourceFile) {
    console.error(`❌ 原 session 不存在: ${sourceId}`);
    process.exit(1);
  }

  // 检查是否已有副本
  const copyId = `${sourceId}${TUI_SUFFIX}`;
  if (findSessionFile(copyId)) {
    console.log(`⚠️  副本已存在: ${copyId}`);
    console.log(`   副本 ID: ${copyId}`);
    return copyId;
  }

  // 读取原 session 的所有帧
  const sourceBuf = fs.readFileSync(sourceFile);
  const sourceFrames = scanZstdFrames(sourceBuf);

  // 创建副本目录
  const sourceInfo = findSessionDir(sourceId);
  const copyDir = path.join(DSH_SESSION_ROOT, sourceInfo.project, copyId);
  fs.mkdirSync(copyDir, { recursive: true });

  // 修改 header 中的 id
  const headerFrame = sourceFrames[0];
  const headerContent = decompressFrame(sourceBuf, headerFrame);
  const header = JSON.parse(headerContent.toString('utf-8'));
  header.id = copyId;
  header.createdAt = Date.now();
  header.parentSession = sourceId;  // 记录来源

  // 创建新的第一帧（修改后的 header）
  const newHeaderFrame = await compressFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf-8'));

  // 后续帧保持原样（直接复制字节）
  const remainingFrames = [];
  for (let i = 1; i < sourceFrames.length; i++) {
    remainingFrames.push(sourceBuf.subarray(sourceFrames[i].start, sourceFrames[i].end));
  }

  // 写入副本文件
  const copyFile = path.join(copyDir, 'session.jsonl.zstd');
  const combined = Buffer.concat([newHeaderFrame, ...remainingFrames]);
  fs.writeFileSync(copyFile, combined);

  // 保存元数据：记录副本创建时原 session 的 lastSeq
  const lastSeq = getLastSeq(copyId);
  const metaFile = path.join(copyDir, '.tui-copy-meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({
    sourceId,
    sourceLastSeq: lastSeq,
    createdAt: Date.now(),
  }));

  // 验证
  console.log(`✅ 副本已创建`);
  console.log(`   副本 ID: ${copyId}`);
  console.log(`   帧数: ${sourceFrames.length}`);
  console.log(`   源 session lastSeq: ${lastSeq}`);
  console.log(`   文件: ${copyFile}`);

  return copyId;
}

/**
 * merge: 从副本中提取 TUI 新增事件，追加到原 session
 *
 * 副本包含原 session 的完整拷贝 + TUI 新增事件。
 * 策略：提取副本中 seq > 原 session lastSeq 的事件，追加到原 session。
 * 这样即使 Web 在 TUI 运行期间写入了新事件，也不会冲突。
 */
async function mergeSession(sourceId) {
  console.log(`🔄 合并 session 副本: ${sourceId}`);

  const copyId = `${sourceId}${TUI_SUFFIX}`;
  const sourceFile = findSessionFile(sourceId);
  const copyFile = findSessionFile(copyId);

  if (!sourceFile) {
    console.error(`❌ 原 session 不存在: ${sourceId}`);
    process.exit(1);
  }

  if (!copyFile) {
    console.error(`❌ 副本不存在: ${copyId}`);
    process.exit(1);
  }

  // 获取原 session 的最新 seq
  const sourceLastSeq = getLastSeq(sourceId);
  console.log(`   原 session 最新 seq: ${sourceLastSeq}`);

  // 获取副本的所有事件
  const copyEvents = getAllEvents(copyId);

  // 过滤出 TUI 新增的事件（seq > 原 session 的 lastSeq）
  const newEvents = copyEvents.filter(e =>
    typeof e.seq === 'number' && e.seq > sourceLastSeq
  );

  if (newEvents.length === 0) {
    console.log(`   📭 副本没有新增事件，跳过合并`);
    cleanupCopy(copyId);
    return;
  }

  console.log(`   副本新增事件数: ${newEvents.length}`);
  console.log(`   新增事件 seq 范围: ${newEvents[0].seq} - ${newEvents[newEvents.length - 1].seq}`);

  // 检查 seq 连续性
  const expectedSeq = sourceLastSeq + 1;
  if (newEvents[0].seq !== expectedSeq) {
    console.error(`❌ Seq 不连续！`);
    console.error(`   原 session 最新 seq: ${sourceLastSeq}`);
    console.error(`   副本第一个新事件 seq: ${newEvents[0].seq}`);
    console.error(`   期望的 seq: ${expectedSeq}`);
    console.error(``);
    console.error(`   Web 在 TUI 运行期间写入了新事件。`);
    console.error(`   请手动处理或丢弃副本。`);
    process.exit(1);
  }

  console.log(`   ✅ Seq 连续性检查通过`);

  // 读取原 session 的所有帧
  const sourceBuf = fs.readFileSync(sourceFile);
  const sourceFrames = scanZstdFrames(sourceBuf);

  // 将新事件编码为新的 zstd 帧
  const newEventsContent = newEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  const newFrame = await compressFrame(Buffer.from(newEventsContent, 'utf-8'));

  // 备份原文件
  const backupFile = sourceFile + '.bak-merge';
  if (!fs.existsSync(backupFile)) {
    fs.copyFileSync(sourceFile, backupFile);
    console.log(`   📦 已备份原文件: ${backupFile}`);
  }

  // 合并：原 session 的所有帧 + 新事件帧
  const mergedFrames = [];
  for (const frame of sourceFrames) {
    mergedFrames.push(sourceBuf.subarray(frame.start, frame.end));
  }
  mergedFrames.push(newFrame);

  // 写入合并后的文件
  const merged = Buffer.concat(mergedFrames);
  fs.writeFileSync(sourceFile, merged);

  // 验证合并结果
  const mergedLastSeq = getLastSeq(sourceId);
  console.log(`   合并后最新 seq: ${mergedLastSeq}`);

  if (mergedLastSeq === newEvents[newEvents.length - 1].seq) {
    console.log(`   ✅ 合并验证通过`);
  } else {
    console.log(`   ⚠️  合并后 seq 与预期不符，请检查`);
  }

  // 清理副本
  cleanupCopy(copyId);

  console.log(`✅ 合并完成`);
}

/**
 * 清理副本
 */
function cleanupCopy(copyId) {
  const copyInfo = findSessionDir(copyId);
  if (copyInfo) {
    const copyDir = path.join(DSH_SESSION_ROOT, copyInfo.project, copyId);
    fs.rmSync(copyDir, { recursive: true, force: true });
    console.log(`   🗑️  已删除副本: ${copyId}`);
  }
}

/**
 * status: 查看 session 状态
 */
function statusSession(sourceId) {
  const sourceFile = findSessionFile(sourceId);
  const copyId = `${sourceId}${TUI_SUFFIX}`;
  const copyFile = findSessionFile(copyId);

  console.log(`📊 Session 状态: ${sourceId}`);

  if (sourceFile) {
    const lastSeq = getLastSeq(sourceId);
    const events = getAllEvents(sourceId);
    console.log(`   原 session: ✅ 存在`);
    console.log(`   事件数: ${events.length}`);
    console.log(`   最新 seq: ${lastSeq}`);
  } else {
    console.log(`   原 session: ❌ 不存在`);
  }

  if (copyFile) {
    const lastSeq = getLastSeq(copyId);
    const events = getAllEvents(copyId);
    console.log(`   副本: ✅ 存在`);
    console.log(`   副本事件数: ${events.length}`);
    console.log(`   副本最新 seq: ${lastSeq}`);
  } else {
    console.log(`   副本: ❌ 不存在`);
  }
}

// ===== 主程序 =====

const [,, command, sessionId] = process.argv;

if (!command || !sessionId) {
  console.log('用法:');
  console.log('  node session-coordinator.js copy <session-id>    # 创建副本');
  console.log('  node session-coordinator.js merge <session-id>   # 合并并清理');
  console.log('  node session-coordinator.js status <session-id>  # 查看状态');
  console.log('  node session-coordinator.js cleanup <session-id> # 强制清理副本');
  process.exit(1);
}

(async () => {
  switch (command) {
    case 'copy':
      await copySession(sessionId);
      break;
    case 'merge':
      await mergeSession(sessionId);
      break;
    case 'status':
      statusSession(sessionId);
      break;
    case 'cleanup':
      cleanupCopy(`${sessionId}${TUI_SUFFIX}`);
      console.log('✅ 已清理副本');
      break;
    default:
      console.error(`❌ 未知命令: ${command}`);
      process.exit(1);
  }
})();
