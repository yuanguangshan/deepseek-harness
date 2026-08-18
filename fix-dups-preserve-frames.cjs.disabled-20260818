/**
 * fix-dups-preserve-frames.cjs — 修复 duplicate seq，保留原始帧结构
 *
 * 策略：逐帧扫描，检测重复 seq，删除第一次出现（interrupted segment），保留第二次（retry segment）。
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('用法: node fix-dups-preserve-frames.cjs <session.jsonl.zstd>'); process.exit(1); }

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  const ZSTD_MAGIC = 0xFD2FB528;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
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

async function fixFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const frames = scanZstdFrames(buf);

  // 解压所有帧，逐帧记录
  const frameData = [];
  for (const frame of frames) {
    const content = zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end));
    const lines = content.toString('utf-8').split('\n').filter(l => l.length > 0);
    frameData.push({ start: frame.start, end: frame.end, lines, content });
  }

  // 检测 duplicate seq
  const seqSeen = new Map(); // seq → frame index
  const framesToRemove = new Set(); // 要删除的帧（包含 duplicate 的第一次出现）

  for (let fi = 0; fi < frameData.length; fi++) {
    const { lines } = frameData[fi];
    let hasDup = false;

    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (typeof e.seq === 'number') {
          if (seqSeen.has(e.seq)) {
            hasDup = true;
            break;
          }
        }
      } catch {}
    }

    if (hasDup) {
      // 整个帧都删除（它是 interrupted segment）
      framesToRemove.add(fi);
    } else {
      // 标记这些 seq 为已见
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (typeof e.seq === 'number') seqSeen.set(e.seq, fi);
        } catch {}
      }
    }
  }

  if (framesToRemove.size === 0) {
    console.log('✅ 无 duplicate');
    return;
  }

  // 重新编码保留的帧
  const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

  const keepFrames = [];
  for (let fi = 0; fi < frameData.length; fi++) {
    if (framesToRemove.has(fi)) {
      console.log(`  删除帧 ${fi} (${frameData[fi].lines.length} 行)`);
      continue;
    }
    // 保持原始压缩（直接复制字节）
    keepFrames.push(buf.subarray(frames[fi].start, frames[fi].end));
  }

  // 备份
  const bakPath = filePath + '.bak-frame-fix';
  if (!fs.existsSync(bakPath)) fs.copyFileSync(filePath, bakPath);

  // 写入
  const merged = Buffer.concat(keepFrames);
  fs.writeFileSync(filePath, merged);

  // 验证
  const verifyBuf = fs.readFileSync(filePath);
  const verifyFrames = scanZstdFrames(verifyBuf);
  const verifySeqs = new Set();
  for (const frame of verifyFrames) {
    const content = zlib.zstdDecompressSync(verifyBuf.subarray(frame.start, frame.end));
    const lines = content.toString('utf-8').split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (typeof e.seq === 'number') {
          if (verifySeqs.has(e.seq)) {
            console.log('❌ 验证失败: seq', e.seq, '仍重复');
            return;
          }
          verifySeqs.add(e.seq);
        }
      } catch {}
    }
  }

  console.log(`✅ 修复完成: 删除 ${framesToRemove.size} 帧, 保留 ${keepFrames.length} 帧, 无 duplicate`);
}

(async () => {
  await fixFile(file);
})();
